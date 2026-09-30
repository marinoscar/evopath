import type {
  AdherenceWeek,
  LiftPerformance,
  MuscleVolume,
  PainSignal,
  PlanSignals,
  PlannedSessionSignal,
} from './plan-signals.contract';

// =============================================================================
// compactSignals: the plan signals sized for an agent prompt (E5.9)
// =============================================================================
//
// PURE. Keeps every total, streak and summary, the most recent `maxWeeks`
// weeks (adherence, frequency, per-muscle volume, planned sessions), the
// `maxMuscles` muscles with the most hard plus planned sets, and the
// `maxExercises` lifts that matter most: flagged lifts first (pain, a PR in
// range, a trend up or down), then by sessions. Everything else is dropped,
// and `dropped` says what. The order is fixed so two calls over the same
// signals produce the same text.
//
// Budget: `estimateTokens` (`ceil(chars / 4)`) stays under
// `COMPACT_TOKEN_BUDGET` for a 26-week user with the default caps (asserted
// by a fixture test).
// =============================================================================

export interface CompactOptions {
  maxExercises: number;
  maxWeeks: number;
  maxMuscles: number;
}

export const COMPACT_DEFAULTS: CompactOptions = { maxExercises: 12, maxWeeks: 8, maxMuscles: 12 };

/** The prompt budget the default caps are sized for. */
export const COMPACT_TOKEN_BUDGET = 6000;

export type CompactSession = Pick<PlannedSessionSignal, 'programWorkoutId' | 'name' | 'plannedFor' | 'status' | 'setsPlanned' | 'setsDone' | 'avgRpe'>;

export interface CompactSignals {
  range: PlanSignals['range'];
  asOf: string;
  programId: string | null;
  planVersion: number | null;
  weeksInRange: number;
  truncated: boolean;
  planChangedOn: string | null;
  adherence: {
    totals: PlanSignals['adherence']['totals'];
    missedStreak: number;
    completedStreak: number;
    weeks: AdherenceWeek[];
  };
  frequency: PlanSignals['frequency'];
  sessions: CompactSession[];
  volume: MuscleVolume[];
  performance: LiftPerformance[];
  effort: PlanSignals['effort'];
  pain: PainSignal[];
  readiness: PlanSignals['readiness'];
  body: PlanSignals['body'];
  dropped: {
    weeks: number;
    sessions: number;
    muscles: string[];
    exercises: string[];
    pain: string[];
  };
}

/** `ceil(chars / 4)` of the JSON text: the estimate the prompt budget is checked with. */
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function isFlagged(lift: LiftPerformance, pained: ReadonlySet<string>): boolean {
  return pained.has(lift.exerciseId) || lift.prInRange || lift.trend === 'up' || lift.trend === 'down';
}

export function compactSignals(signals: PlanSignals, options: Partial<CompactOptions> = {}): CompactSignals {
  const caps = { ...COMPACT_DEFAULTS, ...options };
  const maxWeeks = Math.max(0, Math.floor(caps.maxWeeks));
  const maxMuscles = Math.max(0, Math.floor(caps.maxMuscles));
  const maxExercises = Math.max(0, Math.floor(caps.maxExercises));

  const allWeeks = signals.adherence.weeks.map((week) => week.weekStart);
  const keptWeeks = new Set(maxWeeks > 0 ? allWeeks.slice(-maxWeeks) : []);
  const oldestKept = allWeeks.find((week) => keptWeeks.has(week)) ?? null;
  const inKeptWeeks = (date: string) => oldestKept !== null && date >= oldestKept;

  const sessions = signals.sessions.filter((session) => inKeptWeeks(session.plannedFor));

  const muscleScore = (row: MuscleVolume) => row.totalHardSets + row.weeks.reduce((sum, week) => sum + week.plannedSets, 0);
  const musclesRanked = [...signals.volume].sort((a, b) => muscleScore(b) - muscleScore(a) || (a.muscle < b.muscle ? -1 : 1));
  const keptMuscles = new Set(musclesRanked.slice(0, maxMuscles).map((row) => row.muscle));

  const pained = new Set(signals.pain.map((row) => row.exerciseId));
  const liftsRanked = [...signals.performance].sort(
    (a, b) => Number(isFlagged(b, pained)) - Number(isFlagged(a, pained)) || b.sessions - a.sessions || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const keptLifts = new Set(liftsRanked.slice(0, maxExercises).map((lift) => lift.exerciseId));
  const painKept = signals.pain.slice(0, maxExercises);

  return {
    range: signals.range,
    asOf: signals.asOf,
    programId: signals.programId,
    planVersion: signals.planVersion,
    weeksInRange: signals.weeksInRange,
    truncated: signals.truncated,
    planChangedOn: signals.planChangedOn,
    adherence: {
      totals: signals.adherence.totals,
      missedStreak: signals.adherence.missedStreak,
      completedStreak: signals.adherence.completedStreak,
      weeks: signals.adherence.weeks.filter((week) => keptWeeks.has(week.weekStart)),
    },
    frequency: {
      avgPerWeek: signals.frequency.avgPerWeek,
      perWeek: signals.frequency.perWeek.filter((week) => keptWeeks.has(week.weekStart)),
    },
    sessions: sessions.map(({ programWorkoutId, name, plannedFor, status, setsPlanned, setsDone, avgRpe }) => ({
      programWorkoutId,
      name,
      plannedFor,
      status,
      setsPlanned,
      setsDone,
      avgRpe,
    })),
    // Signal order is kept (muscles by name, lifts by sessions then name).
    volume: signals.volume
      .filter((row) => keptMuscles.has(row.muscle))
      .map((row) => ({ ...row, weeks: row.weeks.filter((week) => keptWeeks.has(week.weekStart)) })),
    performance: signals.performance.filter((lift) => keptLifts.has(lift.exerciseId)),
    effort: signals.effort,
    pain: painKept,
    readiness: signals.readiness,
    body: signals.body,
    dropped: {
      weeks: allWeeks.length - keptWeeks.size,
      sessions: signals.sessions.length - sessions.length,
      muscles: signals.volume.filter((row) => !keptMuscles.has(row.muscle)).map((row) => row.muscle),
      exercises: signals.performance.filter((lift) => !keptLifts.has(lift.exerciseId)).map((lift) => lift.slug),
      pain: signals.pain.slice(maxExercises).map((row) => row.slug),
    },
  };
}
