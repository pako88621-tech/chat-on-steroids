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
import { EXTERNAL_ORCHESTRATOR_VERSION } from './version.js';

const SERVER_INSTRUCTIONS = [
  'Use a stable unique request_id for each start or steer mutation.',
  'After start succeeds, do not poll status or cos_evidence while work is running.',
  "Call cos_orchestrate with action 'wait' and until 'attention', and allow that request to remain pending.",
  'After a checkpoint, steer only when useful, then wait again.',
  'Use cos_evidence only when detailed diagnosis is needed.',
  'Never blindly retry a mutation whose delivery outcome is ambiguous.',
].join(' ');

export interface ExternalOrchestratorBackend {
  orchestrate(request: ExternalOrchestrateRequest, signal?: AbortSignal): Promise<ExternalOrchestrateResponse>;
  evidence(request: ExternalEvidenceRequest, signal?: AbortSignal): Promise<ExternalEvidenceResponse>;
}

export function createExternalOrchestratorMcpServer(backend: ExternalOrchestratorBackend): McpServer {
  const server = new McpServer(
    { name: 'chat-on-steroids-external-orchestrator', version: EXTERNAL_ORCHESTRATOR_VERSION },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool(EXTERNAL_ORCHESTRATOR_TOOL_NAMES[0], {
    description: 'Direct Chat On Steroids through its normal Prime/session workflow. Use stable unique request IDs for start/steer, wait for attention instead of polling, and do not blindly retry ambiguous mutations.',
    inputSchema: externalOrchestrateRequestSchema,
    outputSchema: externalOrchestrateResponseSchema,
  }, async (args, extra) => {
    const request = externalOrchestrateRequestSchema.parse(args);
    const result = externalOrchestrateResponseSchema.parse(await backend.orchestrate(request, extra.mcpReq.signal));
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { ...result } };
  });

  server.registerTool(EXTERNAL_ORCHESTRATOR_TOOL_NAMES[1], {
    description: 'Read bounded evidence from the selected Chat On Steroids session when detailed diagnosis is needed.',
    inputSchema: externalEvidenceRequestSchema,
    outputSchema: externalEvidenceResponseSchema,
  }, async (args, extra) => {
    const request = externalEvidenceRequestSchema.parse(args);
    const result = externalEvidenceResponseSchema.parse(await backend.evidence(request, extra.mcpReq.signal));
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { ...result } };
  });

  return server;
}
