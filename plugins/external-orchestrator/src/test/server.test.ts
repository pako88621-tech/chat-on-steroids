import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpHandler, InMemoryTransport } from '@modelcontextprotocol/server';
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

test('modern discovery publishes only tools plus generic orchestration instructions', async () => {
  const handler = createMcpHandler(() => createExternalOrchestratorMcpServer(backend([])));
  try {
    const discovered = await rpc(handler, 'server/discover');
    assert.deepEqual(Object.keys(discovered.result.capabilities), ['tools']);
    assert.equal('resources' in discovered.result.capabilities, false);
    assert.equal('prompts' in discovered.result.capabilities, false);
    assert.equal('tasks' in discovered.result.capabilities, false);
    assert.match(discovered.result.instructions, /request_id/);
    assert.match(discovered.result.instructions, /until 'attention'/);
    assert.match(discovered.result.instructions, /ambiguous/);
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

test('MCP cancellation aborts the exact in-flight backend request and suppresses its response', async () => {
  let markStarted!: () => void;
  let markAborted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const aborted = new Promise<void>(resolve => { markAborted = resolve; });
  const calls: unknown[] = [];
  const customBackend = backend(calls);
  customBackend.orchestrate = async (request, signal) => {
    calls.push(request);
    markStarted();
    return await new Promise((_, reject) => {
      const onAbort = () => {
        markAborted();
        reject(signal?.reason ?? new Error('aborted'));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  };

  const server = createExternalOrchestratorMcpServer(customBackend);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const messages: unknown[] = [];
  const hasResponse = (id: string | number) => messages.some(message => (
    typeof message === 'object' && message !== null && 'id' in message
    && (message as { id?: string | number }).id === id
  ));
  clientTransport.onmessage = message => { messages.push(message); };
  await clientTransport.start();
  await server.connect(serverTransport);

  try {
    await clientTransport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'eo-cancellation-contract', version: '1.0.0' },
      },
    });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('initialize response timed out')), 1_000);
      const poll = () => {
        if (hasResponse(1)) {
          clearTimeout(deadline);
          resolve();
        } else {
          setImmediate(poll);
        }
      };
      poll();
    });
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    await clientTransport.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'cos_orchestrate', arguments: { action: 'status' } },
    });
    await started;
    await clientTransport.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 2, reason: 'test cancellation' },
    });
    await aborted;
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(hasResponse(2), false);
    assert.deepEqual(calls, [{ action: 'status' }]);
  } finally {
    await clientTransport.close();
    await server.close();
  }
});
