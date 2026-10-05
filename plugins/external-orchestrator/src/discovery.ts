import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { ExternalOrchestratorConfig } from './config.js';

const MAX_ENDPOINT_BYTES = 4 * 1024;
const MAX_TOKEN_BYTES = 256;
const ENDPOINT_KEYS = ['appVersion', 'pid', 'port', 'protocol', 'startedAt'] as const;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type ControlDiscoveryErrorCode =
  | 'publication_missing'
  | 'publication_invalid'
  | 'publication_unsafe';

export class ControlDiscoveryError extends Error {
  readonly code: ControlDiscoveryErrorCode;

  constructor(code: ControlDiscoveryErrorCode) {
    super(
      code === 'publication_missing'
        ? 'Chat On Steroids Local Control API publication is unavailable.'
        : code === 'publication_unsafe'
          ? 'Chat On Steroids Local Control API publication failed local safety checks.'
          : 'Chat On Steroids Local Control API publication is invalid.',
    );
    this.name = 'ControlDiscoveryError';
    this.code = code;
  }
}

export interface ControlEndpointPublication {
  protocol: number;
  port: number;
  pid: number;
  appVersion: string;
  startedAt: string;
}

export interface ControlEpoch {
  protocol: number;
  port: number;
  pid: number;
  tokenFingerprint: string;
  publicationFingerprint: string;
}

export interface DiscoveredControlPublication {
  endpoint: ControlEndpointPublication;
  token: string;
  epoch: ControlEpoch;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function unsafe(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ELOOP' || code === 'EMLINK';
}

function sameFileIdentity(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  if (process.platform === 'win32') return left.size === right.size && left.mtimeMs === right.mtimeMs;
  return left.dev === right.dev && left.ino === right.ino;
}

function verifyPrivateFile(stat: Awaited<ReturnType<typeof lstat>>): void {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ControlDiscoveryError('publication_unsafe');
  if (process.platform === 'win32') return;
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new ControlDiscoveryError('publication_unsafe');
  }
  if ((Number(stat.mode) & 0o077) !== 0) throw new ControlDiscoveryError('publication_unsafe');
}

async function readBoundedPrivateFile(file: string, maxBytes: number): Promise<Buffer> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(file);
  } catch (error) {
    if (missing(error)) throw new ControlDiscoveryError('publication_missing');
    throw new ControlDiscoveryError(unsafe(error) ? 'publication_unsafe' : 'publication_invalid');
  }
  verifyPrivateFile(before);
  if (before.size > maxBytes) throw new ControlDiscoveryError('publication_invalid');

  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (missing(error)) throw new ControlDiscoveryError('publication_missing');
    throw new ControlDiscoveryError(unsafe(error) ? 'publication_unsafe' : 'publication_invalid');
  }

  try {
    const opened = await handle.stat();
    verifyPrivateFile(opened);
    if (!sameFileIdentity(before, opened) || opened.size > maxBytes) {
      throw new ControlDiscoveryError('publication_unsafe');
    }
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new ControlDiscoveryError('publication_invalid');
    return buffer.subarray(0, offset);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new ControlDiscoveryError('publication_invalid');
  }
}

function parseEndpoint(buffer: Buffer): ControlEndpointPublication {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(buffer));
  } catch (error) {
    if (error instanceof ControlDiscoveryError) throw error;
    throw new ControlDiscoveryError('publication_invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControlDiscoveryError('publication_invalid');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== ENDPOINT_KEYS.length || ENDPOINT_KEYS.some((key, index) => key !== keys[index])) {
    throw new ControlDiscoveryError('publication_invalid');
  }
  const { protocol, port, pid, appVersion, startedAt } = record;
  if (!Number.isInteger(protocol) || (protocol as number) < 1 || (protocol as number) > 1_000_000) {
    throw new ControlDiscoveryError('publication_invalid');
  }
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
    throw new ControlDiscoveryError('publication_invalid');
  }
  if (!Number.isSafeInteger(pid) || (pid as number) < 1) throw new ControlDiscoveryError('publication_invalid');
  if (typeof appVersion !== 'string' || appVersion.length < 1 || appVersion.length > 160 || /[\u0000-\u001f\u007f]/u.test(appVersion)) {
    throw new ControlDiscoveryError('publication_invalid');
  }
  if (typeof startedAt !== 'string' || startedAt.length < 1 || startedAt.length > 80 || !Number.isFinite(Date.parse(startedAt))) {
    throw new ControlDiscoveryError('publication_invalid');
  }
  return { protocol: protocol as number, port: port as number, pid: pid as number, appVersion, startedAt };
}

function parseToken(buffer: Buffer): string {
  const token = decodeUtf8(buffer).trim();
  if (!TOKEN_PATTERN.test(token)) throw new ControlDiscoveryError('publication_invalid');
  try {
    const decoded = Buffer.from(token, 'base64url');
    if (decoded.length !== 32 || decoded.toString('base64url') !== token) {
      throw new ControlDiscoveryError('publication_invalid');
    }
  } catch (error) {
    if (error instanceof ControlDiscoveryError) throw error;
    throw new ControlDiscoveryError('publication_invalid');
  }
  return token;
}

function fingerprint(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sameControlEpoch(left: ControlEpoch, right: ControlEpoch): boolean {
  return left.protocol === right.protocol
    && left.port === right.port
    && left.pid === right.pid
    && left.tokenFingerprint === right.tokenFingerprint
    && left.publicationFingerprint === right.publicationFingerprint;
}

export async function discoverControlPublication(config: ExternalOrchestratorConfig): Promise<DiscoveredControlPublication> {
  const endpointBytes = await readBoundedPrivateFile(config.endpointFile, MAX_ENDPOINT_BYTES);
  const endpoint = parseEndpoint(endpointBytes);
  const token = parseToken(await readBoundedPrivateFile(config.tokenFile, MAX_TOKEN_BYTES));

  // The endpoint is published after the token. Reading it again fences a token rotation that raced
  // the first read; a mismatched pair is never treated as one control epoch.
  const endpointAgain = await readBoundedPrivateFile(config.endpointFile, MAX_ENDPOINT_BYTES);
  if (!endpointBytes.equals(endpointAgain)) throw new ControlDiscoveryError('publication_invalid');

  return {
    endpoint,
    token,
    epoch: Object.freeze({
      protocol: endpoint.protocol,
      port: endpoint.port,
      pid: endpoint.pid,
      tokenFingerprint: fingerprint(token),
      publicationFingerprint: fingerprint(endpointBytes),
    }),
  };
}
