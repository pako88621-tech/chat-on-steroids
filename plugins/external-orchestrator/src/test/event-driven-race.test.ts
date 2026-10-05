import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  RACE_SCHEDULE_COUNT,
} from './benchmark-harness.js';
import {
  FROZEN_RACE_FAMILIES,
  familyRaceMatrix,
  frozenRaceMatrix,
  runFrozenRaceMatrix,
  type DeterministicRaceSchedule,
  type FrozenRaceAdapter,
  type ScheduledRaceStep,
} from './race-harness.js';
import {
  checkpointStateForTurn,
  classifySemanticWait,
  emptyTerminalSettleState,
  type SemanticProjectedEvent,
  type SemanticWorkState,
} from '../semantic-wait.js';

const TURN_ID = 'turn-race-0001';
const QUIESCENT_WORK: SemanticWorkState = { state: 'quiescent', reasons: [], nextDeadline: null };
const FROZEN_MATRIX_SHA256 = 'e3b94185286ff17f7f405389a778b4366614cf2b8ec7f0377e73713db4fd74ee';

function matrixFingerprint(schedules: Iterable<DeterministicRaceSchedule>): string {
  const hash = createHash('sha256');
  for (const schedule of schedules) {
    hash.update(`${schedule.index}:${schedule.family}|`);
    for (const step of schedule.steps) hash.update(`${step.actor}:${step.actorStep}:${step.label}|`);
    hash.update('\n');
  }
  return hash.digest('hex');
}

function assertLaneOrder(schedule: DeterministicRaceSchedule): void {
  const actorPositions = new Map<string, number>();
  for (const step of schedule.steps) {
    const expected = actorPositions.get(step.actor) ?? 0;
    assert.equal(step.actorStep, expected, `${schedule.index}:${schedule.family}:${step.actor}`);
    actorPositions.set(step.actor, expected + 1);
  }
}

test('frozen race matrix contains exactly 10,000 fixed-order schedules spanning every Phase-0 race family', () => {
  const counts = new Map<string, number>();
  let scheduleCount = 0;
  for (const schedule of frozenRaceMatrix()) {
    scheduleCount += 1;
    counts.set(schedule.family, (counts.get(schedule.family) ?? 0) + 1);
    assert.equal(schedule.index, scheduleCount - 1);
    assertLaneOrder(schedule);
  }

  assert.equal(scheduleCount, RACE_SCHEDULE_COUNT);
  assert.deepEqual([...counts.keys()].sort(), FROZEN_RACE_FAMILIES.map((family) => family.name).sort());
  const first = matrixFingerprint(frozenRaceMatrix());
  const second = matrixFingerprint(frozenRaceMatrix());
  assert.equal(first, second);
  assert.equal(first, FROZEN_MATRIX_SHA256);
});

test('integration adapter hook executes each frozen schedule once without injecting timers', async () => {
  let begins = 0;
  let verifies = 0;
  let steps = 0;
  let activeSchedule = -1;
  const adapter: FrozenRaceAdapter = {
    begin(schedule) {
      begins += 1;
      activeSchedule = schedule.index;
    },
    step(step, schedule) {
      assert.equal(schedule.index, activeSchedule);
      assert.equal(step.scheduleIndex, schedule.index);
      steps += 1;
    },
    verify(schedule) {
      assert.equal(schedule.index, activeSchedule);
      verifies += 1;
    },
  };

  await runFrozenRaceMatrix(adapter);
  assert.equal(begins, RACE_SCHEDULE_COUNT);
  assert.equal(verifies, RACE_SCHEDULE_COUNT);
  assert.ok(steps > RACE_SCHEDULE_COUNT);
});

function classifierEvent(step: ScheduledRaceStep, seq: number): SemanticProjectedEvent {
  if (step.label === 'final') {
    return { seq, kind: 'assistant_message', summary: 'final answer', turnId: TURN_ID, final: true, state: 'final' };
  }
  if (step.label === 'turn_end') {
    return { seq, kind: 'turn_end', summary: 'turn ended', turnId: TURN_ID, outcome: 'completed' };
  }
  if (step.label === 'trailing_tool') {
    return {
      seq,
      kind: 'tool_call',
      summary: 'trailing tool activity',
      turnId: TURN_ID,
      tool: {
        name: 'read', outcome: 'ok',
        summary: { title: 'Read', kind: 'read' }, changes: [],
      },
    };
  }
  throw new Error(`unexpected classifier race step ${step.label}`);
}

test('10,000 final/trailing-tool schedules never complete before a caught-up stable cut and preserve the settle barrier', () => {
  const family = FROZEN_RACE_FAMILIES.find((candidate) => candidate.name === 'final_trailing_tool');
  assert.ok(family);
  let completed = 0;
  let settling = 0;

  for (const schedule of familyRaceMatrix(family)) {
    let checkpoint = checkpointStateForTurn(TURN_ID, true);
    let settle = emptyTerminalSettleState();
    let seq = 1;
    const seenAt = new Map<string, number>();

    for (const step of schedule.steps) {
      const event = classifierEvent(step, seq);
      seenAt.set(step.label, seq);
      const decision = classifySemanticWait({
        mode: 'terminal', cursor: seq, events: [event], work: QUIESCENT_WORK,
        caughtUp: false, checkpoint, settle,
      });
      checkpoint = decision.checkpoint;
      settle = decision.settle;
      assert.equal(
        decision.action === 'return' && decision.wakeReason === 'completed',
        false,
        `schedule ${schedule.index} completed before the stable cut`,
      );
      seq += 1;
    }

    const decision = classifySemanticWait({
      mode: 'terminal', cursor: seq, events: [], work: QUIESCENT_WORK,
      caughtUp: true, checkpoint, settle,
    });
    const finalSeq = seenAt.get('final');
    const endSeq = seenAt.get('turn_end');
    const toolSeq = seenAt.get('trailing_tool');
    assert.notEqual(finalSeq, undefined);
    assert.notEqual(endSeq, undefined);
    assert.notEqual(toolSeq, undefined);
    const trailingAfterFinal = toolSeq! > endSeq! && toolSeq! > finalSeq!;

    if (trailingAfterFinal) {
      assert.equal(decision.action, 'pending', `schedule ${schedule.index}`);
      if (decision.action === 'pending') assert.equal(decision.settleReason, 'trailing_activity');
      settling += 1;
    } else {
      assert.equal(decision.action, 'return', `schedule ${schedule.index}`);
      if (decision.action === 'return') assert.equal(decision.wakeReason, 'completed');
      completed += 1;
    }
  }

  assert.equal(completed + settling, RACE_SCHEDULE_COUNT);
  assert.ok(completed > 0);
  assert.ok(settling > 0);
});
