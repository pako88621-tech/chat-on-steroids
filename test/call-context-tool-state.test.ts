import { describe, expect, it } from 'vitest';
import {
  emptyEvidence,
  holdWhileSettling,
  onToolStateChange,
  runningToolCalls,
  setCallConversationId,
  settlingToolCalls,
  trackInFlight,
  type CallContext,
} from '../src/main/mcp/call-context.js';

function context(): CallContext {
  return {
    startedAt: Date.now(),
    transportKey: null,
    agent: null,
    caller: { transportKey: null, requestId: null, conversationId: 'conversation-a' },
    outcome: null,
    evidence: emptyEvidence(),
  };
}

describe('tool-state change observation', () => {
  it('notifies only after running and settling mutations are visible', async () => {
    const observed: Array<[number, number]> = [];
    const unsubscribe = onToolStateChange(() => {
      observed.push([runningToolCalls('conversation-a'), settlingToolCalls('conversation-a')]);
    });
    const call = context();

    let releaseRunning = (): void => {};
    const runningWork = new Promise<void>(resolve => { releaseRunning = resolve; });
    const running = trackInFlight(call, () => runningWork);
    expect(observed).toEqual([[1, 0]]);
    releaseRunning();
    await running;
    expect(observed).toEqual([[1, 0], [0, 0]]);

    let releaseSettling = (): void => {};
    const settlingWork = new Promise<void>(resolve => { releaseSettling = resolve; });
    holdWhileSettling(call, settlingWork);
    expect(observed.at(-1)).toEqual([0, 1]);
    releaseSettling();
    await settlingWork;
    await Promise.resolve();
    expect(observed.at(-1)).toEqual([0, 0]);

    const before = observed.length;
    unsubscribe();
    await trackInFlight(call, async () => undefined);
    expect(observed).toHaveLength(before);
  });

  it('does not let an observer failure break tool lifetime tracking', async () => {
    const unsubscribe = onToolStateChange(() => { throw new Error('observer failed'); });
    const call = context();
    await expect(trackInFlight(call, async () => 'ok')).resolves.toBe('ok');
    expect(runningToolCalls('conversation-a')).toBe(0);
    unsubscribe();
  });

  it('invalidates when a live unattributed call gains an exact conversation owner', async () => {
    const observed: Array<[number, number]> = [];
    const unsubscribe = onToolStateChange(() => {
      observed.push([runningToolCalls('conversation-a'), runningToolCalls('conversation-b')]);
    });
    const call = context();
    call.caller.conversationId = null;
    let release = (): void => {};
    const work = new Promise<void>(resolve => { release = resolve; });
    const tracked = trackInFlight(call, () => work);
    expect(observed.at(-1)).toEqual([1, 1]);

    setCallConversationId(call, 'conversation-b');
    expect(observed.at(-1)).toEqual([0, 1]);

    release();
    await tracked;
    expect(observed.at(-1)).toEqual([0, 0]);
    unsubscribe();
  });
});
