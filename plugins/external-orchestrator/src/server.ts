import { McpServer } from '@modelcontextprotocol/server';
import {
  EXTERNAL_ORCHESTRATOR_TOOL_NAMES,
  externalEvidenceRequestSchema,
  externalEvidenceResponseSchema,
  externalOrchestrateRequestSchema,
  externalOrchestrateResponseSchema,
  type ExternalEvidenceRequest,
  type ExternalEvidenceResponse,
  type ExternalOrchestrateRequest,
  type ExternalOrchestrateResponse,
} from './protocol.js';

export interface ExternalOrchestratorBackend {
  orchestrate(request: ExternalOrchestrateRequest, signal?: AbortSignal): Promise<ExternalOrchestrateResponse>;
  evidence(request: ExternalEvidenceRequest, signal?: AbortSignal): Promise<ExternalEvidenceResponse>;
}

export function createExternalOrchestratorMcpServer(backend: ExternalOrchestratorBackend): McpServer {
  const server = new McpServer(
    { name: 'chat-on-steroids-external-orchestrator', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(EXTERNAL_ORCHESTRATOR_TOOL_NAMES[0], {
    description: 'Direct Chat On Steroids through its normal Prime/session workflow: inspect status, start work, steer it, wait for activity, or request cancellation.',
    inputSchema: externalOrchestrateRequestSchema,
    outputSchema: externalOrchestrateResponseSchema,
  }, async (args, extra) => {
    const request = externalOrchestrateRequestSchema.parse(args);
    const result = externalOrchestrateResponseSchema.parse(await backend.orchestrate(request, extra.mcpReq.signal));
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { ...result } };
  });

  server.registerTool(EXTERNAL_ORCHESTRATOR_TOOL_NAMES[1], {
    description: 'Read bounded evidence from the selected Chat On Steroids session through the Local Control API.',
    inputSchema: externalEvidenceRequestSchema,
    outputSchema: externalEvidenceResponseSchema,
  }, async (args, extra) => {
    const request = externalEvidenceRequestSchema.parse(args);
    const result = externalEvidenceResponseSchema.parse(await backend.evidence(request, extra.mcpReq.signal));
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { ...result } };
  });

  return server;
}
