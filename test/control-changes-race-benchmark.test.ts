import { describe, expect, it } from 'vitest';
import {
  ControlChangeBroker,
  type ControlChangeCursor,
  type ControlChangeState,
  type ControlChangeSubscriptions,
} from '../src/main/control-changes.js';
import { RACE_SCHEDULE_COUNT } from '../plugins/external-orchestrator/src/test/benchmark-harness.js';
import {
  FROZEN_RACE_FAMILIES,
  familyRaceMatrix,
  type FrozenRaceFamily,
} from '../plugins/external-orchestrator/src/test/race-harness.js';

function subscriptions(): ControlChangeSubscriptions {
  const subscribe = () => () => {};
  return {
    session: subscribe,
    blocked: subscribe,
    input: subscribe,
    bridge: subscribe,
    goal: subscribe,
    swarm: subscribe,
    status: subscribe,
    toolState: subscribe,
  };
}

function family(name: FrozenRaceFamily['name']): FrozenRaceFamily {
  const value = FROZEN_RACE_FAMILIES.find(candidate => candidate.name === name);
  if (!value) throw new Error(`missing frozen race family ${name}`);
  return value;
}

interface ObservedSettlement {
  count: number;
  promise: Promise<{ state?: ControlChangeState; error?: unknown }>;
}

function observeSettlement(promise: Promise<ControlChangeState>): ObservedSettlement {
  const observed: ObservedSettlement = {
    count: 0,
    promise: promise.then(
      state => {
        observed.count += 1;
        return { state };
      },
      error => {
        observed.count += 1;
        return { error };
      },
    ),
  };
  return observed;
}

describe('Local Control broker deterministic race benchmark', () => {
  it('runs 5,000 snapshot/register/publish schedules with zero lost or double wake', async () => {
    const race = family('snapshot_register_publish');
    const scheduleCount = RACE_SCHEDULE_COUNT / 2;
    let changed = 0;
    let stayedPending = 0;

    for (const schedule of familyRaceMatrix(race, scheduleCount)) {
      const broker = new ControlChangeBroker(subscriptions());
      broker.start();
      const controller = new AbortController();
      let cursor: ControlChangeCursor | null = null;
      let observed: ObservedSettlement | null = null;
      let snapshotPosition = -1;
      let publishPosition = -1;

      for (let position = 0; position < schedule.steps.length; position += 1) {
        const step = schedule.steps[position];
        if (!step) throw new Error('race schedule step disappeared');
        if (step.label === 'snapshot') {
          const snapshot = broker.snapshot();
          cursor = { instanceId: snapshot.instanceId, after: snapshot.seq };
          snapshotPosition = position;
        } else if (step.label === 'register') {
          if (!cursor) throw new Error('register ran before its causal snapshot');
          observed = observeSettlement(broker.wait(cursor, controller.signal));
        } else if (step.label === 'publish') {
          broker.publish();
          publishPosition = position;
        } else if (step.label !== 'recheck') {
          throw new Error(`unexpected broker race step ${step.label}`);
        }
      }

      if (!observed || snapshotPosition < 0 || publishPosition < 0) throw new Error('incomplete broker race schedule');
      await Promise.resolve();
      const publishInvalidatedSnapshot = publishPosition > snapshotPosition;
      if (publishInvalidatedSnapshot) {
        const outcome = await observed.promise;
        expect(outcome.error, `schedule ${schedule.index}`).toBeUndefined();
        expect(outcome.state, `schedule ${schedule.index}`).toMatchObject({ reason: 'changed' });
        changed += 1;
      } else {
        expect(observed.count, `schedule ${schedule.index}`).toBe(0);
        controller.abort(new Error('benchmark cleanup'));
        const outcome = await observed.promise;
        expect(outcome.error, `schedule ${schedule.index}`).toBeInstanceOf(Error);
        stayedPending += 1;
      }
      expect(observed.count, `schedule ${schedule.index}`).toBe(1);
      broker.close();
    }

    expect(changed + stayedPending).toBe(scheduleCount);
    expect(changed).toBeGreaterThan(0);
    expect(stayedPending).toBeGreaterThan(0);
  });

  it('runs 5,000 abort/publish schedules with exactly one waiter settlement', async () => {
    const race = family('abort_publish');
    const scheduleCount = RACE_SCHEDULE_COUNT / 2;
    let resolved = 0;
    let aborted = 0;

    for (const schedule of familyRaceMatrix(race, scheduleCount)) {
      const broker = new ControlChangeBroker(subscriptions());
      broker.start();
      const baseline = broker.snapshot();
      const cursor: ControlChangeCursor = { instanceId: baseline.instanceId, after: baseline.seq };
      const controller = new AbortController();
      let observed: ObservedSettlement | null = null;

      for (const step of schedule.steps) {
        if (step.label === 'register') {
          observed = observeSettlement(broker.wait(cursor, controller.signal));
        } else if (step.label === 'abort') {
          controller.abort(new Error('benchmark abort'));
        } else if (step.label === 'publish') {
          broker.publish();
        } else {
          throw new Error(`unexpected abort/publish race step ${step.label}`);
        }
      }

      if (!observed) throw new Error('abort/publish schedule never registered its waiter');
      const outcome = await observed.promise;
      expect(observed.count, `schedule ${schedule.index}`).toBe(1);
      if (outcome.state) {
        expect(outcome.state.reason, `schedule ${schedule.index}`).toBe('changed');
        resolved += 1;
      } else {
        expect(outcome.error, `schedule ${schedule.index}`).toBeInstanceOf(Error);
        aborted += 1;
      }
      broker.close();
    }

    expect(resolved + aborted).toBe(scheduleCount);
    expect(resolved).toBeGreaterThan(0);
    expect(aborted).toBeGreaterThan(0);
  });
});
