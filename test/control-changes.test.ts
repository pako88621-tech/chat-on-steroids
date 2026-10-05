import { describe, expect, it } from 'vitest';
import {
  CONTROL_CHANGE_MAX_WAITERS,
  ControlChangeBroker,
  ControlChangeClosedError,
  ControlChangeWaiterLimitError,
  type ControlChangeListener,
  type ControlChangeSubscriptions,
} from '../src/main/control-changes.js';

type Hook = keyof ControlChangeSubscriptions;

function harness() {
  const keys: Hook[] = ['session', 'blocked', 'input', 'bridge', 'goal', 'swarm', 'status', 'toolState'];
  const listeners = new Map<Hook, Set<ControlChangeListener>>(keys.map(key => [key, new Set()]));
  const subscribe = (key: Hook) => (listener: ControlChangeListener) => {
    listeners.get(key)!.add(listener);
    return () => { listeners.get(key)!.delete(listener); };
  };
  const broker = new ControlChangeBroker({
    session: subscribe('session'),
    blocked: subscribe('blocked'),
    input: subscribe('input'),
    bridge: subscribe('bridge'),
    goal: subscribe('goal'),
    swarm: subscribe('swarm'),
    status: subscribe('status'),
    toolState: subscribe('toolState'),
  });
  broker.start();
  return {
    broker,
    emit(key: Hook) {
      for (const listener of [...listeners.get(key)!]) listener();
    },
    listenerCount() {
      return [...listeners.values()].reduce((total, rows) => total + rows.size, 0);
    },
  };
}

describe('Local Control change broker', () => {
  it('starts each broker at seq zero with a fresh UUID snapshot', () => {
    const first = harness();
    const second = harness();
    const a = first.broker.snapshot();
    const b = second.broker.snapshot();

    expect(a).toEqual({ instanceId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), seq: 0, reason: 'snapshot' });
    expect(b.seq).toBe(0);
    expect(b.reason).toBe('snapshot');
    expect(b.instanceId).not.toBe(a.instanceId);
    first.broker.close();
    second.broker.close();
  });

  it('subscribes to every work-state owner and publishes only an invalidation generation', async () => {
    const h = harness();
    expect(h.listenerCount()).toBe(8);
    let seq = 0;
    const keys: Hook[] = ['session', 'blocked', 'input', 'bridge', 'goal', 'swarm', 'status', 'toolState'];
    for (const key of keys) {
      const cursor = h.broker.snapshot();
      const pending = h.broker.wait({ instanceId: cursor.instanceId, after: cursor.seq });
      h.emit(key);
      const change = await pending;
      seq += 1;
      expect(change).toEqual({ instanceId: cursor.instanceId, seq, reason: 'changed' });
      expect(Object.keys(change).sort()).toEqual(['instanceId', 'reason', 'seq']);
    }
    h.broker.close();
    expect(h.listenerCount()).toBe(0);
  });

  it('registers then rechecks so a change in the arm gap is not lost', async () => {
    const h = harness();
    const cursor = h.broker.snapshot();
    const signal = {
      aborted: false,
      reason: undefined,
      throwIfAborted: () => h.broker.publish(),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;

    await expect(h.broker.wait({ instanceId: cursor.instanceId, after: cursor.seq }, signal)).resolves.toEqual({
      instanceId: cursor.instanceId,
      seq: 1,
      reason: 'changed',
    });
    h.broker.close();
  });

  it('increments seq before wake and immediately reports already-stale cursors', async () => {
    const h = harness();
    const cursor = h.broker.snapshot();
    const pending = h.broker.wait({ instanceId: cursor.instanceId, after: cursor.seq });
    h.broker.publish();
    await expect(pending).resolves.toEqual({ instanceId: cursor.instanceId, seq: 1, reason: 'changed' });
    await expect(h.broker.wait({ instanceId: cursor.instanceId, after: 0 })).resolves.toEqual({
      instanceId: cursor.instanceId,
      seq: 1,
      reason: 'changed',
    });
    h.broker.close();
  });

  it('returns reset immediately when a caller presents an older broker instance', async () => {
    const old = harness();
    const stale = old.broker.snapshot();
    old.broker.close();
    const current = harness();
    const now = current.broker.snapshot();

    await expect(current.broker.wait({ instanceId: stale.instanceId, after: stale.seq })).resolves.toEqual({
      instanceId: now.instanceId,
      seq: 0,
      reason: 'reset',
    });
    current.broker.close();
  });

  it('caps parked callers at 32 and releases capacity on abort', async () => {
    const h = harness();
    const cursor = h.broker.snapshot();
    const controllers = Array.from({ length: CONTROL_CHANGE_MAX_WAITERS }, () => new AbortController());
    const parked = controllers.map(controller => h.broker.wait(
      { instanceId: cursor.instanceId, after: cursor.seq },
      controller.signal,
    ));

    await expect(h.broker.wait({ instanceId: cursor.instanceId, after: cursor.seq })).rejects.toBeInstanceOf(ControlChangeWaiterLimitError);
    controllers.forEach(controller => controller.abort(new Error('cancelled')));
    await Promise.all(parked.map(promise => promise.catch(() => undefined)));

    const replacement = h.broker.wait({ instanceId: cursor.instanceId, after: cursor.seq });
    h.broker.publish();
    await expect(replacement).resolves.toMatchObject({ seq: 1, reason: 'changed' });
    h.broker.close();
  });

  it('does not consume waiter capacity when aborted before or while arming', async () => {
    const h = harness();
    const cursor = h.broker.snapshot();
    const before = new AbortController();
    before.abort(new Error('before arm'));
    await expect(h.broker.wait({ instanceId: cursor.instanceId, after: cursor.seq }, before.signal)).rejects.toThrow('before arm');

    const during = new AbortController();
    const cancelled = h.broker.wait({ instanceId: cursor.instanceId, after: cursor.seq }, during.signal);
    during.abort(new Error('while armed'));
    await expect(cancelled).rejects.toThrow('while armed');

    const parked = Array.from({ length: CONTROL_CHANGE_MAX_WAITERS }, () => h.broker.wait({
      instanceId: cursor.instanceId,
      after: cursor.seq,
    }));
    h.broker.publish();
    await expect(Promise.all(parked)).resolves.toHaveLength(CONTROL_CHANGE_MAX_WAITERS);
    h.broker.close();
  });

  it('survives repeated arm/cancel cleanup without leaking waiter capacity', async () => {
    const h = harness();
    const cursor = h.broker.snapshot();
    for (let index = 0; index < 1_000; index += 1) {
      const controller = new AbortController();
      const pending = h.broker.wait({ instanceId: cursor.instanceId, after: cursor.seq }, controller.signal);
      controller.abort(new Error('cancelled'));
      await pending.catch(() => undefined);
    }

    const controllers = Array.from({ length: CONTROL_CHANGE_MAX_WAITERS }, () => new AbortController());
    const parked = controllers.map(controller => h.broker.wait(
      { instanceId: cursor.instanceId, after: cursor.seq },
      controller.signal,
    ));
    h.broker.publish();
    await expect(Promise.all(parked)).resolves.toHaveLength(CONTROL_CHANGE_MAX_WAITERS);
    h.broker.close();
  });

  it('cleans owner listeners and rejects every parked waiter on close', async () => {
    const h = harness();
    const cursor = h.broker.snapshot();
    const first = h.broker.wait({ instanceId: cursor.instanceId, after: cursor.seq });
    const second = h.broker.wait({ instanceId: cursor.instanceId, after: cursor.seq });
    h.broker.close();

    await expect(first).rejects.toBeInstanceOf(ControlChangeClosedError);
    await expect(second).rejects.toBeInstanceOf(ControlChangeClosedError);
    expect(h.listenerCount()).toBe(0);
    expect(() => h.broker.snapshot()).toThrow(ControlChangeClosedError);
  });

  it('rolls back listeners if owner subscription setup fails part-way through', () => {
    const listeners = new Set<ControlChangeListener>();
    const noOp = () => () => {};
    const broker = new ControlChangeBroker({
      session: listener => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      blocked: noOp,
      input: () => { throw new Error('subscription failed'); },
      bridge: noOp,
      goal: noOp,
      swarm: noOp,
      status: noOp,
      toolState: noOp,
    });

    expect(() => broker.start()).toThrow('subscription failed');
    expect(listeners.size).toBe(0);
    broker.close();
  });
});
