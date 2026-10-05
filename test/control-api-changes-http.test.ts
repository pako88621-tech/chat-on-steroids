import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '', getVersion: vi.fn(() => '0.0.0'), getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  BrowserWindow: class {},
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => '') },
  nativeTheme: { themeSource: 'system' }
}));

const { initConfigPath } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const controlApi = await import('../src/main/control-api.js');
const { notifyChanged } = await import('../src/main/session/recorder.js');
const { setChatBlocked } = await import('../src/main/session/blocked-chats.js');

let dir: string;

beforeAll(async () => {
  dir = await makeTempDir('clf-control-changes-http-');
  initConfigPath(dir);
  initSecretsPath(dir);
  controlApi.initControlApiPath(dir);
});

afterEach(async () => {
  await controlApi.stopControlApi();
});

afterAll(async () => {
  await controlApi.shutdownControlApi();
  await removeTempDir(dir);
});

async function endpoint(): Promise<{ port: number; token: string }> {
  const value = JSON.parse(await fs.readFile(path.join(dir, 'control-api', 'endpoint.json'), 'utf8')) as { port: number };
  const token = (await fs.readFile(path.join(dir, 'control-api', 'token'), 'utf8')).trim();
  return { port: value.port, token };
}

function get(
  port: number,
  token: string,
  route: string,
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method: 'GET',
      headers: { authorization: 'Bearer ' + token },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown = raw;
        try { body = raw ? JSON.parse(raw) : null; } catch { /* keep raw */ }
        resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function heldGet(
  port: number,
  token: string,
  route: string,
): { request: http.ClientRequest; result: Promise<{ status: number; body: any }> } {
  let request!: http.ClientRequest;
  const result = new Promise<{ status: number; body: any }>((resolve, reject) => {
    request = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method: 'GET',
      headers: { authorization: 'Bearer ' + token },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
      });
    });
    request.on('error', reject);
    request.end();
  });
  return { request, result };
}

describe('Local Control change feed over HTTP', () => {
  it('publishes a generation snapshot, validates the exact cursor grammar, and resets across restart', async () => {
    await controlApi.startControlApi();
    const first = await endpoint();
    const snapshot = await get(first.port, first.token, '/v1/changes');
    expect(snapshot.status).toBe(200);
    expect(snapshot.body).toMatchObject({ seq: 0, reason: 'snapshot' });
    expect(snapshot.body.instanceId).toMatch(/^[0-9a-f-]{36}$/i);

    for (const route of [
      '/v1/changes?instance=bad&after=0',
      '/v1/changes?instance=' + snapshot.body.instanceId,
      '/v1/changes?after=0',
      '/v1/changes?instance=' + snapshot.body.instanceId + '&after=-1',
      '/v1/changes?instance=' + snapshot.body.instanceId + '&after=0&after=0',
      '/v1/changes?instance=' + snapshot.body.instanceId + '&after=0&extra=1',
    ]) {
      const response = await get(first.port, first.token, route);
      expect(response.status, route).toBe(400);
      expect(response.body.error).toBe('invalid_query');
    }

    await controlApi.stopControlApi();
    await controlApi.startControlApi();
    const second = await endpoint();
    const next = await get(second.port, second.token, '/v1/changes');
    expect(next.body.instanceId).not.toBe(snapshot.body.instanceId);
    const reset = await get(
      second.port,
      second.token,
      '/v1/changes?instance=' + snapshot.body.instanceId + '&after=' + snapshot.body.seq,
    );
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ instanceId: next.body.instanceId, seq: 0, reason: 'reset' });
  });

  it('parks without a business timer and wakes only after an owner invalidates the generation', async () => {
    await controlApi.startControlApi();
    const { port, token } = await endpoint();
    const snapshot = (await get(port, token, '/v1/changes')).body;
    const wait = heldGet(port, token, '/v1/changes?instance=' + snapshot.instanceId + '&after=' + snapshot.seq);

    notifyChanged('2026-10-05-change-http-test');
    const changed = await wait.result;
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ instanceId: snapshot.instanceId, reason: 'changed' });
    expect(changed.body.seq).toBeGreaterThan(snapshot.seq);
  });

  it('wakes when the blocked-chat owner changes work state', async () => {
    await controlApi.startControlApi();
    const { port, token } = await endpoint();
    const snapshot = (await get(port, token, '/v1/changes')).body;
    const wait = heldGet(port, token, '/v1/changes?instance=' + snapshot.instanceId + '&after=' + snapshot.seq);
    const conversationId = 'chat-changes-blocked';
    try {
      setChatBlocked(conversationId, true);
      const changed = await wait.result;
      expect(changed.status).toBe(200);
      expect(changed.body).toMatchObject({ instanceId: snapshot.instanceId, reason: 'changed' });
      expect(changed.body.seq).toBeGreaterThan(snapshot.seq);
    } finally {
      setChatBlocked(conversationId, false);
    }
  });

  it('does not consume ordinary unfinished-read slots and client cancellation releases held watches', async () => {
    await controlApi.startControlApi();
    const { port, token } = await endpoint();
    const snapshot = (await get(port, token, '/v1/changes')).body;
    const waits = Array.from({ length: 12 }, () =>
      heldGet(port, token, '/v1/changes?instance=' + snapshot.instanceId + '&after=' + snapshot.seq));

    const status = await get(port, token, '/v1/status');
    expect(status.status).toBe(200);

    for (const wait of waits) wait.request.destroy();
    const settled = await Promise.allSettled(waits.map(wait => wait.result));
    expect(settled.every(result => result.status === 'rejected')).toBe(true);

    const replacement = heldGet(port, token, '/v1/changes?instance=' + snapshot.instanceId + '&after=' + snapshot.seq);
    notifyChanged('2026-10-05-change-http-replacement');
    expect((await replacement.result).body.reason).toBe('changed');
  });
});
