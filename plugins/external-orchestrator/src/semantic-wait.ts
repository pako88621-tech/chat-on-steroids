export type SemanticWaitMode = 'attention' | 'terminal' | 'activity';

export type SemanticWakeReason =
  | 'checkpoint'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'stalled'
  | 'stopped'
  | 'control_lost'
  | 'transport_lease_expired'
  | 'activity';

export type SemanticWorkStateName = 'active' | 'waiting' | 'settling' | 'quiescent' | 'blocked';

export type SemanticWorkReason =
  | 'active_turn'
  | 'tool_activity'
  | 'recovery'
  | 'goal_wait'
  | 'finish_hold'
  | 'job'
  | 'pending_input'
  | 'blocked';

export interface SemanticWorkState {
  state: SemanticWorkStateName;
  reasons: readonly SemanticWorkReason[];
  nextDeadline: number | null;
}

export type SemanticSummaryKind =
  | 'edit'
  | 'create'
  | 'delete'
  | 'move'
  | 'read'
  | 'search'
  | 'browse'
  | 'run'
  | 'process'
  | 'screen'
  | 'input'
  | 'clipboard'
  | 'session'
  | 'agent'
  | 'other';

export interface SemanticToolSummary {
  title: string;
  detail?: string;
  metric?: string;
  kind: string;
}

export interface SemanticProjectedEvent {
  seq: number;
  /** Core event kinds are open-ended; unknown future kinds remain routine/non-semantic here. */
  kind: string;
  /** Optional bounded presentation text. Semantics never depend on it. */
  summary?: string;
  turnId?: string;
  final?: boolean;
  state?: string;
  outcome?: string;
  recoverable?: boolean;
  blocking?: boolean;
  tool?: {
    name: string;
    outcome: string;
    summary: SemanticToolSummary;
    changes: readonly { path: string; added: number; removed: number }[];
  };
}

export type CheckpointCandidate = 'plan_midpoint' | 'plan_complete' | 'material_verify';

export interface CheckpointState {
  turnId: string | null;
  count: 0 | 1 | 2;
  midpointSeen: boolean;
  completeSeen: boolean;
  validPlanSeen: boolean;
  sawMaterialMutation: boolean;
  fallbackSeen: boolean;
  lastCandidateSeq: number | null;
  /** Frozen Phase-0 restart rule: true for the rest of a turn whose prior budget is unknowable. */
  checkpointSuppressed: boolean;
}

export type TerminalOutcome = 'completed' | 'failed' | 'stalled' | 'stopped' | 'interrupted' | 'unknown';

export interface TerminalSettleState {
  turnId: string | null;
  finalSeq: number | null;
  endSeq: number | null;
  outcome: TerminalOutcome | null;
  postEndActivitySeq: number | null;
  lastObservedSeq: number | null;
}

export type SemanticSettleReason =
  | 'awaiting_final'
  | 'trailing_activity'
  | 'work_not_quiescent'
  | 'not_caught_up'
  | 'unclassified_terminal';

export interface SemanticClassifierInput {
  mode: SemanticWaitMode;
  /** Local Control event cursor: the next recorder sequence the caller has not consumed. */
  cursor: number;
  events: readonly SemanticProjectedEvent[];
  work: SemanticWorkState;
  /** True only after the bounded event read reached the current recorder tail on this stable cut. */
  caughtUp: boolean;
  checkpoint: CheckpointState;
  settle: TerminalSettleState;
}

export type SemanticWaitDecision =
  | {
      action: 'pending';
      phase: 'waiting' | 'settling';
      settleReason?: SemanticSettleReason;
      checkpoint: CheckpointState;
      settle: TerminalSettleState;
    }
  | {
      action: 'return';
      wakeReason: SemanticWakeReason;
      eventSeq?: number;
      checkpointKind?: CheckpointCandidate;
      checkpointSummary?: string;
      checkpoint: CheckpointState;
      settle: TerminalSettleState;
    };

const PLAN_COUNTER = /^(\d{1,2}) \/ (\d{1,2}) completed$/u;
const MATERIAL_MUTATION: ReadonlySet<string> = new Set(['create', 'edit', 'delete', 'move']);
const VERIFY_KIND: ReadonlySet<string> = new Set(['run', 'process']);
const TERMINAL_OUTCOMES = new Set<TerminalOutcome>([
  'completed', 'failed', 'stalled', 'stopped', 'interrupted', 'unknown',
]);

function boundedCount(value: number): 0 | 1 | 2 {
  if (value <= 0) return 0;
  if (value === 1) return 1;
  return 2;
}

function validSeq(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function orderedEvents(events: readonly SemanticProjectedEvent[]): SemanticProjectedEvent[] {
  return events.filter((event) => validSeq(event.seq)).slice().sort((left, right) => left.seq - right.seq);
}

function exactTurnId(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : null;
}

function terminalOutcome(value: string | undefined): TerminalOutcome | null {
  return value && TERMINAL_OUTCOMES.has(value as TerminalOutcome) ? value as TerminalOutcome : null;
}

function isFinalAssistant(event: SemanticProjectedEvent): boolean {
  return event.kind === 'assistant_message' && (event.final === true || event.state === 'final');
}

function isPostEndActivity(event: SemanticProjectedEvent): boolean {
  if (event.kind === 'tool_call' || event.kind === 'page_tool' || event.kind === 'progress') return true;
  return event.kind === 'assistant_message' && !isFinalAssistant(event);
}

export function checkpointStateForTurn(turnId: string | null, canonicalBoundaryObserved: boolean): CheckpointState {
  const exact = turnId === null ? null : exactTurnId(turnId) ?? null;
  return {
    turnId: exact,
    count: 0,
    midpointSeen: false,
    completeSeen: false,
    validPlanSeen: false,
    sawMaterialMutation: false,
    fallbackSeen: false,
    lastCandidateSeq: null,
    checkpointSuppressed: !canonicalBoundaryObserved || exact === null,
  };
}

export function emptyTerminalSettleState(): TerminalSettleState {
  return {
    turnId: null,
    finalSeq: null,
    endSeq: null,
    outcome: null,
    postEndActivitySeq: null,
    lastObservedSeq: null,
  };
}

function resetSettleForTurn(turnId: string, seq: number): TerminalSettleState {
  return {
    turnId,
    finalSeq: null,
    endSeq: null,
    outcome: null,
    postEndActivitySeq: null,
    lastObservedSeq: seq,
  };
}

function observeTerminalEvidence(
  previous: TerminalSettleState,
  events: readonly SemanticProjectedEvent[],
): TerminalSettleState {
  let state = { ...previous };
  for (const event of events) {
    const turnId = exactTurnId(event.turnId);
    if (turnId === null) continue;

    if (event.kind === 'turn_start') {
      if (state.lastObservedSeq === null || event.seq > state.lastObservedSeq) state = resetSettleForTurn(turnId, event.seq);
      continue;
    }

    const relevant = isFinalAssistant(event) || event.kind === 'turn_end' || isPostEndActivity(event);
    if (!relevant) continue;
    if (state.turnId !== turnId) {
      if (state.lastObservedSeq !== null && event.seq <= state.lastObservedSeq) continue;
      state = resetSettleForTurn(turnId, event.seq);
    }
    if (state.turnId !== turnId) continue;
    state.lastObservedSeq = Math.max(state.lastObservedSeq ?? event.seq, event.seq);

    if (isFinalAssistant(event)) {
      state.finalSeq = Math.max(state.finalSeq ?? event.seq, event.seq);
      continue;
    }
    if (event.kind === 'turn_end') {
      const outcome = terminalOutcome(event.outcome);
      if (outcome !== null && (state.endSeq === null || event.seq >= state.endSeq)) {
        state.endSeq = event.seq;
        state.outcome = outcome;
        if (state.postEndActivitySeq !== null && state.postEndActivitySeq <= event.seq) state.postEndActivitySeq = null;
      }
      continue;
    }
    if (state.endSeq !== null && event.seq > state.endSeq) {
      state.postEndActivitySeq = Math.max(state.postEndActivitySeq ?? event.seq, event.seq);
    }
  }
  return state;
}

interface PlanCounter {
  completed: number;
  total: number;
}

function planCounter(event: SemanticProjectedEvent): PlanCounter | null {
  if (event.kind !== 'tool_call' || event.tool?.name !== 'update_plan' || event.tool.outcome !== 'ok') return null;
  const detail = event.tool.summary.detail;
  if (detail === undefined) return null;
  const match = PLAN_COUNTER.exec(detail);
  if (!match) return null;
  const completed = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isInteger(completed) || !Number.isInteger(total) || total < 1 || total > 12 || completed < 0 || completed > total) return null;
  return { completed, total };
}

function isSuccessfulMaterialMutation(event: SemanticProjectedEvent): boolean {
  return event.kind === 'tool_call'
    && event.tool?.outcome === 'ok'
    && MATERIAL_MUTATION.has(event.tool.summary.kind)
    && event.tool.changes.length > 0;
}

function isSuccessfulVerification(event: SemanticProjectedEvent): boolean {
  return event.kind === 'tool_call'
    && event.tool?.outcome === 'ok'
    && VERIFY_KIND.has(event.tool.summary.kind);
}

interface CandidateObservation {
  state: CheckpointState;
  candidate: CheckpointCandidate | null;
}

function observeCheckpointEvent(state: CheckpointState, event: SemanticProjectedEvent): CandidateObservation {
  if (state.checkpointSuppressed || state.count >= 2) return { state, candidate: null };
  const turnId = exactTurnId(event.turnId);
  if (turnId === null || turnId !== state.turnId) return { state, candidate: null };

  let next = { ...state };
  const counter = planCounter(event);
  if (counter !== null) {
    next.validPlanSeen = true;
    if (!next.midpointSeen && counter.total >= 3
        && counter.completed >= Math.ceil(counter.total / 2) && counter.completed < counter.total) {
      next.midpointSeen = true;
      if (next.lastCandidateSeq === event.seq) return { state: next, candidate: null };
      next.count = boundedCount(next.count + 1);
      next.lastCandidateSeq = event.seq;
      return { state: next, candidate: 'plan_midpoint' };
    }
    if (!next.completeSeen && counter.total >= 2 && counter.completed === counter.total) {
      next.completeSeen = true;
      if (next.lastCandidateSeq === event.seq) return { state: next, candidate: null };
      next.count = boundedCount(next.count + 1);
      next.lastCandidateSeq = event.seq;
      return { state: next, candidate: 'plan_complete' };
    }
    return { state: next, candidate: null };
  }

  if (isSuccessfulMaterialMutation(event)) {
    next.sawMaterialMutation = true;
    return { state: next, candidate: null };
  }
  if (!next.validPlanSeen && !next.fallbackSeen && next.sawMaterialMutation && isSuccessfulVerification(event)) {
    next.fallbackSeen = true;
    if (next.lastCandidateSeq === event.seq) return { state: next, candidate: null };
    next.count = boundedCount(next.count + 1);
    next.lastCandidateSeq = event.seq;
    return { state: next, candidate: 'material_verify' };
  }
  return { state: next, candidate: null };
}

function eventAtOrAfterCursor(event: SemanticProjectedEvent, cursor: number): boolean {
  return event.seq >= Math.max(0, cursor);
}

function returnDecision(
  wakeReason: SemanticWakeReason,
  checkpoint: CheckpointState,
  settle: TerminalSettleState,
  event?: SemanticProjectedEvent,
  checkpointKind?: CheckpointCandidate,
): SemanticWaitDecision {
  return {
    action: 'return',
    wakeReason,
    ...(event ? { eventSeq: event.seq } : {}),
    ...(checkpointKind ? { checkpointKind } : {}),
    ...(checkpointKind && event?.summary !== undefined ? { checkpointSummary: event.summary } : {}),
    checkpoint,
    settle,
  };
}

function terminalDecision(
  work: SemanticWorkState,
  caughtUp: boolean,
  checkpoint: CheckpointState,
  settle: TerminalSettleState,
): SemanticWaitDecision | null {
  if (settle.endSeq === null || settle.outcome === null) return null;
  if (settle.outcome === 'failed' || settle.outcome === 'stalled' || settle.outcome === 'stopped') {
    return returnDecision(settle.outcome, checkpoint, settle);
  }
  if (settle.outcome !== 'completed') {
    return {
      action: 'pending',
      phase: 'settling',
      settleReason: 'unclassified_terminal',
      checkpoint,
      settle,
    };
  }
  if (settle.finalSeq === null) {
    return { action: 'pending', phase: 'settling', settleReason: 'awaiting_final', checkpoint, settle };
  }
  if (settle.postEndActivitySeq !== null && settle.finalSeq < settle.postEndActivitySeq) {
    return { action: 'pending', phase: 'settling', settleReason: 'trailing_activity', checkpoint, settle };
  }
  if (work.state !== 'quiescent' || work.reasons.length > 0) {
    return { action: 'pending', phase: 'settling', settleReason: 'work_not_quiescent', checkpoint, settle };
  }
  if (!caughtUp) {
    return { action: 'pending', phase: 'settling', settleReason: 'not_caught_up', checkpoint, settle };
  }
  return returnDecision('completed', checkpoint, settle);
}

/**
 * Pure stable-cut classifier. The caller owns broker fencing, HTTP lifetime and exact-deadline
 * scheduling; this function consumes only bounded projected facts and returns a deterministic
 * semantic decision plus bounded process-local state.
 */
export function classifySemanticWait(input: SemanticClassifierInput): SemanticWaitDecision {
  const events = orderedEvents(input.events);
  let checkpoint = { ...input.checkpoint };
  const settle = observeTerminalEvidence(input.settle, events);

  if (input.mode === 'activity') {
    const next = events.find((event) => eventAtOrAfterCursor(event, input.cursor));
    return next
      ? returnDecision('activity', checkpoint, settle, next)
      : { action: 'pending', phase: 'waiting', checkpoint, settle };
  }

  if (input.work.state === 'blocked' || input.work.reasons.includes('blocked')) {
    return returnDecision('blocked', checkpoint, settle);
  }

  const blockingError = events.find((event) => event.kind === 'chat_error'
    && event.blocking === true
    && exactTurnId(event.turnId) !== null
    && eventAtOrAfterCursor(event, input.cursor)
    && !(event.recoverable === true && input.work.reasons.includes('recovery')));
  if (blockingError) return returnDecision('blocked', checkpoint, settle, blockingError);

  const terminal = terminalDecision(input.work, input.caughtUp, checkpoint, settle);
  if (terminal !== null) return terminal;

  if (input.checkpoint.checkpointSuppressed) {
    return { action: 'pending', phase: 'waiting', checkpoint, settle };
  }

  let returnCandidate: { event: SemanticProjectedEvent; kind: CheckpointCandidate } | null = null;
  for (const event of events) {
    const observed = observeCheckpointEvent(checkpoint, event);
    checkpoint = observed.state;
    if (observed.candidate === null) continue;
    if (input.mode === 'attention' && eventAtOrAfterCursor(event, input.cursor)) {
      returnCandidate = { event, kind: observed.candidate };
      break;
    }
  }

  if (returnCandidate !== null) {
    return returnDecision('checkpoint', checkpoint, settle, returnCandidate.event, returnCandidate.kind);
  }
  return { action: 'pending', phase: 'waiting', checkpoint, settle };
}
