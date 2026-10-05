import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '..', 'stdio.js');

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
  return { request };
}

async function initialize(client: ReturnType<typeof lineClient>) {
  const response = await client.request('initialize', {
    protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'eo-process-contract', version: '1.0.0' },
  });
  assert.ok(response.result, JSON.stringify(response));
}

test('built stdio server initializes and exposes exactly two tools while CoS is absent', async () => {
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CHAT_ON_STEROIDS_USER_DATA_DIR: path.join(here, 'definitely-absent-cos-profile') } });
  const client = lineClient(child);
  try {
    await initialize(client);
    const listed = await client.request('tools/list');
    assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), ['cos_orchestrate', 'cos_evidence']);
    const status = await client.request('tools/call', { name: 'cos_orchestrate', arguments: { action: 'status' } });
    assert.equal(status.result?.isError, undefined, JSON.stringify(status));
    assert.equal(status.result?.structuredContent?.ok, false);
    assert.equal(status.result?.structuredContent?.error?.code, 'control_api_unavailable');
    assert.equal(child.exitCode, null, 'structured offline result must not terminate the MCP server');
  } finally {
    child.stdin.end();
    await Promise.race([once(child, 'exit'), new Promise((_, reject) => setTimeout(() => reject(new Error('stdio server did not exit after EOF')), 5_000))]);
  }
});

test('built stdio server exits cleanly on SIGTERM', async () => {
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
  const client = lineClient(child);
  await initialize(client);
  child.kill('SIGTERM');
  const [code, signal] = await Promise.race([
    once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stdio server did not exit after SIGTERM')), 5_000)),
  ]);
  assert.ok(code === 0 || signal === 'SIGTERM', `unexpected exit code=${code} signal=${signal}`);
});
