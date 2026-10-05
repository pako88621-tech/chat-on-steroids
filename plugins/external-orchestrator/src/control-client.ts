import http from 'node:http';
import { z } from 'zod';
import type { ExternalOrchestratorConfig } from './config.js';
import { loadExternalOrchestratorConfig } from './config.js';
import {
  ControlDiscoveryError,
  discoverControlPublication,
  sameControlEpoch,
  type ControlEpoch,
  type DiscoveredControlPublication,
} from './discovery.js';

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const HEALTH_TIMEOUT_MS = 5_000;
const READ_TIMEOUT_MS = 17_500;
const MUTATION_TIMEOUT_MS = 22_500;
const MAX_CALL_TIMEOUT_MS = 30_000;

export const REQUIRED_CONTROL_ROUTES = Object.freeze([
  '/v1/health',
  '/v1/status',
  '/v1/sessions',
  '/v1/sessions/{id}',
  '/v1/sessions/{id}/events',
  '/v1/inputs',
] as const);

export const REQUIRED_CONTROL_ACTION_ROUTES = Object.freeze([
  'POST /v1/inputs',
  'POST /v1/inputs/{id}/cancel',
  'POST /v1/sessions/{id}/stop',
] as const);

export const REQUIRED_CONTROL_ACTION_FEATURES = Object.freeze([
  'input_expected_conversation',
] as const);

export type ControlClientErrorCode =
  | 'control_api_unavailable'
  | 'unsupported_control_api'
  | 'invalid_request'
  | 'invalid_response'
  | 'response_too_large'
  | 'request_timeout'
  | 'request_aborted'
  | 'mutation_ambiguous';

export class ControlClientError extends Error {
  readonly code: ControlClientErrorCode;
  readonly ambiguous: boolean;

  constructor(code: ControlClientErrorCode, ambiguous = false) {
    const messages: Record<ControlClientErrorCode, string> = {
      control_api_unavailable: 'Chat On Steroids Local Control API is unavailable.',
      unsupported_control_api: 'Chat On Steroids Local Control API is not compatible with this External Orchestrator build.',
      invalid_request: 'External Orchestrator refused an invalid Local Control API request.',
      invalid_response: 'Chat On Steroids Local Control API returned an invalid response.',
      response_too_large: 'Chat On Steroids Local Control API response exceeded the allowed size.',
      request_timeout: 'Chat On Steroids Local Control API request timed out.',
      request_aborted: 'Chat On Steroids Local Control API request was cancelled.',
      mutation_ambiguous: 'The Local Control API mutation outcome is unknown; reconcile before retrying.',
    };
    super(messages[code]);
    this.name = 'ControlClientError';
    this.code = code;
    this.ambiguous = ambiguous;
  }
}

export interface ControlHealthSnapshot {
  ok: true;
  protocol: number;
  routes: readonly string[];
  actions: { enabled: boolean; routes: readonly string[]; features: readonly string[] };
  pid: number;
  appVersion: string;
  startedAt: string;
  uptimeSeconds: number;
  epoch: ControlEpoch;
}

export interface ControlHttpResponse<T = unknown> {
  status: number;
  body: T;
  retryAfterMs: number | null;
  epoch: ControlEpoch;
  ambiguous: boolean;
}

export interface ControlRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ControlSessionSummaryDto {
  id: string;
  title: string;
  conversationId: string | null;
  projectId: string | null;
  updatedAt: number;
  endedAt: number | null;
  activeTurnId: string | null;
  origin: { kind: string } | null;
}

export interface ControlSessionLiveDto {
  activeTurnId: string | null;
  stopPending: boolean;
  blocked: string;
  canSendDirectly: boolean;
  canInject: boolean;
  queueAtFinish: boolean;
}

export interface ControlSessionDetailDto {
  session: ControlSessionSummaryDto;
  live?: ControlSessionLiveDto | null;
}

export interface ControlSessionPageDto {
  sessions: ControlSessionSummaryDto[];
  total: number;
  nextCursor: string | null;
  activeId: string | null;
}

export interface ControlTextDto {
  text: string;
  chars: number;
  truncated: boolean;
}

export interface ControlInputDto {
  id: string;
  sessionId: string | null;
  deliveredSessionId: string | null;
  conversationId: string | null;
  state: string;
  delivery: 'sent' | 'not_sent' | 'unconfirmed' | 'pending';
  automatic: boolean;
  purpose: string | null;
  createdAt: number;
  dueAt: number;
  sendAuthorizedAt: number | null;
  text: ControlTextDto;
}

export interface ControlInputsPageDto {
  inputs: ControlInputDto[];
  total: number;
}

export interface ControlEventChangeDto {
  path: string;
  added: number;
  removed: number;
}

export interface ControlEventDto {
  seq: number;
  position: number;
  time: number;
  kind: string;
  source: string;
  unreadable?: true;
  agent?: string;
  turnId?: string;
  model?: string;
  message?: ControlTextDto;
  messageId?: string;
  inputId?: string;
  inputDelivery?: string;
  final?: boolean;
  state?: string;
  resolvedModel?: string;
  conversationId?: string | null;
  title?: string;
  outcome?: string;
  detail?: string;
  reason?: string;
  recoverable?: boolean;
  blocking?: boolean;
  label?: string;
  tool?: {
    callId: string;
    name: string;
    outcome: string;
    durationMs: number;
    attribution: string;
    summary: { title: string; detail?: string; metric?: string; tone: string; kind: string };
    args: ControlTextDto;
    result: ControlTextDto;
    changes: ControlEventChangeDto[];
  };
  from?: string;
  to?: string;
  delivery?: string;
  handoffId?: string;
  chars?: number;
}

export interface ControlEventsPageDto {
  events: ControlEventDto[];
  total: number;
  nextFrom: number;
}

export interface ControlListInputsOptions {
  state?: readonly string[];
  limit?: number;
}

export interface ControlReadEventsOptions {
  from?: number;
  before?: number;
  after?: number;
  limit?: number;
  kinds?: readonly string[];
}

export class ControlRemoteError extends Error {
  constructor(
    readonly status: number,
    readonly remoteCode: string | null,
    readonly retryAfterMs: number | null,
  ) {
    super(`Chat On Steroids Local Control API rejected the request with HTTP ${status}.`);
    this.name = 'ControlRemoteError';
  }
}

interface LiveControlEpoch {
  publication: DiscoveredControlPublication;
  health: ControlHealthSnapshot;
}

interface RawResponse {
  status: number;
  body: unknown;
  retryAfterMs: number | null;
}

interface TransportFailure {
  kind: 'transport';
  code: string | null;
  connected: boolean;
  requestFinished: boolean;
  timeout: boolean;
  aborted: boolean;
}

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sessionIdSchema = z.string().regex(/^[0-9a-z-]{8,64}$/u);
const nullableBoundedString = (max: number) => z.string().max(max).nullable();
const controlTextSchema = z.object({
  text: z.string().max(4_000),
  chars: safeInteger,
  truncated: z.boolean(),
});
const sessionSummarySchema = z.object({
  id: sessionIdSchema,
  title: z.string().max(2_000),
  conversationId: nullableBoundedString(256),
  projectId: nullableBoundedString(256),
  updatedAt: safeInteger,
  endedAt: safeInteger.nullable(),
  activeTurnId: nullableBoundedString(256),
  origin: z.object({ kind: z.string().min(1).max(80) }).nullable(),
});
const sessionLiveSchema = z.object({
  activeTurnId: nullableBoundedString(256),
  stopPending: z.boolean(),
  blocked: z.string().max(80),
  canSendDirectly: z.boolean(),
  canInject: z.boolean(),
  queueAtFinish: z.boolean(),
});
const sessionDetailSchema = z.object({
  session: sessionSummarySchema,
  live: sessionLiveSchema.nullable().optional(),
});
const sessionPageSchema = z.object({
  sessions: z.array(sessionSummarySchema).max(50),
  total: safeInteger,
  nextCursor: z.string().min(1).max(100).nullable(),
  activeId: sessionIdSchema.nullable(),
});
const controlInputSchema = z.object({
  id: z.string().uuid(),
  sessionId: sessionIdSchema.nullable(),
  deliveredSessionId: sessionIdSchema.nullable(),
  conversationId: nullableBoundedString(256),
  state: z.string().min(1).max(80),
  delivery: z.enum(['sent', 'not_sent', 'unconfirmed', 'pending']),
  automatic: z.boolean(),
  purpose: nullableBoundedString(80),
  createdAt: safeInteger,
  dueAt: safeInteger,
  sendAuthorizedAt: safeInteger.nullable(),
  text: controlTextSchema,
});
const inputsPageSchema = z.object({
  inputs: z.array(controlInputSchema).max(500),
  total: safeInteger,
});
const eventChangeSchema = z.object({
  path: z.string().max(1_000),
  added: safeInteger,
  removed: safeInteger,
});
const eventToolSchema = z.object({
  callId: z.string().max(256),
  name: z.string().max(160),
  outcome: z.string().max(80),
  durationMs: safeInteger,
  attribution: z.string().max(80),
  summary: z.object({
    title: z.string().max(2_000),
    detail: z.string().max(2_000).optional(),
    metric: z.string().max(500).optional(),
    tone: z.string().max(80),
    kind: z.string().max(80),
  }),
  args: controlTextSchema,
  result: controlTextSchema,
  changes: z.array(eventChangeSchema).max(64),
});
const eventSchema = z.object({
  seq: safeInteger,
  position: safeInteger,
  time: safeInteger,
  kind: z.string().min(1).max(80),
  source: z.string().max(80),
  unreadable: z.literal(true).optional(),
  agent: z.string().max(160).optional(),
  turnId: z.string().max(256).optional(),
  model: z.string().max(160).optional(),
  message: controlTextSchema.optional(),
  messageId: z.string().max(256).optional(),
  inputId: z.string().max(256).optional(),
  inputDelivery: z.string().max(80).optional(),
  final: z.boolean().optional(),
  state: z.string().max(80).optional(),
  resolvedModel: z.string().max(160).optional(),
  conversationId: nullableBoundedString(256).optional(),
  title: z.string().max(2_000).optional(),
  outcome: z.string().max(80).optional(),
  detail: z.string().max(2_000).optional(),
  reason: z.string().max(2_000).optional(),
  recoverable: z.boolean().optional(),
  blocking: z.boolean().optional(),
  label: z.string().max(2_000).optional(),
  tool: eventToolSchema.optional(),
  from: z.string().max(160).optional(),
  to: z.string().max(160).optional(),
  delivery: z.string().max(80).optional(),
  handoffId: z.string().max(256).optional(),
  chars: safeInteger.optional(),
});
const eventsPageSchema = z.object({
  events: z.array(eventSchema).max(100),
  total: safeInteger,
  nextFrom: safeInteger,
});

function isTransportFailure(value: unknown): value is TransportFailure {
  return !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'transport';
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1 || value > MAX_CALL_TIMEOUT_MS) throw new ControlClientError('invalid_request');
  return Math.floor(value);
}

function validPath(path: string): boolean {
  return path.length > 0
    && path.length <= 8_192
    && path.startsWith('/')
    && !path.startsWith('//')
    && !path.includes('\\')
    && /^[\x21-\x7e]+$/u.test(path);
}

function retryAfterMs(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^\d{1,6}$/u.test(raw)) return null;
  return Math.min(Number(raw) * 1_000, 5 * 60_000);
}

function jsonBody(buffer: Buffer): unknown {
  if (buffer.length === 0) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new ControlClientError('invalid_response');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ControlClientError('invalid_response');
  }
}

function requestJson(
  publication: DiscoveredControlPublication,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RawResponse> {
  if (!validPath(path)) return Promise.reject(new ControlClientError('invalid_request'));
  let payload: Buffer | undefined;
  if (method === 'POST') {
    try {
      payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
    } catch {
      return Promise.reject(new ControlClientError('invalid_request'));
    }
    if (payload.length > MAX_REQUEST_BYTES) return Promise.reject(new ControlClientError('invalid_request'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let connected = false;
    let requestFinished = false;
    let timedOut = false;
    let aborted = false;
    const finish = (error?: unknown, response?: RawResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error);
      else resolve(response!);
    };
    const req = http.request({
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: publication.endpoint.port,
      method,
      path,
      agent: false,
      headers: {
        authorization: `Bearer ${publication.token}`,
        accept: 'application/json',
        ...(payload ? {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(payload.length),
        } : {}),
      },
    }, (res) => {
      const declared = res.headers['content-length'];
      if (declared !== undefined && (!/^\d{1,9}$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
        res.resume();
        req.destroy();
        finish(new ControlClientError('response_too_large'));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          res.destroy();
          req.destroy();
          finish(new ControlClientError('response_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        let parsed: unknown;
        try {
          parsed = jsonBody(Buffer.concat(chunks, total));
        } catch (error) {
          finish(error);
          return;
        }
        finish(undefined, {
          status: res.statusCode ?? 0,
          body: parsed,
          retryAfterMs: retryAfterMs(res.headers['retry-after']),
        });
      });
      res.on('error', (error: NodeJS.ErrnoException) => finish({
        kind: 'transport', code: error.code ?? null, connected, requestFinished, timeout: timedOut, aborted,
      } satisfies TransportFailure));
    });
    req.once('socket', (socket) => {
      if (!socket.connecting) connected = true;
      else socket.once('connect', () => { connected = true; });
    });
    req.once('finish', () => { requestFinished = true; });
    req.once('error', (error: NodeJS.ErrnoException) => finish({
      kind: 'transport', code: error.code ?? null, connected, requestFinished, timeout: timedOut, aborted,
    } satisfies TransportFailure));
    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
      finish({ kind: 'transport', code: null, connected, requestFinished, timeout: true, aborted: false } satisfies TransportFailure);
    }, timeoutMs);
    timer.unref?.();
    const onAbort = (): void => {
      aborted = true;
      req.destroy();
      finish({ kind: 'transport', code: null, connected, requestFinished, timeout: false, aborted: true } satisfies TransportFailure);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    if (!settled) {
      if (payload) req.end(payload);
      else req.end();
    }
  });
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length > 200)) return null;
  return value as string[];
}

function parseDto<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ControlClientError('invalid_response');
  return parsed.data;
}

function remoteCodeOf(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const code = (body as Record<string, unknown>).error;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(code) ? code : null;
}

function rejectRemote(response: ControlHttpResponse<unknown>): never {
  throw new ControlRemoteError(response.status, remoteCodeOf(response.body), response.retryAfterMs);
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new ControlClientError('invalid_request');
  return value;
}

function sessionId(value: string): string {
  const parsed = sessionIdSchema.safeParse(value);
  if (!parsed.success) throw new ControlClientError('invalid_request');
  return parsed.data;
}

function parseHealth(body: unknown, epoch: ControlEpoch): ControlHealthSnapshot {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ControlClientError('invalid_response');
  const value = body as Record<string, unknown>;
  const routes = stringArray(value.routes);
  const actionsValue = value.actions;
  if (value.ok !== true || !Number.isInteger(value.protocol) || !Number.isSafeInteger(value.pid)
      || typeof value.appVersion !== 'string' || value.appVersion.length > 160
      || typeof value.startedAt !== 'string' || value.startedAt.length > 80
      || typeof value.uptimeSeconds !== 'number' || !Number.isFinite(value.uptimeSeconds) || value.uptimeSeconds < 0
      || routes === null || !actionsValue || typeof actionsValue !== 'object' || Array.isArray(actionsValue)) {
    throw new ControlClientError('invalid_response');
  }
  const actions = actionsValue as Record<string, unknown>;
  const actionRoutes = stringArray(actions.routes);
  const actionFeatures = stringArray(actions.features);
  if (typeof actions.enabled !== 'boolean' || actionRoutes === null || actionFeatures === null) {
    throw new ControlClientError('invalid_response');
  }
  return {
    ok: true,
    protocol: value.protocol as number,
    routes,
    actions: { enabled: actions.enabled, routes: actionRoutes, features: actionFeatures },
    pid: value.pid as number,
    appVersion: value.appVersion,
    startedAt: value.startedAt,
    uptimeSeconds: value.uptimeSeconds,
    epoch,
  };
}

function hasRequiredRoutes(health: ControlHealthSnapshot): boolean {
  const reads = new Set(health.routes);
  const actions = new Set(health.actions.routes);
  const features = new Set(health.actions.features);
  return REQUIRED_CONTROL_ROUTES.every((route) => reads.has(route))
    && REQUIRED_CONTROL_ACTION_ROUTES.every((route) => actions.has(route))
    && REQUIRED_CONTROL_ACTION_FEATURES.every((feature) => features.has(feature));
}

function publicationError(error: unknown): ControlClientError {
  if (error instanceof ControlClientError) return error;
  if (error instanceof ControlDiscoveryError) return new ControlClientError('control_api_unavailable');
  return new ControlClientError('control_api_unavailable');
}

function transportReadError(failure: TransportFailure): ControlClientError {
  if (failure.aborted) return new ControlClientError('request_aborted');
  if (failure.timeout) return new ControlClientError('request_timeout');
  return new ControlClientError('control_api_unavailable');
}

function staleReadTransport(failure: TransportFailure): boolean {
  return failure.code === 'ECONNREFUSED' || failure.code === 'ECONNRESET' || failure.code === 'EPIPE';
}

function transportMutationError(failure: TransportFailure): ControlClientError {
  if (failure.aborted && (failure.connected || failure.requestFinished)) return new ControlClientError('mutation_ambiguous', true);
  if (failure.timeout && (failure.connected || failure.requestFinished)) return new ControlClientError('mutation_ambiguous', true);
  if (failure.connected || failure.requestFinished || (failure.code !== null && failure.code !== 'ECONNREFUSED')) {
    return new ControlClientError('mutation_ambiguous', true);
  }
  if (failure.aborted) return new ControlClientError('request_aborted');
  if (failure.timeout) return new ControlClientError('request_timeout');
  return new ControlClientError('control_api_unavailable');
}

function ambiguousMutationResponse(response: RawResponse): boolean {
  if (response.status === 504) {
    const body = response.body && typeof response.body === 'object' && !Array.isArray(response.body)
      ? response.body as Record<string, unknown>
      : null;
    return !(body?.error === 'timeout'
      && body.detail === 'the action did not start and will not run; it is safe to send again');
  }
  if (response.status === 500 || response.status === 502) return true;
  if (response.status !== 503) return false;
  const code = response.body && typeof response.body === 'object' && !Array.isArray(response.body)
    ? (response.body as Record<string, unknown>).error
    : undefined;
  return !['busy', 'queue_full', 'shutting_down', 'stop_unavailable'].includes(String(code ?? ''));
}

export class ControlClient {
  private live: LiveControlEpoch | null = null;
  private redactionTokens: string[] = [];

  constructor(private readonly config: ExternalOrchestratorConfig = loadExternalOrchestratorConfig()) {}

  currentEpoch(): ControlEpoch | null {
    return this.live?.publication.epoch ?? null;
  }

  /** Internal-only redaction material. Never place these values in MCP output, logs or config. */
  sanitizationTokens(): readonly string[] {
    return [...this.redactionTokens];
  }

  invalidate(): void {
    this.live = null;
    this.redactionTokens = [];
  }

  private rememberRedactionToken(token: string): void {
    this.redactionTokens = [token, ...this.redactionTokens.filter((value) => value !== token)].slice(0, 2);
  }

  private async establishLive(previous?: ControlEpoch): Promise<LiveControlEpoch> {
    let lastEpoch: ControlEpoch | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let publication: DiscoveredControlPublication;
      try {
        publication = await discoverControlPublication(this.config);
      } catch (error) {
        throw publicationError(error);
      }
      lastEpoch = publication.epoch;
      if (!this.config.supportedControlApiProtocols.includes(publication.endpoint.protocol)) {
        throw new ControlClientError('unsupported_control_api');
      }
      if (previous && attempt === 0 && sameControlEpoch(previous, publication.epoch)) {
        // A stale read may ask to rediscover once. Reusing the exact same publication is not a new epoch.
        throw new ControlClientError('control_api_unavailable');
      }
      let response: RawResponse;
      try {
        response = await requestJson(publication, 'GET', '/v1/health', undefined, HEALTH_TIMEOUT_MS);
      } catch (error) {
        if (isTransportFailure(error)) {
          if (attempt === 0) continue;
          throw transportReadError(error);
        }
        throw publicationError(error);
      }
      if (response.status === 401) {
        if (attempt === 0) continue;
        throw new ControlClientError('control_api_unavailable');
      }
      if (response.status !== 200) throw new ControlClientError('control_api_unavailable');
      const health = parseHealth(response.body, publication.epoch);
      if (health.pid !== publication.endpoint.pid || health.protocol !== publication.endpoint.protocol) {
        if (attempt === 0) continue;
        throw new ControlClientError('control_api_unavailable');
      }
      if (!this.config.supportedControlApiProtocols.includes(health.protocol) || !hasRequiredRoutes(health)) {
        throw new ControlClientError('unsupported_control_api');
      }
      const live = { publication, health };
      this.live = live;
      this.rememberRedactionToken(publication.token);
      return live;
    }
    void lastEpoch;
    throw new ControlClientError('control_api_unavailable');
  }

  async health(): Promise<ControlHealthSnapshot> {
    return (await this.establishLive()).health;
  }

  async get<T = unknown>(path: string, options: ControlRequestOptions = {}): Promise<ControlHttpResponse<T>> {
    const timeoutMs = boundedTimeout(options.timeoutMs, READ_TIMEOUT_MS);
    const first = this.live ?? await this.establishLive();
    let response: RawResponse;
    try {
      response = await requestJson(first.publication, 'GET', path, undefined, timeoutMs, options.signal);
    } catch (error) {
      if (!isTransportFailure(error)) throw error;
      if (error.aborted || !staleReadTransport(error)) throw transportReadError(error);
      this.live = null;
      const next = await this.establishLive(first.publication.epoch);
      try {
        response = await requestJson(next.publication, 'GET', path, undefined, timeoutMs, options.signal);
      } catch (retryError) {
        if (isTransportFailure(retryError)) throw transportReadError(retryError);
        throw retryError;
      }
      return { ...response, body: response.body as T, epoch: next.publication.epoch, ambiguous: false };
    }
    if (response.status === 401) {
      this.live = null;
      const next = await this.establishLive(first.publication.epoch);
      try {
        response = await requestJson(next.publication, 'GET', path, undefined, timeoutMs, options.signal);
      } catch (retryError) {
        if (isTransportFailure(retryError)) throw transportReadError(retryError);
        throw retryError;
      }
      return { ...response, body: response.body as T, epoch: next.publication.epoch, ambiguous: false };
    }
    return { ...response, body: response.body as T, epoch: first.publication.epoch, ambiguous: false };
  }

  async listSessions(options: { limit: number; cursor?: string }): Promise<ControlSessionPageDto> {
    const limit = boundedInteger(options.limit, 1, 50);
    if (options.cursor !== undefined && !/^\d{1,16}\.[0-9a-z-]{8,64}$/u.test(options.cursor)) {
      throw new ControlClientError('invalid_request');
    }
    const query = new URLSearchParams({ limit: String(limit) });
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    const response = await this.get(`/v1/sessions?${query.toString()}`);
    if (response.status !== 200) rejectRemote(response);
    return parseDto(sessionPageSchema, response.body);
  }

  async getSession(sessionIdValue: string, options: { live: true }): Promise<ControlSessionDetailDto | null> {
    const id = sessionId(sessionIdValue);
    if (options.live !== true) throw new ControlClientError('invalid_request');
    const response = await this.get(`/v1/sessions/${id}?live=1`);
    if (response.status === 404 && remoteCodeOf(response.body) === 'session_not_found') return null;
    if (response.status !== 200) rejectRemote(response);
    const detail = parseDto(sessionDetailSchema, response.body);
    if (detail.session.id !== id) throw new ControlClientError('invalid_response');
    return detail;
  }

  async listInputs(options: ControlListInputsOptions = {}): Promise<ControlInputsPageDto> {
    const limit = boundedInteger(options.limit ?? 100, 1, 500);
    const query = new URLSearchParams({ limit: String(limit) });
    if (options.state !== undefined) {
      if (options.state.length < 1 || options.state.length > 32
          || options.state.some((state) => !/^[a-z][a-z0-9_-]{0,79}$/u.test(state))) {
        throw new ControlClientError('invalid_request');
      }
      query.set('state', options.state.join(','));
    }
    const response = await this.get(`/v1/inputs?${query.toString()}`);
    if (response.status !== 200) rejectRemote(response);
    return parseDto(inputsPageSchema, response.body);
  }

  async readEvents(sessionIdValue: string, options: ControlReadEventsOptions = {}): Promise<ControlEventsPageDto> {
    const id = sessionId(sessionIdValue);
    if (options.from !== undefined && (options.before !== undefined || options.after !== undefined)) {
      throw new ControlClientError('invalid_request');
    }
    const query = new URLSearchParams();
    if (options.from !== undefined) query.set('from', String(boundedInteger(options.from, 0, 10_000_000)));
    if (options.before !== undefined) query.set('before', String(boundedInteger(options.before, 1, 10_000_000)));
    if (options.after !== undefined) query.set('after', String(boundedInteger(options.after, 0, 10_000_000)));
    query.set('limit', String(boundedInteger(options.limit ?? 50, 1, 100)));
    if (options.kinds !== undefined) {
      if (options.kinds.length < 1 || options.kinds.length > 32
          || options.kinds.some((kind) => !/^[a-z][a-z0-9_]{0,79}$/u.test(kind))) {
        throw new ControlClientError('invalid_request');
      }
      query.set('kinds', options.kinds.join(','));
    }
    const response = await this.get(`/v1/sessions/${id}/events?${query.toString()}`);
    if (response.status !== 200) rejectRemote(response);
    return parseDto(eventsPageSchema, response.body);
  }

  async post<T = unknown>(path: string, body: unknown, options: ControlRequestOptions = {}): Promise<ControlHttpResponse<T>> {
    const timeoutMs = boundedTimeout(options.timeoutMs, MUTATION_TIMEOUT_MS);
    // Re-read publication and authenticate health immediately before every mutation. This makes a
    // restarted CoS process establish a fresh epoch before a POST, while the POST itself is never replayed.
    const live = await this.establishLive();
    let response: RawResponse;
    try {
      response = await requestJson(live.publication, 'POST', path, body, timeoutMs, options.signal);
    } catch (error) {
      this.live = null;
      if (isTransportFailure(error)) throw transportMutationError(error);
      if (error instanceof ControlClientError
          && (error.code === 'invalid_response' || error.code === 'response_too_large')) {
        throw new ControlClientError('mutation_ambiguous', true);
      }
      throw error;
    }
    if (response.status === 401) this.live = null;
    const ambiguous = ambiguousMutationResponse(response);
    return { ...response, body: response.body as T, epoch: live.publication.epoch, ambiguous };
  }
}

export function createControlClient(config: ExternalOrchestratorConfig = loadExternalOrchestratorConfig()): ControlClient {
  return new ControlClient(config);
}
