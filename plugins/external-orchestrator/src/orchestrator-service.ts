import type {
  ControlChangesDto,
  ControlSemanticEventDto,
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
  parseControlCancelResult,
} from './control-client.js';
import {
  EvidenceReadError,
  readEvidencePage,
  waitForEvidence,
} from './evidence.js';
import { sanitizeOutboundString } from './evidence-sanitizer.js';
import { projectSemanticControlEvent } from './semantic-events.js';
import {
  checkpointStateForTurn,
  classifySemanticWait,
  emptyTerminalSettleState,
  type CheckpointState,
  type SemanticProjectedEvent,
  type SemanticWaitMode,
  type TerminalSettleState,
} from './semantic-wait.js';
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
const SEMANTIC_EVENT_PAGE_SIZE = 100;
const CONTROL_RESTART_GRACE_MS = 5_000;
const PRESTART_TIMEOUT_DETAIL = 'the action did not start and will not run; it is safe to send again';

type OrchestratorErrorCode = NonNullable<ExternalOrchestrateResponse['error']>['code'];
type EvidenceErrorCode = NonNullable<ExternalEvidenceResponse['error']>['code'];

interface ServiceControlClient extends SessionSelectionClient {
  health(): Promise<ControlHealthSnapshot>;
  currentHealth(): ControlHealthSnapshot | null;
  supportsSemanticWait(health?: ControlHealthSnapshot | null): boolean;
  snapshotChanges(options?: ControlRequestOptions): Promise<ControlChangesDto>;
  waitForChange(
    cursor: { instanceId: string; after: number },
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ControlChangesDto>;
  sanitizationTokens(): readonly string[];
  listInputs(options?: { state?: readonly string[]; limit?: number }): Promise<ControlInputsPageDto>;
  readEvents(sessionId: string, options?: { from?: number; before?: number; after?: number; limit?: number; kinds?: readonly string[] }): Promise<{ events: unknown[]; total: number; nextFrom: number }>;
  readSemanticEvents(
    sessionId: string,
    options?: { from?: number; before?: number; after?: number; limit?: number; kinds?: readonly string[] },
  ): Promise<{ events: ControlSemanticEventDto[]; total: number; nextFrom: number }>;
  get<T = unknown>(path: string, options?: ControlRequestOptions): Promise<ControlHttpResponse<T>>;
  post<T = unknown>(
    path: string,
    body: unknown,
    options?: ControlRequestOptions,
    beforeMutation?: () => Promise<void>,
  ): Promise<ControlHttpResponse<T>>;
}

interface SemanticSessionMemory {
  cursor: number | null;
  checkpoint: CheckpointState;
  settle: TerminalSettleState;
  /** True only after this process has reached one stable recorder tail for this session. */
  initialized: boolean;
  lastTurnStartSeq: number | null;
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
    wait_unavailable: 'Semantic wait is unavailable until the Local Control change feed is supported.',
    internal_error: 'External Orchestrator could not complete the request safely.',
  };
  return messages[code];
}

function stateFor(selection: SelectedSession, inputs: readonly ControlInputDto[]): 'idle' | 'working' {
  if (selection.live.activeTurnId) return 'working';
  return inputs.some((input) => input.sessionId === selection.session.id && input.delivery === 'pending') ? 'working' : 'idle';
}

function sameChangeCut(left: ControlChangesDto, right: ControlChangesDto): boolean {
  return left.instanceId === right.instanceId && left.seq === right.seq;
}

function stateForSemantic(selection: SelectedSession): 'idle' | 'working' {
  const work = selection.live.work;
  return work?.state === 'quiescent' ? 'idle' : 'working';
}

function terminalWake(reason: NonNullable<ExternalOrchestrateResponse['wake_reason']>): boolean {
  return reason === 'completed' || reason === 'failed' || reason === 'stalled' || reason === 'stopped';
}

/**
 * A wire cursor must survive an EO process restart. If terminal evidence is only partially settled,
 * expose the earliest retained terminal fact rather than the process-local read head so a fresh EO
 * can replay enough Core evidence to reconstruct the settle barrier.
 */
function restartSafeSemanticCursor(memory: SemanticSessionMemory, fallback = 0): number {
  const head = memory.cursor ?? fallback;
  const anchors = [memory.settle.finalSeq, memory.settle.endSeq, memory.settle.postEndActivitySeq]
    .filter((value): value is number => value !== null);
  return anchors.length === 0 ? head : Math.min(head, ...anchors);
}

function wakeSummary(reason: NonNullable<ExternalOrchestrateResponse['wake_reason']>, checkpoint?: string): string {
  if (reason === 'checkpoint') return checkpoint ?? 'Prime reported a material checkpoint.';
  const summaries: Record<Exclude<NonNullable<ExternalOrchestrateResponse['wake_reason']>, 'checkpoint'>, string> = {
    blocked: 'Core reports that the supervised Prime is blocked.',
    completed: 'Prime reached a canonical final result and Core is quiescent.',
    failed: 'The supervised Prime turn failed.',
    stalled: 'Core classified the supervised Prime turn as stalled.',
    stopped: 'The supervised Prime turn stopped.',
    control_lost: 'The supervised Core/session relationship changed and requires re-selection.',
    transport_lease_expired: 'The transport compatibility lease expired; this is not a work-progress signal.',
    activity: 'New recorded activity is available.',
  };
  return summaries[reason];
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

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new ControlClientError('request_aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ControlClientError('request_aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
  #semanticWaitSessions = new Set<string>();
  #semanticMemory = new Map<string, SemanticSessionMemory>();

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
          if ('wait_ms' in request) {
            return await this.#wait(health, request.session_id, request.cursor, request.wait_ms, signal);
          }
          return await this.#semanticWait(
            health,
            request.session_id,
            request.cursor,
            request.until,
            request.transport_lease_ms,
            signal,
          );
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

  async #semanticWait(
    health: ControlHealthSnapshot,
    sessionId: string | undefined,
    cursor: number | undefined,
    mode: Exclude<SemanticWaitMode, 'activity'>,
    transportLeaseMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<ExternalOrchestrateResponse> {
    if (!this.#client.supportsSemanticWait(health)) return this.#failure('wait_unavailable', health);
    let selection = await this.#selector.select({ sessionId });
    const id = selection.session.id;
    if (this.#semanticWaitSessions.has(id)) return this.#failure('busy', health, selection);
    this.#semanticWaitSessions.add(id);

    const leaseDeadline = transportLeaseMs === undefined ? null : Date.now() + transportLeaseMs;
    let memory = this.#semanticMemory.get(id);
    if (!memory) {
      memory = {
        cursor: cursor ?? null,
        checkpoint: checkpointStateForTurn(null, false),
        settle: emptyTerminalSettleState(),
        // A fresh process cannot know how much checkpoint budget the caller already consumed.
        // Stay suppressed through the initial bounded backlog; only a turn_start observed after
        // reaching one stable tail can establish a fresh budget.
        initialized: false,
        lastTurnStartSeq: null,
      };
    } else if (cursor !== undefined && memory.cursor !== cursor) {
      // The explicit cursor remains the caller-owned observation boundary, but rewinding/advancing
      // it must not erase process-known checkpoint budget or terminal settle evidence.
      memory = { ...memory, cursor };
    }
    let deferredCheckpoint: { summary?: string } | null = null;

    try {
      for (;;) {
        if (signal?.aborted) throw new ControlClientError('request_aborted');
        if (leaseDeadline !== null && Date.now() >= leaseDeadline) {
          this.#semanticMemory.set(id, memory);
          return this.#success(this.#client.currentHealth() ?? health, selection, {
            state: stateForSemantic(selection),
            cursor: restartSafeSemanticCursor(memory, cursor ?? 0),
            wake_reason: 'transport_lease_expired',
            summary: wakeSummary('transport_lease_expired'),
          });
        }

        const s0 = await this.#client.snapshotChanges({ signal });
        const refreshed = await this.#selector.revalidateForRead(selection);
        const work = refreshed.live.work;
        if (!work) return this.#failure('wait_unavailable', health, refreshed);

        const from: number | null = memory.cursor;
        const page: { events: ControlSemanticEventDto[]; total: number; nextFrom: number } = from === null
          ? await this.#client.readSemanticEvents(id, { limit: SEMANTIC_EVENT_PAGE_SIZE })
          : await this.#client.readSemanticEvents(id, { from, limit: SEMANTIC_EVENT_PAGE_SIZE });
        let caughtUp: boolean = from === null || page.events.length < SEMANTIC_EVENT_PAGE_SIZE;
        if (!caughtUp) {
          const lookahead = await this.#client.readSemanticEvents(id, { from: page.nextFrom, limit: 1 });
          caughtUp = lookahead.events.length === 0;
        }
        const s1 = await this.#client.snapshotChanges({ signal });
        if (!sameChangeCut(s0, s1)) {
          // Stable-cut rule: none of the composite state above is committed.
          continue;
        }

        selection = refreshed;
        const projected: SemanticProjectedEvent[] = page.events
          .map((event) => projectSemanticControlEvent(event, this.#client.sanitizationTokens()))
          .filter((event): event is SemanticProjectedEvent => event !== null);

        let checkpoint = memory.checkpoint;
        const turnStarts = projected
          .filter((event) => event.kind === 'turn_start' && typeof event.turnId === 'string')
          .sort((left, right) => left.seq - right.seq);
        const newestStart = turnStarts.at(-1);
        if (newestStart && (memory.lastTurnStartSeq === null || newestStart.seq > memory.lastTurnStartSeq)) {
          if (memory.initialized) checkpoint = checkpointStateForTurn(newestStart.turnId ?? null, true);
          memory.lastTurnStartSeq = newestStart.seq;
        }

        const decision = classifySemanticWait({
          mode,
          cursor: from ?? 0,
          events: projected,
          work,
          caughtUp,
          checkpoint,
          settle: memory.settle,
        });
        memory = {
          cursor: page.nextFrom,
          checkpoint: decision.checkpoint,
          settle: decision.settle,
          initialized: memory.initialized || caughtUp,
          lastTurnStartSeq: memory.lastTurnStartSeq,
        };
        this.#semanticMemory.set(id, memory);

        // A bounded page may end before the stable recorder tail. Keep consuming immediately so an
        // older checkpoint/turn cannot outrank a newer terminal/intervention in the same Core cut.
        if (!caughtUp && decision.action === 'return' && decision.wakeReason === 'checkpoint') {
          deferredCheckpoint ??= {
            ...(decision.checkpointSummary === undefined ? {} : { summary: decision.checkpointSummary }),
          };
          continue;
        }
        if (!caughtUp && decision.action === 'return' && decision.wakeReason !== 'blocked') continue;
        if (!caughtUp && decision.action === 'pending') continue;

        if (decision.action === 'return') {
          const selectedDecision = deferredCheckpoint !== null && decision.wakeReason === 'checkpoint'
            ? { wakeReason: 'checkpoint' as const, checkpointSummary: deferredCheckpoint.summary }
            : decision;
          const responseCursor = terminalWake(selectedDecision.wakeReason)
            ? memory.cursor ?? 0
            : restartSafeSemanticCursor(memory);
          if (terminalWake(selectedDecision.wakeReason)) {
            // Terminal boundaries are one-shot semantic wakes. Keep the consumed event cursor and
            // checkpoint history, but do not let process-local settle state emit the same boundary
            // again on a later wait with no new Core evidence.
            memory = { ...memory, settle: emptyTerminalSettleState() };
            this.#semanticMemory.set(id, memory);
          }
          return this.#success(this.#client.currentHealth() ?? health, selection, {
            state: stateForSemantic(selection),
            cursor: responseCursor,
            wake_reason: selectedDecision.wakeReason,
            summary: wakeSummary(selectedDecision.wakeReason, selectedDecision.checkpointSummary),
          });
        }
        if (deferredCheckpoint !== null) {
          return this.#success(this.#client.currentHealth() ?? health, selection, {
            state: stateForSemantic(selection),
            cursor: restartSafeSemanticCursor(memory),
            wake_reason: 'checkpoint',
            summary: wakeSummary('checkpoint', deferredCheckpoint.summary),
          });
        }

        const now = Date.now();
        const coreRemaining = work.nextDeadline !== null && work.nextDeadline > now
          ? work.nextDeadline - now
          : work.nextDeadline !== null ? 0 : null;
        const leaseRemaining = leaseDeadline === null ? null : Math.max(0, leaseDeadline - now);
        if (coreRemaining === 0) continue;
        if (leaseRemaining === 0) {
          return this.#success(this.#client.currentHealth() ?? health, selection, {
            state: stateForSemantic(selection),
            cursor: restartSafeSemanticCursor(memory),
            wake_reason: 'transport_lease_expired',
            summary: wakeSummary('transport_lease_expired'),
          });
        }

        let timeoutMs: number | undefined;
        let timeoutKind: 'core' | 'lease' | null = null;
        if (coreRemaining !== null && (leaseRemaining === null || coreRemaining <= leaseRemaining)) {
          timeoutMs = coreRemaining;
          timeoutKind = 'core';
        } else if (leaseRemaining !== null) {
          timeoutMs = leaseRemaining;
          timeoutKind = 'lease';
        }

        try {
          await this.#client.waitForChange(
            { instanceId: s1.instanceId, after: s1.seq },
            { ...(timeoutMs === undefined ? {} : { timeoutMs: Math.max(1, Math.trunc(timeoutMs)) }), signal },
          );
          // `/v1/changes` also invalidates same-epoch configuration such as Allow actions. Refresh
          // health only after a real invalidation/reset so user-visible capability fields cannot
          // remain stale while the semantic wait itself stays event-driven.
          const refreshedHealth = await this.#client.health();
          if (!this.#client.supportsSemanticWait(refreshedHealth)) {
            return this.#failure('wait_unavailable', refreshedHealth, selection);
          }
        } catch (error) {
          if (error instanceof ControlClientError && error.code === 'request_timeout' && timeoutKind !== null) {
            if (timeoutKind === 'core') continue;
            return this.#success(this.#client.currentHealth() ?? health, selection, {
              state: stateForSemantic(selection),
              cursor: restartSafeSemanticCursor(memory),
              wake_reason: 'transport_lease_expired',
              summary: wakeSummary('transport_lease_expired'),
            });
          }
          if (error instanceof ControlClientError && error.code === 'unsupported_control_api') {
            return this.#success(this.#client.currentHealth() ?? health, selection, {
              state: stateForSemantic(selection),
              cursor: restartSafeSemanticCursor(memory),
              wake_reason: 'control_lost',
              summary: wakeSummary('control_lost'),
            });
          }
          if (error instanceof ControlClientError && error.code === 'control_api_unavailable') {
            if (await this.#recoverSemanticReadAfterRestart(signal)) continue;
            return this.#success(this.#client.currentHealth() ?? health, selection, {
              state: stateForSemantic(selection),
              cursor: restartSafeSemanticCursor(memory),
              wake_reason: 'control_lost',
              summary: wakeSummary('control_lost'),
            });
          }
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof SessionSelectionError && error.code === 'session_ineligible') {
        return this.#success(this.#client.currentHealth() ?? health, selection, {
          state: 'working',
          cursor: restartSafeSemanticCursor(memory, cursor ?? 0),
          wake_reason: 'control_lost',
          summary: wakeSummary('control_lost'),
        });
      }
      throw error;
    } finally {
      this.#semanticWaitSessions.delete(id);
    }
  }

  async #recoverSemanticReadAfterRestart(signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + CONTROL_RESTART_GRACE_MS;
    let pause = 25;
    for (;;) {
      if (signal?.aborted) throw new ControlClientError('request_aborted');
      try {
        const health = await this.#client.health();
        return this.#client.supportsSemanticWait(health);
      } catch (error) {
        if (!(error instanceof ControlClientError)
            || !['control_api_unavailable', 'request_timeout'].includes(error.code)) throw error;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await abortableDelay(Math.min(pause, remaining), signal);
      pause = Math.min(pause * 2, 250);
    }
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
      response = await this.#client.post('/v1/inputs', {
        id: reservation.record.inputId,
        sessionId: selection.session.id,
        text: operation.text,
        interrupt: operation.interrupt,
        expectedConversationId: selection.conversationId,
      }, { signal }, () => controller.assertOwned());
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
      if (rejected) {
        this.#assertInputOwnership(rejected, selection.session.id, selection.conversationId);
        // A row that appeared after Core made this refusal may belong to another actor reusing the
        // deterministic UUID. The projection cannot prove full text semantics, so leave this attempt
        // unresolved. A later explicit replay must ask Core to compare the same UUID authoritatively.
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
      response = await this.#client.post(
        `/v1/inputs/${encodeURIComponent(owned.inputId)}/cancel`,
        {},
        { signal },
        () => controller.assertOwned(),
      );
    } catch (error) {
      if (error instanceof ControlClientError && error.ambiguous) {
        return this.#failure('delivery_unknown', health, undefined, { input_id: owned.inputId, delivery: 'unconfirmed' });
      }
      throw error;
    }
    if (response.ambiguous) return this.#failure('delivery_unknown', health, undefined, { input_id: owned.inputId, delivery: 'unconfirmed' });
    if (response.status !== 200) return this.#remoteFailure(response, health, undefined, owned.inputId);
    const cancelled = parseControlCancelResult(response.body);
    const after = cancelled.input;
    this.#assertInputOwnership(after, owned.sessionId);
    if (inputInstanceProof(after) !== owned.inputProofHash) {
      await controller.markConflict({ record: owned, replayed: true });
      return this.#failure('duplicate_request_conflict', health, undefined, {
        input_id: owned.inputId,
        summary: 'The deterministic UUID changed Core input instance while cancellation was settling.',
      });
    }
    if (after.delivery === 'not_sent') {
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
      summary: after.delivery === 'not_sent' ? 'Owned pending input was cancelled before delivery.' : 'Cancel request completed.',
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
      response = await this.#client.post(
        `/v1/sessions/${encodeURIComponent(sessionId)}/stop`,
        { expectedTurnId },
        { signal },
        () => controller.assertOwned(),
      );
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
      ...(extra.wake_reason === undefined ? {} : { wake_reason: extra.wake_reason }),
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
      ...(extra.wake_reason === undefined ? {} : { wake_reason: extra.wake_reason }),
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
