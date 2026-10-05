/**
 * Root contract for the standalone External Orchestrator against the real Local Control API.
 *
 * This keeps Core's session/read-model/outbox owners in process and crosses the same loopback HTTP
 * publication that the standalone connector discovers in production. Only effects that would leave
 * the test process (browser/tunnel) and the browser-native Stop executor are replaced, matching the
 * isolation boundary used by control-api-actions.test.ts.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

const gate = vi.hoisted(() => ({ actions: true, enabled: true }));

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '', getVersion: vi.fn(() => '0.0.0'), getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  BrowserWindow: class {},
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => '') },
  nativeTheme: { themeSource: 'system' }
}));

vi.mock('../src/main/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/config.js')>();
  return { ...actual, getConfig: () => ({ ...actual.getConfig(), controlApi: { enabled: gate.enabled, allowActions: gate.actions } }) };
});

vi.mock('../src/main/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/connection.js')>();
  return {
    ...actual,
    connect: vi.fn(async () => undefined),
    getStatus: () => ({ ...actual.getStatus(), state: 'connected' as const }),
    onStatusChange: () => () => undefined
  };
});

vi.mock('../src/main/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/bridge.js')>();
  return {
    ...actual,
    startBridge: vi.fn(async () => true),
    // Browser-native durable Stop is covered at its owner in bridge.test.ts. This root contract
    // verifies EO's exact-turn fence and that an accepted Stop crosses the real Local Control route.
    stopSessionTurn: vi.fn(async (sessionId: string, expectedTurnId: string) => ({
      sessionId,
      activeTurnId: expectedTurnId,
      stopPending: true
    }) as Awaited<ReturnType<typeof actual.stopSessionTurn>>)
  };
});

vi.mock('../src/main/browser-startup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/browser-startup.js')>();
  return { ...actual, wakeBrowserUrl: vi.fn(async () => undefined) };
});

const { initConfigPath } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const { flushDurable, initDurableStore, resetDurableForTests, writeDurableNow } = await import('../src/main/durable.js');
const { appendEvent, createSession, initSessionStore, observeSessionModel, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { notifyChanged } = await import('../src/main/session/recorder.js');
const input = await import('../src/main/session/input.js');
const startInput = await import('../src/main/session/start-input.js');
const bridge = await import('../src/main/bridge.js');
const controlApi = await import('../src/main/control-api.js');
const coreContract = await import('../src/shared/control-api.js');
const { ControlClient } = await import('../plugins/external-orchestrator/src/control-client.js');
const { CONTROL_API_PROTOCOL: EO_CONTROL_API_PROTOCOL } = await import('../plugins/external-orchestrator/src/config.js');
const { deterministicInputId } = await import('../plugins/external-orchestrator/src/idempotency.js');
const { ExternalOrchestratorService, formatStartText, formatSteerText } = await import('../plugins/external-orchestrator/src/orchestrator-service.js');
const { SessionSelector } = await import('../plugins/external-orchestrator/src/session-selector.js');

let dir: string;
let idempotencyDir: string;
let services: InstanceType<typeof ExternalOrchestratorService>[] = [];

function makeClient(): InstanceType<typeof ControlClient> {
  const controlDir = path.join(dir, 'control-api');
  return new ControlClient({
    userDataDir: dir,
    endpointFile: path.join(controlDir, 'endpoint.json'),
    tokenFile: path.join(controlDir, 'token'),
    supportedControlApiProtocols: [EO_CONTROL_API_PROTOCOL]
  });
}

function makeService(client = makeClient(), selector?: InstanceType<typeof SessionSelector>): InstanceType<typeof ExternalOrchestratorService> {
  const service = new ExternalOrchestratorService({
    client,
    ...(selector ? { selector } : {}),
    idempotency: { stateDir: idempotencyDir, heartbeatMs: 0, staleAfterMs: 1_000 }
  });
  services.push(service);
  return service;
}

async function restartControlApi(): Promise<void> {
  await controlApi.stopControlApi();
  await controlApi.startControlApi();
}

async function makeSession(title: string, conversationId: string | null, origin?: object): Promise<string> {
  return (await createSession({ title, conversationId, ...(origin ? { origin: origin as never } : {}) })).id;
}

async function answeringSession(title: string, conversationId: string, turnId: string): Promise<string> {
  const id = await makeSession(title, conversationId);
  await observeSessionModel(id, conversationId, 'gpt-5.6-sol', Date.now());
  await appendEvent(id, { kind: 'turn_start', source: 'extension', time: Date.now(), turnId });
  return id;
}

async function seedInputs(rows: object[]): Promise<void> {
  await writeDurableNow('session-input', rows);
  input.resetInputForTests();
}

beforeAll(async () => {
  dir = await makeTempDir('clf-eo-contract-');
  idempotencyDir = path.join(dir, 'external-orchestrator-state');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  controlApi.initControlApiPath(dir);
});

beforeEach(async () => {
  gate.enabled = true;
  gate.actions = true;
  startInput.resetInputStartupForTests();
  controlApi.setActionLimitsForTests({});
  await seedInputs([]);
  await fs.rm(idempotencyDir, { recursive: true, force: true });
  vi.mocked(bridge.stopSessionTurn).mockClear();
  await restartControlApi();
});

afterEach(async () => {
  const current = services;
  services = [];
  await Promise.all(current.map((service) => service.close()));
  await fs.rm(idempotencyDir, { recursive: true, force: true });
});

afterAll(async () => {
  await controlApi.shutdownControlApi();
  startInput.resetInputStartupForTests();
  await flushDurable();
  input.resetInputForTests();
  resetDurableForTests();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

describe('External Orchestrator ↔ real Local Control API contract', () => {
  it('discovers protocol/routes including Stop and reports only an eligible Prime session', async () => {
    const prime = await makeSession('EO Prime', 'chat-eo-prime');
    const worker = await makeSession('EO worker', 'chat-eo-worker', {
      kind: 'worker', fromSessionId: prime, agentId: 'worker-1', task: 'worker task'
    });
    const helper = await makeSession('EO helper', 'chat-eo-helper', {
      kind: 'helper', fromSessionId: prime, agentId: null, task: ''
    });
    const client = makeClient();
    const health = await client.health();

    expect(health.protocol).toBe(coreContract.CONTROL_API_PROTOCOL);
    expect(health.routes).toEqual(coreContract.CONTROL_API_ROUTES);
    expect(health.actions).toEqual({
      enabled: true,
      routes: coreContract.CONTROL_API_ACTION_ROUTES,
      features: coreContract.CONTROL_API_ACTION_FEATURES
    });
    expect(health.actions.routes).toContain('POST /v1/sessions/{id}/stop');

    const service = makeService(client);
    const status = await service.orchestrate({ action: 'status', session_id: prime });
    expect(status).toMatchObject({ ok: true, session_id: prime, state: 'idle', actions_enabled: true });
    expect(status.error).toBeUndefined();

    for (const sessionId of [worker, helper]) {
      const refused = await service.orchestrate({ action: 'status', session_id: sessionId });
      expect(refused.ok).toBe(false);
      expect(refused.error?.code).toBe('session_ineligible');
    }
  });

  it('creates one deterministic durable input and exact replay creates no duplicate', async () => {
    const prime = await makeSession('EO start', 'chat-eo-start');
    const client = makeClient();
    const service = makeService(client);
    const requestId = 'contract-start-001';
    const request = {
      action: 'start' as const,
      objective: 'Run the focused checks.',
      constraints: ['Keep the change scoped.'],
      session_id: prime,
      request_id: requestId,
      interrupt: false
    };

    const first = await service.orchestrate(request);
    const expectedId = deterministicInputId(requestId);
    expect(first).toMatchObject({ ok: true, session_id: prime, input_id: expectedId, delivery: 'pending' });
    let rows = await input.listInputs();
    expect(rows.filter((row) => row.id === expectedId)).toHaveLength(1);
    expect(rows.find((row) => row.id === expectedId)).toMatchObject({
      sessionId: prime,
      text: formatStartText(request.objective, request.constraints),
      state: 'queued'
    });

    const sends = vi.spyOn(startInput, 'sendDesktopInput');
    try {
      const replay = await service.orchestrate(request);
      expect(replay).toMatchObject({ ok: true, session_id: prime, input_id: expectedId });
      expect(sends).not.toHaveBeenCalled();
    } finally {
      sends.mockRestore();
    }
    rows = await input.listInputs();
    expect(rows.filter((row) => row.id === expectedId)).toHaveLength(1);
  });

  it('refuses implicit interruption and admits a distinct explicit interrupt request', async () => {
    const prime = await answeringSession('EO answering', 'chat-eo-answering', 'turn-live');
    const service = makeService();

    const refused = await service.orchestrate({
      action: 'start', objective: 'Change direction.', constraints: [], session_id: prime,
      request_id: 'contract-interrupt-refused', interrupt: false
    });
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('would_interrupt');
    expect(await input.listInputs()).toEqual([]);

    const allowed = await service.orchestrate({
      action: 'start', objective: 'Change direction.', constraints: [], session_id: prime,
      request_id: 'contract-interrupt-explicit', interrupt: true
    });
    expect(allowed).toMatchObject({ ok: true, session_id: prime, input_id: deterministicInputId('contract-interrupt-explicit') });
    expect(await input.listInputs()).toHaveLength(1);
    expect((await input.listInputs())[0]).toMatchObject({ directTurn: { id: 'turn-live' } });
  });

  it('steers through the real durable outbox with EO framing', async () => {
    const prime = await makeSession('EO steer', 'chat-eo-steer');
    const service = makeService();
    const requestId = 'contract-steer-001';
    const instruction = 'Inspect the failing contract before changing anything.';

    const result = await service.orchestrate({
      action: 'steer', instruction, session_id: prime, request_id: requestId, interrupt: false
    });
    expect(result).toMatchObject({ ok: true, session_id: prime, input_id: deterministicInputId(requestId), delivery: 'pending' });
    expect(await input.listInputs()).toEqual([
      expect.objectContaining({
        id: deterministicInputId(requestId),
        sessionId: prime,
        text: formatSteerText(instruction),
        state: 'queued'
      })
    ]);
  });

  it('cancels an EO-owned pending input while leaving a foreign Core input untouched', async () => {
    const ownedSession = await makeSession('EO owned cancel', 'chat-eo-owned-cancel');
    const foreignSession = await makeSession('EO foreign cancel', 'chat-eo-foreign-cancel');
    const client = makeClient();
    const service = makeService(client);
    const requestId = 'contract-owned-cancel';
    const ownedId = deterministicInputId(requestId);

    expect((await service.orchestrate({
      action: 'start', objective: 'Queue owned work.', constraints: [], session_id: ownedSession,
      request_id: requestId, interrupt: false
    })).ok).toBe(true);

    const foreignId = randomUUID();
    const foreign = await client.post('/v1/inputs', {
      id: foreignId, sessionId: foreignSession, text: 'Foreign pending input', interrupt: false
    });
    expect(foreign.status).toBe(202);

    const cancelled = await service.orchestrate({ action: 'cancel', session_id: ownedSession, request_id: requestId });
    expect(cancelled).toMatchObject({ ok: true, session_id: ownedSession, input_id: ownedId, delivery: 'not_sent' });
    const rows = await input.listInputs();
    expect(rows.find((row) => row.id === ownedId)).toMatchObject({ state: 'cancelled' });
    expect(rows.find((row) => row.id === foreignId)).toMatchObject({ state: 'queued', sessionId: foreignSession });
  });

  it('fences stale Stop locally and sends the exact active turn through the real Stop route', async () => {
    const prime = await answeringSession('EO stop', 'chat-eo-stop', 'turn-stop');
    const client = makeClient();

    // A signed browser page is the real owner of the process-local live-turn observation. The root
    // suite does not create one, so inject only that live snapshot into EO selection; health, session
    // identity, and the Stop POST still travel through the real ControlClient/Local Control listener.
    const selector = new SessionSelector({
      listSessions: (options) => client.listSessions(options),
      getSession: async (sessionId, options) => {
        const detail = await client.getSession(sessionId, options);
        if (!detail || sessionId !== prime) return detail;
        return {
          ...detail,
          live: {
            activeTurnId: 'turn-stop',
            blocked: detail.live?.blocked ?? ''
          }
        };
      }
    });
    const service = makeService(client, selector);

    const stale = await service.orchestrate({ action: 'stop', session_id: prime, expected_turn_id: 'turn-stale' });
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe('active_turn_changed');
    expect(bridge.stopSessionTurn).not.toHaveBeenCalled();

    const exact = await service.orchestrate({ action: 'stop', session_id: prime, expected_turn_id: 'turn-stop' });
    expect(exact).toMatchObject({ ok: true, session_id: prime, active_turn_id: 'turn-stop', state: 'working' });
    expect(bridge.stopSessionTurn).toHaveBeenCalledTimes(1);
    expect(bridge.stopSessionTurn).toHaveBeenCalledWith(prime, 'turn-stop');
  });

  it('recovers a read after endpoint/token rotation without replacing the ControlClient', async () => {
    const client = makeClient();
    await client.health();
    expect((await client.listInputs()).inputs).toEqual([]);
    const beforeEpoch = client.currentEpoch();
    const beforeToken = (await fs.readFile(path.join(dir, 'control-api', 'token'), 'utf8')).trim();

    await restartControlApi();
    const afterToken = (await fs.readFile(path.join(dir, 'control-api', 'token'), 'utf8')).trim();
    expect(afterToken).not.toBe(beforeToken);

    // listInputs starts from the cached old publication. It must rediscover once on reset/401.
    expect((await client.listInputs()).inputs).toEqual([]);
    const afterEpoch = client.currentEpoch();
    expect(afterEpoch).not.toBeNull();
    expect(afterEpoch).not.toEqual(beforeEpoch);
    expect(afterEpoch?.tokenFingerprint).not.toBe(beforeEpoch?.tokenFingerprint);
  });

  it('distinguishes a running ambiguous action from a queued action that provably never started', async () => {
    const firstSession = await makeSession('EO ambiguous running', 'chat-eo-ambiguous-running');
    const secondSession = await makeSession('EO prestart retry', 'chat-eo-prestart-retry');
    const service = makeService();
    controlApi.setActionLimitsForTests({ deadlineMs: 120 });

    const real = startInput.sendDesktopInput;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const sends = vi.spyOn(startInput, 'sendDesktopInput').mockImplementation(async (args, options) => {
      if (args.sessionId === firstSession) await held;
      return real(args, options);
    });
    try {
      const firstRequest = {
        action: 'start' as const,
        objective: 'Running request.',
        constraints: [] as string[],
        session_id: firstSession,
        request_id: 'contract-ambiguous-running',
        interrupt: false
      };
      const secondRequest = {
        action: 'start' as const,
        objective: 'Queued request.',
        constraints: [] as string[],
        session_id: secondSession,
        request_id: 'contract-prestart-safe',
        interrupt: false
      };

      const runningPromise = service.orchestrate(firstRequest);
      await vi.waitFor(() => expect(sends).toHaveBeenCalledTimes(1));
      const queuedPromise = service.orchestrate(secondRequest);
      const [running, queued] = await Promise.all([runningPromise, queuedPromise]);

      expect(running).toMatchObject({ ok: false, error: { code: 'delivery_unknown' } });
      expect(queued).toMatchObject({ ok: false, error: { code: 'busy' } });
      expect(sends).toHaveBeenCalledTimes(1);
      expect((await input.listInputs()).find((row) => row.id === deterministicInputId(secondRequest.request_id))).toBeUndefined();

      release();
      await vi.waitFor(async () => {
        expect((await input.listInputs()).find((row) => row.id === deterministicInputId(firstRequest.request_id))).toBeDefined();
      });

      // The ambiguous request is reconciled by the same UUID against Core; it is not sent twice.
      const reconciled = await service.orchestrate(firstRequest);
      expect(reconciled.ok).toBe(true);
      expect(sends).toHaveBeenCalledTimes(1);

      // The pre-start request gets exactly one explicit retry using its original deterministic UUID.
      const retried = await service.orchestrate(secondRequest);
      expect(retried.ok).toBe(true);
      expect(retried.input_id).toBe(deterministicInputId(secondRequest.request_id));
      expect(sends).toHaveBeenCalledTimes(2);
      expect((await input.listInputs()).filter((row) => row.id === deterministicInputId(secondRequest.request_id))).toHaveLength(1);
    } finally {
      release();
      sends.mockRestore();
      controlApi.setActionLimitsForTests({});
    }
  });

  it('preserves accepted request ownership across an EO service restart without a duplicate send', async () => {
    const prime = await makeSession('EO restart ownership', 'chat-eo-restart-ownership');
    const requestId = 'contract-restart-owned';
    const request = {
      action: 'start' as const,
      objective: 'Run once across connector restart.',
      constraints: [] as string[],
      session_id: prime,
      request_id: requestId,
      interrupt: false
    };
    const firstService = makeService();
    expect((await firstService.orchestrate(request)).ok).toBe(true);
    expect((await input.listInputs()).filter((row) => row.id === deterministicInputId(requestId))).toHaveLength(1);
    await firstService.close();

    const sends = vi.spyOn(startInput, 'sendDesktopInput');
    try {
      const secondService = makeService();
      const replay = await secondService.orchestrate(request);
      expect(replay).toMatchObject({ ok: true, input_id: deterministicInputId(requestId) });
      expect(sends).not.toHaveBeenCalled();
      expect((await input.listInputs()).filter((row) => row.id === deterministicInputId(requestId))).toHaveLength(1);
    } finally {
      sends.mockRestore();
    }
  });

  it('allows only one mutation controller process-equivalent owner at a time and recovers after release', async () => {
    const ownerSession = await makeSession('EO controller owner', 'chat-eo-controller-owner');
    const blockedSession = await makeSession('EO controller blocked', 'chat-eo-controller-blocked');
    const owner = makeService();
    const contender = makeService();

    expect((await owner.orchestrate({
      action: 'start', objective: 'Own controller.', constraints: [], session_id: ownerSession,
      request_id: 'contract-controller-owner', interrupt: false
    })).ok).toBe(true);

    const blocked = await contender.orchestrate({
      action: 'start', objective: 'Wait for controller.', constraints: [], session_id: blockedSession,
      request_id: 'contract-controller-contender', interrupt: false
    });
    expect(blocked).toMatchObject({ ok: false, error: { code: 'controller_busy' } });
    expect((await input.listInputs()).some((row) => row.id === deterministicInputId('contract-controller-contender'))).toBe(false);

    await owner.close();
    const admitted = await contender.orchestrate({
      action: 'start', objective: 'Wait for controller.', constraints: [], session_id: blockedSession,
      request_id: 'contract-controller-contender', interrupt: false
    });
    expect(admitted).toMatchObject({ ok: true, input_id: deterministicInputId('contract-controller-contender') });
  });

  it('reads real recorder evidence and wait follows the next sequence cursor without a Core watcher', async () => {
    const prime = await makeSession('EO evidence', 'chat-eo-evidence');
    await appendEvent(prime, {
      kind: 'note', source: 'app', time: Date.now(),
      message: { text: 'First evidence', chars: 14, truncated: false }
    });
    const service = makeService();
    const evidence = await service.evidence({ session_id: prime, cursor: 0, limit: 40, level: 'summary' });
    expect(evidence.ok).toBe(true);
    expect(evidence.items.some((item) => item.summary.includes('First evidence'))).toBe(true);
    const cursor = evidence.cursor;

    const waiting = service.orchestrate({ action: 'wait', session_id: prime, cursor, wait_ms: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await appendEvent(prime, {
      kind: 'note', source: 'app', time: Date.now() + 1,
      message: { text: 'Second evidence', chars: 15, truncated: false }
    });
    const result = await waiting;
    expect(result).toMatchObject({ ok: true, session_id: prime });
    expect(result.cursor).toBeGreaterThan(cursor);
    expect(result.summary).toContain('Second evidence');
  });

  it('holds a real semantic terminal wait on /v1/changes and returns only after Core becomes quiescent', async () => {
    const turnId = 'turn-semantic-terminal';
    const prime = await answeringSession('EO semantic terminal', 'chat-eo-semantic-terminal', turnId);
    const service = makeService();
    const waiting = service.orchestrate({
      action: 'wait', until: 'terminal', session_id: prime, transport_lease_ms: 5_000
    });
    await new Promise(resolve => setTimeout(resolve, 100));

    await appendEvent(prime, {
      kind: 'assistant_message', source: 'extension', time: Date.now(), turnId,
      messageId: 'semantic-final', message: { text: 'Finished.', chars: 9, truncated: false },
      final: true, state: 'final'
    });
    await appendEvent(prime, {
      kind: 'turn_end', source: 'extension', time: Date.now() + 1, turnId, outcome: 'completed'
    });
    notifyChanged(prime);

    const result = await waiting;
    expect(result).toMatchObject({
      ok: true,
      session_id: prime,
      wake_reason: 'completed',
      state: 'idle'
    });
  });

  it('keeps a semantic wait alive across Local Control token/port restart and completes on the new generation', async () => {
    const turnId = 'turn-semantic-restart';
    const prime = await answeringSession('EO semantic restart', 'chat-eo-semantic-restart', turnId);
    const service = makeService();
    const waiting = service.orchestrate({
      action: 'wait', until: 'attention', session_id: prime, transport_lease_ms: 8_000
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    await restartControlApi();
    await new Promise(resolve => setTimeout(resolve, 100));

    await appendEvent(prime, {
      kind: 'assistant_message', source: 'extension', time: Date.now(), turnId,
      messageId: 'restart-final', message: { text: 'Restart-safe final.', chars: 19, truncated: false },
      final: true, state: 'final'
    });
    await appendEvent(prime, {
      kind: 'turn_end', source: 'extension', time: Date.now() + 1, turnId, outcome: 'completed'
    });
    notifyChanged(prime);

    const result = await waiting;
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, session_id: prime, wake_reason: 'completed' });
  });

  it('does not replay an accepted ledger entry after Core outbox history no longer contains it', async () => {
    const prime = await makeSession('EO pruned history', 'chat-eo-pruned-history');
    const service = makeService();
    const requestId = 'contract-pruned-accepted';
    const request = {
      action: 'start' as const,
      objective: 'Run once.',
      constraints: [] as string[],
      session_id: prime,
      request_id: requestId,
      interrupt: false
    };
    const first = await service.orchestrate(request);
    expect(first.ok).toBe(true);
    expect(first.input_id).toBe(deterministicInputId(requestId));

    // Simulate bounded Core history pruning while EO retains its durable accepted ownership record.
    await seedInputs([]);
    const sends = vi.spyOn(startInput, 'sendDesktopInput');
    try {
      const replay = await service.orchestrate(request);
      expect(replay.ok).toBe(false);
      expect(replay.error?.code).toBe('delivery_unknown');
      expect(replay.input_id).toBe(deterministicInputId(requestId));
      expect(sends).not.toHaveBeenCalled();
      expect(await input.listInputs()).toEqual([]);
    } finally {
      sends.mockRestore();
    }
  });
});
