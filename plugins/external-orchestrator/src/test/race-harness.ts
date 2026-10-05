import { RACE_SCHEDULE_COUNT } from './benchmark-harness.js';

export type FrozenRaceFamilyName =
  | 'snapshot_register_publish'
  | 'abort_publish'
  | 'restart_wake'
  | 'rebind_read'
  | 'final_trailing_tool'
  | 'cancel_stop'
  | 'controller_post';

export interface RaceLane {
  actor: string;
  steps: readonly string[];
}

export interface FrozenRaceFamily {
  name: FrozenRaceFamilyName;
  lanes: readonly RaceLane[];
}

export interface ScheduledRaceStep {
  family: FrozenRaceFamilyName;
  scheduleIndex: number;
  actor: string;
  actorStep: number;
  label: string;
}

export interface DeterministicRaceSchedule {
  family: FrozenRaceFamilyName;
  index: number;
  steps: readonly ScheduledRaceStep[];
}

export const FROZEN_RACE_FAMILIES: readonly FrozenRaceFamily[] = [
  {
    name: 'snapshot_register_publish',
    lanes: [
      { actor: 'waiter', steps: ['snapshot', 'register', 'recheck'] },
      { actor: 'publisher', steps: ['publish'] },
    ],
  },
  {
    name: 'abort_publish',
    lanes: [
      { actor: 'waiter', steps: ['register', 'abort'] },
      { actor: 'publisher', steps: ['publish'] },
    ],
  },
  {
    name: 'restart_wake',
    lanes: [
      { actor: 'waiter', steps: ['arm', 'observe_wake'] },
      { actor: 'broker', steps: ['restart', 'publish'] },
    ],
  },
  {
    name: 'rebind_read',
    lanes: [
      { actor: 'reader', steps: ['snapshot_a', 'revalidate_b', 'read_b'] },
      { actor: 'session', steps: ['rebind_a_to_b'] },
    ],
  },
  {
    name: 'final_trailing_tool',
    lanes: [
      { actor: 'assistant', steps: ['final'] },
      { actor: 'turn', steps: ['turn_end'] },
      { actor: 'tool', steps: ['trailing_tool'] },
    ],
  },
  {
    name: 'cancel_stop',
    lanes: [
      { actor: 'input', steps: ['pending_cancel'] },
      { actor: 'turn', steps: ['exact_turn_stop'] },
    ],
  },
  {
    name: 'controller_post',
    lanes: [
      { actor: 'mutation', steps: ['preflight', 'controller_fence', 'post'] },
      { actor: 'controller', steps: ['handoff'] },
    ],
  },
] as const;

function nextRandom(value: number): number {
  let state = value >>> 0;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

function seedFor(scheduleIndex: number, familyOrdinal: number): number {
  const mixed = (0x9e3779b9 ^ Math.imul(scheduleIndex + 1, 0x85ebca6b) ^ Math.imul(familyOrdinal + 1, 0xc2b2ae35)) >>> 0;
  return mixed === 0 ? 0xa341316c : mixed;
}

export function deterministicRaceSchedule(
  family: FrozenRaceFamily,
  scheduleIndex: number,
  familyOrdinal = FROZEN_RACE_FAMILIES.findIndex((candidate) => candidate.name === family.name),
): DeterministicRaceSchedule {
  if (!Number.isSafeInteger(scheduleIndex) || scheduleIndex < 0) throw new Error('race schedule index must be a non-negative safe integer');
  const positions = family.lanes.map(() => 0);
  const totalSteps = family.lanes.reduce((sum, lane) => sum + lane.steps.length, 0);
  const steps: ScheduledRaceStep[] = [];
  let random = seedFor(scheduleIndex, Math.max(0, familyOrdinal));

  while (steps.length < totalSteps) {
    const available: number[] = [];
    for (let laneIndex = 0; laneIndex < family.lanes.length; laneIndex += 1) {
      const lane = family.lanes[laneIndex];
      const position = positions[laneIndex];
      if (lane !== undefined && position !== undefined && position < lane.steps.length) available.push(laneIndex);
    }
    if (available.length === 0) throw new Error(`race family ${family.name} has inconsistent lane accounting`);
    random = nextRandom(random);
    const selectedIndex = available[random % available.length];
    if (selectedIndex === undefined) throw new Error('race scheduler selected no lane');
    const lane = family.lanes[selectedIndex];
    const actorStep = positions[selectedIndex];
    if (lane === undefined || actorStep === undefined) throw new Error('race scheduler lane disappeared');
    const label = lane.steps[actorStep];
    if (label === undefined) throw new Error('race scheduler step disappeared');
    steps.push({ family: family.name, scheduleIndex, actor: lane.actor, actorStep, label });
    positions[selectedIndex] = actorStep + 1;
  }

  return { family: family.name, index: scheduleIndex, steps };
}

export function* frozenRaceMatrix(count = RACE_SCHEDULE_COUNT): Generator<DeterministicRaceSchedule> {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('race schedule count must be a positive safe integer');
  for (let index = 0; index < count; index += 1) {
    const familyOrdinal = index % FROZEN_RACE_FAMILIES.length;
    const family = FROZEN_RACE_FAMILIES[familyOrdinal];
    if (family === undefined) throw new Error('frozen race family disappeared');
    yield deterministicRaceSchedule(family, index, familyOrdinal);
  }
}

export function* familyRaceMatrix(family: FrozenRaceFamily, count = RACE_SCHEDULE_COUNT): Generator<DeterministicRaceSchedule> {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('race schedule count must be a positive safe integer');
  const familyOrdinal = FROZEN_RACE_FAMILIES.findIndex((candidate) => candidate.name === family.name);
  for (let index = 0; index < count; index += 1) yield deterministicRaceSchedule(family, index, familyOrdinal);
}

/** Adapter seam for the real broker/service race suite once those production APIs are integrated. */
export interface FrozenRaceAdapter {
  begin(schedule: DeterministicRaceSchedule): void | Promise<void>;
  step(step: ScheduledRaceStep, schedule: DeterministicRaceSchedule): void | Promise<void>;
  verify(schedule: DeterministicRaceSchedule): void | Promise<void>;
}

export async function runFrozenRaceMatrix(adapter: FrozenRaceAdapter, count = RACE_SCHEDULE_COUNT): Promise<void> {
  for (const schedule of frozenRaceMatrix(count)) {
    await adapter.begin(schedule);
    for (const step of schedule.steps) await adapter.step(step, schedule);
    await adapter.verify(schedule);
  }
}
