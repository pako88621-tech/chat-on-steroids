import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CONTROL_CHANGE_ROUTE,
  ControlClient,
  ControlClientError,
  REQUIRED_CONTROL_ACTION_ROUTES,
  REQUIRED_CONTROL_ROUTES,
  supportsSemanticWait,
} from '../control-client.js';
import type { ExternalOrchestratorConfig } from '../config.js';
import { discoverControlPublication } from '../discovery.js';

const STARTED_AT = '2026-10-04T12:00:00.000Z';
const APP_VERSION = '2.1.26-test';

interface Fixture {
  dir: string;
  endpointFile: string;
  tokenFile: string;
  config: ExternalOrchestratorConfig;
}

interface EndpointPublication {
  appVersion: string;
  pid: number;
  port: number;
  protocol: number;
  startedAt: string;
}

interface TestServer {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

function token(seed: number): string {
  return Buffer.alloc(32, seed).toString('base64url');
}

async function createFixture(): Promise<Fixture> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'eo-control-client-'));
  const controlDir = path.join(dir, 'control-api');
  await mkdir(controlDir, { mode: 0o700 });
  const endpointFile = path.join(controlDir, 'endpoint.json');
  const tokenFile = path.join(controlDir, 'token');
  return {
    dir,
    endpointFile,
    tokenFile,
    config: {
      userDataDir: dir,
      endpointFile,
      tokenFile,
      supportedControlApiProtocols: [1],
    },
  };
}

async function destroyFixture(fixture: Fixture): Promise<void> {
  await rm(fixture.dir, { recursive: true, force: true });
}

function endpoint(port: number, overrides: Partial<EndpointPublication> = {}): EndpointPublication {
  return {
    appVersion: APP_VERSION,
    pid: process.pid,
    port,
    protocol: 1,
    startedAt: STARTED_AT,
    ...overrides,
  };
}

async function publish(
  fixture: Fixture,
  port: number,
  bearer: string,
  overrides: Partial<EndpointPublication> = {},
): Promise<EndpointPublication> {
  const value = endpoint(port, overrides);
  await writeFile(fixture.tokenFile, `${bearer}\n`, { mode: 0o600 });
  await chmod(fixture.tokenFile, 0o600);
  await writeFile(fixture.endpointFile, JSON.stringify(value), { mode: 0o600 });
  await chmod(fixture.endpointFile, 0o600);
  return value;
}

function healthBody(value: EndpointPublication, options: {
  pid?: number;
  protocol?: number;
  routes?: readonly string[];
  omitActions?: boolean;
  actionsEnabled?: boolean;
  actionRoutes?: readonly string[];
  actionFeatures?: readonly string[];
} = {}): Record<string, unknown> {
  return {
    ok: true,
    protocol: options.protocol ?? value.protocol,
    routes: options.routes ?? REQUIRED_CONTROL_ROUTES,
    ...(!options.omitActions ? { actions: {
      enabled: options.actionsEnabled ?? true,
      routes: options.actionRoutes ?? REQUIRED_CONTROL_ACTION_ROUTES,
      features: options.actionFeatures ?? ['input_expected_conversation'],
    } } : {}),
    pid: options.pid ?? value.pid,
    appVersion: value.appVersion,
    startedAt: value.startedAt,
    uptimeSeconds: 10,
  };
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(payload);
}

async function startServer(handler: Handler): Promise<TestServer> {
  const server = http.createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: 'test_handler_failed', detail: String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    port: address.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function errorCode(expected: string, forbidden: readonly string[] = []): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    for (const secret of forbidden) assert.equal(error.message.includes(secret), false, `secret leaked in error: ${secret}`);
    return 'code' in error && (error as { code?: unknown }).code === expected;
  };
}

function auth(req: IncomingMessage): string {
  return String(req.headers.authorization ?? '');
}

test('discovery accepts private bounded canonical publication and rejects noncanonical, oversized, and invalid-token publication', async () => {
  const fixture = await createFixture();
  const bearer = token(1);
  try {
    const value = await publish(fixture, 43210, bearer);
    const discovered = await discoverControlPublication(fixture.config);
    assert.deepEqual(discovered.endpoint, value);
    assert.equal(discovered.token, bearer);
    assert.equal(discovered.epoch.port, 43210);
    assert.equal(discovered.epoch.pid, process.pid);
    assert.equal(discovered.epoch.tokenFingerprint.includes(bearer), false);

    await writeFile(fixture.endpointFile, JSON.stringify({ ...value, host: 'localhost' }), { mode: 0o600 });
    await assert.rejects(discoverControlPublication(fixture.config), errorCode('publication_invalid', [bearer]));

    await writeFile(fixture.endpointFile, 'x'.repeat(4 * 1024 + 1), { mode: 0o600 });
    await assert.rejects(discoverControlPublication(fixture.config), errorCode('publication_invalid', [bearer]));

    await writeFile(fixture.endpointFile, JSON.stringify(value), { mode: 0o600 });
    const invalid = 'not-a-canonical-control-token';
    await writeFile(fixture.tokenFile, invalid, { mode: 0o600 });
    await assert.rejects(discoverControlPublication(fixture.config), errorCode('publication_invalid', [invalid]));

    await writeFile(fixture.tokenFile, `${bearer}${'x'.repeat(300)}`, { mode: 0o600 });
    await assert.rejects(discoverControlPublication(fixture.config), errorCode('publication_invalid', [bearer]));
  } finally {
    await destroyFixture(fixture);
  }
});

test('discovery rejects symlink and unsafe publication modes', async () => {
  const fixture = await createFixture();
  const bearer = token(2);
  try {
    await publish(fixture, 43211, bearer);
    if (process.platform !== 'win32') {
      await chmod(fixture.tokenFile, 0o644);
      await assert.rejects(discoverControlPublication(fixture.config), errorCode('publication_unsafe', [bearer]));
      await chmod(fixture.tokenFile, 0o600);
    }

    const target = path.join(fixture.dir, 'real-token');
    await writeFile(target, bearer, { mode: 0o600 });
    await unlink(fixture.tokenFile);
    await symlink(target, fixture.tokenFile);
    await assert.rejects(discoverControlPublication(fixture.config), errorCode('publication_unsafe', [bearer]));
  } finally {
    await destroyFixture(fixture);
  }
});

test('client connects only to literal 127.0.0.1 and sends the published bearer authorization', async () => {
  const fixture = await createFixture();
  const bearer = token(3);
  const seen: Array<{ host: string; auth: string; remote: string | undefined }> = [];
  let published!: EndpointPublication;
  const server = await startServer((req, res) => {
    seen.push({ host: String(req.headers.host ?? ''), auth: auth(req), remote: req.socket.remoteAddress });
    json(res, 200, healthBody(published));
  });
  try {
    published = await publish(fixture, server.port, bearer);
    const health = await new ControlClient(fixture.config).health();
    assert.equal(health.pid, process.pid);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.host, `127.0.0.1:${server.port}`);
    assert.equal(seen[0]!.remote, '127.0.0.1');
    assert.equal(seen[0]!.auth, `Bearer ${bearer}`);
  } finally {
    await server.close();
    await destroyFixture(fixture);
  }
});

test('health fences pid, protocol, base read routes, and unsupported publication protocol without requiring actions or changes', async () => {
  const fixture = await createFixture();
  const bearer = token(4);
  let published!: EndpointPublication;
  let healthOverride: Parameters<typeof healthBody>[1] = {};
  let requests = 0;
  const server = await startServer((req, res) => {
    requests += 1;
    assert.equal(req.url, '/v1/health');
    json(res, 200, healthBody(published, healthOverride));
  });
  try {
    published = await publish(fixture, server.port, bearer);
    healthOverride = { pid: process.pid + 1 };
    await assert.rejects(new ControlClient(fixture.config).health(), errorCode('control_api_unavailable', [bearer]));

    healthOverride = { protocol: published.protocol + 1 };
    await assert.rejects(new ControlClient(fixture.config).health(), errorCode('control_api_unavailable', [bearer]));

    healthOverride = { routes: REQUIRED_CONTROL_ROUTES.filter((route) => route !== '/v1/sessions/{id}/events') };
    await assert.rejects(new ControlClient(fixture.config).health(), errorCode('unsupported_control_api', [bearer]));

    healthOverride = { actionsEnabled: false, actionRoutes: [], actionFeatures: [] };
    const readOnly = await new ControlClient(fixture.config).health();
    assert.equal(readOnly.actions.enabled, false);
    assert.equal(supportsSemanticWait(readOnly), false);

    healthOverride = { omitActions: true };
    const preActionCore = await new ControlClient(fixture.config).health();
    assert.deepEqual(preActionCore.actions, { enabled: false, routes: [], features: [] });

    const beforeUnsupported = requests;
    published = await publish(fixture, server.port, bearer, { protocol: 2 });
    healthOverride = {};
    await assert.rejects(new ControlClient(fixture.config).health(), errorCode('unsupported_control_api', [bearer]));
    assert.equal(requests, beforeUnsupported, 'unsupported publication protocol must be rejected before HTTP');
  } finally {
    await server.close();
    await destroyFixture(fixture);
  }
});

test('mutation compatibility is checked per operation while supported old-Core actions remain usable', async () => {
  const fixture = await createFixture();
  const bearer = token(18);
  let published!: EndpointPublication;
  let actionRoutes: readonly string[] = [];
  let actionFeatures: readonly string[] = [];
  let posts = 0;
  const server = await startServer((req, res) => {
    if (req.url === '/v1/health') {
      json(res, 200, healthBody(published, { actionRoutes, actionFeatures }));
      return;
    }
    if (req.method === 'POST') {
      posts += 1;
      json(res, 200, { ok: true });
      return;
    }
    json(res, 404, { error: 'not_found' });
  });
  try {
    published = await publish(fixture, server.port, bearer);
    const client = new ControlClient(fixture.config);

    await assert.rejects(client.post('/v1/inputs', { text: 'missing' }), errorCode('unsupported_control_api', [bearer]));
    assert.equal(posts, 0);

    actionRoutes = ['POST /v1/inputs'];
    actionFeatures = [];
    await assert.rejects(client.post('/v1/inputs', { text: 'feature-missing' }), errorCode('unsupported_control_api', [bearer]));
    assert.equal(posts, 0);

    actionRoutes = ['POST /v1/inputs/{id}/cancel'];
    actionFeatures = [];
    const cancelled = await client.post('/v1/inputs/00000000-0000-4000-8000-000000000001/cancel', {});
    assert.equal(cancelled.status, 200);

    actionRoutes = ['POST /v1/sessions/{id}/stop'];
    const stopped = await client.post('/v1/sessions/session-1234/stop', { expectedTurnId: 'turn-1' });
    assert.equal(stopped.status, 200);

    actionRoutes = ['POST /v1/inputs'];
    actionFeatures = ['input_expected_conversation'];
    const admitted = await client.post('/v1/inputs', { text: 'supported' });
    assert.equal(admitted.status, 200);
    assert.equal(posts, 3);
  } finally {
    await server.close();
    await destroyFixture(fixture);
  }
});

test('GET rediscoveries once after token rotation signalled by 401', async () => {
  const fixture = await createFixture();
  const oldToken = token(5);
  const newToken = token(6);
  let accepted = oldToken;
  let published!: EndpointPublication;
  let healthCalls = 0;
  let statusCalls = 0;
  const server = await startServer(async (req, res) => {
    if (req.url === '/v1/health') {
      healthCalls += 1;
      assert.equal(auth(req), `Bearer ${accepted}`);
      json(res, 200, healthBody(published));
      return;
    }
    if (req.url === '/v1/status') {
      statusCalls += 1;
      if (accepted === oldToken) {
        assert.equal(auth(req), `Bearer ${oldToken}`);
        accepted = newToken;
        await publish(fixture, server.port, newToken);
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      assert.equal(auth(req), `Bearer ${newToken}`);
      json(res, 200, { ok: true, generation: 2 });
      return;
    }
    json(res, 404, { error: 'not_found' });
  });
  try {
    published = await publish(fixture, server.port, oldToken);
    const client = new ControlClient(fixture.config);
    await client.health();
    const response = await client.get<{ ok: boolean; generation: number }>('/v1/status');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, generation: 2 });
    assert.equal(response.ambiguous, false);
    assert.equal(healthCalls, 2);
    assert.equal(statusCalls, 2);
  } finally {
    await server.close();
    await destroyFixture(fixture);
  }
});

test('GET rediscoveries once after reset and port rotation', async () => {
  const fixture = await createFixture();
  const oldToken = token(7);
  const newToken = token(8);
  let oldPublished!: EndpointPublication;
  let newPublished!: EndpointPublication;
  let oldStatusCalls = 0;
  let newStatusCalls = 0;
  let newHealthCalls = 0;
  const next = await startServer((req, res) => {
    if (req.url === '/v1/health') {
      newHealthCalls += 1;
      assert.equal(auth(req), `Bearer ${newToken}`);
      json(res, 200, healthBody(newPublished));
      return;
    }
    if (req.url === '/v1/status') {
      newStatusCalls += 1;
      json(res, 200, { ok: true, port: next.port });
      return;
    }
    json(res, 404, { error: 'not_found' });
  });
  const old = await startServer(async (req, res) => {
    if (req.url === '/v1/health') {
      json(res, 200, healthBody(oldPublished));
      return;
    }
    if (req.url === '/v1/status') {
      oldStatusCalls += 1;
      newPublished = await publish(fixture, next.port, newToken);
      req.socket.destroy();
      return;
    }
    json(res, 404, { error: 'not_found' });
  });
  try {
    oldPublished = await publish(fixture, old.port, oldToken);
    const client = new ControlClient(fixture.config);
    await client.health();
    const response = await client.get<{ ok: boolean; port: number }>('/v1/status');
    assert.equal(response.status, 200);
    assert.equal(response.body.port, next.port);
    assert.equal(oldStatusCalls, 1);
    assert.equal(newHealthCalls, 1);
    assert.equal(newStatusCalls, 1);
  } finally {
    await old.close();
    await next.close();
    await destroyFixture(fixture);
  }
});

test('change snapshots are capability-gated and strictly validate the bounded broker DTO', async () => {
  const fixture = await createFixture();
  const bearer = token(19);
  const instanceId = '11111111-1111-4111-8111-111111111111';
  let published!: EndpointPublication;
  let routes: readonly string[] = REQUIRED_CONTROL_ROUTES;
  let changeCalls = 0;
  const server = await startServer((req, res) => {
    if (req.url === '/v1/health') {
      json(res, 200, healthBody(published, { routes }));
      return;
    }
    if (req.url === CONTROL_CHANGE_ROUTE) {
      changeCalls += 1;
      json(res, 200, changeCalls === 1
        ? { instanceId, seq: 7, reason: 'snapshot' }
        : { instanceId, seq: 8, reason: 'snapshot', leaked: 'not-allowed' });
      return;
    }
    json(res, 404, { error: 'not_found' });
  });
  try {
    published = await publish(fixture, server.port, bearer);
    const client = new ControlClient(fixture.config);
    const oldCoreHealth = await client.health();
    assert.equal(client.supportsSemanticWait(oldCoreHealth), false);
    await assert.rejects(client.snapshotChanges(), errorCode('unsupported_control_api', [bearer]));
    assert.equal(changeCalls, 0, 'old Core must not be probed for an unadvertised change route');

    routes = [...REQUIRED_CONTROL_ROUTES, CONTROL_CHANGE_ROUTE];
    const newCoreHealth = await client.health();
    assert.equal(client.supportsSemanticWait(newCoreHealth), true);
    assert.deepEqual(await client.snapshotChanges(), { instanceId, seq: 7, reason: 'snapshot' });
    await assert.rejects(client.snapshotChanges(), errorCode('invalid_response', [bearer]));
  } finally {
    await server.close();
    await destroyFixture(fixture);
  }
});

test('waitForChange has no default business timeout and abort closes the held GET promptly', async () => {
  const fixture = await createFixture();
  const bearer = token(20);
  const instanceId = '22222222-2222-4222-8222-222222222222';
  let published!: EndpointPublication;
  let seenResolve!: () => void;
  let closedResolve!: () => void;
  const seen = new Promise<void>((resolve) => { seenResolve = resolve; });
  const closed = new Promise<void>((resolve) => { closedResolve = resolve; });
  const server = await startServer((req, res) => {
    if (req.url === '/v1/health') {
      json(res, 200, healthBody(published, { routes: [...REQUIRED_CONTROL_ROUTES, CONTROL_CHANGE_ROUTE] }));
      return;
    }
    if (req.url === `${CONTROL_CHANGE_ROUTE}?instance=${instanceId}&after=4`) {
      seenResolve();
      req.once('close', closedResolve);
      return;
    }
    json(res, 404, { error: 'not_found' });
  });
  try {
    published = await publish(fixture, server.port, bearer);
    const client = new ControlClient(fixture.config);
    await client.health();
    const controller = new AbortController();
    const waiting = client.waitForChange({ instanceId, after: 4 }, { signal: controller.signal });
    await seen;
    controller.abort();
    await assert.rejects(waiting, errorCode('request_aborted', [bearer]));
    await closed;
  } finally {
    await server.close();
    await destroyFixture(fixture);
  }
});

test('waitForChange safely rediscovers once after token rotation and preserves the broker cursor', async () => {
  const fixture = await createFixture();
  const oldToken = token(21);
  const newToken = token(22);
  const instanceId = '33333333-3333-4333-8333-333333333333';
  let accepted = oldToken;
  let published!: EndpointPublication;
  let healthCalls = 0;
  let changeCalls = 0;
  const expectedPath = `${CONTROL_CHANGE_ROUTE}?instance=${instanceId}&after=9`;
  const server = await startServer(async (req, res) => {
    if (req.url === '/v1/health') {
      healthCalls += 1;
      assert.equal(auth(req), `Bearer ${accepted}`);
      json(res, 200, healthBody(published, { routes: [...REQUIRED_CONTROL_ROUTES, CONTROL_CHANGE_ROUTE] }));
      return;
    }
    if (req.url === expectedPath) {
      changeCalls += 1;
      if (changeCalls === 1) {
        assert.equal(auth(req), `Bearer ${oldToken}`);
        accepted = newToken;
        published = await publish(fixture, server.port, newToken);
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      assert.equal(auth(req), `Bearer ${newToken}`);
      json(res, 200, { instanceId, seq: 10, reason: 'changed' });
      return;
    }
    json(res, 404, { error: 'not_found' });
  });
  try {
    published = await publish(fixture, server.port, oldToken);
    const client = new ControlClient(fixture.config);
    await client.health();
    assert.deepEqual(await client.waitForChange({ instanceId, after: 9 }), {
      instanceId,
      seq: 10,
      reason: 'changed',
    });
    assert.equal(healthCalls, 2);
    assert.equal(changeCalls, 2);
  } finally {
    await server.close();
    await destroyFixture(fixture);
  }
});

test('POST is sent once on connection reset and is never replayed to a rotated epoch', async () => {
  const fixture = await createFixture();
  const oldToken = token(9);
  const newToken = token(10);
  let oldPublished!: EndpointPublication;
  let newPublished!: EndpointPublication;
  let oldPosts = 0;
  let newRequests = 0;
  const next = await startServer((req, res) => {
    newRequests += 1;
    json(res, 200, req.url === '/v1/health' ? healthBody(newPublished) : { ok: true });
  });
  const old = await startServer(async (req, res) => {
    if (req.url === '/v1/health') {
      json(res, 200, healthBody(oldPublished));
      return;
    }
    if (req.method === 'POST') {
      oldPosts += 1;
      newPublished = await publish(fixture, next.port, newToken);
      req.socket.destroy();
      return;
    }
    json(res, 404, { error: 'not_found' });
  });
  try {
    oldPublished = await publish(fixture, old.port, oldToken);
    const client = new ControlClient(fixture.config);
    await assert.rejects(
      client.post('/v1/inputs', { text: 'one-shot' }),
      (error: unknown) => errorCode('mutation_ambiguous', [oldToken, newToken])(error)
        && (error as ControlClientError).ambiguous === true,
    );
    assert.equal(oldPosts, 1);
    assert.equal(newRequests, 0, 'mutation must not be replayed against the newly published epoch');
  } finally {
    await old.close();
    await next.close();
    await destroyFixture(fixture);
  }
});

test('POST runs the mutation fence after live-epoch preflight and sends nothing when the fence rejects', async () => {
  const fixture = await createFixture();
  const bearer = token(17);
  let published!: EndpointPublication;
  const sequence: string[] = [];
  let posts = 0;
  const server = await startServer((req, res) => {
    if (req.url === '/v1/health') {
      sequence.push('health');
      json(res, 200, healthBody(published));
      return;
    }
    if (req.method === 'POST') {
      posts += 1;
      sequence.push('post');
      json(res, 200, { ok: true });
      return;
    }
    json(res, 404, { error: 'not_found' });
  });
  try {
    published = await publish(fixture, server.port, bearer);
    const client = new ControlClient(fixture.config);
    await assert.rejects(
      client.post('/v1/inputs', { text: 'fenced' }, {}, async () => {
        sequence.push('fence');
        throw new Error('controller_lost');
      }),
      /controller_lost/u,
    );
    assert.deepEqual(sequence, ['health', 'fence']);
    assert.equal(posts, 0);
  } finally {
    await server.close();
    await destroyFixture(fixture);
  }
});

test('POST does not replay a 401 and revalidates a later mutation against the new epoch', async () => {
  const fixture = await createFixture();
  const oldToken = token(11);
  const newToken = token(12);
  let oldPublished!: EndpointPublication;
  let newPublished!: EndpointPublication;
  let oldPosts = 0;
  let newPosts = 0;
  let newHealth = 0;
  const next = await startServer((req, res) => {
    if (req.url === '/v1/health') {
      newHealth += 1;
      assert.equal(auth(req), `Bearer ${newToken}`);
      json(res, 200, healthBody(newPublished));
      return;
    }
    if (req.method === 'POST') {
      newPosts += 1;
      json(res, 200, { ok: true, epoch: 'new' });
      return;
    }
    json(res, 404, { error: 'not_found' });
  });
  const old = await startServer(async (req, res) => {
    if (req.url === '/v1/health') {
      json(res, 200, healthBody(oldPublished));
      return;
    }
    if (req.method === 'POST') {
      oldPosts += 1;
      newPublished = await publish(fixture, next.port, newToken);
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    json(res, 404, { error: 'not_found' });
  });
  try {
    oldPublished = await publish(fixture, old.port, oldToken);
    const client = new ControlClient(fixture.config);
    const first = await client.post('/v1/inputs', { text: 'first' });
    assert.equal(first.status, 401);
    assert.equal(first.ambiguous, false);
    assert.equal(oldPosts, 1);
    assert.equal(newPosts, 0, '401 mutation must not be replayed automatically');

    const second = await client.post('/v1/inputs', { text: 'second' });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { ok: true, epoch: 'new' });
    assert.equal(newHealth, 1);
    assert.equal(newPosts, 1);
  } finally {
    await old.close();
    await next.close();
    await destroyFixture(fixture);
  }
});

test('POST classifies 504 before-start as non-ambiguous and may-still-complete as ambiguous without retry', async () => {
  const fixture = await createFixture();
  const bearer = token(13);
  let published!: EndpointPublication;
  let posts = 0;
  const server = await startServer((req, res) => {
    if (req.url === '/v1/health') {
      json(res, 200, healthBody(published));
      return;
    }
    posts += 1;
    if (posts === 1) {
      json(res, 504, { error: 'timeout', detail: 'the action did not start and will not run; it is safe to send again' });
      return;
    }
    json(res, 504, { error: 'timeout', detail: 'the action may still complete' });
  });
  try {
    published = await publish(fixture, server.port, bearer);
    const client = new ControlClient(fixture.config);
    const beforeStart = await client.post('/v1/inputs', { text: 'first' });
    assert.equal(beforeStart.status, 504);
    assert.equal(beforeStart.ambiguous, false);
    assert.equal(posts, 1);

    const mayComplete = await client.post('/v1/inputs', { text: 'second' });
    assert.equal(mayComplete.status, 504);
    assert.equal(mayComplete.ambiguous, true);
    assert.equal(posts, 2);
  } finally {
    await server.close();
    await destroyFixture(fixture);
  }
});

test('429 preserves bounded Retry-After without retrying the mutation', async () => {
  const fixture = await createFixture();
  const bearer = token(14);
  let published!: EndpointPublication;
  let posts = 0;
  const server = await startServer((req, res) => {
    if (req.url === '/v1/health') {
      json(res, 200, healthBody(published));
      return;
    }
    posts += 1;
    json(res, 429, { error: 'rate_limited' }, { 'retry-after': '7' });
  });
  try {
    published = await publish(fixture, server.port, bearer);
    const response = await new ControlClient(fixture.config).post('/v1/inputs', { text: 'once' });
    assert.equal(response.status, 429);
    assert.equal(response.retryAfterMs, 7_000);
    assert.equal(response.ambiguous, false);
    assert.equal(posts, 1);
  } finally {
    await server.close();
    await destroyFixture(fixture);
  }
});

test('GET rejects malformed and oversized responses without exposing bearer values in errors', async () => {
  const fixture = await createFixture();
  const bearer = token(15);
  let published!: EndpointPublication;
  const server = await startServer((req, res) => {
    if (req.url === '/v1/health') {
      json(res, 200, healthBody(published));
      return;
    }
    if (req.url === '/malformed') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(`{"secret":"${bearer}"`);
      return;
    }
    if (req.url === '/oversized') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(1024 * 1024 + 1) });
      res.end('{}');
      return;
    }
    json(res, 404, { error: 'not_found' });
  });
  try {
    published = await publish(fixture, server.port, bearer);
    const client = new ControlClient(fixture.config);
    await assert.rejects(client.get('/malformed'), errorCode('invalid_response', [bearer]));
    await assert.rejects(client.get('/oversized'), errorCode('response_too_large', [bearer]));
  } finally {
    await server.close();
    await destroyFixture(fixture);
  }
});

test('typed list/get/inputs/events helpers use bounded canonical paths and validate response shapes', async () => {
  const fixture = await createFixture();
  const bearer = token(16);
  const session = {
    id: 'session-1234',
    title: 'Prime',
    conversationId: 'conversation-1',
    projectId: 'project-1',
    updatedAt: 100,
    endedAt: null,
    activeTurnId: 'turn-1',
    origin: { kind: 'prime' },
  };
  const input = {
    id: '00000000-0000-4000-8000-000000000001',
    sessionId: session.id,
    deliveredSessionId: null,
    conversationId: session.conversationId,
    state: 'pending',
    delivery: 'pending',
    automatic: false,
    purpose: 'external_orchestrator',
    createdAt: 101,
    dueAt: 102,
    sendAuthorizedAt: null,
    text: { text: 'hello', chars: 5, truncated: false },
  };
  const event = { seq: 1, position: 0, time: 102, kind: 'message', source: 'assistant', message: { text: 'ok', chars: 2, truncated: false } };
  const live = {
    activeTurnId: 'turn-1',
    stopPending: false,
    automation: 'goal',
    blocked: '',
    canSendDirectly: true,
    canInject: false,
    queueAtFinish: false,
    finishHeld: false,
    finishWaiting: false,
    goalWait: { reason: 'activity', until: 500 },
    recovery: [{ kind: 'silence', deadline: 400, visibleAt: null, next: 'goal', reload: false, generating: false }],
    job: { stage: 'opening', startedAt: 90, automatic: true, busy: true, sourceSend: 'sent', destinationSend: 'not-attempted', error: null },
    work: { state: 'waiting', reasons: ['recovery', 'goal_wait', 'job'], nextDeadline: 400 },
  };
  const seen: string[] = [];
  let detailCalls = 0;
  let published!: EndpointPublication;
  const server = await startServer((req, res) => {
    seen.push(String(req.url));
    if (req.url === '/v1/health') return json(res, 200, healthBody(published));
    if (req.url === '/v1/sessions?limit=2&cursor=12.session-1234') return json(res, 200, { sessions: [session], total: 1, nextCursor: null, activeId: session.id });
    if (req.url === '/v1/sessions/session-1234?live=1') {
      detailCalls += 1;
      return json(res, 200, {
        session,
        live: detailCalls === 1 ? live : { ...live, work: { ...live.work, unexpected: true } },
      });
    }
    if (req.url === '/v1/inputs?limit=3&state=pending%2Csent') return json(res, 200, { inputs: [input], total: 1 });
    if (req.url === '/v1/sessions/session-1234/events?after=7&limit=4&kinds=message%2Ctool') return json(res, 200, { events: [event], total: 1, nextFrom: 8 });
    if (req.url === '/v1/sessions?limit=1') return json(res, 200, { sessions: [{ ...session, updatedAt: 'bad' }], total: 1, nextCursor: null, activeId: session.id });
    return json(res, 404, { error: 'not_found' });
  });
  try {
    published = await publish(fixture, server.port, bearer);
    const client = new ControlClient(fixture.config);
    const sessions = await client.listSessions({ limit: 2, cursor: '12.session-1234' });
    assert.deepEqual(sessions.sessions, [session]);
    const detail = await client.getSession('session-1234', { live: true });
    assert.equal(detail?.session.id, session.id);
    assert.deepEqual(detail?.live?.work, live.work);
    const inputs = await client.listInputs({ limit: 3, state: ['pending', 'sent'] });
    assert.deepEqual(inputs.inputs, [input]);
    const events = await client.readEvents('session-1234', { after: 7, limit: 4, kinds: ['message', 'tool'] });
    assert.deepEqual(events.events, [event]);
    await assert.rejects(client.getSession('session-1234', { live: true }), errorCode('invalid_response', [bearer]));
    await assert.rejects(client.listSessions({ limit: 1 }), errorCode('invalid_response', [bearer]));
    assert.deepEqual(seen, [
      '/v1/health',
      '/v1/sessions?limit=2&cursor=12.session-1234',
      '/v1/sessions/session-1234?live=1',
      '/v1/inputs?limit=3&state=pending%2Csent',
      '/v1/sessions/session-1234/events?after=7&limit=4&kinds=message%2Ctool',
      '/v1/sessions/session-1234?live=1',
      '/v1/sessions?limit=1',
    ]);
  } finally {
    await server.close();
    await destroyFixture(fixture);
  }
});
