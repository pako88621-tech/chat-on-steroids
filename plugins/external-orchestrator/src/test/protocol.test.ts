import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXTERNAL_ORCHESTRATOR_TOOL_NAMES,
  externalEvidenceRequestSchema,
  externalOrchestrateRequestSchema,
} from '../protocol.js';

test('publishes exactly the two EO tools', () => {
  assert.deepEqual([...EXTERNAL_ORCHESTRATOR_TOOL_NAMES], ['cos_orchestrate', 'cos_evidence']);
});

test('requires request_id for every EO-owned input mutation and defaults interrupt false', () => {
  for (const value of [
    { action: 'start', objective: 'Ship the feature' },
    { action: 'steer', instruction: 'Run the focused tests' },
    { action: 'cancel' },
  ]) assert.equal(externalOrchestrateRequestSchema.safeParse(value).success, false, JSON.stringify(value));

  const start = externalOrchestrateRequestSchema.parse({ action: 'start', objective: 'Ship the feature', request_id: 'req.start.1' });
  assert.deepEqual(start, {
    action: 'start', objective: 'Ship the feature', constraints: [], request_id: 'req.start.1', interrupt: false,
  });
  const steer = externalOrchestrateRequestSchema.parse({ action: 'steer', instruction: 'Run tests', request_id: 'req.steer.1' });
  assert.deepEqual(steer, { action: 'steer', instruction: 'Run tests', request_id: 'req.steer.1', interrupt: false });
  assert.deepEqual(
    externalOrchestrateRequestSchema.parse({ action: 'cancel', request_id: 'req.cancel.1' }),
    { action: 'cancel', request_id: 'req.cancel.1' },
  );
});

test('keeps interruption explicit and bounded to start/steer', () => {
  assert.deepEqual(
    externalOrchestrateRequestSchema.parse({ action: 'start', objective: 'x', request_id: 'r1', interrupt: true }),
    { action: 'start', objective: 'x', constraints: [], request_id: 'r1', interrupt: true },
  );
  assert.deepEqual(
    externalOrchestrateRequestSchema.parse({ action: 'steer', instruction: 'x', request_id: 'r2', interrupt: true }),
    { action: 'steer', instruction: 'x', request_id: 'r2', interrupt: true },
  );
  for (const value of [
    { action: 'status', interrupt: true },
    { action: 'wait', interrupt: true },
    { action: 'cancel', request_id: 'r3', interrupt: true },
  ]) assert.equal(externalOrchestrateRequestSchema.safeParse(value).success, false, JSON.stringify(value));
});

test('separates exact-turn stop from request-owned pending-input cancel', () => {
  const stop = externalOrchestrateRequestSchema.parse({
    action: 'stop', session_id: 'session-12345678', expected_turn_id: 'turn-12345678',
  });
  assert.deepEqual(stop, { action: 'stop', session_id: 'session-12345678', expected_turn_id: 'turn-12345678' });
  for (const value of [
    { action: 'stop', session_id: 'session-12345678' },
    { action: 'stop', expected_turn_id: 'turn-12345678' },
    { action: 'stop', session_id: 'session-12345678', expected_turn_id: '' },
    { action: 'cancel', request_id: 'r4', expected_turn_id: 'turn-12345678' },
  ]) assert.equal(externalOrchestrateRequestSchema.safeParse(value).success, false, JSON.stringify(value));
});

test('rejects legacy authority and passthrough fields at the protocol boundary', () => {
  for (const value of [
    { action: 'status', task_id: 'legacy-task' },
    { action: 'status', control_revision: 7 },
    { action: 'steer', instruction: 'x', request_id: 'r5', approval_id: 'legacy-approval' },
    { action: 'status', auth_token: 'secret' },
    { action: 'start', objective: 'x', request_id: 'r6', tool: 'exec_command' },
  ]) assert.equal(externalOrchestrateRequestSchema.safeParse(value).success, false, JSON.stringify(value));
});

test('keeps wait and evidence defaults bounded', () => {
  assert.deepEqual(externalOrchestrateRequestSchema.parse({ action: 'wait' }), { action: 'wait', wait_ms: 15_000 });
  assert.deepEqual(externalOrchestrateRequestSchema.parse({ action: 'wait', until: 'activity' }), {
    action: 'wait', until: 'activity', wait_ms: 15_000,
  });
  assert.equal(externalOrchestrateRequestSchema.safeParse({ action: 'wait', wait_ms: 99 }).success, false);
  assert.equal(externalOrchestrateRequestSchema.safeParse({ action: 'wait', wait_ms: 30_001 }).success, false);
  assert.deepEqual(externalEvidenceRequestSchema.parse({}), { limit: 40, level: 'summary' });
  assert.equal(externalEvidenceRequestSchema.safeParse({ limit: 0 }).success, false);
  assert.equal(externalEvidenceRequestSchema.safeParse({ limit: 101 }).success, false);
});

test('freezes semantic wait modes without turning transport leases into business polling', () => {
  assert.deepEqual(
    externalOrchestrateRequestSchema.parse({ action: 'wait', until: 'attention' }),
    { action: 'wait', until: 'attention' },
  );
  assert.deepEqual(
    externalOrchestrateRequestSchema.parse({ action: 'wait', until: 'terminal', transport_lease_ms: 90_000 }),
    { action: 'wait', until: 'terminal', transport_lease_ms: 90_000 },
  );
  for (const value of [
    { action: 'wait', until: 'attention', wait_ms: 15_000 },
    { action: 'wait', until: 'terminal', wait_ms: 30_000 },
    { action: 'wait', until: 'activity', transport_lease_ms: 90_000 },
    { action: 'wait', transport_lease_ms: 90_000 },
    { action: 'wait', until: 'attention', transport_lease_ms: 999 },
    { action: 'wait', until: 'terminal', transport_lease_ms: 86_400_001 },
  ]) assert.equal(externalOrchestrateRequestSchema.safeParse(value).success, false, JSON.stringify(value));
});

test('rejects a start request whose frozen framing would exceed the Core input ceiling', () => {
  assert.equal(externalOrchestrateRequestSchema.safeParse({
    action: 'start',
    objective: 'x'.repeat(32_000),
    constraints: Array.from({ length: 9 }, () => 'y'.repeat(4_000)),
    request_id: 'req.oversized.start',
  }).success, false);

  assert.equal(externalOrchestrateRequestSchema.safeParse({
    action: 'start',
    objective: 'x'.repeat(20_000),
    constraints: Array.from({ length: 8 }, () => 'y'.repeat(4_000)),
    request_id: 'req.bounded.start',
  }).success, true);
});
