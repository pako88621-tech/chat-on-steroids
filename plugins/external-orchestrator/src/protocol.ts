import { z } from 'zod';

export const EXTERNAL_ORCHESTRATOR_PROTOCOL_VERSION = 1 as const;
export const EXTERNAL_ORCHESTRATOR_TOOL_NAMES = ['cos_orchestrate', 'cos_evidence'] as const;
export type ExternalOrchestratorToolName = typeof EXTERNAL_ORCHESTRATOR_TOOL_NAMES[number];

export const externalSessionIdSchema = z.string().regex(/^[0-9a-z-]{8,64}$/u);
const requestId = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/u);
const projectId = z.string().trim().min(1).max(256);
const cursor = z.number().int().nonnegative();
const expectedTurnId = z.string().trim().min(1).max(256);
const CORE_INPUT_TEXT_LIMIT = 64_000;

function framedStartLength(objective: string, constraints: readonly string[]): number {
  let length = 'External coding agent objective:\n\n'.length + objective.length;
  if (constraints.length > 0) {
    length += '\n\nConstraints:\n'.length;
    length += constraints.reduce((total, item, index) => total + (index === 0 ? 0 : 1) + 2 + item.length, 0);
  }
  return length;
}

export const externalOrchestratorErrorCodeSchema = z.enum([
  'control_api_unavailable',
  'unsupported_control_api',
  'actions_disabled',
  'no_executor',
  'session_not_found',
  'session_ineligible',
  'would_interrupt',
  'duplicate_request_conflict',
  'request_not_sent',
  'request_not_owned',
  'input_not_found',
  'active_turn_changed',
  'cancel_failed',
  'stop_unavailable',
  'controller_busy',
  'busy',
  'rate_limited',
  'delivery_unknown',
  'wait_unavailable',
  'internal_error',
]);

const legacyWait = z.object({
  action: z.literal('wait'),
  session_id: externalSessionIdSchema.optional(),
  cursor: cursor.optional(),
  wait_ms: z.number().int().min(100).max(30_000).optional().default(15_000),
}).strict();

const activityWait = z.object({
  action: z.literal('wait'),
  session_id: externalSessionIdSchema.optional(),
  cursor: cursor.optional(),
  until: z.literal('activity'),
  wait_ms: z.number().int().min(100).max(30_000).optional().default(15_000),
}).strict();

const semanticWait = (until: 'attention' | 'terminal') => z.object({
  action: z.literal('wait'),
  session_id: externalSessionIdSchema.optional(),
  cursor: cursor.optional(),
  until: z.literal(until),
  transport_lease_ms: z.number().int().min(1_000).max(86_400_000).optional(),
}).strict();

export const externalOrchestrateRequestSchema = z.union([
  z.object({ action: z.literal('status'), session_id: externalSessionIdSchema.optional() }).strict(),
  z.object({
    action: z.literal('start'),
    objective: z.string().trim().min(1).max(32_000),
    constraints: z.array(z.string().trim().min(1).max(4_000)).max(32).optional().default([]),
    session_id: externalSessionIdSchema.optional(),
    project_id: projectId.optional(),
    request_id: requestId,
    interrupt: z.boolean().optional().default(false),
  }).strict().refine(
    (value) => framedStartLength(value.objective, value.constraints) <= CORE_INPUT_TEXT_LIMIT,
    { message: 'framed start instruction exceeds the Local Control input limit' },
  ),
  z.object({
    action: z.literal('steer'),
    instruction: z.string().trim().min(1).max(16_000),
    session_id: externalSessionIdSchema.optional(),
    request_id: requestId,
    interrupt: z.boolean().optional().default(false),
  }).strict(),
  legacyWait,
  activityWait,
  semanticWait('attention'),
  semanticWait('terminal'),
  z.object({ action: z.literal('cancel'), session_id: externalSessionIdSchema.optional(), request_id: requestId }).strict(),
  z.object({ action: z.literal('stop'), session_id: externalSessionIdSchema, expected_turn_id: expectedTurnId }).strict(),
]);
export type ExternalOrchestrateRequest = z.infer<typeof externalOrchestrateRequestSchema>;

export const externalWakeReasonSchema = z.enum([
  'checkpoint',
  'blocked',
  'completed',
  'failed',
  'stalled',
  'stopped',
  'control_lost',
  'transport_lease_expired',
  'activity',
]);
export type ExternalWakeReason = z.infer<typeof externalWakeReasonSchema>;

export const externalOrchestrateResponseSchema = z.object({
  ok: z.boolean(),
  enabled: z.boolean(),
  connected: z.boolean(),
  actions_enabled: z.boolean(),
  session_id: externalSessionIdSchema.nullable(),
  project_id: projectId.nullable(),
  state: z.enum(['idle', 'working', 'unavailable']),
  summary: z.string().max(8_000).optional(),
  cursor: cursor.optional(),
  input_id: z.string().uuid().optional(),
  active_turn_id: expectedTurnId.nullable(),
  delivery: z.enum(['pending', 'sent', 'not_sent', 'unconfirmed']).optional(),
  wake_reason: externalWakeReasonSchema.optional(),
  error: z.object({ code: externalOrchestratorErrorCodeSchema, message: z.string().max(2_000) }).strict().optional(),
}).strict();
export type ExternalOrchestrateResponse = z.infer<typeof externalOrchestrateResponseSchema>;

export const externalEvidenceRequestSchema = z.object({
  session_id: externalSessionIdSchema.optional(),
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(100).optional().default(40),
  level: z.enum(['summary', 'detail']).optional().default('summary'),
}).strict();
export type ExternalEvidenceRequest = z.infer<typeof externalEvidenceRequestSchema>;

const evidenceChangeSchema = z.object({
  path: z.string().max(1_000),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
}).strict();

export const externalEvidenceDetailSchema = z.object({
  turn_id: expectedTurnId.optional(),
  message_id: z.string().max(256).optional(),
  model: z.string().max(160).optional(),
  state: z.string().max(80).optional(),
  outcome: z.string().max(80).optional(),
  reason: z.string().max(1_000).optional(),
  recoverable: z.boolean().optional(),
  blocking: z.boolean().optional(),
  tool: z.string().max(160).optional(),
  title: z.string().max(2_000).optional(),
  detail: z.string().max(2_000).optional(),
  metric: z.string().max(500).optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  changes: z.array(evidenceChangeSchema).max(64).optional(),
  from: z.string().max(160).optional(),
  to: z.string().max(160).optional(),
  delivery: z.string().max(80).optional(),
}).strict();

export const externalEvidenceItemSchema = z.object({
  seq: cursor,
  time: z.number().int().nonnegative(),
  kind: z.enum([
    'session_start', 'user_message', 'assistant_message', 'progress', 'page_tool', 'turn_start',
    'turn_end', 'chat_error', 'tool_call', 'note', 'agent_message', 'handoff',
  ]),
  summary: z.string().max(8_000),
  detail: externalEvidenceDetailSchema.optional(),
}).strict();

export const externalEvidenceResponseSchema = z.object({
  ok: z.boolean(),
  enabled: z.boolean(),
  session_id: externalSessionIdSchema.nullable(),
  cursor,
  caught_up: z.boolean(),
  items: z.array(externalEvidenceItemSchema).max(100),
  error: z.object({ code: externalOrchestratorErrorCodeSchema, message: z.string().max(2_000) }).strict().optional(),
}).strict();
export type ExternalEvidenceResponse = z.infer<typeof externalEvidenceResponseSchema>;
