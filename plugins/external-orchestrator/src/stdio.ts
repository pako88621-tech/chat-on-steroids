#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createExternalOrchestratorService } from './orchestrator-service.js';
import { createExternalOrchestratorMcpServer } from './server.js';

const service = createExternalOrchestratorService();
const handle = serveStdio(
  () => createExternalOrchestratorMcpServer(service),
  { legacy: 'serve' },
);
let closing: Promise<void> | null = null;

function close(): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    const transportClosing = handle.close().catch(() => undefined);
    const serviceClosing = service.close().catch(() => undefined);
    await Promise.all([transportClosing, serviceClosing]);
  })();
  return closing;
}

process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
process.stdin.once('end', () => { void close(); });
process.stdin.once('close', () => { void close(); });
process.stdin.once('error', () => { void close(); });
process.stdout.once('error', () => { void close(); });
