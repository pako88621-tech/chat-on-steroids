import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  IDEMPOTENCY_STATE_DIR_ENV,
  IdempotencyError,
  acquireIdempotencyController,
  canonicalPayloadHash,
  deterministicInputId,
  readIdempotencyRecord,
  requestIdHash,
  resolveExternalOrchestratorStateDir,
  type IdempotencyController,
  type IdempotencyErrorCode,
  type IdempotencyOperationKind,
  type IdempotencyReservation,
} from '../idempotency.js';

const SESSION_A = 'session-0001';
const SESSION_B = 'session-0002';

async function withStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-eo-idempotency-'));
  try {
    await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function expectIdempotencyError(promise: Promise<unknown>, code: IdempotencyErrorCode): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof IdempotencyError && error.code === code,
  );
}

async function reserve(
  controller: IdempotencyController,
  requestId: string,
  payload: unknown,
  kind: IdempotencyOperationKind = 'start',
  sessionId = SESSION_A,
): Promise<IdempotencyReservation> {
  return controller.reserve({ requestId, sessionId, kind, payload });
}

async function readOwner(lockPath: string): Promise<{ nonce: string; createdAt: number; updatedAt: number }> {
  return JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')) as {
    nonce: string;
    createdAt: number;
    updatedAt: number;
  };
}

test('deterministic input ids match independent locked UUID vectors', () => {
  assert.equal(deterministicInputId('req.start.1'), 'a3b4db65-4b3f-5b10-8a46-8626f219ec61');
  assert.equal(deterministicInputId('req.steer.1'), '1ad287d6-db8a-5330-a78c-88794e98ea83');
  assert.equal(deterministicInputId('request-abc-123'), '973471e7-d963-52c5-9d19-96583d689792');
});

test('canonical payload hashing is stable across object-key order and detects changed meaning', async () => {
  const left = {
    task: 'ship it',
    options: { project: 'alpha', retries: 2 },
    flags: ['a', 'b'],
  };
  const reordered = {
    flags: ['a', 'b'],
    options: { retries: 2, project: 'alpha' },
    task: 'ship it',
  };
  assert.equal(canonicalPayloadHash(left), canonicalPayloadHash(reordered));

  await withStateDir(async (stateDir) => {
    const controller = await acquireIdempotencyController({ stateDir, heartbeatMs: 0, staleAfterMs: 1_000 });
    try {
      const first = await reserve(controller, 'req.canonical.1', left);
      assert.equal(first.replayed, false);
      const replay = await reserve(controller, 'req.canonical.1', reordered);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.record, first.record);

      await expectIdempotencyError(
        reserve(controller, 'req.canonical.1', { ...left, task: 'different task' }),
        'duplicate_request_conflict',
      );
    } finally {
      await controller.release();
    }
  });
});

test('persisted ledger contains only hashes and mutation metadata, never request id, task text, or token', async () => {
  await withStateDir(async (stateDir) => {
    const controller = await acquireIdempotencyController({ stateDir, heartbeatMs: 0, staleAfterMs: 1_000 });
    const requestId = 'req.persistence.secret.1';
    const taskText = 'TASK_TEXT_MUST_NEVER_BE_PERSISTED_4d9f';
    const bearerToken = 'TOKEN_MUST_NEVER_BE_PERSISTED_87a1';
    try {
      await reserve(controller, requestId, {
        task: taskText,
        auth: { token: bearerToken },
        nested: { instruction: 'run once' },
      });

      const raw = await fs.readFile(controller.ledgerFile, 'utf8');
      assert.equal(raw.includes(requestId), false);
      assert.equal(raw.includes(taskText), false);
      assert.equal(raw.includes(bearerToken), false);

      const rows = JSON.parse(raw) as Array<Record<string, unknown>>;
      assert.equal(rows.length, 1);
      assert.deepEqual(Object.keys(rows[0]!).sort(), [
        'inputId',
        'kind',
        'payloadHash',
        'requestHash',
        'reservedAt',
        'schemaVersion',
        'sessionId',
        'state',
        'updatedAt',
      ]);
      assert.equal(rows[0]!.requestHash, requestIdHash(requestId));
    } finally {
      await controller.release();
    }
  });
});

test('restart preserves lookup and exact replay without creating another ledger row', async () => {
  await withStateDir(async (stateDir) => {
    const firstController = await acquireIdempotencyController({ stateDir, heartbeatMs: 0, staleAfterMs: 1_000 });
    const request = {
      requestId: 'req.restart.1',
      sessionId: SESSION_A,
      kind: 'start' as const,
      payload: { task: 'continue after restart', mode: 'safe' },
    };
    const original = await firstController.reserve(request);
    assert.equal(await firstController.release(), true);

    const secondController = await acquireIdempotencyController({ stateDir, heartbeatMs: 0, staleAfterMs: 1_000 });
    try {
      assert.deepEqual(await secondController.lookup(request.requestId), original.record);
      assert.deepEqual(await readIdempotencyRecord(request.requestId, { stateDir }), original.record);

      const replay = await secondController.reserve(request);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.record, original.record);
      const persisted = JSON.parse(await fs.readFile(secondController.ledgerFile, 'utf8')) as unknown[];
      assert.equal(persisted.length, 1);
    } finally {
      await secondController.release();
    }
  });
});

test('retry-safe attempts close back to reserved across restart, then accepted cannot regress', async () => {
  await withStateDir(async (stateDir) => {
    let now = 100;
    const firstController = await acquireIdempotencyController({
      stateDir,
      heartbeatMs: 0,
      staleAfterMs: 1_000,
      now: () => now,
    });
    const reservation = await reserve(firstController, 'req.transitions.1', { task: 'state machine' });
    try {
      assert.equal(reservation.record.state, 'reserved');
      assert.equal(reservation.record.updatedAt, 100);

      now = 200;
      const retrySafe = await firstController.markRetrySafe(reservation);
      assert.equal(retrySafe.state, 'retry_safe');
      assert.equal(retrySafe.updatedAt, 200);

      now = 250;
      const attempting = await firstController.markAttempting(reservation);
      assert.equal(attempting.state, 'reserved');
      assert.equal(attempting.updatedAt, 250);
    } finally {
      await firstController.release();
    }

    now = 300;
    const restarted = await acquireIdempotencyController({
      stateDir,
      heartbeatMs: 0,
      staleAfterMs: 1_000,
      now: () => now,
    });
    try {
      const persisted = await restarted.lookup('req.transitions.1');
      assert.equal(persisted?.state, 'reserved');
      assert.equal(persisted?.updatedAt, 250);

      const retrySafeAgain = await restarted.markRetrySafe(reservation);
      assert.equal(retrySafeAgain.state, 'retry_safe');
      assert.equal(retrySafeAgain.updatedAt, 300);

      now = 400;
      const accepted = await restarted.markAccepted(reservation);
      assert.equal(accepted.state, 'accepted');
      assert.equal(accepted.acceptedAt, 400);
      assert.equal(accepted.updatedAt, 400);

      now = 500;
      await expectIdempotencyError(restarted.markAttempting(reservation), 'retry_permission_consumed');

      now = 600;
      const stillAccepted = await restarted.markRetrySafe(reservation);
      assert.equal(stillAccepted.state, 'accepted');
      assert.equal(stillAccepted.acceptedAt, 400);
      assert.equal(stillAccepted.updatedAt, 400);
      assert.deepEqual(await restarted.lookup('req.transitions.1'), stillAccepted);
    } finally {
      await restarted.release();
    }
  });
});

test('terminal not_sent ownership survives restart and can never reopen a resend window', async () => {
  await withStateDir(async (stateDir) => {
    const first = await acquireIdempotencyController({ stateDir, heartbeatMs: 0, staleAfterMs: 1_000 });
    const reservation = await reserve(first, 'req.not-sent.persisted', { task: 'never resend' });
    const terminal = await first.markNotSent(reservation);
    assert.equal(terminal.state, 'not_sent');
    await first.assertOwned();
    await first.release();

    const restarted = await acquireIdempotencyController({ stateDir, heartbeatMs: 0, staleAfterMs: 1_000 });
    try {
      const persisted = await restarted.lookup('req.not-sent.persisted');
      assert.equal(persisted?.state, 'not_sent');
      const replay = await reserve(restarted, 'req.not-sent.persisted', { task: 'never resend' });
      assert.equal(replay.replayed, true);
      assert.equal((await restarted.markRetrySafe(replay)).state, 'not_sent');
      await expectIdempotencyError(restarted.markAttempting(replay), 'retry_permission_consumed');
      await expectIdempotencyError(restarted.markAccepted(replay), 'duplicate_request_conflict');
    } finally {
      await restarted.release();
    }
  });
});

test('retry-safe permission has exactly one atomic consumer', async () => {
  await withStateDir(async (stateDir) => {
    const controller = await acquireIdempotencyController({ stateDir, heartbeatMs: 0, staleAfterMs: 1_000 });
    try {
      const reservation = await reserve(controller, 'req.retry.atomic', { task: 'one retry' });
      const retrySafe = await controller.markRetrySafe(reservation);
      const staleView: IdempotencyReservation = { record: retrySafe, replayed: true };
      const outcomes = await Promise.allSettled([
        controller.markAttempting(staleView),
        controller.markAttempting(staleView),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
      assert.ok(rejected && rejected.status === 'rejected');
      assert.ok(rejected.reason instanceof IdempotencyError);
      assert.equal(rejected.reason.code, 'retry_permission_consumed');
      assert.equal((await controller.lookup('req.retry.atomic'))?.state, 'reserved');
    } finally {
      await controller.release();
    }
  });
});

test('accepted ownership may become terminal not_sent after a proven cancel', async () => {
  await withStateDir(async (stateDir) => {
    const controller = await acquireIdempotencyController({ stateDir, heartbeatMs: 0, staleAfterMs: 1_000 });
    try {
      const reservation = await reserve(controller, 'req.cancel.not-sent', { task: 'cancel me' });
      const accepted = await controller.markAccepted(reservation);
      assert.equal(accepted.state, 'accepted');
      const notSent = await controller.markNotSent({ record: accepted, replayed: true });
      assert.equal(notSent.state, 'not_sent');
      assert.equal((await controller.lookup('req.cancel.not-sent'))?.state, 'not_sent');
    } finally {
      await controller.release();
    }
  });
});

test('accepted Core row proof is persisted as an opaque hash, strengthened after restart, and rejects a different instance', async () => {
  await withStateDir(async (stateDir) => {
    const requestId = 'req.accepted.proof';
    const firstProof = canonicalPayloadHash({ id: 'row', createdAt: 100, dueAt: 101 });
    const secondProof = canonicalPayloadHash({ id: 'row', createdAt: 200, dueAt: 201 });
    const first = await acquireIdempotencyController({ stateDir, heartbeatMs: 0, staleAfterMs: 1_000 });
    const reservation = await reserve(first, requestId, { task: 'opaque proof' });
    try {
      const accepted = await first.markAccepted(reservation, firstProof);
      assert.equal(accepted.state, 'accepted');
      assert.equal(accepted.inputProofHash, firstProof);
      const raw = await fs.readFile(first.ledgerFile, 'utf8');
      assert.equal(raw.includes('opaque proof'), false);
      assert.equal(raw.includes(firstProof), true);
    } finally {
      await first.release();
    }

    const restarted = await acquireIdempotencyController({ stateDir, heartbeatMs: 0, staleAfterMs: 1_000 });
    try {
      const replay = await reserve(restarted, requestId, { task: 'opaque proof' });
      assert.equal(replay.record.inputProofHash, firstProof);
      await expectIdempotencyError(restarted.markAccepted(replay, secondProof), 'duplicate_request_conflict');
      assert.equal((await restarted.lookup(requestId))?.inputProofHash, firstProof);
    } finally {
      await restarted.release();
    }
  });
});

test('Core id_conflict is terminal across restart and cannot degrade into ambiguity', async () => {
  await withStateDir(async (stateDir) => {
    const first = await acquireIdempotencyController({ stateDir, heartbeatMs: 0, staleAfterMs: 1_000 });
    const reservation = await reserve(first, 'req.conflict.persisted', { task: 'semantic A' });
    const conflict = await first.markConflict(reservation);
    assert.equal(conflict.state, 'conflict');
    await first.release();

    const restarted = await acquireIdempotencyController({ stateDir, heartbeatMs: 0, staleAfterMs: 1_000 });
    try {
      const replay = await reserve(restarted, 'req.conflict.persisted', { task: 'semantic A' });
      assert.equal(replay.record.state, 'conflict');
      assert.equal((await restarted.markRetrySafe(replay)).state, 'conflict');
      await expectIdempotencyError(restarted.markAccepted(replay), 'duplicate_request_conflict');
      await expectIdempotencyError(restarted.markNotSent(replay), 'duplicate_request_conflict');
    } finally {
      await restarted.release();
    }
  });
});

test('same request id conflicts when session, kind, or canonical payload meaning changes', async () => {
  await withStateDir(async (stateDir) => {
    const controller = await acquireIdempotencyController({ stateDir, heartbeatMs: 0, staleAfterMs: 1_000 });
    try {
      await reserve(controller, 'req.conflict.1', { action: 'start', value: 1 });

      await expectIdempotencyError(
        reserve(controller, 'req.conflict.1', { action: 'start', value: 1 }, 'start', SESSION_B),
        'duplicate_request_conflict',
      );
      await expectIdempotencyError(
        reserve(controller, 'req.conflict.1', { action: 'start', value: 1 }, 'steer'),
        'duplicate_request_conflict',
      );
      await expectIdempotencyError(
        reserve(controller, 'req.conflict.1', { action: 'start', value: 2 }),
        'duplicate_request_conflict',
      );
    } finally {
      await controller.release();
    }
  });
});

test('full ledger fails visibly and never evicts existing reservations', async () => {
  await withStateDir(async (stateDir) => {
    const controller = await acquireIdempotencyController({
      stateDir,
      ledgerLimit: 2,
      heartbeatMs: 0,
      staleAfterMs: 1_000,
    });
    try {
      const first = await reserve(controller, 'req.full.1', { slot: 1 });
      const second = await reserve(controller, 'req.full.2', { slot: 2 });
      await expectIdempotencyError(
        reserve(controller, 'req.full.3', { slot: 3 }),
        'idempotency_ledger_full',
      );

      assert.deepEqual(await controller.lookup('req.full.1'), first.record);
      assert.deepEqual(await controller.lookup('req.full.2'), second.record);
      assert.equal(await controller.lookup('req.full.3'), null);
      const replay = await reserve(controller, 'req.full.1', { slot: 1 });
      assert.equal(replay.replayed, true);

      const rows = JSON.parse(await fs.readFile(controller.ledgerFile, 'utf8')) as Array<{ requestHash: string }>;
      assert.deepEqual(rows.map((row) => row.requestHash), [
        requestIdHash('req.full.1'),
        requestIdHash('req.full.2'),
      ]);
    } finally {
      await controller.release();
    }
  });
});

test('POSIX state, lock, owner, and ledger permissions remain private', { skip: process.platform === 'win32' }, async () => {
  await withStateDir(async (stateDir) => {
    const controller = await acquireIdempotencyController({
      stateDir,
      heartbeatMs: 0,
      staleAfterMs: 1_000,
      platform: process.platform,
    });
    try {
      await reserve(controller, 'req.modes.1', { value: 1 });
      const [stateStat, lockStat, ownerStat, ledgerStat] = await Promise.all([
        fs.stat(controller.stateDir),
        fs.stat(controller.controllerLockPath),
        fs.stat(path.join(controller.controllerLockPath, 'owner.json')),
        fs.stat(controller.ledgerFile),
      ]);
      assert.equal(stateStat.mode & 0o777, 0o700);
      assert.equal(lockStat.mode & 0o777, 0o700);
      assert.equal(ownerStat.mode & 0o777, 0o600);
      assert.equal(ledgerStat.mode & 0o777, 0o600);
    } finally {
      await controller.release();
    }
  });
});

test('a live per-user controller lock reports controller_busy', async () => {
  await withStateDir(async (stateDir) => {
    const now = () => 10_000;
    const first = await acquireIdempotencyController({ stateDir, heartbeatMs: 0, staleAfterMs: 1_000, now });
    try {
      await expectIdempotencyError(
        acquireIdempotencyController({ stateDir, heartbeatMs: 0, staleAfterMs: 1_000, now }),
        'controller_busy',
      );
    } finally {
      await first.release();
    }
  });
});

test('stale controller lock is taken over by a fresh controller', async () => {
  await withStateDir(async (stateDir) => {
    const stale = await acquireIdempotencyController({
      stateDir,
      heartbeatMs: 0,
      staleAfterMs: 1_000,
      now: () => 1_000,
    });
    const staleOwner = await readOwner(stale.controllerLockPath);
    const fresh = await acquireIdempotencyController({
      stateDir,
      heartbeatMs: 0,
      staleAfterMs: 1_000,
      now: () => 3_000,
    });
    try {
      const freshOwner = await readOwner(fresh.controllerLockPath);
      assert.notEqual(freshOwner.nonce, staleOwner.nonce);
      const reservation = await reserve(fresh, 'req.takeover.1', { owner: 'fresh' });
      assert.equal(reservation.replayed, false);
      await expectIdempotencyError(stale.lookup('req.takeover.1'), 'controller_lost');
    } finally {
      await stale.release();
      await fresh.release();
    }
  });
});

test('an old lock nonce cannot release or replace its successor', async () => {
  await withStateDir(async (stateDir) => {
    const oldController = await acquireIdempotencyController({
      stateDir,
      heartbeatMs: 0,
      staleAfterMs: 1_000,
      now: () => 1_000,
    });
    const oldOwner = await readOwner(oldController.controllerLockPath);
    const successor = await acquireIdempotencyController({
      stateDir,
      heartbeatMs: 0,
      staleAfterMs: 1_000,
      now: () => 3_000,
    });
    try {
      const successorBefore = await readOwner(successor.controllerLockPath);
      assert.notEqual(successorBefore.nonce, oldOwner.nonce);

      assert.equal(await oldController.release(), false);
      const successorAfter = await readOwner(successor.controllerLockPath);
      assert.deepEqual(successorAfter, successorBefore);
      assert.equal(await successor.lookup('req.never-created'), null);
    } finally {
      await oldController.release();
      await successor.release();
    }
  });
});

test('state directory resolution is platform-specific, canonical, and honors absolute overrides', () => {
  assert.equal(
    resolveExternalOrchestratorStateDir({}, 'linux', '/home/alice'),
    '/home/alice/.local/state/chat-on-steroids-external-orchestrator',
  );
  assert.equal(
    resolveExternalOrchestratorStateDir({ XDG_STATE_HOME: '/var/lib/state' }, 'linux', '/home/alice'),
    '/var/lib/state/chat-on-steroids-external-orchestrator',
  );
  assert.equal(
    resolveExternalOrchestratorStateDir({}, 'darwin', '/Users/alice'),
    '/Users/alice/Library/Application Support/chat-on-steroids-external-orchestrator',
  );
  assert.equal(
    resolveExternalOrchestratorStateDir({}, 'win32', 'C:\\Users\\alice'),
    'C:\\Users\\alice\\AppData\\Local\\chat-on-steroids-external-orchestrator',
  );
  assert.equal(
    resolveExternalOrchestratorStateDir({ LOCALAPPDATA: 'D:\\LocalState' }, 'win32', 'C:\\Users\\alice'),
    'D:\\LocalState\\chat-on-steroids-external-orchestrator',
  );
  assert.equal(
    resolveExternalOrchestratorStateDir({ [IDEMPOTENCY_STATE_DIR_ENV]: '/srv/eo-state' }, 'linux', '/home/alice'),
    '/srv/eo-state',
  );
  assert.throws(
    () => resolveExternalOrchestratorStateDir({ [IDEMPOTENCY_STATE_DIR_ENV]: 'relative/state' }, 'linux', '/home/alice'),
    new RegExp(`${IDEMPOTENCY_STATE_DIR_ENV} must be an absolute path`),
  );
});
