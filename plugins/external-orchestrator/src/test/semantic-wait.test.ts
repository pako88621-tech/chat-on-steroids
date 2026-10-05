import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkpointStateForTurn,
  classifySemanticWait,
  emptyTerminalSettleState,
  type CheckpointState,
  type SemanticClassifierInput,
  type SemanticProjectedEvent,
  type SemanticSummaryKind,
  type SemanticWaitDecision,
  type SemanticWaitMode,
  type SemanticWorkReason,
  type SemanticWorkState,
  type TerminalSettleState,
} from '../semantic-wait.js';

const TURN = 'turn-semantic-1';

function work(
  state: SemanticWorkState['state'] = 'quiescent',
  reasons: readonly SemanticWorkReason[] = [],
): SemanticWorkState {
  return { state, reasons, nextDeadline: null };
}

function event(
  seq: number,
  kind: SemanticProjectedEvent['kind'],
  extra: Partial<SemanticProjectedEvent> = {},
): SemanticProjectedEvent {
  return { seq, kind, summary: `${kind}-${seq}`, turnId: TURN, ...extra };
}

function toolEvent(
  seq: number,
  options: {
    name?: string;
    outcome?: string;
    kind?: SemanticSummaryKind;
    detail?: string;
    changes?: readonly { path: string; added: number; removed: number }[];
    turnId?: string;
  } = {},
): SemanticProjectedEvent {
  return event(seq, 'tool_call', {
    turnId: options.turnId ?? TURN,
    summary: `tool-${seq}`,
    tool: {
      name: options.name ?? 'exec_command',
      outcome: options.outcome ?? 'ok',
      summary: {
        title: `tool-${seq}`,
        kind: options.kind ?? 'run',
        ...(options.detail === undefined ? {} : { detail: options.detail }),
      },
      changes: options.changes ?? [],
    },
  });
}

function planEvent(seq: number, detail: string, turnId = TURN): SemanticProjectedEvent {
  return toolEvent(seq, { name: 'update_plan', kind: 'session', detail, turnId });
}

function baseInput(options: {
  mode?: SemanticWaitMode;
  cursor?: number;
  events?: readonly SemanticProjectedEvent[];
  work?: SemanticWorkState;
  caughtUp?: boolean;
  checkpoint?: CheckpointState;
  settle?: TerminalSettleState;
} = {}): SemanticClassifierInput {
  return {
    mode: options.mode ?? 'attention',
    cursor: options.cursor ?? 0,
    events: options.events ?? [],
    work: options.work ?? work(),
    caughtUp: options.caughtUp ?? true,
    checkpoint: options.checkpoint ?? checkpointStateForTurn(TURN, true),
    settle: options.settle ?? emptyTerminalSettleState(),
  };
}

function expectPending(decision: SemanticWaitDecision): asserts decision is Extract<SemanticWaitDecision, { action: 'pending' }> {
  assert.equal(decision.action, 'pending');
}

function expectWake(
  decision: SemanticWaitDecision,
  wakeReason: Extract<SemanticWaitDecision, { action: 'return' }>['wakeReason'],
): asserts decision is Extract<SemanticWaitDecision, { action: 'return' }> {
  assert.equal(decision.action, 'return');
  if (decision.action === 'return') assert.equal(decision.wakeReason, wakeReason);
}

test('activity mode returns the next bounded projected event without semantic promotion', () => {
  const routine = event(7, 'progress');
  const decision = classifySemanticWait(baseInput({ mode: 'activity', cursor: 7, events: [routine] }));
  expectWake(decision, 'activity');
  assert.equal(decision.eventSeq, 7);
});

test('routine chatter stays pending in attention mode', () => {
  const events = [
    toolEvent(1, { kind: 'read' }),
    event(2, 'progress'),
    event(3, 'assistant_message', { state: 'streaming' }),
    event(4, 'agent_message'),
  ];
  const decision = classifySemanticWait(baseInput({ events }));
  expectPending(decision);
  assert.equal(decision.phase, 'waiting');
  assert.equal(decision.checkpoint.count, 0);
});

test('frozen plan table: M=1 produces zero routine checkpoints', () => {
  const decision = classifySemanticWait(baseInput({ events: [planEvent(1, '1 / 1 completed')] }));
  expectPending(decision);
  assert.equal(decision.checkpoint.validPlanSeen, true);
  assert.equal(decision.checkpoint.count, 0);
});

test('frozen plan table: 0/2 -> 1/2 -> 2/2 emits complete only', () => {
  let checkpoint = checkpointStateForTurn(TURN, true);
  let settle = emptyTerminalSettleState();
  for (const [seq, detail] of [[1, '0 / 2 completed'], [2, '1 / 2 completed']] as const) {
    const decision = classifySemanticWait(baseInput({ cursor: seq, events: [planEvent(seq, detail)], checkpoint, settle }));
    expectPending(decision);
    checkpoint = decision.checkpoint;
    settle = decision.settle;
  }
  const done = classifySemanticWait(baseInput({ cursor: 3, events: [planEvent(3, '2 / 2 completed')], checkpoint, settle }));
  expectWake(done, 'checkpoint');
  assert.equal(done.checkpointKind, 'plan_complete');
  assert.equal(done.checkpoint.count, 1);
  assert.equal(done.checkpoint.midpointSeen, false);
});

test('frozen plan table: 0/3 -> 2/3 -> 3/3 emits midpoint then complete', () => {
  let checkpoint = checkpointStateForTurn(TURN, true);
  let settle = emptyTerminalSettleState();

  const zero = classifySemanticWait(baseInput({ cursor: 1, events: [planEvent(1, '0 / 3 completed')], checkpoint, settle }));
  expectPending(zero);
  checkpoint = zero.checkpoint;
  settle = zero.settle;

  const midpoint = classifySemanticWait(baseInput({ cursor: 2, events: [planEvent(2, '2 / 3 completed')], checkpoint, settle }));
  expectWake(midpoint, 'checkpoint');
  assert.equal(midpoint.checkpointKind, 'plan_midpoint');
  checkpoint = midpoint.checkpoint;
  settle = midpoint.settle;

  const complete = classifySemanticWait(baseInput({ cursor: 3, events: [planEvent(3, '3 / 3 completed')], checkpoint, settle }));
  expectWake(complete, 'checkpoint');
  assert.equal(complete.checkpointKind, 'plan_complete');
  assert.equal(complete.checkpoint.count, 2);
});

test('repeated plan counters and plan rewrites never reset milestone classes or exceed the budget', () => {
  const first = classifySemanticWait(baseInput({ cursor: 1, events: [planEvent(1, '2 / 3 completed')] }));
  expectWake(first, 'checkpoint');
  assert.equal(first.checkpointKind, 'plan_midpoint');

  const repeated = classifySemanticWait(baseInput({
    cursor: 2,
    events: [planEvent(2, '2 / 3 completed'), planEvent(3, '0 / 12 completed')],
    checkpoint: first.checkpoint,
    settle: first.settle,
  }));
  expectPending(repeated);
  assert.equal(repeated.checkpoint.count, 1);

  const complete = classifySemanticWait(baseInput({
    cursor: 4,
    events: [planEvent(4, '12 / 12 completed')],
    checkpoint: repeated.checkpoint,
    settle: repeated.settle,
  }));
  expectWake(complete, 'checkpoint');
  assert.equal(complete.checkpoint.count, 2);

  const rewriteMidpoint = classifySemanticWait(baseInput({
    cursor: 5,
    events: [planEvent(5, '3 / 5 completed')],
    checkpoint: complete.checkpoint,
    settle: complete.settle,
  }));
  expectPending(rewriteMidpoint);
  assert.equal(rewriteMidpoint.checkpoint.count, 2);
});

test('malformed plan summaries and missing exact turn identity produce false negatives', () => {
  const malformed = [
    planEvent(1, '2/3 completed'),
    planEvent(2, '02 / 99 completed'),
    planEvent(3, '4 / 3 completed'),
  ];
  const malformedDecision = classifySemanticWait(baseInput({ events: malformed }));
  expectPending(malformedDecision);
  assert.equal(malformedDecision.checkpoint.validPlanSeen, false);
  assert.equal(malformedDecision.checkpoint.count, 0);

  const missingTurn = planEvent(4, '2 / 3 completed');
  delete missingTurn.turnId;
  const missingDecision = classifySemanticWait(baseInput({ cursor: 4, events: [missingTurn] }));
  expectPending(missingDecision);
  assert.equal(missingDecision.checkpoint.count, 0);
});

test('material mutation followed by successful run/process emits one no-plan fallback', () => {
  const mutation = toolEvent(1, {
    kind: 'edit',
    changes: [{ path: 'src/a.ts', added: 2, removed: 1 }],
  });
  const verify = toolEvent(2, { kind: 'run' });
  const decision = classifySemanticWait(baseInput({ cursor: 1, events: [mutation, verify] }));
  expectWake(decision, 'checkpoint');
  assert.equal(decision.checkpointKind, 'material_verify');
  assert.equal(decision.eventSeq, 2);
  assert.equal(decision.checkpoint.count, 1);
});

test('verification without a prior material mutation and failed verification do not checkpoint', () => {
  const noMutation = classifySemanticWait(baseInput({ events: [toolEvent(1, { kind: 'run' })] }));
  expectPending(noMutation);
  assert.equal(noMutation.checkpoint.count, 0);

  const failed = classifySemanticWait(baseInput({ events: [
    toolEvent(2, { kind: 'edit', changes: [{ path: 'x', added: 1, removed: 0 }] }),
    toolEvent(3, { kind: 'run', outcome: 'process_exit_nonzero' }),
  ] }));
  expectPending(failed);
  assert.equal(failed.checkpoint.count, 0);
});

test('any valid plan counter disables the no-plan fallback even when it is not a milestone', () => {
  const decision = classifySemanticWait(baseInput({ events: [
    planEvent(1, '0 / 4 completed'),
    toolEvent(2, { kind: 'edit', changes: [{ path: 'x', added: 1, removed: 0 }] }),
    toolEvent(3, { kind: 'run' }),
  ] }));
  expectPending(decision);
  assert.equal(decision.checkpoint.validPlanSeen, true);
  assert.equal(decision.checkpoint.fallbackSeen, false);
});

test('fallback may use slot one and only one later plan milestone can use slot two', () => {
  const fallback = classifySemanticWait(baseInput({ cursor: 1, events: [
    toolEvent(1, { kind: 'create', changes: [{ path: 'x', added: 4, removed: 0 }] }),
    toolEvent(2, { kind: 'process' }),
  ] }));
  expectWake(fallback, 'checkpoint');
  assert.equal(fallback.checkpointKind, 'material_verify');

  const midpoint = classifySemanticWait(baseInput({
    cursor: 3,
    events: [planEvent(3, '2 / 3 completed')],
    checkpoint: fallback.checkpoint,
    settle: fallback.settle,
  }));
  expectWake(midpoint, 'checkpoint');
  assert.equal(midpoint.checkpointKind, 'plan_midpoint');
  assert.equal(midpoint.checkpoint.count, 2);

  const complete = classifySemanticWait(baseInput({
    cursor: 4,
    events: [planEvent(4, '3 / 3 completed')],
    checkpoint: midpoint.checkpoint,
    settle: midpoint.settle,
  }));
  expectPending(complete);
  assert.equal(complete.checkpoint.count, 2);
});

test('checkpoint_suppressed restart rule yields no routine checkpoint for the remainder of that turn', () => {
  const suppressed = checkpointStateForTurn(TURN, false);
  const decision = classifySemanticWait(baseInput({
    cursor: 1,
    checkpoint: suppressed,
    events: [
      planEvent(1, '3 / 3 completed'),
      toolEvent(2, { kind: 'edit', changes: [{ path: 'x', added: 1, removed: 0 }] }),
      toolEvent(3, { kind: 'run' }),
    ],
  }));
  expectPending(decision);
  assert.equal(decision.checkpoint.checkpointSuppressed, true);
  assert.equal(decision.checkpoint.count, 0);

  const nextTurn = checkpointStateForTurn('turn-semantic-2', true);
  const next = classifySemanticWait(baseInput({
    cursor: 4,
    checkpoint: nextTurn,
    events: [planEvent(4, '2 / 2 completed', 'turn-semantic-2')],
  }));
  expectWake(next, 'checkpoint');
  assert.equal(next.checkpointKind, 'plan_complete');
});

test('a checkpoint before the caller cursor consumes budget without generating a stale wake', () => {
  const decision = classifySemanticWait(baseInput({ cursor: 10, events: [planEvent(4, '3 / 3 completed')] }));
  expectPending(decision);
  assert.equal(decision.checkpoint.count, 1);
  assert.equal(decision.checkpoint.completeSeen, true);
});

test('terminal mode ignores routine checkpoint wakes while consuming their bounded state', () => {
  const decision = classifySemanticWait(baseInput({
    mode: 'terminal',
    cursor: 1,
    events: [planEvent(1, '2 / 2 completed')],
  }));
  expectPending(decision);
  assert.equal(decision.checkpoint.count, 1);
  assert.equal(decision.checkpoint.completeSeen, true);
});

test('turn_end before matching final enters settle state and later final completes only when quiescent/caught-up', () => {
  const ended = classifySemanticWait(baseInput({
    cursor: 1,
    events: [event(1, 'turn_end', { outcome: 'completed' })],
  }));
  expectPending(ended);
  assert.equal(ended.phase, 'settling');
  assert.equal(ended.settleReason, 'awaiting_final');

  const final = classifySemanticWait(baseInput({
    cursor: 2,
    events: [event(2, 'assistant_message', { final: true, state: 'final' })],
    checkpoint: ended.checkpoint,
    settle: ended.settle,
  }));
  expectWake(final, 'completed');
});

test('trailing tool activity after end prevents false completion until a later matching final', () => {
  const trailing = classifySemanticWait(baseInput({
    cursor: 1,
    events: [
      event(1, 'turn_end', { outcome: 'completed' }),
      event(2, 'assistant_message', { final: true, state: 'final' }),
      toolEvent(3, { kind: 'run' }),
    ],
  }));
  expectPending(trailing);
  assert.equal(trailing.phase, 'settling');
  assert.equal(trailing.settleReason, 'trailing_activity');

  const settled = classifySemanticWait(baseInput({
    cursor: 4,
    events: [event(4, 'assistant_message', { final: true, state: 'final' })],
    checkpoint: trailing.checkpoint,
    settle: trailing.settle,
  }));
  expectWake(settled, 'completed');
});

test('Goal/finish/job/recovery/tool/input obligations keep a completed turn in settling', () => {
  const terminalEvents = [
    event(1, 'turn_end', { outcome: 'completed' }),
    event(2, 'assistant_message', { final: true, state: 'final' }),
  ];
  for (const reason of ['goal_wait', 'finish_hold', 'job', 'recovery', 'tool_activity', 'pending_input'] as const) {
    const state = reason === 'tool_activity' ? 'settling' : 'waiting';
    const decision = classifySemanticWait(baseInput({ events: terminalEvents, work: work(state, [reason]) }));
    expectPending(decision);
    assert.equal(decision.phase, 'settling', reason);
    assert.equal(decision.settleReason, 'work_not_quiescent', reason);
  }
});

test('completed terminal waits for final cursor catch-up', () => {
  const decision = classifySemanticWait(baseInput({
    caughtUp: false,
    events: [
      event(1, 'turn_end', { outcome: 'completed' }),
      event(2, 'assistant_message', { final: true, state: 'final' }),
    ],
  }));
  expectPending(decision);
  assert.equal(decision.phase, 'settling');
  assert.equal(decision.settleReason, 'not_caught_up');
});

test('failed, stalled and stopped canonical turn boundaries wake without waiting for routine checkpoints', () => {
  for (const outcome of ['failed', 'stalled', 'stopped'] as const) {
    const decision = classifySemanticWait(baseInput({
      events: [planEvent(1, '2 / 2 completed'), event(2, 'turn_end', { outcome })],
    }));
    expectWake(decision, outcome);
    assert.equal(decision.checkpoint.count, 0, `${outcome} should outrank and suppress the same-cut checkpoint`);
  }
});

test('completed terminal on the same stable cut suppresses a routine checkpoint wake', () => {
  const decision = classifySemanticWait(baseInput({
    events: [
      planEvent(1, '2 / 2 completed'),
      event(2, 'turn_end', { outcome: 'completed' }),
      event(3, 'assistant_message', { final: true, state: 'final' }),
    ],
  }));
  expectWake(decision, 'completed');
  assert.equal(decision.checkpoint.count, 0);
  assert.equal(decision.checkpoint.completeSeen, false);
});

test('blocked interventions outrank same-cut routine or completed decisions', () => {
  const blocked = classifySemanticWait(baseInput({
    work: work('blocked', ['blocked']),
    events: [
      planEvent(3, '2 / 2 completed'),
      event(4, 'turn_end', { outcome: 'completed' }),
      event(5, 'assistant_message', { final: true, state: 'final' }),
    ],
  }));
  expectWake(blocked, 'blocked');
  assert.equal(blocked.checkpoint.count, 0);
});

test('event-based interventions fail closed without exact turn identity', () => {
  const error = event(2, 'chat_error', { blocking: true, recoverable: false });
  delete error.turnId;
  const decision = classifySemanticWait(baseInput({ cursor: 1, events: [error] }));
  expectPending(decision);
  assert.equal(decision.phase, 'waiting');
});

test('recoverable chat error with active Core recovery stays pending', () => {
  const decision = classifySemanticWait(baseInput({
    cursor: 1,
    work: work('waiting', ['recovery']),
    events: [event(1, 'chat_error', { blocking: true, recoverable: true })],
  }));
  expectPending(decision);
  assert.equal(decision.phase, 'waiting');
});

test('non-recoverable blocking chat error is an actionable blocker', () => {
  const decision = classifySemanticWait(baseInput({
    cursor: 1,
    events: [event(1, 'chat_error', { blocking: true, recoverable: false })],
  }));
  expectWake(decision, 'blocked');
});

test('interrupted and unknown terminal outcomes fail conservatively instead of inventing failed/completed', () => {
  for (const outcome of ['interrupted', 'unknown'] as const) {
    const decision = classifySemanticWait(baseInput({ events: [event(1, 'turn_end', { outcome })] }));
    expectPending(decision);
    assert.equal(decision.phase, 'settling');
    assert.equal(decision.settleReason, 'unclassified_terminal');
  }
});
