import type {
  ControlHealthSnapshot,
  ControlHttpResponse,
  ControlInputDto,
  ControlInputsPageDto,
  ControlRequestOptions,
} from './control-client.js';
import {
  ControlClientError,
  ControlRemoteError,
  createControlClient,
} from './control-client.js';
import {
  EvidenceReadError,
  readEvidencePage,
  waitForEvidence,
} from './evidence.js';
import { sanitizeOutboundString } from './evidence-sanitizer.js';
import {
  IdempotencyError,
  acquireIdempotencyController,
  canonicalPayloadHash,
  type IdempotencyControllerOptions,
  type IdempotencyRecord,
  type IdempotencyReservation,
} from './idempotency.js';
import type {
  ExternalEvidenceRequest,
  ExternalEvidenceResponse,
  ExternalOrchestrateRequest,
  ExternalOrchestrateResponse,
} from './protocol.js';
import {
  SessionSelectionError,
  SessionSelector,
  type SelectedSession,
  type SessionSelectionClient,
} from './session-selector.js';

const INPUT_LOOKUP_LIMIT = 500;
const PRESTART_TIMEOUT_DETAIL = 'the action did not start and will not run; it is safe to send again';

type OrchestratorErrorCode = NonNullable<ExternalOrchestrateResponse['error']>['code'];
type EvidenceErrorCode = NonNullable<ExternalEvidenceResponse['error']>['code'];

interface ServiceControlClient extends SessionSelectionClient {
  health(): Promise<ControlHealthSnapshot>;
  sanitizationTokens(): readonly string[];
  listInputs(options?: { state?: readonly string[]; limit?: number }): Promise<ControlInputsPageDto>;
  readEvents(sessionId: string, options?: { from?: number; before?: number; after?: number; limit?: number; kinds?: readonly string[] }): Promise<{ events: unknown[]; total: number; nextFrom: number }>;
  get<T = unknown>(path: string, options?: ControlRequestOptions): Promise<ControlHttpResponse<T>>;
  post<T = unknown>(path: string, body: unknown, options?: ControlRequestOptions): Promise<ControlHttpResponse<T>>;
}

interface MutationController {
  assertOwned(): Promise<void>;
  lookup(requestId: string): Promise<IdempotencyRecord | null>;
  reserve(request: { requestId: string; sessionId: string; kind: 'start' | 'steer'; payload: unknown }): Promise<IdempotencyReservation>;
  markRetrySafe(reservation: IdempotencyReservation): Promise<IdempotencyRecord>;
  markNotSent(reservation: IdempotencyReservation): Promise<IdempotencyRecord>;
  markConflict(reservation: IdempotencyReservation): Promise<IdempotencyRecord>;
  markAttempting(reservation: IdempotencyReservation): Promise<IdempotencyRecord>;
  markAccepted(reservation: IdempotencyReservation, inputProofHash?: string): Promise<IdempotencyRecord>;
  release(): Promise<boolean>;
}

export interface ExternalOrchestratorServiceOptions {
  client?: ServiceControlClient;
  selector?: SessionSelector;
  idempotency?: IdempotencyControllerOptions;
  acquireController?: () => Promise<MutationController>;
}

export function formatStartText(objective: string, constraints: readonly string[]): string {
  const sections = ['External coding agent objective:', objective];
  if (constraints.length > 0) sections.push(`Constraints:\n${constraints.map((item) => `- ${item}`).join('\n')}`);
  return sections.join('\n\n');
}

export function formatSteerText(instruction: string): string {
  return `External coding agent instruction:\n\n${instruction}`;
}

function inputInstanceProof(input: ControlInputDto): string {
  return canonicalPayloadHash({
    id: input.id,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    createdAt: input.createdAt,
    dueAt: input.dueAt,
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function remoteCode(body: unknown): string | null {
  const value = record(body);
  return typeof value?.error === 'string' && value.error.length <= 80 ? value.error : null;
}

function remoteDetail(body: unknown): string | null {
  const value = record(body);
  return typeof value?.detail === 'string' && value.detail.length <= 500 ? value.detail : null;
}

function fixedMessage(code: OrchestratorErrorCode, override?: string): string {
  if (override) return override;
  const messages: Record<OrchestratorErrorCode, string> = {
    control_api_unavailable: 'Chat On Steroids Local Control API is unavailable.',
    unsupported_control_api: 'This External Orchestrator build is not compatible with the available Local Control API.',
    actions_disabled: 'Chat On Steroids Local Control actions are disabled.',
    no_executor: 'No eligible Prime session is available.',
    session_not_found: 'The requested Chat On Steroids session does not exist.',
    session_ineligible: 'The requested session is not an eligible controllable Prime session.',
    would_interrupt: 'The target is currently answering; retry with interrupt:true only if interruption is intended.',
    duplicate_request_conflict: 'request_id is already bound to a different external mutation.',
    request_not_sent: 'This request identity is proven not sent and will not be re-admitted.',
    request_not_owned: 'The request_id is not owned by this External Orchestrator ledger.',
    input_not_found: 'The owned pending input is no longer present in the Core outbox.',
    active_turn_changed: 'The active turn changed; exact-turn Stop was not retargeted.',
    cancel_failed: 'The owned input cannot be cancelled safely.',
    stop_unavailable: 'Chat On Steroids could not durably accept the Stop request.',
    controller_busy: 'Another External Orchestrator mutation controller is active for this user.',
    busy: 'External Orchestrator cannot safely admit another mutation right now.',
    rate_limited: 'Chat On Steroids is rate limiting Local Control requests.',
    delivery_unknown: 'The mutation outcome is unknown; reconcile state before issuing a different request.',
    internal_error: 'External Orchestrator could not complete the request safely.',
  };
  return messages[code];
}

function stateFor(selection: SelectedSession, inputs: readonly ControlInputDto[]): 'idle' | 'working' {
  if (selection.live.activeTurnId) return 'working';
  return inputs.some((input) => input.sessionId === selection.session.id && input.delivery === 'pending') ? 'working' : 'idle';
}

function inputBelongsTo(input: ControlInputDto, sessionId: string): boolean {
  return input.sessionId === sessionId || input.deliveredSessionId === sessionId;
}

function deliveryOf(input: ControlInputDto | null): ExternalOrchestrateResponse['delivery'] {
  return input?.delivery ?? 'unconfirmed';
}

function mutationWasProvenNotStarted(response: ControlHttpResponse<unknown>): boolean {
  return response.status === 504
    && response.ambiguous === false
    && remoteCode(response.body) === 'timeout'
    && remoteDetail(response.body) === PRESTART_TIMEOUT_DETAIL;
}

function settledMutationRefusalIsRetrySafe(response: ControlHttpResponse<unknown>): boolean {
  if (response.ambiguous || response.status === 200 || response.status === 202) return false;
  // Core's id_conflict says this deterministic UUID already names a different input. Do not ever
  // turn pruning of that foreign row into permission to send this logical request later.
  if (response.status === 409 && remoteCode(response.body) === 'id_conflict') return false;
  return true;
}

export class ExternalOrchestratorService {
  readonly #client: ServiceControlClient;
  readonly #selector: SessionSelector;
  readonly #acquire: () => Promise<MutationController>;
  #controller: MutationController | null = null;
  #closing = false;
  #closePromise: Promise<void> | null = null;
  #shutdown = new AbortController();
  #inFlight = new Set<Promise<unknown>>();

  constructor(options: ExternalOrchestratorServiceOptions = {}) {
    const client = options.client ?? createControlClient();
    this.#client = client;
    this.#selector = options.selector ?? new SessionSelector(client);
    this.#acquire = options.acquireController ?? (() => acquireIdempotencyController(options.idempotency));
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#shutdown.abort(new Error('External Orchestrator is shutting down.'));
    this.#closePromise = (async () => {
      await Promise.allSettled([...this.#inFlight]);
      const controller = this.#controller;
      this.#controller = null;
      if (controller) await controller.release().catch(() => false);
    })();
    return this.#closePromise;
  }

  async orchestrate(request: ExternalOrchestrateRequest, signal?: AbortSignal): Promise<ExternalOrchestrateResponse> {
    if (this.#closing) return this.#failure('control_api_unavailable');
    const operation = this.#orchestrate(request, this.#operationSignal(signal));
    this.#inFlight.add(operation);
    try {
      return await operation;
    } finally {
      this.#inFlight.delete(operation);
    }
  }

  async #orchestrate(request: ExternalOrchestrateRequest, signal?: AbortSignal): Promise<ExternalOrchestrateResponse> {
    let health: ControlHealthSnapshot | undefined;
    try {
      health = await this.#client.health();
      switch (request.action) {
        case 'status':
          return await this.#status(health, request.session_id);
        case 'wait':
          return await this.#wait(health, request.session_id, request.cursor, request.wait_ms, signal);
        case 'start':
          return await this.#send(health, 'start', {
            requestId: request.request_id,
            sessionId: request.session_id,
            projectId: request.project_id,
            text: formatStartText(request.objective, request.constraints),
            interrupt: request.interrupt,
          }, signal);
        case 'steer':
          return await this.#send(health, 'steer', {
            requestId: request.request_id,
            sessionId: request.session_id,
            text: formatSteerText(request.instruction),
            interrupt: request.interrupt,
          }, signal);
        case 'cancel':
          return await this.#cancel(health, request.request_id, request.session_id, signal);
        case 'stop':
          return await this.#stop(health, request.session_id, request.expected_turn_id, signal);
      }
    } catch (error) {
      return this.#failureFrom(error, health);
    }
  }

  async evidence(request: ExternalEvidenceRequest, signal?: AbortSignal): Promise<ExternalEvidenceResponse> {
    if (this.#closing) {
      return {
        ok: false,
        enabled: false,
        session_id: request.session_id ?? null,
        cursor: request.cursor ?? 0,
        caught_up: true,
        items: [],
        error: { code: 'control_api_unavailable', message: fixedMessage('control_api_unavailable') },
      };
    }
    const operation = this.#evidence(request, this.#operationSignal(signal));
    this.#inFlight.add(operation);
    try {
      return await operation;
    } finally {
      this.#inFlight.delete(operation);
    }
  }

  async #evidence(request: ExternalEvidenceRequest, signal?: AbortSignal): Promise<ExternalEvidenceResponse> {
    const cursor = request.cursor ?? 0;
    try {
      await this.#client.health();
      const selection = await this.#selector.select({ sessionId: request.session_id });
      const page = await readEvidencePage(this.#client, {
        sessionId: selection.session.id,
        cursor,
        limit: request.limit,
        level: request.level,
        bearerTokens: this.#client.sanitizationTokens(),
        signal,
      });
      return {
        ok: true,
        enabled: true,
        session_id: selection.session.id,
        cursor: page.cursor,
        caught_up: page.caught_up,
        items: page.items,
      };
    } catch (error) {
      const mapped = this.#mapEvidenceError(error);
      return {
        ok: false,
        enabled: mapped.code !== 'control_api_unavailable' && mapped.code !== 'unsupported_control_api',
        session_id: request.session_id ?? null,
        cursor,
        caught_up: true,
        items: [],
        error: mapped,
      };
    }
  }

  async #status(health: ControlHealthSnapshot, sessionId?: string): Promise<ExternalOrchestrateResponse> {
    const selection = await this.#selector.select({ sessionId });
    const [inputs, tail] = await Promise.all([
      this.#client.listInputs({ limit: INPUT_LOOKUP_LIMIT }),
      this.#client.readEvents(selection.session.id, { limit: 1 }),
    ]);
    return this.#success(health, selection, {
      state: stateFor(selection, inputs.inputs),
      cursor: tail.nextFrom,
      summary: selection.live.activeTurnId ? 'Prime session is working.' : 'Prime session is available.',
    });
  }

  async #wait(health: ControlHealthSnapshot, sessionId: string | undefined, cursor: number | undefined, waitMs: number, signal?: AbortSignal): Promise<ExternalOrchestrateResponse> {
    const selection = await this.#selector.select({ sessionId });
    const initialCursor = cursor ?? (await this.#client.readEvents(selection.session.id, { limit: 1 })).nextFrom;
    const waited = await waitForEvidence(this.#client, {
      sessionId: selection.session.id,
      cursor: initialCursor,
      waitMs,
      bearerTokens: this.#client.sanitizationTokens(),
      signal,
    });
    const refreshed = await this.#selector.revalidateForMutation(selection).catch(() => selection);
    const inputs = await this.#client.listInputs({ limit: INPUT_LOOKUP_LIMIT });
    return this.#success(health, refreshed, {
      state: stateFor(refreshed, inputs.inputs),
      cursor: waited.cursor,
      summary: waited.item?.summary ?? 'No new recorded activity.',
    });
  }

  async #send(
    health: ControlHealthSnapshot,
    kind: 'start' | 'steer',
    operation: { requestId: string; sessionId?: string; projectId?: string; text: string; interrupt: boolean },
    signal?: AbortSignal,
  ): Promise<ExternalOrchestrateResponse> {
    if (!health.actions.enabled) return this.#failure('actions_disabled', health);
    const selected = await this.#selector.select({ sessionId: operation.sessionId, projectId: operation.projectId });
    const controller = await this.#controllerForMutation();
    const selection = await this.#selector.revalidateForMutation(selected, operation.projectId);
    const reservation = await controller.reserve({
      requestId: operation.requestId,
      sessionId: selection.session.id,
      kind,
      payload: {
        text: operation.text,
        interrupt: operation.interrupt,
        expectedConversationId: selection.conversationId,
      },
    });

    if (reservation.record.state === 'not_sent') {
      return this.#failure('request_not_sent', health, selection, {
        input_id: reservation.record.inputId,
        delivery: 'not_sent',
        summary: 'A prior attempt is durably proven not sent and this request_id will not be re-admitted.',
      });
    }
    if (reservation.record.state === 'conflict') {
      return this.#failure('duplicate_request_conflict', health, selection, {
        input_id: reservation.record.inputId,
        summary: 'Core previously proved this deterministic request identity belongs to different input semantics.',
      });
    }

    const existing = await this.#findInput(reservation.record.inputId);
    // A projected Core row is never enough to prove full semantic ownership: text can be truncated,
    // and Core may have pruned the original row before another local actor reused the UUID. On every
    // explicit replay with a retained row — including a locally accepted request — ask the
    // authoritative outbox to compare UUID + session + full text + expected conversation. Its 200
    // replay response proves equality without a second provider send; 409 id_conflict fails closed.
    if (existing) this.#assertInputOwnership(existing, reservation.record.sessionId, selection.conversationId);

    if (reservation.replayed && reservation.record.state !== 'retry_safe' && !existing) {
      return this.#failure('delivery_unknown', health, selection, {
        input_id: reservation.record.inputId,
        delivery: 'unconfirmed',
        summary: reservation.record.state === 'accepted'
          ? 'Request was previously accepted; Core no longer retains delivery proof.'
          : 'A previous mutation attempt has an ambiguous outcome and was not replayed.',
      });
    }

    // A retry-safe record grants exactly one later explicit attempt. Revoke that grant durably
    // before the POST so a crash/reset can never leave a reusable retry permission behind.
    if (reservation.record.state === 'retry_safe') {
      try {
        await controller.markAttempting(reservation);
      } catch (error) {
        if (!(error instanceof IdempotencyError) || error.code !== 'retry_permission_consumed') throw error;
        const current = await controller.lookup(operation.requestId);
        if (current?.state === 'not_sent') {
          return this.#failure('request_not_sent', health, selection, {
            input_id: current.inputId,
            delivery: 'not_sent',
          });
        }
        if (current?.state === 'conflict') {
          return this.#failure('duplicate_request_conflict', health, selection, { input_id: current.inputId });
        }
        return this.#failure('delivery_unknown', health, selection, {
          input_id: reservation.record.inputId,
          delivery: 'unconfirmed',
          summary: 'Another concurrent caller already consumed the single explicit retry permission.',
        });
      }
    }

    let response: ControlHttpResponse<unknown>;
    try {
      await controller.assertOwned();
      response = await this.#client.post('/v1/inputs', {
        id: reservation.record.inputId,
        sessionId: selection.session.id,
        text: operation.text,
        interrupt: operation.interrupt,
        expectedConversationId: selection.conversationId,
      }, { signal });
    } catch (error) {
      if (error instanceof ControlClientError && error.ambiguous) {
        return this.#failure('delivery_unknown', health, selection, {
          input_id: reservation.record.inputId,
          delivery: 'unconfirmed',
          summary: 'Mutation outcome is ambiguous; the request was not replayed.',
        });
      }
      if (error instanceof ControlClientError) await controller.markRetrySafe(reservation);
      throw error;
    }

    if (response.status === 200 || response.status === 202) {
      const admitted = await this.#findInput(reservation.record.inputId);
      if (admitted) this.#assertInputOwnership(admitted, selection.session.id, selection.conversationId);
      const admittedProof = admitted ? inputInstanceProof(admitted) : undefined;
      if (reservation.record.inputProofHash !== undefined && admittedProof !== undefined
          && reservation.record.inputProofHash !== admittedProof) {
        await controller.markConflict(reservation);
        return this.#failure('duplicate_request_conflict', health, selection, {
          input_id: reservation.record.inputId,
          summary: 'The deterministic UUID now names a different Core input instance.',
        });
      }
      if (admitted?.delivery === 'not_sent') {
        await controller.markNotSent(reservation);
        return this.#failure('request_not_sent', health, selection, {
          input_id: reservation.record.inputId,
          delivery: 'not_sent',
          summary: 'Core proved this request identity was not sent; it will not be re-admitted.',
        });
      }
      await controller.markAccepted(reservation, admittedProof);
      return this.#success(health, selection, {
        state: admitted ? stateFor(selection, [admitted]) : 'working',
        input_id: reservation.record.inputId,
        delivery: deliveryOf(admitted),
        summary: response.status === 200 ? 'Request was already admitted by Core.' : 'Request was admitted to the durable Core outbox.',
      });
    }

    if (mutationWasProvenNotStarted(response)) {
      await controller.markRetrySafe(reservation);
      return this.#failure('busy', health, selection, {
        input_id: reservation.record.inputId,
        summary: 'Core proved the mutation did not start. A later explicit retry may reuse this request_id.',
      });
    }
    if (response.ambiguous) {
      return this.#failure('delivery_unknown', health, selection, {
        input_id: reservation.record.inputId,
        delivery: 'unconfirmed',
        summary: 'Mutation outcome is ambiguous; the request was not replayed.',
      });
    }
    if (response.status === 409 && remoteCode(response.body) === 'id_conflict') {
      await controller.markConflict(reservation);
      return this.#remoteFailure(response, health, selection, reservation.record.inputId);
    }
    if (settledMutationRefusalIsRetrySafe(response)) {
      const rejected = await this.#findInput(reservation.record.inputId);
      if (rejected && remoteCode(response.body) !== 'id_conflict') {
        this.#assertInputOwnership(rejected, selection.session.id, selection.conversationId);
        if (rejected.delivery === 'not_sent') await controller.markNotSent(reservation);
        else await controller.markRetrySafe(reservation);
      } else await controller.markRetrySafe(reservation);
    }
    return this.#remoteFailure(response, health, selection, reservation.record.inputId);
  }

  async #cancel(health: ControlHealthSnapshot, requestId: string, sessionId: string | undefined, signal?: AbortSignal): Promise<ExternalOrchestrateResponse> {
    if (!health.actions.enabled) return this.#failure('actions_disabled', health);
    const controller = await this.#controllerForMutation();
    const owned = await controller.lookup(requestId);
    if (!owned) return this.#failure('request_not_owned', health);
    if (sessionId !== undefined && sessionId !== owned.sessionId) return this.#failure('duplicate_request_conflict', health);
    if (owned.state === 'not_sent') {
      return this.#failure('request_not_sent', health, undefined, {
        input_id: owned.inputId,
        delivery: 'not_sent',
        summary: 'This request is already durably proven not sent.',
      });
    }
    if (owned.state === 'conflict') {
      return this.#failure('duplicate_request_conflict', health, undefined, {
        input_id: owned.inputId,
        summary: 'This request identity is durably known to conflict with different Core input semantics.',
      });
    }
    if (owned.state !== 'accepted') {
      return this.#failure('delivery_unknown', health, undefined, {
        input_id: owned.inputId,
        delivery: 'unconfirmed',
        summary: 'Request ownership is not yet proven accepted; reconcile the same start/steer request before cancelling it.',
      });
    }
    if (!owned.inputProofHash) {
      return this.#failure('delivery_unknown', health, undefined, {
        input_id: owned.inputId,
        delivery: 'unconfirmed',
        summary: 'Accepted ownership predates Core row proof; replay the same start/steer request to reconcile before cancelling.',
      });
    }
    const input = await this.#findInput(owned.inputId);
    if (!input) return this.#failure('input_not_found', health, undefined, { input_id: owned.inputId });
    this.#assertInputOwnership(input, owned.sessionId);
    if (inputInstanceProof(input) !== owned.inputProofHash) {
      await controller.markConflict({ record: owned, replayed: true });
      return this.#failure('duplicate_request_conflict', health, undefined, {
        input_id: owned.inputId,
        summary: 'The deterministic UUID now names a different Core input instance.',
      });
    }
    let response: ControlHttpResponse<unknown>;
    try {
      await controller.assertOwned();
      response = await this.#client.post(`/v1/inputs/${encodeURIComponent(owned.inputId)}/cancel`, {}, { signal });
    } catch (error) {
      if (error instanceof ControlClientError && error.ambiguous) {
        return this.#failure('delivery_unknown', health, undefined, { input_id: owned.inputId, delivery: 'unconfirmed' });
      }
      throw error;
    }
    if (response.ambiguous) return this.#failure('delivery_unknown', health, undefined, { input_id: owned.inputId, delivery: 'unconfirmed' });
    if (response.status !== 200) return this.#remoteFailure(response, health, undefined, owned.inputId);
    const after = await this.#findInput(owned.inputId);
    if (after?.delivery === 'not_sent') {
      await controller.markNotSent({ record: owned, replayed: true });
    }
    return {
      ok: true,
      enabled: true,
      connected: true,
      actions_enabled: true,
      session_id: owned.sessionId,
      project_id: null,
      state: 'idle',
      summary: after?.delivery === 'not_sent' ? 'Owned pending input was cancelled before delivery.' : 'Cancel request completed.',
      input_id: owned.inputId,
      active_turn_id: null,
      delivery: deliveryOf(after),
    };
  }

  async #stop(health: ControlHealthSnapshot, sessionId: string, expectedTurnId: string, signal?: AbortSignal): Promise<ExternalOrchestrateResponse> {
    if (!health.actions.enabled) return this.#failure('actions_disabled', health);
    const controller = await this.#controllerForMutation();
    const selected = await this.#selector.select({ sessionId });
    const selection = await this.#selector.revalidateForMutation(selected);
    if (selection.live.activeTurnId !== expectedTurnId) return this.#failure('active_turn_changed', health, selection);
    let response: ControlHttpResponse<unknown>;
    try {
      await controller.assertOwned();
      response = await this.#client.post(`/v1/sessions/${encodeURIComponent(sessionId)}/stop`, { expectedTurnId }, { signal });
    } catch (error) {
      if (error instanceof ControlClientError && error.ambiguous) return this.#failure('delivery_unknown', health, selection);
      throw error;
    }
    if (response.ambiguous) return this.#failure('delivery_unknown', health, selection);
    if (response.status !== 202) return this.#remoteFailure(response, health, selection);
    return this.#success(health, selection, {
      state: 'working',
      active_turn_id: expectedTurnId,
      summary: 'Exact-turn Stop request was durably accepted by Core.',
    });
  }

  async #controllerForMutation(): Promise<MutationController> {
    if (this.#controller) {
      try {
        await this.#controller.assertOwned();
        return this.#controller;
      } catch (error) {
        this.#controller = null;
        throw error;
      }
    }
    try {
      this.#controller = await this.#acquire();
      return this.#controller;
    } catch (error) {
      throw error;
    }
  }

  async #findInput(inputId: string): Promise<ControlInputDto | null> {
    const page = await this.#client.listInputs({ limit: INPUT_LOOKUP_LIMIT });
    return page.inputs.find((input) => input.id === inputId) ?? null;
  }

  #assertInputOwnership(input: ControlInputDto, sessionId: string, expectedConversationId?: string): void {
    if (!inputBelongsTo(input, sessionId)
        || (expectedConversationId !== undefined && input.conversationId !== expectedConversationId)) {
      throw new IdempotencyError('duplicate_request_conflict', 'Owned input identity no longer belongs to the recorded session.');
    }
  }

  #success(
    health: ControlHealthSnapshot,
    selection: SelectedSession,
    extra: Partial<ExternalOrchestrateResponse> = {},
  ): ExternalOrchestrateResponse {
    const tokens = this.#client.sanitizationTokens();
    const summary = typeof extra.summary === 'string' ? sanitizeOutboundString(extra.summary, tokens) : undefined;
    return {
      ok: true,
      enabled: true,
      connected: true,
      actions_enabled: health.actions.enabled,
      session_id: selection.session.id,
      project_id: selection.session.projectId ?? null,
      state: extra.state ?? (selection.live.activeTurnId ? 'working' : 'idle'),
      ...(summary === undefined ? {} : { summary }),
      ...(extra.cursor === undefined ? {} : { cursor: extra.cursor }),
      ...(extra.input_id === undefined ? {} : { input_id: extra.input_id }),
      active_turn_id: extra.active_turn_id === undefined ? selection.live.activeTurnId : extra.active_turn_id,
      ...(extra.delivery === undefined ? {} : { delivery: extra.delivery }),
    };
  }

  #failure(
    code: OrchestratorErrorCode,
    health?: ControlHealthSnapshot,
    selection?: SelectedSession,
    extra: Partial<ExternalOrchestrateResponse> = {},
    message?: string,
  ): ExternalOrchestrateResponse {
    const tokens = this.#client.sanitizationTokens();
    const summary = typeof extra.summary === 'string' ? sanitizeOutboundString(extra.summary, tokens) : undefined;
    return {
      ok: false,
      enabled: health !== undefined,
      connected: health !== undefined,
      actions_enabled: health?.actions.enabled ?? false,
      session_id: selection?.session.id ?? null,
      project_id: selection?.session.projectId ?? null,
      state: 'unavailable',
      ...(summary === undefined ? {} : { summary }),
      ...(extra.cursor === undefined ? {} : { cursor: extra.cursor }),
      ...(extra.input_id === undefined ? {} : { input_id: extra.input_id }),
      active_turn_id: selection?.live.activeTurnId ?? null,
      ...(extra.delivery === undefined ? {} : { delivery: extra.delivery }),
      error: { code, message: sanitizeOutboundString(fixedMessage(code, message), tokens) },
    };
  }

  #remoteFailure(
    response: ControlHttpResponse<unknown>,
    health: ControlHealthSnapshot,
    selection?: SelectedSession,
    inputId?: string,
  ): ExternalOrchestrateResponse {
    const code = remoteCode(response.body);
    let mapped: OrchestratorErrorCode = 'internal_error';
    if (response.status === 403 && code === 'actions_disabled') mapped = 'actions_disabled';
    else if (response.status === 401) mapped = 'control_api_unavailable';
    else if (response.status === 404 && code === 'session_not_found') mapped = 'session_not_found';
    else if (response.status === 404 && code === 'input_not_found') mapped = 'input_not_found';
    else if (response.status === 409 && code === 'would_interrupt') mapped = 'would_interrupt';
    else if (response.status === 409 && code === 'busy') mapped = 'busy';
    else if (response.status === 409 && code === 'conversation_changed') mapped = 'session_ineligible';
    else if (response.status === 409 && (code === 'session_not_controllable' || code === 'no_chat' || code === 'chat_blocked')) mapped = 'session_ineligible';
    else if (response.status === 409 && code === 'active_turn_changed') mapped = 'active_turn_changed';
    else if (response.status === 409 && code === 'id_conflict') mapped = 'duplicate_request_conflict';
    else if (response.status === 409 && code === 'not_cancellable') mapped = 'cancel_failed';
    else if (response.status === 409 && code === 'delivery_unconfirmed') mapped = 'delivery_unknown';
    else if (response.status === 429) mapped = 'rate_limited';
    else if (response.status === 503 && code === 'stop_unavailable') mapped = 'stop_unavailable';
    else if (response.status === 503 && (code === 'busy' || code === 'queue_full' || code === 'shutting_down')) mapped = 'busy';
    else if (response.ambiguous) mapped = 'delivery_unknown';
    const truthfulHealth = mapped === 'actions_disabled'
      ? { ...health, actions: { ...health.actions, enabled: false } }
      : mapped === 'control_api_unavailable' ? undefined : health;
    return this.#failure(mapped, truthfulHealth, selection, {
      ...(inputId ? { input_id: inputId } : {}),
      ...(mapped === 'delivery_unknown' ? { delivery: 'unconfirmed' as const } : {}),
    });
  }

  #failureFrom(error: unknown, health?: ControlHealthSnapshot): ExternalOrchestrateResponse {
    if (error instanceof SessionSelectionError) {
      return this.#failure(error.code === 'session_not_found' ? 'session_not_found' : error.code === 'no_executor' ? 'no_executor' : 'session_ineligible', health);
    }
    if (error instanceof IdempotencyError) {
      if (error.code === 'duplicate_request_conflict') return this.#failure('duplicate_request_conflict', health);
      if (error.code === 'retry_permission_consumed') return this.#failure('delivery_unknown', health);
      if (error.code === 'controller_busy' || error.code === 'controller_lost') {
        if (error.code === 'controller_lost') this.#controller = null;
        return this.#failure('controller_busy', health);
      }
      if (error.code === 'idempotency_ledger_full') return this.#failure('busy', health, undefined, {}, 'External Orchestrator idempotency ledger is full; no accepted request was evicted.');
      return this.#failure('internal_error', health);
    }
    if (error instanceof ControlClientError) {
      if (error.code === 'unsupported_control_api') return this.#failure('unsupported_control_api');
      if (error.ambiguous || error.code === 'mutation_ambiguous') return this.#failure('delivery_unknown', health);
      if (error.code === 'control_api_unavailable' || error.code === 'request_timeout' || error.code === 'request_aborted') return this.#failure('control_api_unavailable');
      return this.#failure('internal_error', health);
    }
    if (error instanceof ControlRemoteError) {
      if (error.status === 429) return this.#failure('rate_limited', health);
      if (error.status === 503 && error.remoteCode === 'busy') return this.#failure('busy', health);
      if (error.status === 504) return this.#failure('busy', health);
      if (error.status === 404) return this.#failure('session_not_found', health);
      if (error.status === 401) return this.#failure('control_api_unavailable');
      return this.#failure('internal_error', health);
    }
    if (error instanceof EvidenceReadError) {
      const code: OrchestratorErrorCode = error.code === 'rate_limited' ? 'rate_limited'
        : error.code === 'busy' ? 'busy'
          : error.code === 'session_not_found' ? 'session_not_found'
            : error.code === 'unsupported_control_api' ? 'unsupported_control_api'
              : error.code === 'control_api_unavailable' ? 'control_api_unavailable'
                : 'internal_error';
      return this.#failure(code, code === 'control_api_unavailable' || code === 'unsupported_control_api' ? undefined : health);
    }
    return this.#failure('internal_error', health);
  }

  #mapEvidenceError(error: unknown): { code: EvidenceErrorCode; message: string } {
    let code: EvidenceErrorCode = 'internal_error';
    if (error instanceof SessionSelectionError) {
      code = error.code === 'session_not_found' ? 'session_not_found' : error.code === 'no_executor' ? 'no_executor' : 'session_ineligible';
    } else if (error instanceof EvidenceReadError) {
      code = error.code;
    } else if (error instanceof ControlClientError) {
      if (error.code === 'unsupported_control_api') code = 'unsupported_control_api';
      else if (error.code === 'control_api_unavailable' || error.code === 'request_timeout' || error.code === 'request_aborted') code = 'control_api_unavailable';
    } else if (error instanceof ControlRemoteError) {
      if (error.status === 429) code = 'rate_limited';
      else if (error.status === 503 || error.status === 504) code = 'busy';
      else if (error.status === 404) code = 'session_not_found';
      else if (error.status === 401) code = 'control_api_unavailable';
    }
    const compatible: OrchestratorErrorCode = code;
    return { code, message: sanitizeOutboundString(fixedMessage(compatible), this.#client.sanitizationTokens()) };
  }

  #operationSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.#shutdown.signal]) : this.#shutdown.signal;
  }
}

export function createExternalOrchestratorService(options: ExternalOrchestratorServiceOptions = {}): ExternalOrchestratorService {
  return new ExternalOrchestratorService(options);
}
