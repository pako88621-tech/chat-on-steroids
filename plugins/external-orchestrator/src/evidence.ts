import {
  sanitizeExternalEvidenceDetail,
  sanitizeExternalEvidenceString,
  type OutboundJsonValue,
} from './evidence-sanitizer.js';
import type { ExternalEvidenceResponse } from './protocol.js';

const MAX_EVIDENCE_ITEMS = 100;
const MAX_SUMMARY_CHARS = 8_000;
const MAX_WAIT_MS = 30_000;
const MIN_POLL_MS = 600;
const MAX_IDLE_POLL_MS = 2_000;
const DEFAULT_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

type ExternalEvidenceItem = ExternalEvidenceResponse['items'][number];
type ExternalEvidenceDetail = NonNullable<ExternalEvidenceItem['detail']>;
type ExternalEvidenceKind = ExternalEvidenceItem['kind'];
type ExternalErrorCode = NonNullable<ExternalEvidenceResponse['error']>['code'];

export interface EvidenceControlResponse<T = unknown> {
  status: number;
  body: T;
  retryAfterMs: number | null;
}

/** Minimal structural seam. The bundle ControlClient satisfies this without an import dependency. */
export interface EvidenceControlClient {
  get<T = unknown>(
    path: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<EvidenceControlResponse<T>>;
}

export interface ControlEventPageDto {
  events: unknown[];
  total: number;
  nextFrom: number;
}

export interface ReadEvidencePageOptions {
  sessionId: string;
  /** Control API `from` cursor: the next recorder sequence number to read. */
  cursor?: number;
  limit?: number;
  level?: 'summary' | 'detail';
  bearerTokens?: Iterable<string>;
  signal?: AbortSignal;
}

export interface EvidencePage {
  /** Next Control API `from` cursor, not the last event sequence returned. */
  cursor: number;
  caught_up: boolean;
  items: ExternalEvidenceItem[];
}

export interface WaitForEvidenceOptions {
  sessionId: string;
  /** Control API `from` cursor: the next recorder sequence number to read. */
  cursor?: number;
  waitMs: number;
  level?: 'summary' | 'detail';
  bearerTokens?: Iterable<string>;
  signal?: AbortSignal;
  now?: () => number;
}

export interface EvidenceWaitResult {
  cursor: number;
  timedOut: boolean;
  item?: ExternalEvidenceItem;
}

export class EvidenceReadError extends Error {
  constructor(
    readonly code: ExternalErrorCode,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'EvidenceReadError';
  }
}

const EVIDENCE_KINDS = new Set<ExternalEvidenceKind>([
  'session_start',
  'user_message',
  'assistant_message',
  'progress',
  'page_tool',
  'turn_start',
  'turn_end',
  'chat_error',
  'tool_call',
  'note',
  'agent_message',
  'handoff',
]);

const activeWaitSessions = new Set<string>();

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

function sanitizeString(value: unknown, max: number, tokens: readonly string[]): string | undefined {
  if (typeof value !== 'string') return undefined;
  return clip(sanitizeExternalEvidenceString(value, tokens), max);
}

function text(value: unknown): string | undefined {
  const object = record(value);
  return object && typeof object.text === 'string' ? object.text : undefined;
}

function evidenceKind(value: unknown): ExternalEvidenceKind | null {
  return typeof value === 'string' && EVIDENCE_KINDS.has(value as ExternalEvidenceKind)
    ? value as ExternalEvidenceKind
    : null;
}

function summaryFor(event: Record<string, unknown>, kind: ExternalEvidenceKind): string {
  if (event.unreadable === true) return `${kind.replaceAll('_', ' ')} event unavailable`;
  switch (kind) {
    case 'session_start':
      return typeof event.title === 'string' && event.title.length > 0
        ? `Session started: ${event.title}`
        : 'Session started';
    case 'user_message':
    case 'assistant_message':
    case 'progress':
    case 'note':
    case 'chat_error':
      return text(event.message) ?? `${kind.replaceAll('_', ' ')} event`;
    case 'page_tool':
      return typeof event.label === 'string' && event.label.length > 0
        ? event.label
        : 'Page tool activity';
    case 'turn_start':
      return typeof event.detail === 'string' && event.detail.length > 0
        ? `Turn started: ${event.detail}`
        : 'Turn started';
    case 'turn_end': {
      const outcome = typeof event.outcome === 'string' && event.outcome.length > 0 ? event.outcome : 'unknown';
      return typeof event.detail === 'string' && event.detail.length > 0
        ? `Turn ended (${outcome}): ${event.detail}`
        : `Turn ended: ${outcome}`;
    }
    case 'tool_call': {
      const tool = record(event.tool);
      const summary = record(tool?.summary);
      const name = typeof tool?.name === 'string' && tool.name.length > 0 ? tool.name : 'Tool call';
      const title = typeof summary?.title === 'string' && summary.title.length > 0 ? summary.title : name;
      const detail = typeof summary?.detail === 'string' && summary.detail.length > 0 ? ` — ${summary.detail}` : '';
      const metric = typeof summary?.metric === 'string' && summary.metric.length > 0 ? ` (${summary.metric})` : '';
      return `${title}${detail}${metric}`;
    }
    case 'agent_message': {
      const from = typeof event.from === 'string' && event.from.length > 0 ? event.from : 'agent';
      const to = typeof event.to === 'string' && event.to.length > 0 ? event.to : 'agent';
      const message = text(event.message);
      return message === undefined ? `${from} → ${to}` : `${from} → ${to}: ${message}`;
    }
    case 'handoff': {
      const reason = typeof event.reason === 'string' && event.reason.length > 0 ? event.reason : 'handoff';
      const chars = nonNegativeInteger(event.chars);
      return chars === null ? `Session handoff (${reason})` : `Session handoff (${reason}, ${chars} chars)`;
    }
  }
}

function commonDetail(event: Record<string, unknown>, tokens: readonly string[]): ExternalEvidenceDetail {
  const detail: ExternalEvidenceDetail = {};
  const turnId = sanitizeString(event.turnId, 256, tokens);
  const model = sanitizeString(event.resolvedModel ?? event.model, 160, tokens);
  if (turnId) detail.turn_id = turnId;
  if (model) detail.model = model;
  return detail;
}

function eventDetail(
  event: Record<string, unknown>,
  kind: ExternalEvidenceKind,
  tokens: readonly string[],
): ExternalEvidenceDetail | undefined {
  if (event.unreadable === true) return undefined;
  const detail = commonDetail(event, tokens);
  const messageId = sanitizeString(event.messageId, 256, tokens);
  if (messageId) detail.message_id = messageId;

  switch (kind) {
    case 'session_start': {
      const title = sanitizeString(event.title, 2_000, tokens);
      if (title) detail.title = title;
      break;
    }
    case 'user_message': {
      const delivery = sanitizeString(event.inputDelivery, 80, tokens);
      if (delivery) detail.delivery = delivery;
      break;
    }
    case 'assistant_message': {
      const state = sanitizeString(event.state, 80, tokens);
      if (state) detail.state = state;
      break;
    }
    case 'progress':
    case 'note':
      break;
    case 'page_tool': {
      const title = sanitizeString(event.label, 2_000, tokens);
      if (title) detail.title = title;
      break;
    }
    case 'turn_start': {
      const value = sanitizeString(event.detail, 2_000, tokens);
      if (value) detail.detail = value;
      break;
    }
    case 'turn_end': {
      const outcome = sanitizeString(event.outcome, 80, tokens);
      const value = sanitizeString(event.detail, 2_000, tokens);
      const reason = sanitizeString(event.reason, 1_000, tokens);
      if (outcome) detail.outcome = outcome;
      if (value) detail.detail = value;
      if (reason) detail.reason = reason;
      break;
    }
    case 'chat_error': {
      const reason = sanitizeString(event.reason, 1_000, tokens);
      if (reason) detail.reason = reason;
      if (typeof event.recoverable === 'boolean') detail.recoverable = event.recoverable;
      if (typeof event.blocking === 'boolean') detail.blocking = event.blocking;
      break;
    }
    case 'tool_call': {
      const tool = record(event.tool);
      const toolSummary = record(tool?.summary);
      const name = sanitizeString(tool?.name, 160, tokens);
      const outcome = sanitizeString(tool?.outcome, 80, tokens);
      const title = sanitizeString(toolSummary?.title, 2_000, tokens);
      const toolDetail = sanitizeString(toolSummary?.detail, 2_000, tokens);
      const metric = sanitizeString(toolSummary?.metric, 500, tokens);
      const durationMs = nonNegativeInteger(tool?.durationMs);
      if (name) detail.tool = name;
      if (outcome) detail.outcome = outcome;
      if (title) detail.title = title;
      if (toolDetail) detail.detail = toolDetail;
      if (metric) detail.metric = metric;
      if (durationMs !== null) detail.duration_ms = durationMs;
      if (Array.isArray(tool?.changes)) {
        const changes: NonNullable<ExternalEvidenceDetail['changes']> = [];
        for (const rawChange of tool.changes.slice(0, 64)) {
          const change = record(rawChange);
          if (!change) continue;
          const path = sanitizeString(change.path, 1_000, tokens);
          const added = nonNegativeInteger(change.added);
          const removed = nonNegativeInteger(change.removed);
          if (path === undefined || added === null || removed === null) continue;
          changes.push({ path, added, removed });
        }
        if (changes.length > 0) detail.changes = changes;
      }
      break;
    }
    case 'agent_message': {
      const from = sanitizeString(event.from, 160, tokens);
      const to = sanitizeString(event.to, 160, tokens);
      const delivery = sanitizeString(event.delivery, 80, tokens);
      if (from) detail.from = from;
      if (to) detail.to = to;
      if (delivery) detail.delivery = delivery;
      break;
    }
    case 'handoff': {
      const reason = sanitizeString(event.reason, 1_000, tokens);
      if (reason) detail.reason = reason;
      break;
    }
  }

  if (Object.keys(detail).length === 0) return undefined;
  return sanitizeExternalEvidenceDetail(
    detail as Record<string, OutboundJsonValue>,
    tokens,
  ) as ExternalEvidenceDetail;
}

/**
 * Project one allowlisted Local Control event. Unknown kinds and rows without safe cursor/time
 * identity are intentionally omitted; page cursor advancement still prevents them from stalling a
 * reader. Raw tool args/results are never inspected or copied.
 */
export function projectControlEvent(
  value: unknown,
  level: 'summary' | 'detail' = 'summary',
  bearerTokens: Iterable<string> = [],
): ExternalEvidenceItem | null {
  const event = record(value);
  if (!event) return null;
  const seq = nonNegativeInteger(event.seq);
  const time = nonNegativeInteger(event.time);
  const kind = evidenceKind(event.kind);
  if (seq === null || time === null || kind === null) return null;
  const tokens = [...bearerTokens];
  const summary = clip(sanitizeExternalEvidenceString(summaryFor(event, kind), tokens), MAX_SUMMARY_CHARS);
  const detail = level === 'detail' ? eventDetail(event, kind, tokens) : undefined;
  return { seq, time, kind, summary, ...(detail ? { detail } : {}) };
}

function fixedError(code: ExternalErrorCode, retryAfterMs: number | null = null): EvidenceReadError {
  const messages: Partial<Record<ExternalErrorCode, string>> = {
    control_api_unavailable: 'Chat On Steroids Local Control API is unavailable.',
    unsupported_control_api: 'Chat On Steroids Local Control API is not compatible with this External Orchestrator build.',
    session_not_found: 'The requested Chat On Steroids session does not exist.',
    busy: 'Chat On Steroids is busy reading session evidence; retry shortly.',
    rate_limited: 'Chat On Steroids is rate limiting evidence reads; retry later.',
    internal_error: 'External Orchestrator could not read session evidence safely.',
  };
  return new EvidenceReadError(code, messages[code] ?? 'External Orchestrator could not read session evidence safely.', retryAfterMs);
}

function clientError(error: unknown, signal?: AbortSignal): EvidenceReadError | Error {
  if (signal?.aborted) return abortError();
  const value = record(error);
  const code = value?.code;
  if (code === 'request_aborted') return abortError();
  if (code === 'control_api_unavailable' || code === 'request_timeout') return fixedError('control_api_unavailable');
  if (code === 'unsupported_control_api') return fixedError('unsupported_control_api');
  return fixedError('internal_error');
}

function errorCode(body: unknown): string | null {
  const value = record(body);
  return typeof value?.error === 'string' ? value.error : null;
}

function parsePage(body: unknown, from: number, limit: number): ControlEventPageDto {
  const value = record(body);
  if (!value || !Array.isArray(value.events) || value.events.length > limit) throw fixedError('internal_error');
  const total = nonNegativeInteger(value.total);
  const nextFrom = nonNegativeInteger(value.nextFrom);
  if (total === null || nextFrom === null || nextFrom < from) throw fixedError('internal_error');
  if ((value.events.length === 0 && nextFrom !== from) || (value.events.length > 0 && nextFrom <= from)) {
    throw fixedError('internal_error');
  }
  return { events: value.events, total, nextFrom };
}

function eventPath(sessionId: string, from: number, limit: number): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/events?from=${from}&limit=${limit}`;
}

async function fetchEventPage(
  client: EvidenceControlClient,
  sessionId: string,
  from: number,
  limit: number,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<ControlEventPageDto> {
  let response: EvidenceControlResponse<unknown>;
  try {
    response = await client.get(eventPath(sessionId, from, limit), {
      signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  } catch (error) {
    throw clientError(error, signal);
  }
  if (response.status === 200) return parsePage(response.body, from, limit);
  if (response.status === 404) throw fixedError('session_not_found');
  if (response.status === 429) throw fixedError('rate_limited', boundedRetry(response.retryAfterMs));
  if (response.status === 503 && errorCode(response.body) === 'busy') {
    throw fixedError('busy', boundedRetry(response.retryAfterMs));
  }
  if (response.status === 401 || response.status === 503) throw fixedError('control_api_unavailable');
  throw fixedError('internal_error');
}

function boundedRetry(value: number | null): number {
  if (value === null || !Number.isFinite(value) || value < 0) return DEFAULT_RETRY_MS;
  return Math.min(MAX_RETRY_MS, Math.max(MIN_POLL_MS, Math.trunc(value)));
}

/**
 * Read one bounded EO evidence page. Cursor semantics mirror Control API `nextFrom`: callers pass
 * the returned cursor unchanged on the next read. A single one-row lookahead is used only when the
 * first page filled its requested limit, which makes the exact page boundary `caught_up` truthful.
 */
export async function readEvidencePage(
  client: EvidenceControlClient,
  options: ReadEvidencePageOptions,
): Promise<EvidencePage> {
  const from = boundedInt(options.cursor, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInt(options.limit, 40, 1, MAX_EVIDENCE_ITEMS);
  const tokens = [...(options.bearerTokens ?? [])];
  const page = await fetchEventPage(client, options.sessionId, from, limit, options.signal);
  const items = page.events
    .map((event) => projectControlEvent(event, options.level ?? 'summary', tokens))
    .filter((item): item is ExternalEvidenceItem => item !== null);

  let caughtUp = true;
  if (page.events.length === limit) {
    const lookahead = await fetchEventPage(client, options.sessionId, page.nextFrom, 1, options.signal);
    caughtUp = lookahead.events.length === 0;
  }
  return { cursor: page.nextFrom, caught_up: caughtUp, items };
}

function abortError(): Error {
  const error = new Error('Evidence wait was cancelled.');
  error.name = 'AbortError';
  return error;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(), ms);
    timer.unref?.();
    const onAbort = (): void => finish(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Poll one session for the next publishable EO evidence row. Only one loop per session may exist in
 * this Node process. Empty polls start at 600ms and back off to 2s; 429/503 busy delays honor the
 * client's Retry-After value. The caller's cancellation signal interrupts both HTTP and sleep.
 */
export async function waitForEvidence(
  client: EvidenceControlClient,
  options: WaitForEvidenceOptions,
): Promise<EvidenceWaitResult> {
  if (activeWaitSessions.has(options.sessionId)) throw fixedError('busy', MIN_POLL_MS);
  activeWaitSessions.add(options.sessionId);
  const now = options.now ?? Date.now;
  const waitMs = boundedInt(options.waitMs, 15_000, 0, MAX_WAIT_MS);
  const deadline = now() + waitMs;
  const tokens = [...(options.bearerTokens ?? [])];
  let cursor = boundedInt(options.cursor, 0, 0, Number.MAX_SAFE_INTEGER);
  let idleDelay = MIN_POLL_MS;

  try {
    for (;;) {
      if (options.signal?.aborted) throw abortError();
      const remaining = Math.max(0, deadline - now());
      if (remaining === 0) return { cursor, timedOut: true };

      try {
        const page = await fetchEventPage(
          client,
          options.sessionId,
          cursor,
          1,
          options.signal,
          Math.max(1, remaining),
        );
        if (page.events.length > 0) {
          cursor = page.nextFrom;
          const item = projectControlEvent(page.events[0], options.level ?? 'summary', tokens);
          if (item) return { cursor, timedOut: false, item };
          // The recorder may grow a kind the EO protocol does not publish. Advance through it,
          // but yield briefly so a run of such rows cannot become a tight HTTP loop.
          await sleep(Math.min(MIN_POLL_MS, Math.max(0, deadline - now())), options.signal);
          idleDelay = MIN_POLL_MS;
          continue;
        }

        const pause = Math.min(idleDelay, Math.max(0, deadline - now()));
        await sleep(pause, options.signal);
        idleDelay = Math.min(MAX_IDLE_POLL_MS, Math.ceil(idleDelay * 1.5));
      } catch (error) {
        if (!(error instanceof EvidenceReadError) || (error.code !== 'busy' && error.code !== 'rate_limited')) throw error;
        const pause = Math.min(error.retryAfterMs ?? DEFAULT_RETRY_MS, Math.max(0, deadline - now()));
        await sleep(pause, options.signal);
      }
    }
  } finally {
    activeWaitSessions.delete(options.sessionId);
  }
}
