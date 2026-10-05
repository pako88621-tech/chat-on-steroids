import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BenchmarkCounterLedger,
  FakeMonotonicClock,
  IRRELEVANT_INVALIDATION_COUNT,
  QUIET_TRACE_MINUTES,
  RESOURCE_WAIT_COUNT,
  WaitAccounting,
  advanceQuietTrace,
} from './benchmark-harness.js';
import {
  checkpointStateForTurn,
  classifySemanticWait,
  emptyTerminalSettleState,
  type CheckpointState,
  type SemanticProjectedEvent,
  type SemanticWaitDecision,
  type SemanticWorkState,
  type TerminalSettleState,
} from '../semantic-wait.js';

const TURN_ID = 'turn-benchmark-0001';
const ACTIVE_WORK: SemanticWorkState = { state: 'active', reasons: ['active_turn'], nextDeadline: null };
const QUIESCENT_WORK: SemanticWorkState = { state: 'quiescent', reasons: [], nextDeadline: null };

function carry(decision: SemanticWaitDecision): { checkpoint: CheckpointState; settle: TerminalSettleState } {
  return { checkpoint: decision.checkpoint, settle: decision.settle };
}

function progressEvent(seq: number): SemanticProjectedEvent {
  return { seq, kind: 'progress', summary: 'routine progress', turnId: TURN_ID };
}

function planEvent(seq: number, detail: string): SemanticProjectedEvent {
  return {
    seq,
    kind: 'tool_call',
    summary: 'plan progress',
    turnId: TURN_ID,
    tool: {
      name: 'update_plan',
      outcome: 'ok',
      summary: { title: 'Plan updated', detail, kind: 'other' },
      changes: [],
    },
  };
}

test('fake monotonic clock controls Date.now, performance.now, setTimeout, and clearTimeout', () => {
  const epoch = 2_000_000_000_000;
  const clock = new FakeMonotonicClock(epoch);
  let fired = 0;
  clock.install();
  try {
    assert.equal(Date.now(), epoch);
    assert.equal(performance.now(), 0);
    setTimeout(() => { fired += 1; }, 5_000);
    const cancelled = setTimeout(() => { fired += 100; }, 4_000);
    clearTimeout(cancelled);

    clock.advanceBy(4_999);
    assert.equal(fired, 0);
    assert.equal(Date.now(), epoch + 4_999);
    assert.equal(performance.now(), 4_999);
    assert.equal(clock.timerFirings, 0);

    clock.advanceBy(1);
    assert.equal(fired, 1);
    assert.equal(clock.timerFirings, 1);
    assert.equal(clock.pendingTimerCount, 0);
  } finally {
    clock.restore();
  }
});

test('quiet-trace foundation advances 20/60/180 minutes as one jump and one-second increments without synthetic timers', () => {
  for (const minutes of QUIET_TRACE_MINUTES) {
    for (const mode of ['whole', 'seconds'] as const) {
      const clock = new FakeMonotonicClock();
      const ledger = new BenchmarkCounterLedger();
      clock.install();
      try {
        advanceQuietTrace(clock, minutes, mode);
        assert.equal(clock.elapsedMs, minutes * 60 * 1_000, `${minutes}m ${mode}`);
        assert.equal(clock.timerFirings, 0, `${minutes}m ${mode}`);
        assert.equal(clock.pendingTimerCount, 0, `${minutes}m ${mode}`);
        assert.equal(ledger.snapshot().businessReads, 0, `${minutes}m ${mode}`);
        assert.equal(ledger.snapshot().modelResults, 0, `${minutes}m ${mode}`);
      } finally {
        clock.restore();
      }
    }
  }
});

test('resource accounting foundation holds exactly 32 distinct watches through virtual 180-minute idle and serial re-arm', () => {
  const ledger = new BenchmarkCounterLedger();
  const accounting = new WaitAccounting(ledger);
  const sessionIds = Array.from({ length: RESOURCE_WAIT_COUNT }, (_, index) => `session-benchmark-${String(index).padStart(2, '0')}`);
  for (const sessionId of sessionIds) accounting.arm(sessionId);

  const clock = new FakeMonotonicClock();
  clock.install();
  try {
    advanceQuietTrace(clock, 180, 'whole');
  } finally {
    clock.restore();
  }

  let counts = ledger.snapshot();
  assert.equal(accounting.activeCount, RESOURCE_WAIT_COUNT);
  assert.equal(counts.activeWaiters, RESOURCE_WAIT_COUNT);
  assert.equal(counts.watchArms, RESOURCE_WAIT_COUNT);
  assert.equal(counts.businessReads, 0);
  assert.equal(counts.status429, 0);
  assert.equal(counts.status503, 0);

  for (const sessionId of sessionIds) {
    accounting.complete(sessionId);
    ledger.bump('invalidations');
    accounting.arm(sessionId, true);
    assert.equal(accounting.activeCount, RESOURCE_WAIT_COUNT);
  }
  counts = ledger.snapshot();
  assert.equal(counts.watchRearms, RESOURCE_WAIT_COUNT);
  assert.equal(counts.invalidations, RESOURCE_WAIT_COUNT);
  assert.equal(counts.businessReads, 0);
  assert.equal(counts.status429, 0);
  assert.equal(counts.status503, 0);

  accounting.cleanup();
  assert.equal(accounting.activeCount, 0);
  assert.equal(ledger.snapshot().activeWaiters, 0);
});

test('fixed 100 irrelevant invalidations produce zero attention wakes before one terminal result', () => {
  const ledger = new BenchmarkCounterLedger();
  let checkpoint = checkpointStateForTurn(TURN_ID, true);
  let settle = emptyTerminalSettleState();

  let decision = classifySemanticWait({
    mode: 'attention', cursor: 1,
    events: [{ seq: 1, kind: 'turn_start', summary: 'turn started', turnId: TURN_ID }],
    work: ACTIVE_WORK, caughtUp: true, checkpoint, settle,
  });
  ({ checkpoint, settle } = carry(decision));
  assert.equal(decision.action, 'pending');

  for (let index = 0; index < IRRELEVANT_INVALIDATION_COUNT; index += 1) {
    const seq = index + 2;
    ledger.bump('invalidations');
    ledger.bump('businessReads');
    decision = classifySemanticWait({
      mode: 'attention', cursor: seq, events: [progressEvent(seq)], work: ACTIVE_WORK,
      caughtUp: true, checkpoint, settle,
    });
    ({ checkpoint, settle } = carry(decision));
    assert.equal(decision.action, 'pending', `irrelevant invalidation ${index + 1}`);
  }

  let counts = ledger.snapshot();
  assert.equal(counts.invalidations, IRRELEVANT_INVALIDATION_COUNT);
  assert.equal(counts.businessReads, IRRELEVANT_INVALIDATION_COUNT);
  assert.equal(counts.modelResults, 0);
  assert.equal(counts.acceptedCheckpoints, 0);

  decision = classifySemanticWait({
    mode: 'attention', cursor: 102,
    events: [
      { seq: 102, kind: 'assistant_message', summary: 'final answer', turnId: TURN_ID, final: true, state: 'final' },
      { seq: 103, kind: 'turn_end', summary: 'turn ended', turnId: TURN_ID, outcome: 'completed' },
    ],
    work: QUIESCENT_WORK, caughtUp: true, checkpoint, settle,
  });
  assert.equal(decision.action, 'return');
  if (decision.action === 'return') assert.equal(decision.wakeReason, 'completed');
  ledger.bump('terminalInterventions');
  ledger.bump('modelResults');

  counts = ledger.snapshot();
  assert.equal(counts.modelResults, counts.acceptedCheckpoints + counts.terminalInterventions);
  assert.equal(counts.modelResults, 1);
});

test('checkpoint-count foundation equates model wakes with accepted checkpoints plus terminal/intervention wakes', () => {
  const ledger = new BenchmarkCounterLedger();
  let checkpoint = checkpointStateForTurn(TURN_ID, true);
  let settle = emptyTerminalSettleState();

  for (const [seq, detail] of [[10, '2 / 4 completed'], [20, '4 / 4 completed']] as const) {
    const decision = classifySemanticWait({
      mode: 'attention', cursor: seq, events: [planEvent(seq, detail)], work: ACTIVE_WORK,
      caughtUp: true, checkpoint, settle,
    });
    ({ checkpoint, settle } = carry(decision));
    assert.equal(decision.action, 'return');
    if (decision.action === 'return') assert.equal(decision.wakeReason, 'checkpoint');
    ledger.bump('acceptedCheckpoints');
    ledger.bump('modelResults');
  }

  for (let index = 0; index < IRRELEVANT_INVALIDATION_COUNT; index += 1) {
    const seq = 30 + index;
    const decision = classifySemanticWait({
      mode: 'attention', cursor: seq, events: [progressEvent(seq)], work: ACTIVE_WORK,
      caughtUp: true, checkpoint, settle,
    });
    ({ checkpoint, settle } = carry(decision));
    assert.equal(decision.action, 'pending');
  }

  const terminal = classifySemanticWait({
    mode: 'attention', cursor: 200,
    events: [
      { seq: 200, kind: 'assistant_message', summary: 'final answer', turnId: TURN_ID, final: true, state: 'final' },
      { seq: 201, kind: 'turn_end', summary: 'turn ended', turnId: TURN_ID, outcome: 'completed' },
    ],
    work: QUIESCENT_WORK, caughtUp: true, checkpoint, settle,
  });
  assert.equal(terminal.action, 'return');
  if (terminal.action === 'return') assert.equal(terminal.wakeReason, 'completed');
  ledger.bump('terminalInterventions');
  ledger.bump('modelResults');

  const counts = ledger.snapshot();
  assert.equal(counts.acceptedCheckpoints, 2);
  assert.equal(counts.terminalInterventions, 1);
  assert.equal(counts.modelResults, 3);
  assert.equal(counts.modelResults, counts.acceptedCheckpoints + counts.terminalInterventions);
});
