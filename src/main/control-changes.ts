import { randomUUID } from 'node:crypto';

export const CONTROL_CHANGE_MAX_WAITERS = 32;

export type ControlChangeReason = 'snapshot' | 'changed' | 'reset';

export interface ControlChangeState {
  instanceId: string;
  seq: number;
  reason: ControlChangeReason;
}

export interface ControlChangeCursor {
  instanceId: string;
  after: number;
}

export type ControlChangeListener = () => void;
export type ControlChangeSubscribe = (listener: ControlChangeListener) => () => void;

/**
 * Every owner whose state participates in the Local Control work/quiescence projection.
 *
 * Kept as explicit wiring rather than importing those owners here so the broker remains a small
 * Local Control primitive. The Control API generation that owns the broker installs the current
 * owner listeners when it starts and closes them with the listener generation.
 */
export interface ControlChangeSubscriptions {
  session: ControlChangeSubscribe;
  input: ControlChangeSubscribe;
  bridge: ControlChangeSubscribe;
  goal: ControlChangeSubscribe;
  swarm: ControlChangeSubscribe;
  status: ControlChangeSubscribe;
  toolState: ControlChangeSubscribe;
}

export class ControlChangeWaiterLimitError extends Error {
  constructor() {
    super('control_changes_waiter_limit');
    this.name = 'ControlChangeWaiterLimitError';
  }
}

export class ControlChangeClosedError extends Error {
  constructor() {
    super('control_changes_closed');
    this.name = 'ControlChangeClosedError';
  }
}

interface Waiter {
  check(): void;
  cancel(error: unknown): void;
}

/**
 * No-payload invalidation generation for Local Control long waits.
 *
 * The sequence is only a fence telling the caller to re-read authoritative owners. It never
 * retains session state, text, paths, goals or other semantic payloads.
 */
export class ControlChangeBroker {
  private readonly instanceId = randomUUID();
  private readonly waiters = new Set<Waiter>();
  private readonly unsubscribers: Array<() => void> = [];
  private sequence = 0;
  private started = false;
  private closed = false;

  constructor(private readonly subscriptions: ControlChangeSubscriptions) {}

  /** Installs one listener for each authoritative owner. Idempotent within this generation. */
  start(): void {
    if (this.closed) throw new ControlChangeClosedError();
    if (this.started) return;

    const installed: Array<() => void> = [];
    const publish = () => this.publish();
    try {
      const subscriptions: ControlChangeSubscribe[] = [
        this.subscriptions.session,
        this.subscriptions.input,
        this.subscriptions.bridge,
        this.subscriptions.goal,
        this.subscriptions.swarm,
        this.subscriptions.status,
        this.subscriptions.toolState,
      ];
      for (const subscribe of subscriptions) installed.push(subscribe(publish));
    } catch (error) {
      for (const unsubscribe of installed.reverse()) {
        try { unsubscribe(); } catch { /* the failed start still owns listener cleanup */ }
      }
      throw error;
    }

    this.unsubscribers.push(...installed);
    this.started = true;
  }

  /** Current generation without semantic owner state. */
  snapshot(): ControlChangeState {
    if (this.closed) throw new ControlChangeClosedError();
    return this.state('snapshot');
  }

  /**
   * Waits for the supplied generation cursor to become stale.
   *
   * The second check happens only after the waiter is registered, which closes the lost-wakeup
   * gap between the caller's first observation and parking. There is intentionally no timer.
   */
  async wait(cursor: ControlChangeCursor, signal?: AbortSignal): Promise<ControlChangeState> {
    if (this.closed) throw new ControlChangeClosedError();

    const ready = this.classify(cursor);
    if (ready) return ready;

    // Keep this after the first read: an abort or change in this gap must still leave no waiter.
    signal?.throwIfAborted();
    if (this.waiters.size >= CONTROL_CHANGE_MAX_WAITERS) throw new ControlChangeWaiterLimitError();

    return await new Promise<ControlChangeState>((resolve, reject) => {
      let settled = false;
      const finish = (result?: ControlChangeState, error?: unknown): void => {
        if (settled) return;
        settled = true;
        this.waiters.delete(waiter);
        signal?.removeEventListener('abort', abort);
        if (error !== undefined) reject(error);
        else resolve(result!);
      };
      const waiter: Waiter = {
        check: () => {
          if (this.closed) {
            finish(undefined, new ControlChangeClosedError());
            return;
          }
          const next = this.classify(cursor);
          if (next) finish(next);
        },
        cancel: error => finish(undefined, error),
      };
      const abort = () => waiter.cancel(signal?.reason ?? new Error('control_changes_cancelled'));

      this.waiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      waiter.check();
    });
  }

  /** Advances the invalidation fence before waking every parked caller. */
  publish(): void {
    if (this.closed) return;
    if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('control_changes_sequence_exhausted');
    this.sequence += 1;
    for (const waiter of [...this.waiters]) waiter.check();
  }

  /** Releases owner listeners and rejects every waiter owned by this Local Control generation. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.unsubscribers.splice(0).reverse()) {
      try { unsubscribe(); } catch { /* owner notification cleanup must not block shutdown */ }
    }
    for (const waiter of [...this.waiters]) waiter.cancel(new ControlChangeClosedError());
  }

  private classify(cursor: ControlChangeCursor): ControlChangeState | null {
    if (cursor.instanceId !== this.instanceId) return this.state('reset');
    if (this.sequence > cursor.after) return this.state('changed');
    return null;
  }

  private state(reason: ControlChangeReason): ControlChangeState {
    return { instanceId: this.instanceId, seq: this.sequence, reason };
  }
}
