import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcpb } from './package-process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
const artifact = path.join(root, 'release', `${manifest.name}-${manifest.version}.mcpb`);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-eo-mcpb-smoke-'));
const unpacked = path.join(temporary, 'unpacked');
const absentProfile = path.join(temporary, 'absent-cos-profile');
const stateDir = path.join(temporary, 'eo-state');

const REQUIRED_ROUTES = ['/v1/health', '/v1/status', '/v1/sessions', '/v1/sessions/{id}', '/v1/sessions/{id}/events', '/v1/inputs'];
const REQUIRED_ACTION_ROUTES = ['POST /v1/inputs', 'POST /v1/inputs/{id}/cancel', 'POST /v1/sessions/{id}/stop'];

function json(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length) });
  res.end(bytes);
}

async function startControlServer(bearer, requestedPort = 0) {
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${bearer}`) return json(res, 401, { error: 'unauthorized' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/v1/health') return json(res, 200, {
      ok: true,
      protocol: 1,
      routes: REQUIRED_ROUTES,
      actions: { enabled: true, routes: REQUIRED_ACTION_ROUTES, features: ['input_expected_conversation'] },
      pid: process.pid,
      appVersion: '2.1.26-smoke',
      startedAt: '2026-10-04T12:00:00.000Z',
      uptimeSeconds: 1,
    });
    if (url.pathname === '/v1/sessions') return json(res, 200, { sessions: [], total: 0, nextCursor: null, activeId: null });
    return json(res, 404, { error: 'not_found' });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const port = server.address().port;
  return {
    port,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function publishControl(port, bearer) {
  const control = path.join(absentProfile, 'control-api');
  await fs.mkdir(control, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(control, 'token'), `${bearer}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(control, 'endpoint.json'), `${JSON.stringify({
    protocol: 1,
    port,
    pid: process.pid,
    appVersion: '2.1.26-smoke',
    startedAt: '2026-10-04T12:00:00.000Z',
  })}\n`, { mode: 0o600 });
}

function lineClient(child) {
  let buffer = '';
  let nextId = 0;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (typeof message.id === 'number') pending.get(message.id)?.(message);
    }
  });
  return {
    request(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for extracted MCPB ${method}`));
        }, 5_000);
        pending.set(id, message => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
  };
}

try {
  runMcpb(root, ['unpack', artifact, unpacked], { cwd: root });
  const entry = path.join(unpacked, 'dist', 'stdio.js');
  await fs.access(entry);
  const child = spawn(process.execPath, [entry], {
    cwd: unpacked,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CHAT_ON_STEROIDS_USER_DATA_DIR: absentProfile,
      CHAT_ON_STEROIDS_EXTERNAL_ORCHESTRATOR_STATE_DIR: stateDir,
    },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const client = lineClient(child);
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'eo-extracted-artifact-smoke', version: '1.0.0' },
    });
    if (!initialized.result) throw new Error(`Extracted MCPB initialize failed: ${JSON.stringify(initialized)}`);
    const listed = await client.request('tools/list');
    const names = listed.result?.tools?.map(tool => tool.name);
    if (JSON.stringify(names) !== JSON.stringify(['cos_orchestrate', 'cos_evidence'])) {
      throw new Error(`Extracted MCPB tool list mismatch: ${JSON.stringify(names)}`);
    }
    const status = await client.request('tools/call', { name: 'cos_orchestrate', arguments: { action: 'status' } });
    if (status.result?.structuredContent?.error?.code !== 'control_api_unavailable') {
      throw new Error(`Extracted MCPB did not stay alive while CoS was absent: ${JSON.stringify(status)}`);
    }

    const firstToken = randomBytes(32).toString('base64url');
    const firstControl = await startControlServer(firstToken);
    await publishControl(firstControl.port, firstToken);
    try {
      const attached = await client.request('tools/call', { name: 'cos_orchestrate', arguments: { action: 'status' } });
      if (attached.result?.structuredContent?.error?.code !== 'no_executor' || attached.result?.structuredContent?.connected !== true) {
        throw new Error(`Extracted MCPB did not hot-attach to Local Control: ${JSON.stringify(attached)}`);
      }

      await firstControl.close();
      // Hold the stale port and reject the old token so the next read must rediscover the newly
      // published port/token rather than succeeding accidentally on a reused listener.
      const blocker = http.createServer((_req, res) => json(res, 401, { error: 'unauthorized' }));
      await new Promise((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(firstControl.port, '127.0.0.1', () => { blocker.off('error', reject); resolve(); });
      });
      const secondToken = randomBytes(32).toString('base64url');
      const secondControl = await startControlServer(secondToken);
      try {
        if (secondControl.port === firstControl.port) throw new Error('Smoke failed to rotate Local Control port.');
        await publishControl(secondControl.port, secondToken);
        const rotated = await client.request('tools/call', { name: 'cos_evidence', arguments: {} });
        if (rotated.result?.structuredContent?.error?.code !== 'no_executor') {
          throw new Error(`Extracted MCPB did not recover after token/port rotation: ${JSON.stringify(rotated)}`);
        }
      } finally {
        await secondControl.close();
        await new Promise(resolve => blocker.close(resolve));
      }
    } finally {
      // firstControl may already be closed after the deliberate rotation.
      await firstControl.close().catch(() => undefined);
    }
  } finally {
    child.stdin.end();
    const exit = await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Extracted MCPB did not exit after EOF')), 5_000)),
    ]);
    const code = exit[0];
    if (code !== 0) throw new Error(`Extracted MCPB exited ${code}: ${stderr.slice(0, 2_000)}`);
  }
  process.stdout.write('Extracted External Orchestrator MCPB process smoke passed.\n');
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
