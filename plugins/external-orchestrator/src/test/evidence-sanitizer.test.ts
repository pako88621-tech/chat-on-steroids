import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXTERNAL_OUTBOUND_REDACTION,
  sanitizeExternalEvidenceDetail,
  sanitizeExternalEvidenceExact,
  sanitizeExternalEvidenceString,
  sanitizeOutboundJson,
  sanitizeOutboundJsonValue,
  sanitizeOutboundString,
  type OutboundJsonValue,
} from '../evidence-sanitizer.js';

const SECRET = EXTERNAL_OUTBOUND_REDACTION.secret;
const HOST_PATH = EXTERNAL_OUTBOUND_REDACTION.hostPath;
const DEPTH = EXTERNAL_OUTBOUND_REDACTION.depth;

function assertAbsent(value: string, forbidden: readonly string[]): void {
  for (const plaintext of forbidden) {
    assert.equal(value.includes(plaintext), false, `plaintext leaked: ${plaintext}`);
  }
}

test('redacts supplied bearer values exactly even without an auth prefix', () => {
  const current = 'eo.current-token_ABC123456789';
  const inFlight = 'eo.in-flight-token_XYZ987654321';
  const sanitized = sanitizeOutboundString(
    `request failed with ${current}; retry carried ${inFlight}; repeated ${current}`,
    [current, inFlight, current],
  );

  assert.equal(sanitized, `request failed with ${SECRET}; retry carried ${SECRET}; repeated ${SECRET}`);
  assertAbsent(sanitized, [current, inFlight]);
});

test('redacts Authorization, Bearer, and sensitive key assignment forms', () => {
  const plaintext = [
    'opaque-bearer-12345678',
    'QWxhZGRpbjpPcGVuU2VzYW1l',
    'standalone-token-12345678',
    'quoted-api-secret',
    'plain-password-secret',
    'client-secret-value',
    'refresh-secret-value',
    'json-token-value',
  ];
  const input = [
    'Authorization: Bearer opaque-bearer-12345678',
    'authorization=Basic QWxhZGRpbjpPcGVuU2VzYW1l',
    'Bearer standalone-token-12345678',
    'api_key="quoted-api-secret"',
    'password=plain-password-secret',
    "client-secret:'client-secret-value'",
    'refresh_token=refresh-secret-value',
    '"token":"json-token-value"',
  ].join(' | ');

  const sanitized = sanitizeOutboundString(input);
  assertAbsent(sanitized, plaintext);
  assert.ok(sanitized.includes(`Authorization: ${SECRET}`));
  assert.ok(sanitized.includes(`Bearer ${SECRET}`));
  for (const key of ['api_key', 'password', 'client-secret', 'refresh_token', '"token"']) {
    assert.ok(sanitized.includes(key), `assignment key disappeared: ${key}`);
  }
  assert.equal(sanitized.match(/\[secret-redacted\]/g)?.length, plaintext.length);
});

test('redacts POSIX, Windows drive, and UNC absolute host paths', () => {
  const posix = '/Users/alice/work/private/file.ts';
  const linux = '/home/alice/.config/cos/token.json';
  const windows = String.raw`C:\Users\alice\work\private\file.ts`;
  const unc = String.raw`\\build-server\private-share\release\artifact.log`;
  const sanitized = sanitizeOutboundString(`posix=${posix} linux=${linux} win=${windows} unc=${unc}`);

  assertAbsent(sanitized, [posix, linux, windows, unc, '/Users/alice', '/home/alice', 'C:\\Users\\alice', 'build-server\\private-share']);
  assert.equal(sanitized.match(/\[host-path-redacted\]/g)?.length, 4);
});

test('preserves Local Control /v1 routes while sanitizing nearby host paths', () => {
  const input = 'GET /v1/status then /v1/sessions/session-1/events; file=/Users/alice/private/state.json';
  const sanitized = sanitizeOutboundString(input);

  assert.ok(sanitized.includes('/v1/status'));
  assert.ok(sanitized.includes('/v1/sessions/session-1/events'));
  assert.ok(sanitized.includes(`file=${HOST_PATH}`));
  assert.equal(sanitized.includes('/Users/alice/private/state.json'), false);
});

test('keeps http URLs intact and redacts an absolute host path carried in a URL query', () => {
  const input = [
    'control=http://127.0.0.1:48123/v1/status',
    'docs=https://example.test/reference/v1/events',
    'inspect=https://example.test/v1/status?file=/Users/alice/private/state.json',
  ].join(' ');
  const sanitized = sanitizeOutboundString(input);

  assert.ok(sanitized.includes('http://127.0.0.1:48123/v1/status'));
  assert.ok(sanitized.includes('https://example.test/reference/v1/events'));
  assert.ok(sanitized.includes(`https://example.test/v1/status?file=${HOST_PATH}`));
  assert.equal(sanitized.includes('/Users/alice/private/state.json'), false);
});

test('redacts sensitive keys recursively using normalized key spellings', () => {
  const detail: OutboundJsonValue = {
    safe: 'visible',
    nested: {
      api_key: 'api-plaintext',
      'client-secret': 'client-plaintext',
      credential_ref: 'credential-plaintext',
      deeper: [
        { Authorization: 'Bearer auth-plaintext-12345678' },
        { proxy_authorization: 'Basic proxy-plaintext' },
        { refreshToken: 'refresh-plaintext' },
        { x_api_key: 'x-api-plaintext' },
      ],
    },
  };

  const sanitized = sanitizeOutboundJsonValue(detail);
  assert.deepEqual(JSON.parse(JSON.stringify(sanitized)), {
    nested: {
      api_key: SECRET,
      'client-secret': SECRET,
      credential_ref: SECRET,
      deeper: [
        { Authorization: SECRET },
        { proxy_authorization: SECRET },
        { refreshToken: SECRET },
        { x_api_key: SECRET },
      ],
    },
    safe: 'visible',
  });
  assertAbsent(JSON.stringify(sanitized), [
    'api-plaintext', 'client-plaintext', 'credential-plaintext', 'auth-plaintext',
    'proxy-plaintext', 'refresh-plaintext', 'x-api-plaintext',
  ]);
});

test('serializes sanitized JSON with deterministic recursive key order', () => {
  const first: OutboundJsonValue = {
    z: 9,
    a: { d: 4, b: 2 },
    list: [{ y: 2, x: 1 }, { beta: true, alpha: false }],
  };
  const second: OutboundJsonValue = {
    list: [{ x: 1, y: 2 }, { alpha: false, beta: true }],
    a: { b: 2, d: 4 },
    z: 9,
  };

  const expected = '{"a":{"b":2,"d":4},"list":[{"x":1,"y":2},{"alpha":false,"beta":true}],"z":9}';
  assert.equal(sanitizeOutboundJson(first), expected);
  assert.equal(sanitizeOutboundJson(second), expected);
});

test('bounds recursive JSON sanitization at the published maximum depth', () => {
  let withinBound: OutboundJsonValue = 'leaf';
  for (let i = 0; i < EXTERNAL_OUTBOUND_REDACTION.maxDepth; i += 1) withinBound = { child: withinBound };
  const within = sanitizeOutboundJsonValue(withinBound);
  let cursor = within;
  for (let i = 0; i < EXTERNAL_OUTBOUND_REDACTION.maxDepth; i += 1) {
    assert.equal(Array.isArray(cursor), false);
    assert.equal(typeof cursor, 'object');
    assert.notEqual(cursor, null);
    cursor = (cursor as Record<string, OutboundJsonValue>).child!;
  }
  assert.equal(cursor, 'leaf');

  let beyondBound: OutboundJsonValue = 'hidden-leaf';
  for (let i = 0; i <= EXTERNAL_OUTBOUND_REDACTION.maxDepth; i += 1) beyondBound = { child: beyondBound };
  const beyond = sanitizeOutboundJsonValue(beyondBound);
  cursor = beyond;
  for (let i = 0; i < EXTERNAL_OUTBOUND_REDACTION.maxDepth; i += 1) {
    cursor = (cursor as Record<string, OutboundJsonValue>).child!;
  }
  assert.deepEqual(JSON.parse(JSON.stringify(cursor)), { child: DEPTH });
  assert.equal(JSON.stringify(beyond).includes('hidden-leaf'), false);
});

test('preserves array order while sanitizing every array element recursively', () => {
  const token = 'array-current-token-12345678';
  const value: OutboundJsonValue = [
    'first',
    { token: 'object-secret', path: '/Users/alice/private/a.txt' },
    [token, 'third'],
    4,
  ];
  const sanitized = sanitizeOutboundJsonValue(value, [token]);

  assert.deepEqual(JSON.parse(JSON.stringify(sanitized)), [
    'first',
    { path: HOST_PATH, token: SECRET },
    [SECRET, 'third'],
    4,
  ]);
});

test('evidence wrappers share the generic outbound boundary and publish no plaintext secrets or paths', () => {
  const bearer = 'current-control-bearer-1234567890';
  const posix = '/Users/alice/Library/Application Support/chat-on-steroids/control-token';
  const windows = String.raw`D:\private\cos\control-token.txt`;
  const unc = String.raw`\\host\share\private\control-token.txt`;
  const forbidden = [bearer, posix, windows, unc, 'nested-secret-value'];

  const freeForm = sanitizeExternalEvidenceString(`raw=${bearer} posix=${posix} win=${windows} unc=${unc}`, [bearer]);
  const detail = sanitizeExternalEvidenceDetail({
    path: posix,
    nested: { secret_key: 'nested-secret-value', raw: bearer },
    routes: ['/v1/status', 'https://example.test/v1/events'],
  }, [bearer]);
  const exact = sanitizeExternalEvidenceExact(JSON.stringify({
    z: windows,
    a: { token: bearer, unc },
  }), [bearer]);

  for (const published of [freeForm, JSON.stringify(detail), exact]) assertAbsent(published, forbidden);
  assert.ok(freeForm.includes(HOST_PATH));
  assert.deepEqual(detail.routes, ['/v1/status', 'https://example.test/v1/events']);
  assert.equal(exact, `{"a":{"token":"${SECRET}","unc":"${HOST_PATH}"},"z":"${HOST_PATH}"}`);
});
