import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Exact namespace retained from the reference simpleInputId implementation. */
const INPUT_ID_NAMESPACE = 'cos-simple-external-orchestrator\0';

export const IDEMPOTENCY_SCHEMA_VERSION = 1 as const;
export const IDEMPOTENCY_LEDGER_LIMIT = 10_000;
export const IDEMPOTENCY_STATE_DIR_ENV = 'CHAT_ON_STEROIDS_EXTERNAL_ORCHESTRATOR_STATE_DIR';
export const IDEMPOTENCY_LEDGER_FILE = 'idempotency.json';
export const IDEMPOTENCY_CONTROLLER_LOCK = 'controller.lock';

const LOCK_OWNER_FILE = 'owner.json';
const LOCK_HEARTBEAT_PREFIX = 'heartbeat-';
const LOCK_HEARTBEAT_SUFFIX = '.json';
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 30_000;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const SESSION_ID = /^[0-9a-z-]{8,64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type IdempotencyOperationKind = 'start' | 'steer';
export type IdempotencyRecordState = 'reserved' | 'retry_safe' | 'not_sent' | 'conflict' | 'accepted';

export interface IdempotencyRecord {
  schemaVersion: typeof IDEMPOTENCY_SCHEMA_VERSION;
  requestHash: string;
  inputId: string;
  sessionId: string;
  payloadHash: string;
  kind: IdempotencyOperationKind;
  state: IdempotencyRecordState;
  reservedAt: number;
  updatedAt: number;
  acceptedAt?: number;
  /** SHA-256 of immutable Core-projected row identity fields; never message text or credentials. */
  inputProofHash?: string;
}

export interface IdempotencyReservationRequest {
  requestId: string;
  sessionId: string;
  kind: IdempotencyOperationKind;
  /** Canonical semantic payload. Only its SHA-256 digest is persisted. */
  payload: unknown;
}

export interface IdempotencyReservation {
  record: IdempotencyRecord;
  replayed: boolean;
}

export type IdempotencyErrorCode =
  | 'controller_busy'
  | 'controller_lost'
  | 'duplicate_request_conflict'
  | 'retry_permission_consumed'
  | 'idempotency_ledger_full'
  | 'idempotency_state_invalid';

export class IdempotencyError extends Error {
  constructor(readonly code: IdempotencyErrorCode, message: string) {
    super(message);
    this.name = 'IdempotencyError';
  }
}

interface LockOwner {
  nonce: string;
  createdAt: number;
  updatedAt: number;
}

interface LockHeartbeat {
  nonce: string;
  updatedAt: number;
}

export interface IdempotencyControllerOptions {
  /** Absolute test/advanced override. Production normally relies on platform application state. */
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  ledgerLimit?: number;
  heartbeatMs?: number;
  staleAfterMs?: number;
  now?: () => number;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function deterministicInputId(requestId: string): string {
  const bytes = Buffer.from(createHash('sha256').update(INPUT_ID_NAMESPACE).update(requestId).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function requestIdHash(requestId: string): string {
  validateRequestId(requestId);
  return digest(requestId);
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical payload contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('canonical payload must contain plain objects only');
    const keys = Object.keys(object).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw new TypeError('canonical payload contains a non-JSON value');
}

export function canonicalPayloadHash(value: unknown): string {
  return digest(canonicalJson(value));
}

function validateRequestId(requestId: string): void {
  if (!REQUEST_ID.test(requestId)) throw new TypeError('requestId is not a canonical External Orchestrator request id');
}

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) throw new TypeError('sessionId is not a canonical CoS session id');
}

function platformPath(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function resolveExternalOrchestratorStateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const paths = platformPath(platform);
  const override = env[IDEMPOTENCY_STATE_DIR_ENV]?.trim();
  if (override) {
    if (!paths.isAbsolute(override)) throw new Error(`${IDEMPOTENCY_STATE_DIR_ENV} must be an absolute path`);
    return paths.normalize(override);
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim();
    return paths.join(local && paths.isAbsolute(local) ? local : paths.join(home, 'AppData', 'Local'), 'chat-on-steroids-external-orchestrator');
  }
  if (platform === 'darwin') return paths.join(home, 'Library', 'Application Support', 'chat-on-steroids-external-orchestrator');
  const xdg = env.XDG_STATE_HOME?.trim();
  return paths.join(xdg && paths.isAbsolute(xdg) ? xdg : paths.join(home, '.local', 'state'), 'chat-on-steroids-external-orchestrator');
}

function stateDirFrom(options: IdempotencyControllerOptions): string {
  if (options.stateDir !== undefined) {
    const paths = platformPath(options.platform ?? process.platform);
    if (!paths.isAbsolute(options.stateDir)) throw new Error('stateDir must be absolute');
    return paths.normalize(options.stateDir);
  }
  return resolveExternalOrchestratorStateDir(options.env, options.platform, options.home);
}

function numericTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is IdempotencyRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const accepted = row.state === 'accepted';
  const hasAcceptedAt = Object.prototype.hasOwnProperty.call(row, 'acceptedAt');
  const hasInputProofHash = Object.prototype.hasOwnProperty.call(row, 'inputProofHash');
  const allowed = ['schemaVersion', 'requestHash', 'inputId', 'sessionId', 'payloadHash', 'kind', 'state', 'reservedAt', 'updatedAt'];
  if (hasAcceptedAt) allowed.push('acceptedAt');
  if (hasInputProofHash) allowed.push('inputProofHash');
  if (!exactKeys(row, allowed)) return false;
  if (row.schemaVersion !== IDEMPOTENCY_SCHEMA_VERSION || !SHA256.test(String(row.requestHash)) || !UUID_V5.test(String(row.inputId))) return false;
  if (!SESSION_ID.test(String(row.sessionId)) || !SHA256.test(String(row.payloadHash))) return false;
  if (row.kind !== 'start' && row.kind !== 'steer') return false;
  if (row.state !== 'reserved' && row.state !== 'retry_safe' && row.state !== 'not_sent' && row.state !== 'conflict' && row.state !== 'accepted') return false;
  if (!numericTimestamp(row.reservedAt) || !numericTimestamp(row.updatedAt) || row.updatedAt < row.reservedAt) return false;
  if (accepted && !hasAcceptedAt) return false;
  if (hasAcceptedAt) {
    if (row.state !== 'accepted' && row.state !== 'not_sent') return false;
    if (!numericTimestamp(row.acceptedAt) || row.acceptedAt < row.reservedAt || row.updatedAt < row.acceptedAt) return false;
  }
  if (hasInputProofHash) {
    if (row.state !== 'accepted' && row.state !== 'not_sent') return false;
    if (!hasAcceptedAt) return false;
    if (!SHA256.test(String(row.inputProofHash))) return false;
  }
  return true;
}

function isLockOwner(value: unknown): value is LockOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return exactKeys(owner, ['nonce', 'createdAt', 'updatedAt']) &&
    typeof owner.nonce === 'string' && /^[0-9a-f-]{36}$/u.test(owner.nonce) &&
    numericTimestamp(owner.createdAt) && numericTimestamp(owner.updatedAt) && owner.updatedAt >= owner.createdAt;
}

function isLockHeartbeat(value: unknown): value is LockHeartbeat {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const heartbeat = value as Record<string, unknown>;
  return exactKeys(heartbeat, ['nonce', 'updatedAt'])
    && typeof heartbeat.nonce === 'string'
    && /^[0-9a-f-]{36}$/u.test(heartbeat.nonce)
    && numericTimestamp(heartbeat.updatedAt);
}

function heartbeatPath(lockDir: string, nonce: string): string {
  return path.join(lockDir, `${LOCK_HEARTBEAT_PREFIX}${nonce}${LOCK_HEARTBEAT_SUFFIX}`);
}

async function ensurePrivateDirectory(directory: string, platform: NodeJS.Platform): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') await fs.chmod(directory, 0o700);
}

function isNodeError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

async function writePrivateJson(file: string, value: unknown, platform: NodeJS.Platform): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
    if (platform !== 'win32') await fs.chmod(file, 0o600);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Publish a new generation identity without any replace operation. The file handle pins the
 * directory generation if stale-lock takeover renames it while this write is in flight.
 */
async function writePrivateJsonExclusive(file: string, value: unknown, platform: NodeJS.Platform): Promise<void> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(file, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    if (platform !== 'win32') await handle.chmod(0o600);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function loadLedger(file: string): Promise<IdempotencyRecord[]> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new IdempotencyError('idempotency_state_invalid', 'External Orchestrator idempotency state is not valid JSON.');
  }
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
    throw new IdempotencyError('idempotency_state_invalid', 'External Orchestrator idempotency state has an unsupported shape.');
  }
  const seen = new Set<string>();
  for (const record of parsed) {
    if (seen.has(record.requestHash)) throw new IdempotencyError('idempotency_state_invalid', 'External Orchestrator idempotency state contains duplicate request identities.');
    seen.add(record.requestHash);
  }
  return parsed;
}

async function readLockOwner(lockDir: string): Promise<LockOwner | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(lockDir, LOCK_OWNER_FILE), 'utf8'));
    return isLockOwner(parsed) ? parsed : null;
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function readLockHeartbeat(lockDir: string, nonce: string): Promise<LockHeartbeat | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(heartbeatPath(lockDir, nonce), 'utf8'));
    return isLockHeartbeat(parsed) && parsed.nonce === nonce ? parsed : null;
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function lockUpdatedAt(lockDir: string): Promise<number | null> {
  const owner = await readLockOwner(lockDir);
  if (owner) {
    const heartbeat = await readLockHeartbeat(lockDir, owner.nonce);
    return heartbeat ? Math.max(owner.updatedAt, heartbeat.updatedAt) : owner.updatedAt;
  }
  try {
    return Math.trunc((await fs.stat(lockDir)).mtimeMs);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

async function quarantineStaleLock(lockDir: string, now: number, staleAfterMs: number): Promise<boolean> {
  const quarantine = `${lockDir}.stale-${randomUUID()}`;
  try {
    await fs.rename(lockDir, quarantine);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return true;
    throw error;
  }
  let stale = false;
  try {
    const updatedAt = await lockUpdatedAt(quarantine);
    stale = updatedAt === null || now - updatedAt >= staleAfterMs;
    if (stale) {
      await fs.rm(quarantine, { recursive: true, force: true });
      return true;
    }
    try {
      await fs.rename(quarantine, lockDir);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST') && !isNodeError(error, 'ENOTEMPTY')) throw error;
      await fs.rm(quarantine, { recursive: true, force: true });
    }
    return false;
  } catch (error) {
    if (stale) await fs.rm(quarantine, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function acquireLockDirectory(
  stateDir: string,
  nonce: string,
  now: () => number,
  platform: NodeJS.Platform,
  staleAfterMs: number,
): Promise<{ lockDir: string; owner: LockOwner }> {
  const lockDir = path.join(stateDir, IDEMPOTENCY_CONTROLLER_LOCK);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const timestamp = now();
    try {
      await fs.mkdir(lockDir, { mode: 0o700 });
      if (platform !== 'win32') await fs.chmod(lockDir, 0o700);
      const owner: LockOwner = { nonce, createdAt: timestamp, updatedAt: timestamp };
      try {
        // Never replace owner.json: a stale acquirer that resumes after takeover must either keep
        // writing through a handle pinned to its quarantined directory or lose O_EXCL to the
        // successor generation. This closes the same split-brain class as heartbeat refreshes.
        await writePrivateJsonExclusive(path.join(lockDir, LOCK_OWNER_FILE), owner, platform);
        await writePrivateJson(heartbeatPath(lockDir, nonce), { nonce, updatedAt: timestamp } satisfies LockHeartbeat, platform);
        const published = await readLockOwner(lockDir);
        if (!published || published.nonce !== nonce || published.createdAt !== timestamp) {
          throw new IdempotencyError('controller_busy', 'Another External Orchestrator mutation controller won the lock generation.');
        }
      } catch (error) {
        // Never remove the canonical directory here: it may already be a successor generation.
        // A failed/partial generation is recovered only through the ordinary stale-lock path.
        throw error;
      }
      return { lockDir, owner };
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
    const updatedAt = await lockUpdatedAt(lockDir);
    if (updatedAt !== null && timestamp - updatedAt < staleAfterMs) {
      throw new IdempotencyError('controller_busy', 'Another External Orchestrator mutation controller is active for this user.');
    }
    if (!await quarantineStaleLock(lockDir, timestamp, staleAfterMs)) {
      throw new IdempotencyError('controller_busy', 'Another External Orchestrator mutation controller is active for this user.');
    }
  }
  throw new IdempotencyError('controller_busy', 'External Orchestrator could not acquire its mutation controller lock.');
}

export class IdempotencyController {
  readonly stateDir: string;
  readonly ledgerFile: string;
  readonly controllerLockPath: string;

  readonly #nonce: string;
  readonly #platform: NodeJS.Platform;
  readonly #ledgerLimit: number;
  readonly #heartbeatMs: number;
  readonly #now: () => number;
  readonly #createdAt: number;
  #heartbeat: NodeJS.Timeout | null = null;
  #tail: Promise<void> = Promise.resolve();
  #released = false;
  #lost = false;

  private constructor(
    stateDir: string,
    lockDir: string,
    owner: LockOwner,
    options: Required<Pick<IdempotencyControllerOptions, 'ledgerLimit' | 'heartbeatMs' | 'staleAfterMs' | 'now'>> & { platform: NodeJS.Platform },
  ) {
    this.stateDir = stateDir;
    this.ledgerFile = path.join(stateDir, IDEMPOTENCY_LEDGER_FILE);
    this.controllerLockPath = lockDir;
    this.#nonce = owner.nonce;
    this.#createdAt = owner.createdAt;
    this.#platform = options.platform;
    this.#ledgerLimit = options.ledgerLimit;
    this.#heartbeatMs = options.heartbeatMs;
    this.#now = options.now;
    if (this.#heartbeatMs > 0) {
      this.#heartbeat = setInterval(() => {
        void this.#refreshLock().catch(() => {
          this.#lost = true;
          if (this.#heartbeat) clearInterval(this.#heartbeat);
          this.#heartbeat = null;
        });
      }, this.#heartbeatMs);
      this.#heartbeat.unref();
    }
  }

  static async acquire(options: IdempotencyControllerOptions = {}): Promise<IdempotencyController> {
    const platform = options.platform ?? process.platform;
    const stateDir = stateDirFrom({ ...options, platform });
    const ledgerLimit = options.ledgerLimit ?? IDEMPOTENCY_LEDGER_LIMIT;
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const now = options.now ?? Date.now;
    if (!Number.isSafeInteger(ledgerLimit) || ledgerLimit < 1) throw new RangeError('ledgerLimit must be a positive integer');
    if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 0) throw new RangeError('heartbeatMs must be a non-negative integer');
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < Math.max(1_000, heartbeatMs * 3)) {
      throw new RangeError('staleAfterMs must allow at least three heartbeat intervals and be at least one second');
    }
    await ensurePrivateDirectory(stateDir, platform);
    const nonce = randomUUID();
    const lock = await acquireLockDirectory(stateDir, nonce, now, platform, staleAfterMs);
    return new IdempotencyController(stateDir, lock.lockDir, lock.owner, { platform, ledgerLimit, heartbeatMs, staleAfterMs, now });
  }

  async lookup(requestId: string): Promise<IdempotencyRecord | null> {
    validateRequestId(requestId);
    return this.#serialize(async () => {
      await this.#assertOwned();
      const hash = requestIdHash(requestId);
      return (await loadLedger(this.ledgerFile)).find((record) => record.requestHash === hash) ?? null;
    });
  }

  async reserve(request: IdempotencyReservationRequest): Promise<IdempotencyReservation> {
    validateRequestId(request.requestId);
    validateSessionId(request.sessionId);
    const requestHash = requestIdHash(request.requestId);
    const payloadHash = canonicalPayloadHash(request.payload);
    const inputId = deterministicInputId(request.requestId);
    return this.#serialize(async () => {
      await this.#refreshLock();
      const records = await loadLedger(this.ledgerFile);
      const existing = records.find((record) => record.requestHash === requestHash);
      if (existing) {
        if (existing.inputId !== inputId || existing.sessionId !== request.sessionId || existing.payloadHash !== payloadHash || existing.kind !== request.kind) {
          throw new IdempotencyError('duplicate_request_conflict', 'request_id is already bound to a different external mutation.');
        }
        return { record: existing, replayed: true };
      }
      if (records.length >= this.#ledgerLimit) {
        throw new IdempotencyError('idempotency_ledger_full', `External Orchestrator idempotency ledger reached its ${this.#ledgerLimit}-record limit.`);
      }
      const timestamp = this.#now();
      const record: IdempotencyRecord = {
        schemaVersion: IDEMPOTENCY_SCHEMA_VERSION,
        requestHash,
        inputId,
        sessionId: request.sessionId,
        payloadHash,
        kind: request.kind,
        state: 'reserved',
        reservedAt: timestamp,
        updatedAt: timestamp,
      };
      records.push(record);
      await this.#writeLedger(records);
      return { record, replayed: false };
    });
  }

  async markAccepted(reservation: IdempotencyReservation, inputProofHash?: string): Promise<IdempotencyRecord> {
    return this.#serialize(async () => {
      if (inputProofHash !== undefined && !SHA256.test(inputProofHash)) {
        throw new IdempotencyError('idempotency_state_invalid', 'Accepted input proof must be a SHA-256 digest.');
      }
      await this.#refreshLock();
      const records = await loadLedger(this.ledgerFile);
      const index = records.findIndex((record) => record.requestHash === reservation.record.requestHash);
      const current = index >= 0 ? records[index]! : null;
      if (!current || current.inputId !== reservation.record.inputId || current.sessionId !== reservation.record.sessionId ||
          current.payloadHash !== reservation.record.payloadHash || current.kind !== reservation.record.kind) {
        throw new IdempotencyError('duplicate_request_conflict', 'Reserved request ownership no longer matches the accepted mutation.');
      }
      if (current.state === 'accepted') {
        if (inputProofHash !== undefined && current.inputProofHash !== undefined && current.inputProofHash !== inputProofHash) {
          throw new IdempotencyError('duplicate_request_conflict', 'Accepted request points at a different Core input instance.');
        }
        if (inputProofHash !== undefined && current.inputProofHash === undefined) {
          const timestamp = Math.max(current.updatedAt, this.#now());
          const strengthened: IdempotencyRecord = { ...current, inputProofHash, updatedAt: timestamp };
          records[index] = strengthened;
          await this.#writeLedger(records);
          return strengthened;
        }
        return current;
      }
      if (current.state === 'not_sent' || current.state === 'conflict') {
        throw new IdempotencyError('duplicate_request_conflict', 'A request proven not sent cannot later be marked accepted.');
      }
      const timestamp = Math.max(current.updatedAt, this.#now());
      const accepted: IdempotencyRecord = {
        ...current,
        state: 'accepted',
        acceptedAt: timestamp,
        updatedAt: timestamp,
        ...(inputProofHash === undefined ? {} : { inputProofHash }),
      };
      records[index] = accepted;
      await this.#writeLedger(records);
      return accepted;
    });
  }

  /**
   * Marks only a Core-proven "did not start" outcome. This never retries by itself; it merely
   * records that a later explicit retry may reuse the same request id and deterministic input id.
   */
  async markRetrySafe(reservation: IdempotencyReservation): Promise<IdempotencyRecord> {
    return this.#serialize(async () => {
      await this.#refreshLock();
      const records = await loadLedger(this.ledgerFile);
      const index = records.findIndex((record) => record.requestHash === reservation.record.requestHash);
      const current = index >= 0 ? records[index]! : null;
      if (!current || current.inputId !== reservation.record.inputId || current.sessionId !== reservation.record.sessionId ||
          current.payloadHash !== reservation.record.payloadHash || current.kind !== reservation.record.kind) {
        throw new IdempotencyError('duplicate_request_conflict', 'Reserved request ownership no longer matches the retry-safe mutation.');
      }
      // Once Core has accepted the mutation, no later response can make it safe to send again.
      if (current.state === 'accepted' || current.state === 'retry_safe' || current.state === 'not_sent' || current.state === 'conflict') return current;
      const timestamp = Math.max(current.updatedAt, this.#now());
      const retrySafe: IdempotencyRecord = { ...current, state: 'retry_safe', updatedAt: timestamp };
      records[index] = retrySafe;
      await this.#writeLedger(records);
      return retrySafe;
    });
  }

  /**
   * Records a terminal Core proof that this request identity was not sent. Unlike retry_safe, this
   * state never grants later resend permission after the Core tombstone is pruned.
   */
  async markNotSent(reservation: IdempotencyReservation): Promise<IdempotencyRecord> {
    return this.#serialize(async () => {
      await this.#refreshLock();
      const records = await loadLedger(this.ledgerFile);
      const index = records.findIndex((record) => record.requestHash === reservation.record.requestHash);
      const current = index >= 0 ? records[index]! : null;
      if (!current || current.inputId !== reservation.record.inputId || current.sessionId !== reservation.record.sessionId ||
          current.payloadHash !== reservation.record.payloadHash || current.kind !== reservation.record.kind) {
        throw new IdempotencyError('duplicate_request_conflict', 'Reserved request ownership no longer matches the not-sent mutation.');
      }
      if (current.state === 'not_sent') return current;
      if (current.state === 'conflict') {
        throw new IdempotencyError('duplicate_request_conflict', 'A conflicting request identity cannot become not-sent ownership.');
      }
      const timestamp = Math.max(current.updatedAt, this.#now());
      const notSent: IdempotencyRecord = { ...current, state: 'not_sent', updatedAt: timestamp };
      records[index] = notSent;
      await this.#writeLedger(records);
      return notSent;
    });
  }

  /** Persist a definitive Core id_conflict so later Core history pruning cannot turn it ambiguous. */
  async markConflict(reservation: IdempotencyReservation): Promise<IdempotencyRecord> {
    return this.#serialize(async () => {
      await this.#refreshLock();
      const records = await loadLedger(this.ledgerFile);
      const index = records.findIndex((record) => record.requestHash === reservation.record.requestHash);
      const current = index >= 0 ? records[index]! : null;
      if (!current || current.inputId !== reservation.record.inputId || current.sessionId !== reservation.record.sessionId ||
          current.payloadHash !== reservation.record.payloadHash || current.kind !== reservation.record.kind) {
        throw new IdempotencyError('duplicate_request_conflict', 'Reserved request ownership no longer matches the conflicting mutation.');
      }
      if (current.state === 'conflict') return current;
      const timestamp = Math.max(current.updatedAt, this.#now());
      const { acceptedAt: _acceptedAt, inputProofHash: _inputProofHash, ...base } = current;
      const conflict: IdempotencyRecord = { ...base, state: 'conflict', updatedAt: timestamp };
      records[index] = conflict;
      await this.#writeLedger(records);
      return conflict;
    });
  }

  /**
   * Closes a previously proven retry window immediately before the caller crosses the next
   * mutation boundary. A crash after this write is deliberately conservative: `reserved` means
   * the attempt may have happened, so another process must reconcile rather than send again.
   */
  async markAttempting(reservation: IdempotencyReservation): Promise<IdempotencyRecord> {
    return this.#serialize(async () => {
      await this.#refreshLock();
      const records = await loadLedger(this.ledgerFile);
      const index = records.findIndex((record) => record.requestHash === reservation.record.requestHash);
      const current = index >= 0 ? records[index]! : null;
      if (!current || current.inputId !== reservation.record.inputId || current.sessionId !== reservation.record.sessionId ||
          current.payloadHash !== reservation.record.payloadHash || current.kind !== reservation.record.kind) {
        throw new IdempotencyError('duplicate_request_conflict', 'Reserved request ownership no longer matches the attempted mutation.');
      }
      if (current.state !== 'retry_safe') {
        throw new IdempotencyError('retry_permission_consumed', 'The explicit retry permission was already consumed by another request.');
      }
      const timestamp = Math.max(current.updatedAt, this.#now());
      const reserved: IdempotencyRecord = { ...current, state: 'reserved', updatedAt: timestamp };
      records[index] = reserved;
      await this.#writeLedger(records);
      return reserved;
    });
  }

  /** Verify and refresh the per-user mutation-controller lock without touching the ledger. */
  async assertOwned(): Promise<void> {
    await this.#serialize(async () => {
      await this.#refreshLock();
    });
  }

  async release(): Promise<boolean> {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    return this.#serialize(async () => {
      if (this.#released) return true;
      const owner = await readLockOwner(this.controllerLockPath);
      if (!owner || owner.nonce !== this.#nonce) {
        this.#lost = true;
        this.#released = true;
        return false;
      }
      const releasePath = `${this.controllerLockPath}.release-${this.#nonce}`;
      try {
        await fs.rename(this.controllerLockPath, releasePath);
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
          this.#lost = true;
          this.#released = true;
          return false;
        }
        throw error;
      }
      const moved = await readLockOwner(releasePath);
      if (!moved || moved.nonce !== this.#nonce) {
        try { await fs.rename(releasePath, this.controllerLockPath); } catch { /* another controller owns the canonical path */ }
        this.#lost = true;
        this.#released = true;
        return false;
      }
      await fs.rm(releasePath, { recursive: true, force: true });
      this.#released = true;
      return true;
    });
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work);
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #assertOwned(): Promise<LockOwner> {
    if (this.#released || this.#lost) throw new IdempotencyError('controller_lost', 'External Orchestrator no longer owns the mutation controller lock.');
    const owner = await readLockOwner(this.controllerLockPath);
    if (!owner || owner.nonce !== this.#nonce || owner.createdAt !== this.#createdAt) {
      this.#lost = true;
      throw new IdempotencyError('controller_lost', 'External Orchestrator no longer owns the mutation controller lock.');
    }
    return owner;
  }

  async #refreshLock(): Promise<void> {
    const owner = await this.#assertOwned();
    const previousHeartbeat = await readLockHeartbeat(this.controllerLockPath, this.#nonce);
    const timestamp = Math.max(owner.updatedAt, previousHeartbeat?.updatedAt ?? 0, this.#now());
    try {
      // `owner.json` is immutable generation identity. Heartbeats are nonce-scoped so a stalled
      // controller that resumes after stale-lock takeover can at worst write an ignored old-nonce
      // heartbeat into the successor directory; it can never replace the successor's owner file.
      await writePrivateJson(
        heartbeatPath(this.controllerLockPath, this.#nonce),
        { nonce: this.#nonce, updatedAt: timestamp } satisfies LockHeartbeat,
        this.#platform,
      );
    } catch (error) {
      if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
        this.#lost = true;
        throw new IdempotencyError('controller_lost', 'External Orchestrator lost the mutation controller lock while refreshing it.');
      }
      throw error;
    }
    const after = await readLockOwner(this.controllerLockPath);
    if (!after || after.nonce !== this.#nonce || after.createdAt !== this.#createdAt) {
      this.#lost = true;
      throw new IdempotencyError('controller_lost', 'External Orchestrator lost the mutation controller lock while refreshing it.');
    }
  }

  async #writeLedger(records: readonly IdempotencyRecord[]): Promise<void> {
    const temporary = path.join(this.stateDir, `.${IDEMPOTENCY_LEDGER_FILE}.${randomUUID()}.tmp`);
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(records)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      // A stalled writer that lost the controller while preparing the temp file must not publish.
      await this.#refreshLock();
      await fs.rename(temporary, this.ledgerFile);
      if (this.#platform !== 'win32') await fs.chmod(this.ledgerFile, 0o600);
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export async function acquireIdempotencyController(options: IdempotencyControllerOptions = {}): Promise<IdempotencyController> {
  return IdempotencyController.acquire(options);
}

export async function readIdempotencyRecord(
  requestId: string,
  options: Pick<IdempotencyControllerOptions, 'stateDir' | 'env' | 'platform' | 'home'> = {},
): Promise<IdempotencyRecord | null> {
  validateRequestId(requestId);
  const stateDir = stateDirFrom(options);
  const ledger = await loadLedger(path.join(stateDir, IDEMPOTENCY_LEDGER_FILE));
  const hash = requestIdHash(requestId);
  return ledger.find((record) => record.requestHash === hash) ?? null;
}
