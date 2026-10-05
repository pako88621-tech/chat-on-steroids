import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { EXTERNAL_ORCHESTRATOR_VERSION } from '../version.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '..', 'stdio.js');
const offlineProfile = path.join(here, 'definitely-absent-cos-profile');
const expectedTools = ['cos_orchestrate', 'cos_evidence'];
const modernVersion = '2026-07-28';
const legacyVersion = '2025-11-25';

function stdioTransport(): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...getDefaultEnvironment(),
      CHAT_ON_STEROIDS_USER_DATA_DIR: offlineProfile,
    },
    stderr: 'pipe',
  });
}

async function closeClient(client: Client): Promise<void> {
  await client.close().catch(() => undefined);
}

function lineClient(child: ChildProcessWithoutNullStreams) {
  let buffer = '';
  const pending = new Map<number, (message: any) => void>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const at = buffer.indexOf('\n');
      if (at < 0) break;
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (typeof message.id === 'number') pending.get(message.id)?.(message);
    }
  });
  let id = 0;
  const request = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timed out waiting for ${method}`)); }, 5_000);
    pending.set(requestId, message => { clearTimeout(timer); pending.delete(requestId); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
  const notify = (method: string, params: Record<string, unknown> = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };
  return { notify, request };
}

async function initializeLegacy(client: ReturnType<typeof lineClient>) {
  const response = await client.request('initialize', {
    protocolVersion: legacyVersion, capabilities: {}, clientInfo: { name: 'eo-process-contract', version: '1.0.0' },
  });
  assert.ok(response.result, JSON.stringify(response));
  assert.equal(response.result.protocolVersion, legacyVersion);
  client.notify('notifications/initialized');
}

test('official modern client pins 2026-07-28, discovers the server, and stays available while CoS is offline', async () => {
  const client = new Client(
    { name: 'eo-modern-process-contract', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: modernVersion } } },
  );
  const transport = stdioTransport();
  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), 'modern');
    assert.equal(client.getNegotiatedProtocolVersion(), modernVersion);
    assert.ok(client.getDiscoverResult());
    assert.equal(client.getServerVersion()?.version, EXTERNAL_ORCHESTRATOR_VERSION);

    const discovered = await client.discover();
    assert.deepEqual(Object.keys(discovered.capabilities), ['tools']);
    assert.equal(typeof discovered.instructions, 'string');

    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name), expectedTools);

    const status = await client.callTool({ name: 'cos_orchestrate', arguments: { action: 'status' } });
    const structured = status.structuredContent as { ok?: boolean; error?: { code?: string } } | undefined;
    assert.equal(status.isError, undefined);
    assert.equal(structured?.ok, false);
    assert.equal(structured?.error?.code, 'control_api_unavailable');
    assert.notEqual(transport.pid, null);
    process.kill(transport.pid!, 0);
  } finally {
    await closeClient(client);
  }
});

test('official legacy client explicitly uses the 2025-11-25 initialize branch', async () => {
  const client = new Client(
    { name: 'eo-legacy-process-contract', version: '1.0.0' },
    { versionNegotiation: { mode: 'legacy' } },
  );
  const transport = stdioTransport();
  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), 'legacy');
    assert.equal(client.getNegotiatedProtocolVersion(), legacyVersion);
    assert.equal(client.getDiscoverResult(), undefined);
    assert.equal(client.getServerVersion()?.version, EXTERNAL_ORCHESTRATOR_VERSION);
    assert.deepEqual(Object.keys(client.getServerCapabilities() ?? {}), ['tools']);

    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name), expectedTools);
  } finally {
    await closeClient(client);
  }
});

async function waitForExit(child: ChildProcessWithoutNullStreams, label: string) {
  return Promise.race([
    once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`stdio server did not exit after ${label}`)), 2_000)),
  ]);
}

function spawnRawServer(): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CHAT_ON_STEROIDS_USER_DATA_DIR: offlineProfile },
  });
}

test('built stdio server closes cleanly on EOF, SIGTERM, and SIGINT', async (t) => {
  await t.test('EOF', async () => {
    const child = spawnRawServer();
    const client = lineClient(child);
    await initializeLegacy(client);
    child.stdin.end();
    await waitForExit(child, 'EOF');
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    await t.test(signal, async () => {
      const child = spawnRawServer();
      const client = lineClient(child);
      await initializeLegacy(client);
      child.kill(signal);
      const [code, receivedSignal] = await waitForExit(child, signal);
      assert.ok(code === 0 || receivedSignal === signal, `unexpected exit code=${code} signal=${receivedSignal}`);
    });
  }
});
