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
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-eo-mcpb-controller-'));
const unpacked = path.join(temporary, 'unpacked');
const userData = path.join(temporary, 'cos-profile');
const stateDir = path.join(temporary, 'eo-state');
const token = randomBytes(32).toString('base64url');
const startedAt = '2026-10-04T12:00:00.000Z';
const sessions = new Map([
  ['session-aaa00001', 'conversation-a'],
  ['session-bbb00002', 'conversation-b'],
]);
const inputs = new Map();
let mutationPosts = 0;

function json(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length) });
  res.end(bytes);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { reject(error); }
    });
  });
}

function sessionSummary(id, conversationId) {
  return {
    id,
    title: id,
    conversationId,
    projectId: null,
    updatedAt: 1,
    endedAt: null,
    activeTurnId: null,
    origin: { kind: 'desktop' },
  };
}

function live() {
  return {
    activeTurnId: null,
    stopPending: false,
    blocked: '',
    canSendDirectly: true,
    canInject: false,
    queueAtFinish: true,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'unauthorized' });
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/v1/health') return json(res, 200, {
    ok: true,
    protocol: 1,
    routes: ['/v1/health', '/v1/status', '/v1/sessions', '/v1/sessions/{id}', '/v1/sessions/{id}/events', '/v1/inputs'],
    actions: {
      enabled: true,
      routes: ['POST /v1/inputs', 'POST /v1/inputs/{id}/cancel', 'POST /v1/sessions/{id}/stop'],
      features: ['input_expected_conversation'],
    },
    pid: process.pid,
    appVersion: '2.1.26-smoke',
    startedAt,
    uptimeSeconds: 1,
  });
  if (req.method === 'GET' && url.pathname === '/v1/inputs') {
    return json(res, 200, { inputs: [...inputs.values()], total: inputs.size });
  }
  const sessionMatch = /^\/v1\/sessions\/([0-9a-z-]{8,64})$/u.exec(url.pathname);
  if (req.method === 'GET' && sessionMatch) {
    const conversationId = sessions.get(sessionMatch[1]);
    if (!conversationId) return json(res, 404, { error: 'session_not_found' });
    return json(res, 200, { session: sessionSummary(sessionMatch[1], conversationId), live: live() });
  }
  if (req.method === 'POST' && url.pathname === '/v1/inputs') {
    const body = await readBody(req);
    const conversationId = sessions.get(body.sessionId);
    if (!conversationId) return json(res, 404, { error: 'session_not_found' });
    if (body.expectedConversationId !== conversationId) return json(res, 409, { error: 'conversation_changed' });
    const existing = inputs.get(body.id);
    if (existing) {
      if (existing.sessionId !== body.sessionId || existing.text.text !== body.text || existing.conversationId !== body.expectedConversationId) {
        return json(res, 409, { error: 'id_conflict' });
      }
      return json(res, 200, { input: existing, replayed: true });
    }
    mutationPosts += 1;
    const createdAt = Date.now();
    const row = {
      id: body.id,
      sessionId: body.sessionId,
      deliveredSessionId: null,
      conversationId,
      state: 'queued',
      delivery: 'pending',
      automatic: false,
      purpose: null,
      createdAt,
      dueAt: createdAt,
      sendAuthorizedAt: null,
      text: { text: body.text, chars: body.text.length, truncated: false },
    };
    inputs.set(body.id, row);
    return json(res, 202, { input: row, replayed: false });
  }
  return json(res, 404, { error: 'not_found' });
});

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
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out waiting for ${method}`)); }, 5_000);
        pending.set(id, message => { clearTimeout(timer); pending.delete(id); resolve(message); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
  };
}

async function spawnMcp(entry) {
  const child = spawn(process.execPath, [entry], {
    cwd: unpacked,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CHAT_ON_STEROIDS_USER_DATA_DIR: userData,
      CHAT_ON_STEROIDS_EXTERNAL_ORCHESTRATOR_STATE_DIR: stateDir,
    },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const client = lineClient(child);
  const initialized = await client.request('initialize', {
    protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'eo-controller-smoke', version: '1.0.0' },
  });
  if (!initialized.result) throw new Error(`MCP initialize failed: ${JSON.stringify(initialized)} ${stderr}`);
  return { child, client, stderr: () => stderr };
}

async function closeMcp(instance) {
  instance.child.stdin.end();
  const [code] = await Promise.race([
    once(instance.child, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('MCP child did not exit after EOF')), 5_000)),
  ]);
  if (code !== 0) throw new Error(`MCP child exited ${code}: ${instance.stderr().slice(0, 2_000)}`);
}

async function start(client, sessionId, requestId) {
  const response = await client.request('tools/call', {
    name: 'cos_orchestrate',
    arguments: { action: 'start', objective: `Objective ${requestId}`, constraints: [], session_id: sessionId, request_id: requestId },
  });
  return response.result?.structuredContent;
}

try {
  runMcpb(root, ['unpack', artifact, unpacked], { cwd: root });
  const entry = path.join(unpacked, 'dist', 'stdio.js');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const port = server.address().port;
  const control = path.join(userData, 'control-api');
  await fs.mkdir(control, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(control, 'token'), `${token}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(control, 'endpoint.json'), `${JSON.stringify({
    protocol: 1, port, pid: process.pid, appVersion: '2.1.26-smoke', startedAt,
  })}\n`, { mode: 0o600 });

  const owner = await spawnMcp(entry);
  const contender = await spawnMcp(entry);
  try {
    const owned = await start(owner.client, 'session-aaa00001', 'process-owner');
    if (owned?.ok !== true) throw new Error(`Owner mutation failed: ${JSON.stringify(owned)}`);
    const beforeBusy = mutationPosts;
    const busy = await start(contender.client, 'session-bbb00002', 'process-contender');
    if (busy?.error?.code !== 'controller_busy' || mutationPosts !== beforeBusy) {
      throw new Error(`Second MCP process was not fenced by controller lock: ${JSON.stringify(busy)}`);
    }

    await closeMcp(owner);
    const admitted = await start(contender.client, 'session-bbb00002', 'process-contender');
    if (admitted?.ok !== true || mutationPosts !== beforeBusy + 1) {
      throw new Error(`Contender did not recover after controller release: ${JSON.stringify(admitted)}`);
    }
    await closeMcp(contender);

    const restarted = await spawnMcp(entry);
    try {
      const beforeReplay = mutationPosts;
      const replay = await start(restarted.client, 'session-bbb00002', 'process-contender');
      if (replay?.ok !== true || mutationPosts !== beforeReplay) {
        throw new Error(`MCP restart duplicated an accepted request: ${JSON.stringify(replay)}`);
      }
    } finally {
      await closeMcp(restarted);
    }
  } finally {
    if (owner.child.exitCode === null) await closeMcp(owner).catch(() => undefined);
    if (contender.child.exitCode === null) await closeMcp(contender).catch(() => undefined);
  }
  if (mutationPosts !== 2 || inputs.size !== 2) throw new Error(`Expected two logical mutations, got posts=${mutationPosts} rows=${inputs.size}`);
  process.stdout.write('Extracted External Orchestrator cross-process controller/restart smoke passed.\n');
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true });
}
