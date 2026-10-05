import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createExternalOrchestratorMcpServer, type ExternalOrchestratorBackend } from '../server.js';

async function rpc(handler: ReturnType<typeof createMcpHandler>, method: string, params: Record<string, unknown> = {}) {
  const response = await handler.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method,
      ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method,
      params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } },
    }),
  }));
  const body = await response.text();
  return JSON.parse(body.startsWith('{') ? body : [...body.matchAll(/^data: (.+)$/gm)].at(-1)![1]!);
}

function backend(calls: unknown[]): ExternalOrchestratorBackend {
  return {
    async orchestrate(request) {
      calls.push(request);
      return {
        ok: true,
        enabled: true,
        connected: true,
        actions_enabled: true,
        session_id: 'session-12345678',
        project_id: null,
        state: 'idle',
        active_turn_id: null,
      };
    },
    async evidence(request) {
      calls.push(request);
      return { ok: true, enabled: true, session_id: request.session_id ?? null, cursor: request.cursor ?? 0, caught_up: true, items: [] };
    },
  };
}

test('lists exactly two strict public tools', async () => {
  const handler = createMcpHandler(() => createExternalOrchestratorMcpServer(backend([])));
  try {
    const listed = await rpc(handler, 'tools/list');
    const tools = listed.result.tools as Array<{ name: string; inputSchema?: unknown; outputSchema?: unknown }>;
    assert.deepEqual(tools.map(tool => tool.name), ['cos_orchestrate', 'cos_evidence']);
    assert.equal(tools.length, 2);
    assert.equal(tools.every(tool => tool.inputSchema && tool.outputSchema), true);
  } finally { await handler.close(); }
});

test('dispatches hardened defaults and separate stop without client authority context', async () => {
  const calls: unknown[] = [];
  const handler = createMcpHandler(() => createExternalOrchestratorMcpServer(backend(calls)));
  try {
    const start = await rpc(handler, 'tools/call', { name: 'cos_orchestrate', arguments: { action: 'start', objective: 'Ship it', request_id: 'req-start' } });
    assert.equal(start.result.isError, undefined);
    assert.deepEqual(calls[0], { action: 'start', objective: 'Ship it', constraints: [], request_id: 'req-start', interrupt: false });
    await rpc(handler, 'tools/call', { name: 'cos_orchestrate', arguments: { action: 'stop', session_id: 'session-12345678', expected_turn_id: 'turn-12345678' } });
    assert.deepEqual(calls[1], { action: 'stop', session_id: 'session-12345678', expected_turn_id: 'turn-12345678' });
    await rpc(handler, 'tools/call', { name: 'cos_evidence', arguments: {} });
    assert.deepEqual(calls[2], { limit: 40, level: 'summary' });
  } finally { await handler.close(); }
});

test('rejects missing request ownership and legacy fields before backend dispatch', async () => {
  const calls: unknown[] = [];
  const handler = createMcpHandler(() => createExternalOrchestratorMcpServer(backend(calls)));
  try {
    for (const args of [
      { action: 'start', objective: 'x' },
      { action: 'steer', instruction: 'x' },
      { action: 'cancel' },
      { action: 'status', task_id: 'legacy' },
    ]) {
      const result = await rpc(handler, 'tools/call', { name: 'cos_orchestrate', arguments: args });
      assert.equal(result.result?.isError, true, JSON.stringify(result));
    }
    assert.equal(calls.length, 0);
    const unknown = await rpc(handler, 'tools/call', { name: 'dispatch', arguments: {} });
    assert.equal(unknown.result, undefined);
    assert.equal(typeof unknown.error?.message, 'string');
  } finally { await handler.close(); }
});
