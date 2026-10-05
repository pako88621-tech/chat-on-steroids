import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { faultGate, makeTempDir, removeTempDir } from './helpers.js';

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0' },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  }
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { flushDurable, initDurableStore, resetDurableForTests } = await import('../src/main/durable.js');
const { initSecretsPath, setSecret } = await import('../src/main/secrets.js');
const {
  appendEvent,
  createSession,
  initSessionStore,
  resetSessionStoreForTests
} = await import('../src/main/session/store.js');
const goal = await import('../src/main/goal.js');

let directory: string;
let releases: Array<() => void>;

beforeEach(async () => {
  directory = await makeTempDir('cos-goal-durability-');
  releases = [];
  initConfigPath(directory);
  initDurableStore(directory);
  initSecretsPath(directory);
  initSessionStore(directory);
  goal.resetGoalStateForTests();
  const config = defaultConfig();
  await saveConfig({
    ...config,
    goal: {
      ...config.goal,
      enabled: true,
      mode: 'goal',
      backend: 'api',
      model: 'test/goal-durability'
    }
  });
  await setSecret('openRouterApiKey', 'sk-or-goal-durability-test');
});

afterEach(async () => {
  for (const release of releases) release();
  await flushDurable();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  goal.resetGoalStateForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

function decision(action: 'stop' | 'continue', reply = ''): Response {
  return Response.json({
    choices: [{ message: { content: JSON.stringify({ action, reply }) } }]
  });
}

function gateGoalReplyRenames(...ordinals: number[]) {
  const gates = ordinals.map(() => faultGate());
  const byOrdinal = new Map(ordinals.map((ordinal, index) => [ordinal, gates[index]!]));
  const rename = fs.rename.bind(fs);
  let count = 0;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (path.basename(String(to)) === goal.GOAL_REPLIES_STATE + '.json') {
      count += 1;
      const gate = byOrdinal.get(count);
      if (gate) await gate.hold();
    }
    return rename(from, to);
  });
  for (const gate of gates) releases.push(gate.release);
  return gates;
}

function rejectNextGoalReplyRename() {
  const gate = faultGate();
  const rename = fs.rename.bind(fs);
  let rejected = false;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (!rejected && path.basename(String(to)) === goal.GOAL_REPLIES_STATE + '.json') {
      rejected = true;
      await gate.hold();
      throw new Error('Goal reply commit failed');
    }
    return rename(from, to);
  });
  releases.push(gate.release);
  return gate;
}

function rejectThenGateGoalReplyRenames() {
  const failed = faultGate();
  const newer = faultGate();
  const rename = fs.rename.bind(fs);
  let count = 0;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (path.basename(String(to)) === goal.GOAL_REPLIES_STATE + '.json') {
      count += 1;
      if (count === 1) {
        await failed.hold();
        throw new Error('Older Goal reply commit failed');
      }
      if (count === 2) await newer.hold();
    }
    return rename(from, to);
  });
  releases.push(failed.release, newer.release);
  return { failed, newer };
}

async function acceptPending(conversationId: string, sessionId: string, eventSeq: number, replyId: string, turnId: string) {
  await goal.acceptGoalReplyNow({
    conversationId,
    sessionId,
    replyId,
    turnId,
    eventSeq,
    blocked: false
  });
  expect(goal.goalPendingReplyFor(conversationId)?.replyId).toBe(replyId);
}

function observe<T>(operation: Promise<T>) {
  return operation.then(
    value => ({ value, error: null as Error | null }),
    error => ({ value: undefined, error: error as Error })
  );
}

it('keeps ACK retirement non-quiescent until the handled tombstone is durable', async () => {
  const conversationId = 'goal-durability-ack';
  const session = await createSession({ conversationId });
  await appendEvent(session.id, {
    source: 'extension',
    time: Date.now(),
    kind: 'user_message',
    message: { text: 'Finish the requested work', chars: 25, truncated: false }
  });
  await acceptPending(conversationId, session.id, 1, 'reply-ack', 'turn-ack');
  vi.stubGlobal('fetch', vi.fn(async () => decision('stop')));
  goal.startGoalDraft({ conversationId, sessionId: session.id, turnId: 'turn-ack' });
  await vi.waitFor(() => expect(goal.goalViewFor(conversationId)?.stage).toBe('no-reply'));

  const commit = gateGoalReplyRenames(1)[0]!;
  const acknowledged = goal.ackGoalDraftNow(conversationId, goal.goalViewFor(conversationId)!.token);
  await commit.entered;
  expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
  expect(goal.goalDurabilityPendingFor(conversationId)).toBe(true);

  commit.release();
  await expect(acknowledged).resolves.toBe(true);
  expect(goal.goalDurabilityPendingFor(conversationId)).toBe(false);
});

it('keeps a synchronous retirement non-quiescent until its background commit lands', async () => {
  const conversationId = 'goal-durability-sync-retire';
  await acceptPending(conversationId, 'session-sync-retire', 1, 'reply-sync', 'turn-sync');
  const commit = gateGoalReplyRenames(1)[0]!;

  expect(goal.retireGoalDraftsFor(conversationId)).toBe(true);
  await commit.entered;
  expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
  expect(goal.goalDurabilityPendingFor(conversationId)).toBe(true);

  commit.release();
  await vi.waitFor(() => expect(goal.goalDurabilityPendingFor(conversationId)).toBe(false));
});

it('restores visible debt and clears the veto when an Off retirement rolls back', async () => {
  const conversationId = 'goal-durability-rollback';
  await acceptPending(conversationId, 'session-rollback', 1, 'reply-rollback', 'turn-rollback');
  const commit = rejectNextGoalReplyRename();

  const retiring = goal.setGoalReplyActiveNow(conversationId, false);
  await commit.entered;
  expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
  expect(goal.goalDurabilityPendingFor(conversationId)).toBe(true);

  commit.release();
  await expect(retiring).rejects.toThrow('Goal reply commit failed');
  expect(goal.goalPendingReplyFor(conversationId)?.replyId).toBe('reply-rollback');
  expect(goal.goalDurabilityPendingFor(conversationId)).toBe(false);
});

it('does not let an older durable completion clear a newer retirement claim', async () => {
  const conversationId = 'goal-durability-newer-race';
  await acceptPending(conversationId, 'session-newer-race', 1, 'reply-old', 'turn-old');
  const gates = gateGoalReplyRenames(1, 3);
  const olderCommit = gates[0]!;
  const newerCommit = gates[1]!;

  const olderRetirement = observe(goal.setGoalReplyActiveNow(conversationId, false));
  await olderCommit.entered;
  expect(goal.goalDurabilityPendingFor(conversationId)).toBe(true);

  const newerAcceptance = goal.acceptGoalReplyNow({
    conversationId,
    sessionId: 'session-newer-race',
    replyId: 'reply-new',
    turnId: 'turn-new',
    eventSeq: 2,
    blocked: false
  });
  await vi.waitFor(() => expect(goal.goalPendingReplyFor(conversationId)?.replyId).toBe('reply-new'));
  expect(goal.retireGoalDraftsFor(conversationId)).toBe(true);
  expect(goal.goalPendingReplyFor(conversationId)).toBeNull();

  olderCommit.release();
  await newerCommit.entered;
  expect((await olderRetirement).value).toBe(true);
  await expect(newerAcceptance).resolves.toBeUndefined();
  expect(goal.goalDurabilityPendingFor(conversationId)).toBe(true);

  newerCommit.release();
  await vi.waitFor(() => expect(goal.goalDurabilityPendingFor(conversationId)).toBe(false));
});

it('keeps a failed retirement veto until a newer handled projection commits', async () => {
  const conversationId = 'goal-durability-failed-newer';
  await acceptPending(conversationId, 'session-failed-newer', 1, 'reply-old', 'turn-old');
  const commits = rejectThenGateGoalReplyRenames();

  const olderRetirement = observe(goal.setGoalReplyActiveNow(conversationId, false));
  await commits.failed.entered;
  expect(goal.goalDurabilityPendingFor(conversationId)).toBe(true);

  const newerChange = goal.acceptGoalReplyNow({
    conversationId,
    sessionId: 'session-failed-newer',
    replyId: 'reply-new',
    turnId: 'turn-new',
    eventSeq: 2,
    blocked: true
  });
  await vi.waitFor(() => {
    expect(goal.snapshotGoalReplies().replies).toContainEqual(
      expect.objectContaining({ conversationId, replyId: 'reply-new', state: 'handled' })
    );
  });

  commits.failed.release();
  await commits.newer.entered;
  expect((await olderRetirement).error?.message).toBe('Older Goal reply commit failed');
  expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
  expect(goal.goalDurabilityPendingFor(conversationId)).toBe(true);

  commits.newer.release();
  await expect(newerChange).resolves.toBeUndefined();
  expect(goal.goalDurabilityPendingFor(conversationId)).toBe(false);
});

it('publishes a Goal invalidation after a newly pending reply is durably visible', async () => {
  const conversationId = 'goal-addition-notify';
  const observed: string[] = [];
  const unsubscribe = goal.onGoalChange(() => {
    observed.push(goal.goalPendingReplyFor(conversationId)?.replyId ?? 'none');
  });
  try {
    await acceptPending(conversationId, 'session-addition-notify', 1, 'reply-addition', 'turn-addition');
    expect(observed).toContain('reply-addition');
  } finally {
    unsubscribe();
  }
});

it('publishes a Goal invalidation when a handled reply is deliberately re-armed', async () => {
  const conversationId = 'goal-rearm-notify';
  await acceptPending(conversationId, 'session-rearm-notify', 1, 'reply-rearm', 'turn-rearm');
  await expect(goal.setGoalReplyActiveNow(conversationId, false)).resolves.toBe(true);
  expect(goal.goalPendingReplyFor(conversationId)).toBeNull();

  const observed: string[] = [];
  const unsubscribe = goal.onGoalChange(() => {
    observed.push(goal.goalPendingReplyFor(conversationId)?.replyId ?? 'none');
  });
  try {
    await expect(goal.setGoalReplyActiveNow(conversationId, true)).resolves.toBe(true);
    expect(observed).toContain('reply-rearm');
  } finally {
    unsubscribe();
  }
});

it('publishes a Goal invalidation when a prepared draft reservation is discarded', () => {
  const conversationId = 'goal-discard-notify';
  const draft = goal.startGoalDraft({
    conversationId,
    sessionId: 'session-discard-notify',
    turnId: 'turn-discard-notify',
    deferStart: true
  });
  const observed: boolean[] = [];
  const unsubscribe = goal.onGoalChange(() => observed.push(goal.goalDraftBusy(conversationId)));
  try {
    expect(goal.discardPreparedGoalDraft(conversationId, draft.token)).toBe(true);
    expect(goal.goalDraftBusy(conversationId)).toBe(false);
    expect(observed).toContain(false);
  } finally {
    unsubscribe();
  }
});

it('publishes a Goal invalidation when reply activation retires an in-flight draft', async () => {
  const conversationId = 'goal-active-retire-notify';
  goal.startGoalDraft({
    conversationId,
    sessionId: 'session-active-retire-notify',
    turnId: 'turn-active-retire-notify',
    deferStart: true
  });
  const observed: boolean[] = [];
  const unsubscribe = goal.onGoalChange(() => observed.push(goal.goalDraftBusy(conversationId)));
  try {
    await expect(goal.setGoalReplyActiveNow(conversationId, false)).resolves.toBe(true);
    expect(goal.goalDraftBusy(conversationId)).toBe(false);
    expect(observed).toContain(false);
  } finally {
    unsubscribe();
  }
});

it('publishes a Goal invalidation when settings retirement clears active drafts', () => {
  const conversationId = 'goal-retire-all-notify';
  goal.startGoalDraft({
    conversationId,
    sessionId: 'session-retire-all-notify',
    turnId: 'turn-retire-all-notify',
    deferStart: true
  });
  const observed: boolean[] = [];
  const unsubscribe = goal.onGoalChange(() => observed.push(goal.goalDraftBusy(conversationId)));
  try {
    expect(goal.retireGoalDrafts()).toBe(1);
    expect(goal.goalDraftBusy(conversationId)).toBe(false);
    expect(observed).toContain(false);
  } finally {
    unsubscribe();
  }
});

it('projects the exact pending Goal TTL as a Core-owned deadline', async () => {
  const conversationId = 'goal-expiry-deadline';
  await acceptPending(conversationId, 'session-expiry-deadline', 1, 'reply-expiry', 'turn-expiry');
  const pending = goal.goalPendingReplyFor(conversationId);
  expect(pending).not.toBeNull();
  const expected = pending!.acceptedAt + 12 * 60 * 60_000;
  expect(goal.goalPendingReplyDeadlineFor(conversationId, pending!.acceptedAt)).toBe(expected);
  expect(goal.goalPendingReplyDeadlineFor(conversationId, expected - 1)).toBe(expected);
  expect(goal.goalPendingReplyDeadlineFor(conversationId, expected)).toBeNull();
});
