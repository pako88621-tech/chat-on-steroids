import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ControlClientError,
  type ControlHealthSnapshot,
  type ControlHttpResponse,
  type ControlInputDto,
  type ControlInputsPageDto,
  type ControlRequestOptions,
} from '../control-client.js';
import {
  IDEMPOTENCY_SCHEMA_VERSION,
  IdempotencyError,
  canonicalPayloadHash,
  deterministicInputId,
  requestIdHash,
  type IdempotencyRecord,
  type IdempotencyReservation,
  type IdempotencyReservationRequest,
} from '../idempotency.js';
import {
  ExternalOrchestratorService,
  formatStartText,
  formatSteerText,
} from '../orchestrator-service.js';
import { externalOrchestrateRequestSchema } from '../protocol.js';
import type {
  SessionSelectionDetail,
  SessionSelectionPage,
} from '../session-selector.js';

const SESSION_ID = 'session-12345678';
const OTHER_SESSION_ID = 'session-87654321';
const TURN_ID = 'turn-12345678';
const PROJECT_ID = 'project-alpha';
const TOKEN = 'current-control-token-1234567890';
const HOST_PATH = '/Users/alice/Library/Application Support/chat-on-steroids/control-api/token';

function health(actionsEnabled = true): ControlHealthSnapshot {
  return {
    ok: true,
    protocol: 1,
    routes: ['/v1/health', '/v1/status', '/v1/sessions', '/v1/sessions/{id}', '/v1/sessions/{id}/events', '/v1/inputs'],
    actions: {
      enabled: actionsEnabled,
      routes: ['POST /v1/inputs', 'POST /v1/inputs/{id}/cancel', 'POST /v1/sessions/{id}/stop'],
      features: ['input_expected_conversation'],
    },
    pid: 4242,
    appVersion: '2.1.26',
    startedAt: '2026-10-04T13:00:00.000Z',
    uptimeSeconds: 60,
    epoch: {
      protocol: 1,
      port: 48123,
      pid: 4242,
      tokenFingerprint: 'token-fingerprint',
      publicationFingerprint: 'publication-fingerprint',
    },
  };
}

function response<T>(status: number, body: T, ambiguous = false): ControlHttpResponse<T> {
  return {
    status,
    body,
    retryAfterMs: null,
    epoch: health().epoch,
    ambiguous,
  };
}

function input(id: string, options: Partial<ControlInputDto> = {}): ControlInputDto {
  return {
    id,
    sessionId: SESSION_ID,
    deliveredSessionId: null,
    conversationId: 'conversation-1',
    state: 'pending',
    delivery: 'pending',
    automatic: false,
    purpose: 'external_orchestrator',
    createdAt: 100,
    dueAt: 101,
    sendAuthorizedAt: null,
    text: { text: 'queued', chars: 6, truncated: false },
    ...options,
  };
}

function proofForInput(value: ControlInputDto): string {
  return canonicalPayloadHash({
    id: value.id,
    sessionId: value.sessionId,
    conversationId: value.conversationId,
    createdAt: value.createdAt,
    dueAt: value.dueAt,
  });
}

type PostCall = { path: string; body: unknown; options?: ControlRequestOptions };

class FakeClient {
  healthSnapshot = health();
  detail: SessionSelectionDetail = {
    session: {
      id: SESSION_ID,
      conversationId: 'conversation-1',
      projectId: PROJECT_ID,
      updatedAt: 100,
      endedAt: null,
      origin: { kind: 'prime' },
    },
    live: { activeTurnId: null, blocked: '' },
  };
  inputs: ControlInputDto[] = [];
  nextFrom = 17;
  tokens: string[] = [TOKEN];
  postQueue: Array<ControlHttpResponse<unknown> | Error> = [];
  postCalls: PostCall[] = [];
  beforePost: (() => void) | null = null;
  healthCalls = 0;
  sessionReads = 0;
  inputReads = 0;

  async health(): Promise<ControlHealthSnapshot> {
    this.healthCalls += 1;
    return this.healthSnapshot;
  }

  sanitizationTokens(): readonly string[] {
    return this.tokens;
  }

  async listSessions(_options: { limit: number; cursor?: string }): Promise<SessionSelectionPage> {
    return {
      sessions: [this.detail.session],
      nextCursor: null,
      activeId: this.detail.session.id,
    };
  }

  async getSession(sessionId: string, _options: { live: true }): Promise<SessionSelectionDetail | null> {
    this.sessionReads += 1;
    return sessionId === this.detail.session.id ? this.detail : null;
  }

  async listInputs(_options?: { state?: readonly string[]; limit?: number }): Promise<ControlInputsPageDto> {
    this.inputReads += 1;
    return { inputs: [...this.inputs], total: this.inputs.length };
  }

  async readEvents(
    _sessionId: string,
    _options?: { from?: number; before?: number; after?: number; limit?: number; kinds?: readonly string[] },
  ): Promise<{ events: unknown[]; total: number; nextFrom: number }> {
    return { events: [], total: 0, nextFrom: this.nextFrom };
  }

  async get<T = unknown>(_path: string, _options?: ControlRequestOptions): Promise<ControlHttpResponse<T>> {
    throw new Error('unexpected GET');
  }

  async post<T = unknown>(path: string, body: unknown, options?: ControlRequestOptions): Promise<ControlHttpResponse<T>> {
    this.beforePost?.();
    this.postCalls.push({ path, body, options });
    const next = this.postQueue.shift() ?? response(202, { ok: true });
    if (next instanceof Error) throw next;
    return next as ControlHttpResponse<T>;
  }
}

interface ControllerEntry {
  requestId: string;
  record: IdempotencyRecord;
}

function recordFor(
  requestId: string,
  options: {
    sessionId?: string;
    kind?: 'start' | 'steer';
    payload?: unknown;
    state?: IdempotencyRecord['state'];
  } = {},
): IdempotencyRecord {
  const state = options.state ?? 'reserved';
  const record: IdempotencyRecord = {
    schemaVersion: IDEMPOTENCY_SCHEMA_VERSION,
    requestHash: requestIdHash(requestId),
    inputId: deterministicInputId(requestId),
    sessionId: options.sessionId ?? SESSION_ID,
    payloadHash: canonicalPayloadHash(options.payload ?? { text: 'payload', interrupt: false, expectedConversationId: 'conversation-1' }),
    kind: options.kind ?? 'start',
    state,
    reservedAt: 10,
    updatedAt: 10,
  };
  if (state === 'accepted') {
    record.acceptedAt = 10;
    record.inputProofHash = proofForInput(input(record.inputId, {
      sessionId: record.sessionId,
      conversationId: 'conversation-1',
    }));
  }
  return record;
}

class FakeController {
  readonly entries = new Map<string, ControllerEntry>();
  reserveCalls: IdempotencyReservationRequest[] = [];
  acceptedCalls: IdempotencyReservation[] = [];
  retrySafeCalls: IdempotencyReservation[] = [];
  notSentCalls: IdempotencyReservation[] = [];
  conflictCalls: IdempotencyReservation[] = [];
  attemptingCalls: IdempotencyReservation[] = [];
  assertOwnedCalls = 0;
  assertOwnedError: Error | null = null;
  failAssertAtCall: number | null = null;
  lookupCalls: string[] = [];
  releaseCalls = 0;

  seed(requestId: string, record: IdempotencyRecord): void {
    this.entries.set(requestId, { requestId, record });
  }

  async lookup(requestId: string): Promise<IdempotencyRecord | null> {
    this.lookupCalls.push(requestId);
    return this.entries.get(requestId)?.record ?? null;
  }

  async reserve(request: IdempotencyReservationRequest): Promise<IdempotencyReservation> {
    this.reserveCalls.push(request);
    const existing = this.entries.get(request.requestId);
    const expectedInputId = deterministicInputId(request.requestId);
    const expectedPayloadHash = canonicalPayloadHash(request.payload);
    if (existing) {
      if (existing.record.inputId !== expectedInputId
        || existing.record.sessionId !== request.sessionId
        || existing.record.kind !== request.kind
        || existing.record.payloadHash !== expectedPayloadHash) {
        throw new IdempotencyError('duplicate_request_conflict', 'request_id is already bound to a different external mutation.');
      }
      return { record: existing.record, replayed: true };
    }
    const created = recordFor(request.requestId, {
      sessionId: request.sessionId,
      kind: request.kind,
      payload: request.payload,
      state: 'reserved',
    });
    this.seed(request.requestId, created);
    return { record: created, replayed: false };
  }

  async markAccepted(reservation: IdempotencyReservation, inputProofHash?: string): Promise<IdempotencyRecord> {
    this.acceptedCalls.push(reservation);
    const entry = [...this.entries.values()].find((candidate) => candidate.record.requestHash === reservation.record.requestHash);
    if (entry?.record.state === 'accepted' && inputProofHash && entry.record.inputProofHash && entry.record.inputProofHash !== inputProofHash) {
      throw new IdempotencyError('duplicate_request_conflict', 'different Core input instance');
    }
    const accepted: IdempotencyRecord = {
      ...(entry?.record ?? reservation.record),
      state: 'accepted',
      updatedAt: 11,
      acceptedAt: entry?.record.acceptedAt ?? 11,
      ...(inputProofHash === undefined ? {} : { inputProofHash }),
    };
    if (entry) entry.record = accepted;
    return accepted;
  }

  async markRetrySafe(reservation: IdempotencyReservation): Promise<IdempotencyRecord> {
    this.retrySafeCalls.push(reservation);
    const retrySafe: IdempotencyRecord = { ...reservation.record, state: 'retry_safe', updatedAt: 11 };
    const entry = [...this.entries.values()].find((candidate) => candidate.record.requestHash === reservation.record.requestHash);
    if (entry) entry.record = retrySafe;
    return retrySafe;
  }

  async markNotSent(reservation: IdempotencyReservation): Promise<IdempotencyRecord> {
    this.notSentCalls.push(reservation);
    const notSent: IdempotencyRecord = { ...reservation.record, state: 'not_sent', updatedAt: 11 };
    const entry = [...this.entries.values()].find((candidate) => candidate.record.requestHash === reservation.record.requestHash);
    if (entry) entry.record = notSent;
    return notSent;
  }

  async markConflict(reservation: IdempotencyReservation): Promise<IdempotencyRecord> {
    this.conflictCalls.push(reservation);
    const entry = [...this.entries.values()].find((candidate) => candidate.record.requestHash === reservation.record.requestHash);
    const current = entry?.record ?? reservation.record;
    const { acceptedAt: _acceptedAt, inputProofHash: _inputProofHash, ...base } = current;
    const conflict: IdempotencyRecord = { ...base, state: 'conflict', updatedAt: 11 };
    if (entry) entry.record = conflict;
    return conflict;
  }

  async assertOwned(): Promise<void> {
    this.assertOwnedCalls += 1;
    if (this.failAssertAtCall === this.assertOwnedCalls) {
      throw new IdempotencyError('controller_lost', 'lost at mutation boundary');
    }
    if (this.assertOwnedError) throw this.assertOwnedError;
  }

  async markAttempting(reservation: IdempotencyReservation): Promise<IdempotencyRecord> {
    this.attemptingCalls.push(reservation);
    const entry = [...this.entries.values()].find((candidate) => candidate.record.requestHash === reservation.record.requestHash);
    if (!entry || entry.record.state !== 'retry_safe') {
      throw new IdempotencyError('retry_permission_consumed', 'retry consumed');
    }
    const attempting: IdempotencyRecord = { ...reservation.record, state: 'reserved', updatedAt: 12 };
    entry.record = attempting;
    return attempting;
  }

  async release(): Promise<boolean> {
    this.releaseCalls += 1;
    return true;
  }
}

function service(client: FakeClient, controller: FakeController): ExternalOrchestratorService {
  return new ExternalOrchestratorService({
    client,
    acquireController: async () => controller,
  });
}

test('freezes exact start and steer framing', () => {
  assert.equal(
    formatStartText('Ship the connector', []),
    'External coding agent objective:\n\nShip the connector',
  );
  assert.equal(
    formatStartText('Ship the connector', ['Keep protocol stable', 'Run focused tests']),
    'External coding agent objective:\n\nShip the connector\n\nConstraints:\n- Keep protocol stable\n- Run focused tests',
  );
  assert.equal(
    formatSteerText('Run the focused tests'),
    'External coding agent instruction:\n\nRun the focused tests',
  );
});

test('status reports working/idle state from live/outbox state and preserves the event cursor', async () => {
  const client = new FakeClient();
  const controller = new FakeController();
  const api = service(client, controller);
  client.nextFrom = 77;
  client.inputs = [input('00000000-0000-5000-8000-000000000001')];

  const working = await api.orchestrate({ action: 'status', session_id: SESSION_ID });
  assert.equal(working.ok, true);
  assert.equal(working.state, 'working');
  assert.equal(working.cursor, 77);
  assert.equal(working.session_id, SESSION_ID);
  assert.equal(working.active_turn_id, null);

  client.inputs = [];
  client.nextFrom = 78;
  const idle = await api.orchestrate({ action: 'status', session_id: SESSION_ID });
  assert.equal(idle.state, 'idle');
  assert.equal(idle.cursor, 78);
  assert.equal(controller.reserveCalls.length, 0);
  assert.equal(client.postCalls.length, 0);
});

test('actions disabled fails before controller acquisition or reservation', async () => {
  const client = new FakeClient();
  client.healthSnapshot = health(false);
  const controller = new FakeController();
  let acquireCalls = 0;
  const api = new ExternalOrchestratorService({
    client,
    acquireController: async () => {
      acquireCalls += 1;
      return controller;
    },
  });

  const result = await api.orchestrate(externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Ship', request_id: 'req.actions-off',
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'actions_disabled');
  assert.equal(acquireCalls, 0);
  assert.equal(controller.reserveCalls.length, 0);
  assert.equal(client.postCalls.length, 0);
});

test('start posts exact frozen text, explicit interrupt, and deterministic reservation UUID', async () => {
  const client = new FakeClient();
  client.postQueue.push(response(202, { ok: true }), response(202, { ok: true }));
  const controller = new FakeController();
  const api = service(client, controller);

  const first = externalOrchestrateRequestSchema.parse({
    action: 'start',
    objective: 'Ship the feature',
    constraints: ['Preserve API'],
    session_id: SESSION_ID,
    request_id: 'req.start.false',
  });
  const second = externalOrchestrateRequestSchema.parse({
    action: 'start',
    objective: 'Ship the feature',
    constraints: [],
    session_id: SESSION_ID,
    request_id: 'req.start.true',
    interrupt: true,
  });
  assert.equal((await api.orchestrate(first)).ok, true);
  assert.equal((await api.orchestrate(second)).ok, true);

  assert.deepEqual(client.postCalls.map((call) => ({ path: call.path, body: call.body })), [
    {
      path: '/v1/inputs',
      body: {
        id: deterministicInputId('req.start.false'),
        sessionId: SESSION_ID,
        text: 'External coding agent objective:\n\nShip the feature\n\nConstraints:\n- Preserve API',
        interrupt: false,
        expectedConversationId: 'conversation-1',
      },
    },
    {
      path: '/v1/inputs',
      body: {
        id: deterministicInputId('req.start.true'),
        sessionId: SESSION_ID,
        text: 'External coding agent objective:\n\nShip the feature',
        interrupt: true,
        expectedConversationId: 'conversation-1',
      },
    },
  ]);
  assert.deepEqual(controller.reserveCalls.map((call) => call.payload), [
    { text: 'External coding agent objective:\n\nShip the feature\n\nConstraints:\n- Preserve API', interrupt: false, expectedConversationId: 'conversation-1' },
    { text: 'External coding agent objective:\n\nShip the feature', interrupt: true, expectedConversationId: 'conversation-1' },
  ]);
});

test('steer posts its frozen framing unchanged', async () => {
  const client = new FakeClient();
  const controller = new FakeController();
  const api = service(client, controller);

  const result = await api.orchestrate(externalOrchestrateRequestSchema.parse({
    action: 'steer',
    instruction: 'Run the focused tests',
    session_id: SESSION_ID,
    request_id: 'req.steer.1',
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(client.postCalls[0]?.body, {
    id: deterministicInputId('req.steer.1'),
    sessionId: SESSION_ID,
    text: 'External coding agent instruction:\n\nRun the focused tests',
    interrupt: false,
    expectedConversationId: 'conversation-1',
  });
});

test('accepted replay asks Core to prove exact semantics without issuing a second provider send', async () => {
  const requestId = 'req.accepted.replay';
  const text = formatStartText('Ship', []);
  const controller = new FakeController();
  controller.seed(requestId, recordFor(requestId, {
    state: 'accepted',
    payload: { text, interrupt: false, expectedConversationId: 'conversation-1' },
  }));
  const client = new FakeClient();
  client.inputs = [input(deterministicInputId(requestId), { delivery: 'sent' })];
  client.postQueue.push(response(200, { replayed: true }));
  const api = service(client, controller);

  const result = await api.orchestrate(externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Ship', session_id: SESSION_ID, request_id: requestId,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.input_id, deterministicInputId(requestId));
  assert.equal(result.delivery, 'sent');
  assert.equal(result.summary, 'Request was already admitted by Core.');
  assert.equal(client.postCalls.length, 1, 'wire replay proves equality but must not create another provider send');
});

test('accepted local history never blesses a foreign same-UUID row after Core pruning', async () => {
  const requestId = 'req.accepted.foreign-reuse';
  const text = formatStartText('Ship', []);
  const id = deterministicInputId(requestId);
  const controller = new FakeController();
  controller.seed(requestId, recordFor(requestId, {
    state: 'accepted',
    payload: { text, interrupt: false, expectedConversationId: 'conversation-1' },
  }));
  const client = new FakeClient();
  client.inputs = [input(id, {
    delivery: 'pending',
    text: { text: 'foreign replacement', chars: 19, truncated: false },
  })];
  client.postQueue.push(response(409, { error: 'id_conflict' }));
  const api = service(client, controller);

  const result = await api.orchestrate(externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Ship', session_id: SESSION_ID, request_id: requestId,
  }));
  assert.equal(result.error?.code, 'duplicate_request_conflict');
  assert.equal(controller.entries.get(requestId)?.record.state, 'conflict');
  assert.equal(client.postCalls.length, 1);
});

test('accepted replay detects same semantic UUID reused as a different Core row instance', async () => {
  const requestId = 'req.accepted.same-text-reuse';
  const text = formatStartText('Ship', []);
  const id = deterministicInputId(requestId);
  const controller = new FakeController();
  controller.seed(requestId, recordFor(requestId, {
    state: 'accepted',
    payload: { text, interrupt: false, expectedConversationId: 'conversation-1' },
  }));
  const originalProof = controller.entries.get(requestId)!.record.inputProofHash;
  const client = new FakeClient();
  client.inputs = [input(id, {
    createdAt: 9_000,
    dueAt: 9_001,
    text: { text, chars: text.length, truncated: false },
  })];
  client.postQueue.push(response(200, { replayed: true }));
  const api = service(client, controller);

  const result = await api.orchestrate(externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Ship', session_id: SESSION_ID, request_id: requestId,
  }));
  assert.equal(result.error?.code, 'duplicate_request_conflict');
  assert.equal(controller.entries.get(requestId)?.record.state, 'conflict');
  assert.notEqual(proofForInput(client.inputs[0]!), originalProof);
  assert.equal(client.postCalls.length, 1, 'Core semantic replay is checked before the instance proof rejects replacement');
});

test('replayed reserved request with no retained input returns delivery_unknown without POST', async () => {
  const requestId = 'req.reserved.unknown';
  const text = formatStartText('Ship', []);
  const controller = new FakeController();
  controller.seed(requestId, recordFor(requestId, {
    state: 'reserved',
    payload: { text, interrupt: false, expectedConversationId: 'conversation-1' },
  }));
  const client = new FakeClient();
  const api = service(client, controller);

  const result = await api.orchestrate(externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Ship', session_id: SESSION_ID, request_id: requestId,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'delivery_unknown');
  assert.equal(result.input_id, deterministicInputId(requestId));
  assert.equal(result.delivery, 'unconfirmed');
  assert.equal(client.postCalls.length, 0);
});

test('retry_safe replay requires an explicit call and reuses the same deterministic UUID', async () => {
  const requestId = 'req.retry.safe';
  const text = formatStartText('Ship', []);
  const controller = new FakeController();
  controller.seed(requestId, recordFor(requestId, {
    state: 'retry_safe',
    payload: { text, interrupt: false, expectedConversationId: 'conversation-1' },
  }));
  const client = new FakeClient();
  client.postQueue.push(response(202, { ok: true }));
  client.beforePost = () => assert.equal(controller.attemptingCalls.length, 1, 'retry permission must be consumed before POST');
  const api = service(client, controller);

  const result = await api.orchestrate(externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Ship', session_id: SESSION_ID, request_id: requestId,
  }));
  assert.equal(result.ok, true);
  assert.equal(client.postCalls.length, 1);
  assert.deepEqual(client.postCalls[0]?.body, {
    id: deterministicInputId(requestId),
    sessionId: SESSION_ID,
    text,
    interrupt: false,
    expectedConversationId: 'conversation-1',
  });
  assert.equal(controller.attemptingCalls.length, 1);
  assert.equal(controller.acceptedCalls.length, 1);
});

test('ambiguous explicit retry consumes retry_safe permission before POST and cannot be replayed again', async () => {
  const requestId = 'req.retry.safe.ambiguous';
  const text = formatStartText('Ship', []);
  const controller = new FakeController();
  controller.seed(requestId, recordFor(requestId, {
    state: 'retry_safe',
    payload: { text, interrupt: false, expectedConversationId: 'conversation-1' },
  }));
  const client = new FakeClient();
  client.beforePost = () => {
    assert.equal(controller.attemptingCalls.length, 1, 'retry_safe must become reserved before mutation I/O');
    assert.equal(controller.entries.get(requestId)?.record.state, 'reserved');
  };
  client.postQueue.push(new ControlClientError('mutation_ambiguous', true));
  const api = service(client, controller);
  const request = externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Ship', session_id: SESSION_ID, request_id: requestId,
  });

  const ambiguous = await api.orchestrate(request);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error?.code, 'delivery_unknown');
  assert.equal(client.postCalls.length, 1);
  assert.equal(controller.entries.get(requestId)?.record.state, 'reserved');

  client.beforePost = null;
  const repeated = await api.orchestrate(request);
  assert.equal(repeated.ok, false);
  assert.equal(repeated.error?.code, 'delivery_unknown');
  assert.equal(client.postCalls.length, 1, 'consumed retry permission must not issue a third POST');
});

test('both 200 replay admission and 202 new admission mark the reservation accepted', async () => {
  const client = new FakeClient();
  client.postQueue.push(response(200, { replayed: true }), response(202, { ok: true }));
  const controller = new FakeController();
  const api = service(client, controller);

  const first = await api.orchestrate(externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'One', session_id: SESSION_ID, request_id: 'req.http.200',
  }));
  const second = await api.orchestrate(externalOrchestrateRequestSchema.parse({
    action: 'steer', instruction: 'Two', session_id: SESSION_ID, request_id: 'req.http.202',
  }));
  assert.equal(first.ok, true);
  assert.equal(first.summary, 'Request was already admitted by Core.');
  assert.equal(second.ok, true);
  assert.equal(second.summary, 'Request was admitted to the durable Core outbox.');
  assert.equal(controller.acceptedCalls.length, 2);
  assert.deepEqual(
    controller.acceptedCalls.map((reservation) => reservation.record.inputId),
    [deterministicInputId('req.http.200'), deterministicInputId('req.http.202')],
  );
});

test('exact pre-start 504 marks retry_safe and only a later explicit call retries the same UUID', async () => {
  const requestId = 'req.prestart.504';
  const client = new FakeClient();
  client.postQueue.push(
    response(504, { error: 'timeout', detail: 'the action did not start and will not run; it is safe to send again' }, false),
    response(202, { ok: true }),
  );
  const controller = new FakeController();
  const api = service(client, controller);
  const request = externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Ship', session_id: SESSION_ID, request_id: requestId,
  });

  const first = await api.orchestrate(request);
  assert.equal(first.ok, false);
  assert.equal(first.error?.code, 'busy');
  assert.equal(controller.retrySafeCalls.length, 1);
  assert.equal(client.postCalls.length, 1, 'pre-start timeout must not auto-retry');

  const second = await api.orchestrate(request);
  assert.equal(second.ok, true);
  assert.equal(client.postCalls.length, 2);
  const ids = client.postCalls.map((call) => (call.body as { id: string }).id);
  assert.deepEqual(ids, [deterministicInputId(requestId), deterministicInputId(requestId)]);
});

test('settled non-ambiguous refusal becomes retry_safe and only an explicit retry posts again', async () => {
  const requestId = 'req.would-interrupt.retry';
  const client = new FakeClient();
  client.postQueue.push(
    response(409, { error: 'would_interrupt' }, false),
    response(202, { ok: true }, false),
  );
  const controller = new FakeController();
  const api = service(client, controller);
  const request = externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Ship', session_id: SESSION_ID, request_id: requestId,
  });

  const refused = await api.orchestrate(request);
  assert.equal(refused.error?.code, 'would_interrupt');
  assert.equal(controller.entries.get(requestId)?.record.state, 'retry_safe');
  assert.equal(client.postCalls.length, 1);

  const retried = await api.orchestrate(request);
  assert.equal(retried.ok, true);
  assert.equal(client.postCalls.length, 2);
  assert.deepEqual(client.postCalls.map((call) => (call.body as { id: string }).id), [
    deterministicInputId(requestId), deterministicInputId(requestId),
  ]);
});

test('pre-POST control failure is retry_safe because no mutation request crossed the boundary', async () => {
  const requestId = 'req.preflight.retry';
  const client = new FakeClient();
  client.postQueue.push(new ControlClientError('control_api_unavailable'), response(202, { ok: true }));
  const controller = new FakeController();
  const api = service(client, controller);
  const request = externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Ship', session_id: SESSION_ID, request_id: requestId,
  });

  const first = await api.orchestrate(request);
  assert.equal(first.error?.code, 'control_api_unavailable');
  assert.equal(controller.entries.get(requestId)?.record.state, 'retry_safe');
  assert.equal(client.postCalls.length, 1);
  assert.equal((await api.orchestrate(request)).ok, true);
  assert.equal(client.postCalls.length, 2);
});

test('Core not-sent tombstone becomes terminal locally and is never re-admitted after pruning', async () => {
  const requestId = 'req.not-sent.terminal';
  const id = deterministicInputId(requestId);
  const text = formatStartText('Ship', []);
  const controller = new FakeController();
  controller.seed(requestId, recordFor(requestId, {
    state: 'retry_safe',
    payload: { text, interrupt: false, expectedConversationId: 'conversation-1' },
  }));
  const client = new FakeClient();
  client.inputs = [input(id, { delivery: 'not_sent', state: 'cancelled', text: { text, chars: text.length, truncated: false } })];
  client.postQueue.push(response(200, { replayed: true }));
  const api = service(client, controller);
  const request = externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Ship', session_id: SESSION_ID, request_id: requestId,
  });

  const terminal = await api.orchestrate(request);
  assert.equal(terminal.error?.code, 'request_not_sent');
  assert.equal(terminal.delivery, 'not_sent');
  assert.equal(controller.entries.get(requestId)?.record.state, 'not_sent');
  assert.equal(client.postCalls.length, 1, 'terminal tombstone is reconciled once through Core semantic equality');

  client.inputs = [];
  const pruned = await api.orchestrate(request);
  assert.equal(pruned.error?.code, 'request_not_sent');
  assert.equal(client.postCalls.length, 1, 'terminal not-sent ownership survives Core tombstone pruning without another POST');
});

test('foreign same-UUID Core tombstone is reconciled as terminal conflict and stays conflict after pruning', async () => {
  const requestId = 'req.foreign.tombstone';
  const id = deterministicInputId(requestId);
  const text = formatStartText('Ship', []);
  const controller = new FakeController();
  controller.seed(requestId, recordFor(requestId, {
    state: 'retry_safe',
    payload: { text, interrupt: false, expectedConversationId: 'conversation-1' },
  }));
  const client = new FakeClient();
  client.inputs = [input(id, {
    delivery: 'not_sent', state: 'cancelled',
    text: { text: 'foreign semantic payload', chars: 24, truncated: false },
  })];
  client.postQueue.push(response(409, { error: 'id_conflict' }));
  const api = service(client, controller);
  const request = externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Ship', session_id: SESSION_ID, request_id: requestId,
  });

  const conflicted = await api.orchestrate(request);
  assert.equal(conflicted.error?.code, 'duplicate_request_conflict');
  assert.equal(controller.entries.get(requestId)?.record.state, 'conflict');
  assert.equal(controller.notSentCalls.length, 0);
  assert.equal(controller.conflictCalls.length, 1);
  assert.equal(client.postCalls.length, 1);

  client.inputs = [];
  const pruned = await api.orchestrate(request);
  assert.equal(pruned.error?.code, 'duplicate_request_conflict');
  assert.equal(client.postCalls.length, 1, 'terminal conflict survives Core pruning without a second POST');
});

test('a non-accepted existing Core row must be reconciled by the authoritative same-UUID POST', async () => {
  const requestId = 'req.existing.reconcile';
  const id = deterministicInputId(requestId);
  const text = formatStartText('Ship', []);
  const controller = new FakeController();
  controller.seed(requestId, recordFor(requestId, {
    state: 'retry_safe',
    payload: { text, interrupt: false, expectedConversationId: 'conversation-1' },
  }));
  const client = new FakeClient();
  client.inputs = [input(id, { delivery: 'pending', text: { text, chars: text.length, truncated: false } })];
  client.postQueue.push(response(200, { replayed: true }));
  const api = service(client, controller);

  const result = await api.orchestrate(externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Ship', session_id: SESSION_ID, request_id: requestId,
  }));
  assert.equal(result.ok, true);
  assert.equal(client.postCalls.length, 1);
  assert.equal(controller.acceptedCalls.length, 1);
});

test('409 busy is truthful and leaves one explicit retry permission', async () => {
  const requestId = 'req.busy.retry';
  const client = new FakeClient();
  client.postQueue.push(response(409, { error: 'busy' }, false));
  const controller = new FakeController();
  const api = service(client, controller);
  const result = await api.orchestrate(externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Ship', session_id: SESSION_ID, request_id: requestId,
  }));
  assert.equal(result.error?.code, 'busy');
  assert.equal(controller.entries.get(requestId)?.record.state, 'retry_safe');
});

test('ambiguous transport and ambiguous 504 outcomes are never automatically replayed', async (t) => {
  await t.test('transport ambiguity', async () => {
    const client = new FakeClient();
    client.postQueue.push(new ControlClientError('mutation_ambiguous', true));
    const controller = new FakeController();
    const api = service(client, controller);
    const result = await api.orchestrate(externalOrchestrateRequestSchema.parse({
      action: 'start', objective: 'Ship', session_id: SESSION_ID, request_id: 'req.transport.ambiguous',
    }));
    assert.equal(result.error?.code, 'delivery_unknown');
    assert.equal(client.postCalls.length, 1);
    assert.equal(controller.retrySafeCalls.length, 0);
    assert.equal(controller.acceptedCalls.length, 0);
  });

  await t.test('504 may still complete', async () => {
    const client = new FakeClient();
    client.postQueue.push(response(504, { error: 'timeout', detail: 'the action may still complete' }, true));
    const controller = new FakeController();
    const api = service(client, controller);
    const result = await api.orchestrate(externalOrchestrateRequestSchema.parse({
      action: 'start', objective: 'Ship', session_id: SESSION_ID, request_id: 'req.504.ambiguous',
    }));
    assert.equal(result.error?.code, 'delivery_unknown');
    assert.equal(client.postCalls.length, 1);
    assert.equal(controller.retrySafeCalls.length, 0);
  });
});

test('same request_id with different canonical meaning is a conflict and does not POST again', async () => {
  const requestId = 'req.meaning.conflict';
  const client = new FakeClient();
  client.postQueue.push(response(202, { ok: true }));
  const controller = new FakeController();
  const api = service(client, controller);

  const first = await api.orchestrate(externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'First meaning', session_id: SESSION_ID, request_id: requestId,
  }));
  assert.equal(first.ok, true);
  const second = await api.orchestrate(externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Different meaning', session_id: SESSION_ID, request_id: requestId,
  }));
  assert.equal(second.ok, false);
  assert.equal(second.error?.code, 'duplicate_request_conflict');
  assert.equal(client.postCalls.length, 1);
});

test('cancel targets only the ledger-owned input, never a newer input or Stop route', async () => {
  const requestId = 'req.cancel.owned';
  const ownedId = deterministicInputId(requestId);
  const newerId = deterministicInputId('req.cancel.newer');
  const controller = new FakeController();
  controller.seed(requestId, recordFor(requestId, { state: 'accepted' }));
  const client = new FakeClient();
  client.inputs = [
    input(newerId, { createdAt: 200 }),
    input(ownedId, { createdAt: 100, delivery: 'pending' }),
  ];
  client.postQueue.push(response(200, { ok: true }));
  const api = service(client, controller);

  const result = await api.orchestrate({ action: 'cancel', request_id: requestId });
  assert.equal(result.ok, true);
  assert.equal(result.input_id, ownedId);
  assert.equal(client.postCalls.length, 1);
  assert.equal(client.postCalls[0]?.path, `/v1/inputs/${ownedId}/cancel`);
  assert.deepEqual(client.postCalls[0]?.body, {});
  assert.equal(client.postCalls[0]?.path.includes(newerId), false);
  assert.equal(client.postCalls[0]?.path.includes('/stop'), false);
});

test('successful owned cancel persists definitive not_sent ownership', async () => {
  const requestId = 'req.cancel.persist-not-sent';
  const ownedId = deterministicInputId(requestId);
  const controller = new FakeController();
  controller.seed(requestId, recordFor(requestId, { state: 'accepted' }));
  const client = new FakeClient();
  client.inputs = [input(ownedId, { delivery: 'pending' })];
  client.postQueue.push(response(200, { ok: true }));
  client.beforePost = () => {
    client.inputs = [input(ownedId, { delivery: 'not_sent', state: 'cancelled' })];
  };
  const api = service(client, controller);

  const cancelled = await api.orchestrate({ action: 'cancel', request_id: requestId });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.delivery, 'not_sent');
  assert.equal(controller.entries.get(requestId)?.record.state, 'not_sent');
  assert.equal(controller.notSentCalls.length, 1);
});

test('cancel refuses an accepted UUID that now points at a different Core row instance even with same session/text', async () => {
  const requestId = 'req.cancel.recreated-row';
  const ownedId = deterministicInputId(requestId);
  const controller = new FakeController();
  const accepted = recordFor(requestId, { state: 'accepted' });
  controller.seed(requestId, accepted);
  const client = new FakeClient();
  client.inputs = [input(ownedId, { createdAt: 7_000, dueAt: 7_001 })];
  const api = service(client, controller);

  const result = await api.orchestrate({ action: 'cancel', request_id: requestId });
  assert.equal(result.error?.code, 'duplicate_request_conflict');
  assert.equal(controller.entries.get(requestId)?.record.state, 'conflict');
  assert.equal(client.postCalls.length, 0);
});

test('legacy accepted ownership without a Core row proof must reconcile before cancel', async () => {
  const requestId = 'req.cancel.legacy-proofless';
  const ownedId = deterministicInputId(requestId);
  const controller = new FakeController();
  const accepted = recordFor(requestId, { state: 'accepted' });
  delete accepted.inputProofHash;
  controller.seed(requestId, accepted);
  const client = new FakeClient();
  client.inputs = [input(ownedId)];
  const api = service(client, controller);

  const result = await api.orchestrate({ action: 'cancel', request_id: requestId });
  assert.equal(result.error?.code, 'delivery_unknown');
  assert.equal(client.postCalls.length, 0);
});

test('cancel fails closed until Core admission ownership is proven accepted', async () => {
  for (const state of ['reserved', 'retry_safe'] as const) {
    const requestId = `req.cancel.unproven.${state}`;
    const controller = new FakeController();
    controller.seed(requestId, recordFor(requestId, { state }));
    const client = new FakeClient();
    client.inputs = [input(deterministicInputId(requestId), { delivery: 'pending' })];
    const api = service(client, controller);

    const result = await api.orchestrate({ action: 'cancel', request_id: requestId });
    assert.equal(result.error?.code, 'delivery_unknown');
    assert.equal(client.postCalls.length, 0);
  }
});

test('cancel never touches a row whose deterministic UUID is durably conflicting', async () => {
  const requestId = 'req.cancel.conflict';
  const controller = new FakeController();
  controller.seed(requestId, recordFor(requestId, { state: 'conflict' }));
  const client = new FakeClient();
  client.inputs = [input(deterministicInputId(requestId), { delivery: 'pending' })];
  const api = service(client, controller);

  const result = await api.orchestrate({ action: 'cancel', request_id: requestId });
  assert.equal(result.error?.code, 'duplicate_request_conflict');
  assert.equal(client.postCalls.length, 0);
});

test('cancel optional session_id must match ledger ownership before any POST', async () => {
  const requestId = 'req.cancel.session-mismatch';
  const controller = new FakeController();
  controller.seed(requestId, recordFor(requestId, { state: 'accepted' }));
  const client = new FakeClient();
  client.inputs = [input(deterministicInputId(requestId))];
  const api = service(client, controller);

  const result = await api.orchestrate({ action: 'cancel', request_id: requestId, session_id: OTHER_SESSION_ID });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'duplicate_request_conflict');
  assert.equal(client.postCalls.length, 0);
  assert.equal(client.inputReads, 0, 'session mismatch should fail before looking up the Core input');
});

test('Stop fences the exact session and turn; stale turns do not POST and 202 reports admission only', async () => {
  const client = new FakeClient();
  client.detail = {
    ...client.detail,
    live: { activeTurnId: TURN_ID, blocked: '' },
  };
  const controller = new FakeController();
  const api = service(client, controller);

  const stale = await api.orchestrate({
    action: 'stop', session_id: SESSION_ID, expected_turn_id: 'turn-stale-12345678',
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, 'active_turn_changed');
  assert.equal(client.postCalls.length, 0);
  assert.equal(controller.assertOwnedCalls, 0, 'fresh acquisition itself proves ownership');

  client.postQueue.push(response(202, { ok: true }));
  const accepted = await api.orchestrate({
    action: 'stop', session_id: SESSION_ID, expected_turn_id: TURN_ID,
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.state, 'working');
  assert.equal(accepted.active_turn_id, TURN_ID);
  assert.equal(accepted.summary, 'Exact-turn Stop request was durably accepted by Core.');
  assert.equal(accepted.summary?.includes('stopped'), false);
  assert.equal(controller.assertOwnedCalls, 2, 'cached controller is checked on reuse and again at the Stop POST boundary');
  assert.deepEqual(client.postCalls.map((call) => ({ path: call.path, body: call.body })), [{
    path: `/v1/sessions/${SESSION_ID}/stop`,
    body: { expectedTurnId: TURN_ID },
  }]);
});

test('lost cached controller ownership blocks exact-turn Stop before POST', async () => {
  const client = new FakeClient();
  client.detail = { ...client.detail, live: { activeTurnId: TURN_ID, blocked: '' } };
  const controller = new FakeController();
  const api = service(client, controller);

  // First mutation acquires/caches the controller, then the lock is lost before Stop.
  client.postQueue.push(response(202, { ok: true }));
  await api.orchestrate(externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Prime lock', session_id: SESSION_ID, request_id: 'req.lock.prime', interrupt: true,
  }));
  controller.assertOwnedError = new IdempotencyError('controller_lost', 'lost');
  const before = client.postCalls.length;
  const stopped = await api.orchestrate({ action: 'stop', session_id: SESSION_ID, expected_turn_id: TURN_ID });
  assert.equal(stopped.error?.code, 'controller_busy');
  assert.equal(client.postCalls.length, before);
});

test('controller loss at the final Stop boundary is caught after target revalidation and before POST', async () => {
  const client = new FakeClient();
  client.detail = { ...client.detail, live: { activeTurnId: TURN_ID, blocked: '' } };
  const controller = new FakeController();
  const api = service(client, controller);

  client.postQueue.push(response(202, { ok: true }));
  await api.orchestrate(externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Prime lock', session_id: SESSION_ID,
    request_id: 'req.boundary.lock.prime', interrupt: true,
  }));
  const before = client.postCalls.length;
  controller.failAssertAtCall = controller.assertOwnedCalls + 2;
  const stopped = await api.orchestrate({ action: 'stop', session_id: SESSION_ID, expected_turn_id: TURN_ID });
  assert.equal(stopped.error?.code, 'controller_busy');
  assert.equal(client.postCalls.length, before, 'no Stop POST crosses the boundary after lock loss');
});

test('actions-disabled race reports current action authority instead of stale health', async () => {
  const client = new FakeClient();
  client.postQueue.push(response(403, { error: 'actions_disabled' }));
  const controller = new FakeController();
  const api = service(client, controller);
  const result = await api.orchestrate(externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Ship', session_id: SESSION_ID, request_id: 'req.actions-disabled-race',
  }));
  assert.equal(result.error?.code, 'actions_disabled');
  assert.equal(result.connected, true);
  assert.equal(result.enabled, true);
  assert.equal(result.actions_enabled, false);
});

test('controller_busy is surfaced as a fixed service error without issuing a mutation', async () => {
  const client = new FakeClient();
  const api = new ExternalOrchestratorService({
    client,
    acquireController: async () => {
      throw new IdempotencyError('controller_busy', 'private controller detail');
    },
  });

  const result = await api.orchestrate(externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Ship', session_id: SESSION_ID, request_id: 'req.controller.busy',
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'controller_busy');
  assert.equal(result.error?.message, 'Another External Orchestrator mutation controller is active for this user.');
  assert.equal(client.postCalls.length, 0);
});

test('errors publish fixed sanitized text and never leak bearer tokens or host paths', async () => {
  const client = new FakeClient();
  client.tokens = [TOKEN];
  const api = new ExternalOrchestratorService({
    client,
    acquireController: async () => {
      throw new IdempotencyError(
        'idempotency_ledger_full',
        `Authorization: Bearer ${TOKEN}; state=${HOST_PATH}`,
      );
    },
  });

  const result = await api.orchestrate(externalOrchestrateRequestSchema.parse({
    action: 'start', objective: 'Ship', session_id: SESSION_ID, request_id: 'req.sanitized.error',
  }));
  assert.equal(result.error?.code, 'busy');
  assert.equal(result.error?.message, 'External Orchestrator idempotency ledger is full; no accepted request was evicted.');
  const published = JSON.stringify(result);
  assert.equal(published.includes(TOKEN), false);
  assert.equal(published.includes(HOST_PATH), false);
  assert.equal(published.includes('Authorization: Bearer'), false);
});
