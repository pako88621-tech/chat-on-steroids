export type OutboundJsonValue =
  | null
  | boolean
  | number
  | string
  | OutboundJsonValue[]
  | { [key: string]: OutboundJsonValue };

const PATH_PLACEHOLDER = '[host-path-redacted]';
const SECRET_PLACEHOLDER = '[secret-redacted]';
const DEPTH_PLACEHOLDER = '[outbound-depth-redacted]';
const MAX_DEPTH = 64;

const SENSITIVE_KEYS = new Set([
  'accesskey',
  'accesstoken',
  'apikey',
  'authorization',
  'authtoken',
  'bearertoken',
  'bootstrap',
  'bootstraptoken',
  'clientsecret',
  'credential',
  'credentialref',
  'password',
  'proxyauthorization',
  'refreshtoken',
  'secret',
  'secretkey',
  'token',
  'xapikey',
]);

// Host paths are publication-private. Match arbitrary absolute POSIX filesystem roots while keeping
// Local Control `/v1/...` routes and URL `//...` components useful in stable protocol errors.
const POSIX_ABSOLUTE_PATH = /(^|[\s"'=(:,[{])\/(?!\/|v1(?:\/|$))[^/\s"'`<>|,;:{}()[\]]+(?:\/[^/\s"'`<>|,;:{}()[\]]+)*/g;
const WINDOWS_DRIVE_PATH = /\b[A-Za-z]:[\\/][^\s"'`<>|,;)\]}]+/g;
const WINDOWS_UNC_PATH = /\\\\[^\\\s"'`<>|,;)\]}]+\\[^\\\s"'`<>|,;)\]}]+(?:\\[^\s"'`<>|,;)\]}]+)*/g;

const SENSITIVE_KEY_PATTERN = '(?:api[_-]?key|apikey|authorization|auth[_-]?token|bearer[_-]?token|bootstrap[_-]?token|client[_-]?secret|credential(?:[_-]?ref)?|password|proxy[_-]?authorization|refresh[_-]?token|secret(?:[_-]?key)?|token|access[_-]?(?:token|key)|x[_-]?api[_-]?key)';
const QUOTED_SECRET_ASSIGNMENT = new RegExp(
  `(["']?)(${SENSITIVE_KEY_PATTERN})\\1(\\s*[:=]\\s*)(["'])(.*?)\\4`,
  'gi',
);
const UNQUOTED_SECRET_ASSIGNMENT = new RegExp(
  `\\b(${SENSITIVE_KEY_PATTERN})(\\s*[:=]\\s*)([^\\s,;)}\\]]+)`,
  'gi',
);
const AUTHORIZATION_VALUE = /\bAuthorization\s*[:=]\s*(?:(?:Bearer|Basic|Token)\s+)?[^\s,;"'}\]]+/gi;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

function normalizedKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizedKey(key));
}

/**
 * Normalize caller-supplied current/in-flight Control API bearer values once per sanitization.
 * Longest-first replacement prevents a shorter stale token from exposing the suffix of a longer
 * current token when both happen to overlap.
 */
function exactTokens(tokens: Iterable<string>): string[] {
  return [...new Set([...tokens].filter((token) => token.length > 0))]
    .sort((left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0));
}

function redactExactTokens(value: string, tokens: readonly string[]): string {
  let sanitized = value;
  for (const token of tokens) sanitized = sanitized.split(token).join(SECRET_PLACEHOLDER);
  return sanitized;
}

/**
 * Generic publication-boundary sanitizer for every External Orchestrator MCP string.
 *
 * Exact current/in-flight bearer values are removed even when an exception contains the raw token
 * without an `Authorization`/`Bearer` prefix. Shape-based redaction then catches credential forms
 * not represented by that exact token set, followed by host filesystem path removal.
 */
export function sanitizeOutboundString(value: string, bearerTokens: Iterable<string> = []): string {
  const tokens = exactTokens(bearerTokens);
  return redactExactTokens(value, tokens)
    .replace(AUTHORIZATION_VALUE, `Authorization: ${SECRET_PLACEHOLDER}`)
    .replace(BEARER_VALUE, `Bearer ${SECRET_PLACEHOLDER}`)
    .replace(QUOTED_SECRET_ASSIGNMENT, (
      _match,
      keyQuote: string,
      key: string,
      separator: string,
      valueQuote: string,
    ) => `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${SECRET_PLACEHOLDER}${valueQuote}`)
    .replace(UNQUOTED_SECRET_ASSIGNMENT, (_match, key: string, separator: string) =>
      `${key}${separator}${SECRET_PLACEHOLDER}`)
    .replace(WINDOWS_UNC_PATH, PATH_PLACEHOLDER)
    .replace(WINDOWS_DRIVE_PATH, PATH_PLACEHOLDER)
    .replace(POSIX_ABSOLUTE_PATH, (_match, prefix: string) => `${prefix}${PATH_PLACEHOLDER}`);
}

function sanitizeJsonValue(
  value: OutboundJsonValue,
  tokens: readonly string[],
  key: string | null,
  depth: number,
): OutboundJsonValue {
  if (depth > MAX_DEPTH) return DEPTH_PLACEHOLDER;
  if (key !== null && isSensitiveKey(key)) return SECRET_PLACEHOLDER;
  if (typeof value === 'string') return sanitizeOutboundString(value, tokens);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item, tokens, null, depth + 1));

  const sanitized: Record<string, OutboundJsonValue> = Object.create(null) as Record<string, OutboundJsonValue>;
  for (const objectKey of Object.keys(value).sort()) {
    sanitized[objectKey] = sanitizeJsonValue(value[objectKey]!, tokens, objectKey, depth + 1);
  }
  return sanitized;
}

/**
 * Sanitize a JSON-compatible outbound value deterministically. Object keys are sorted, arrays keep
 * their semantic order, sensitive-key values are replaced before traversal, and recursion is
 * bounded so an externally sourced detail cannot create unbounded publication work.
 */
export function sanitizeOutboundJsonValue(
  value: OutboundJsonValue,
  bearerTokens: Iterable<string> = [],
): OutboundJsonValue {
  return sanitizeJsonValue(value, exactTokens(bearerTokens), null, 0);
}

/** Canonical sanitized JSON for logging, exact evidence and other string publication surfaces. */
export function sanitizeOutboundJson(
  value: OutboundJsonValue,
  bearerTokens: Iterable<string> = [],
): string {
  return JSON.stringify(sanitizeOutboundJsonValue(value, bearerTokens));
}

/** Evidence wrappers retain the reference API while sharing the generic outbound boundary. */
export function sanitizeExternalEvidenceString(
  value: string,
  bearerTokens: Iterable<string> = [],
): string {
  return sanitizeOutboundString(value, bearerTokens);
}

export function sanitizeExternalEvidenceDetail(
  detail: Record<string, OutboundJsonValue>,
  bearerTokens: Iterable<string> = [],
): Record<string, OutboundJsonValue> {
  return sanitizeOutboundJsonValue(detail, bearerTokens) as Record<string, OutboundJsonValue>;
}

/** Exact evidence may be canonical JSON (reports/session events) or free-form tool/log output. */
export function sanitizeExternalEvidenceExact(
  exact: string,
  bearerTokens: Iterable<string> = [],
): string {
  try {
    return sanitizeOutboundJson(JSON.parse(exact) as OutboundJsonValue, bearerTokens);
  } catch {
    return sanitizeOutboundString(exact, bearerTokens);
  }
}

export const EXTERNAL_OUTBOUND_REDACTION = Object.freeze({
  hostPath: PATH_PLACEHOLDER,
  secret: SECRET_PLACEHOLDER,
  depth: DEPTH_PLACEHOLDER,
  maxDepth: MAX_DEPTH,
});

/** Backward-compatible evidence naming for callers ported from the experimental implementation. */
export const EXTERNAL_EVIDENCE_REDACTION = EXTERNAL_OUTBOUND_REDACTION;
