#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createExternalOrchestratorService } from './orchestrator-service.js';
import { createExternalOrchestratorMcpServer } from './server.js';

const service = createExternalOrchestratorService();
const server = createExternalOrchestratorMcpServer(service);
const transport = new StdioServerTransport();
let closing: Promise<void> | null = null;

function close(): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    const serverClosing = server.close().catch(() => undefined);
    await service.close();
    await serverClosing;
  })();
  return closing;
}

process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
process.stdin.once('end', () => { void close(); });

try {
  await server.connect(transport);
} catch {
  await close();
  process.exitCode = 1;
}
