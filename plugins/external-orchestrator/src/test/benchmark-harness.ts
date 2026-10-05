export const QUIET_TRACE_MINUTES = [20, 60, 180] as const;
export type QuietTraceMinutes = typeof QUIET_TRACE_MINUTES[number];

export const RESOURCE_WAIT_COUNT = 32;
export const IRRELEVANT_INVALIDATION_COUNT = 100;
export const RACE_SCHEDULE_COUNT = 10_000;
export const SECOND_MS = 1_000;

export type QuietAdvanceMode = 'whole' | 'seconds';

interface FakeTimerHandle {
  readonly fakeTimerId: number;
  ref(): FakeTimerHandle;
  unref(): FakeTimerHandle;
  hasRef(): boolean;
  refresh(): FakeTimerHandle;
  [Symbol.toPrimitive](): number;
}

interface FakeTimerRecord {
  id: number;
  dueMs: number;
  callback: (...args: unknown[]) => void;
  args: unknown[];
  handle: FakeTimerHandle;
}

function normalizedDelay(value: unknown): number {
  const delay = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(delay) || delay <= 0) return 0;
  return delay;
}

/**
 * Deterministic Phase-0 clock for benchmark code. It owns the four frozen time primitives while
 * installed and fires only timers that benchmarked code explicitly schedules.
 */
export class FakeMonotonicClock {
  private readonly epochMs: number;
  private elapsed = 0;
  private nextTimerId = 1;
  private readonly timers = new Map<number, FakeTimerRecord>();
  private installed = false;
  private originalDateNow: (() => number) | null = null;
  private originalSetTimeout: typeof globalThis.setTimeout | null = null;
  private originalClearTimeout: typeof globalThis.clearTimeout | null = null;
  private originalPerformanceNowDescriptor: PropertyDescriptor | undefined;
  private hadOwnPerformanceNow = false;
  private firings = 0;

  constructor(epochMs = 1_700_000_000_000) {
    if (!Number.isSafeInteger(epochMs) || epochMs < 0) throw new Error('fake clock epoch must be a non-negative safe integer');
    this.epochMs = epochMs;
  }

  get elapsedMs(): number {
    return this.elapsed;
  }

  get timerFirings(): number {
    return this.firings;
  }

  get pendingTimerCount(): number {
    return this.timers.size;
  }

  install(): void {
    if (this.installed) throw new Error('fake clock is already installed');
    this.installed = true;
    this.originalDateNow = Date.now;
    this.originalSetTimeout = globalThis.setTimeout;
    this.originalClearTimeout = globalThis.clearTimeout;
    this.hadOwnPerformanceNow = Object.prototype.hasOwnProperty.call(globalThis.performance, 'now');
    this.originalPerformanceNowDescriptor = Object.getOwnPropertyDescriptor(globalThis.performance, 'now');

    Date.now = () => this.epochMs + this.elapsed;
    Object.defineProperty(globalThis.performance, 'now', {
      configurable: true,
      value: () => this.elapsed,
    });

    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (typeof callback !== 'function') throw new TypeError('fake clock setTimeout callback must be a function');
      const id = this.nextTimerId++;
      const handle: FakeTimerHandle = {
        fakeTimerId: id,
        ref() { return this; },
        unref() { return this; },
        hasRef() { return false; },
        refresh() { return this; },
        [Symbol.toPrimitive]() { return id; },
      };
      this.timers.set(id, {
        id,
        dueMs: this.elapsed + normalizedDelay(delay),
        callback,
        args,
        handle,
      });
      return handle as unknown as ReturnType<typeof globalThis.setTimeout>;
    }) as typeof globalThis.setTimeout;

    globalThis.clearTimeout = ((handle: ReturnType<typeof globalThis.setTimeout> | number | string | undefined) => {
      if (handle === undefined) return;
      const candidate = handle as unknown;
      const id = typeof candidate === 'object' && candidate !== null && 'fakeTimerId' in candidate
        ? (candidate as FakeTimerHandle).fakeTimerId
        : Number(candidate);
      if (Number.isSafeInteger(id)) this.timers.delete(id);
    }) as typeof globalThis.clearTimeout;
  }

  restore(): void {
    if (!this.installed) return;
    if (this.originalDateNow !== null) Date.now = this.originalDateNow;
    if (this.originalSetTimeout !== null) globalThis.setTimeout = this.originalSetTimeout;
    if (this.originalClearTimeout !== null) globalThis.clearTimeout = this.originalClearTimeout;
    if (this.hadOwnPerformanceNow && this.originalPerformanceNowDescriptor !== undefined) {
      Object.defineProperty(globalThis.performance, 'now', this.originalPerformanceNowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis.performance, 'now');
    }
    this.timers.clear();
    this.installed = false;
  }

  advanceBy(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('fake clock advance must be a non-negative safe integer');
    const target = this.elapsed + ms;
    if (!Number.isSafeInteger(target)) throw new Error('fake clock target exceeds safe integer range');

    for (;;) {
      let next: FakeTimerRecord | null = null;
      for (const timer of this.timers.values()) {
        if (timer.dueMs > target) continue;
        if (next === null || timer.dueMs < next.dueMs || (timer.dueMs === next.dueMs && timer.id < next.id)) next = timer;
      }
      if (next === null) break;
      this.timers.delete(next.id);
      this.elapsed = next.dueMs;
      this.firings += 1;
      next.callback(...next.args);
    }
    this.elapsed = target;
  }
}

export interface BenchmarkCountSnapshot {
  businessReads: number;
  watchArms: number;
  watchRearms: number;
  timerFirings: number;
  modelResults: number;
  activeWaiters: number;
  status429: number;
  status503: number;
  invalidations: number;
  acceptedCheckpoints: number;
  terminalInterventions: number;
}

export type BenchmarkCountName = keyof BenchmarkCountSnapshot;

function zeroCounts(): BenchmarkCountSnapshot {
  return {
    businessReads: 0,
    watchArms: 0,
    watchRearms: 0,
    timerFirings: 0,
    modelResults: 0,
    activeWaiters: 0,
    status429: 0,
    status503: 0,
    invalidations: 0,
    acceptedCheckpoints: 0,
    terminalInterventions: 0,
  };
}

/** Count-only instrumentation. Runtime adapters call this at existing seams; it owns no product state. */
export class BenchmarkCounterLedger {
  private readonly counts = zeroCounts();

  bump(name: BenchmarkCountName, amount = 1): void {
    if (!Number.isSafeInteger(amount)) throw new Error('benchmark counter delta must be a safe integer');
    const next = this.counts[name] + amount;
    if (!Number.isSafeInteger(next) || next < 0) throw new Error(`benchmark counter ${name} would become invalid`);
    this.counts[name] = next;
  }

  snapshot(): BenchmarkCountSnapshot {
    return { ...this.counts };
  }
}

export function diffCounts(after: BenchmarkCountSnapshot, before: BenchmarkCountSnapshot): BenchmarkCountSnapshot {
  const result = zeroCounts();
  for (const key of Object.keys(result) as BenchmarkCountName[]) result[key] = after[key] - before[key];
  return result;
}

/**
 * Accounts for held change watches without implementing their behavior. Integration tests mark the
 * real broker's arm/completion/re-arm seams here so resource assertions cannot create a shadow waiter.
 */
export class WaitAccounting {
  private readonly active = new Set<string>();

  constructor(private readonly ledger: BenchmarkCounterLedger) {}

  get activeCount(): number {
    return this.active.size;
  }

  arm(sessionId: string, rearm = false): void {
    if (this.active.has(sessionId)) throw new Error(`benchmark waiter already active for ${sessionId}`);
    this.active.add(sessionId);
    this.ledger.bump('activeWaiters');
    this.ledger.bump('watchArms');
    if (rearm) this.ledger.bump('watchRearms');
  }

  complete(sessionId: string): void {
    if (!this.active.delete(sessionId)) throw new Error(`benchmark waiter is not active for ${sessionId}`);
    this.ledger.bump('activeWaiters', -1);
  }

  cleanup(): void {
    for (const sessionId of [...this.active]) this.complete(sessionId);
  }
}

export function advanceQuietTrace(clock: FakeMonotonicClock, minutes: QuietTraceMinutes, mode: QuietAdvanceMode): void {
  const totalMs = minutes * 60 * SECOND_MS;
  if (mode === 'whole') {
    clock.advanceBy(totalMs);
    return;
  }
  for (let elapsed = 0; elapsed < totalMs; elapsed += SECOND_MS) clock.advanceBy(SECOND_MS);
}

/**
 * Compile-time seam for the later service integration. Implementations must report observations from
 * the real broker/service; benchmark utilities never synthesize a product timer or product wake.
 */
export interface EventDrivenWaitBenchmarkAdapter {
  readonly clock: FakeMonotonicClock;
  snapshotCounts(): BenchmarkCountSnapshot;
  arm(sessionId: string): Promise<void>;
  invalidate(sessionId: string): Promise<void>;
  injectTerminal(sessionId: string): Promise<void>;
  cleanup(sessionId: string): Promise<void>;
}
