// =============================================================================
// Goal progress — pure counting, precedence, on-track and streak rules (#268)
// =============================================================================
//
// No Nest, no Prisma: days are `YYYY-MM-DD` strings (the user's LOCAL days;
// `activity_entries.occurred_on` is already local), so every rule here is
// testable without a database or a clock. `GoalProgressService` loads the rows
// and calls these.
//
// MATCHING (which entries a goal looks at):
//   metric `steps`          every entry carrying a `steps` value (any kind)
//   kind walk               entries of kind `walk`
//   kind run                entries of kind `run`
//   kind cardio_any         entries of kind `walk`, `run` or `cardio_any`
//   kind workout_any        entries of kind `workout_any` (the workout-derived
//                           one every completed workout gets, plus manual ones)
//   kind custom             entries of kind `custom`
// and, by metric, the entry must carry something to count: `sessions` needs
// `completed: true`, `minutes` a `durationSeconds`, `distance_m` a
// `distanceMeters`, `steps` a `steps`. Entries before the goal's `startsOn`
// never count.
//
// PRECEDENCE, per local day and goal: integration > workout > manual. Only the
// entries of the highest source present that day count; the others are
// `superseded`. So a manual "I did it" walk and a walk workout on the same day
// are ONE session, and a manual 6000 steps loses to an imported 8200.
//
// COUNTING, within the winning source of a day:
//   sessions   workout: distinct `workoutId` (a workout's derived walk and
//              cardio_any entries are one session); otherwise one per entry
//   minutes,   workout: per workout the largest value among its matching
//   distance   entries (its cardio_any entry already includes its walk), summed;
//              otherwise the sum. Minutes are floor(seconds / 60) over the
//              whole period, distance floor(meters).
//   steps      the MAX of the day (steps are daily totals); a week sums days
//
// ON TRACK: a hit period is on track. Otherwise `sessions`: remaining <=
// daysLeft (today included); volume: done >= target * elapsedFraction, where
// elapsedFraction is the share of the period's days fully BEFORE `date`
// (so Monday morning, or a day goal's own day, is on track at zero).
//
// STREAK: consecutive hit periods immediately before the current one, going
// back no further than the period holding `startsOn` and no further than the
// data the caller loaded (`dataFrom`). The current period never counts.
// =============================================================================

import { addDays } from '../check-ins/local-date';
import { weekStartOf } from '../programs/signals/aggregate-signals';
import type {
  ActivityKindValue,
  ActivitySourceValue,
  GoalActivityKind,
  GoalMetricValue,
  GoalPeriodValue,
} from './activity.constants';

export const SOURCE_RANK: Readonly<Record<ActivitySourceValue, number>> = Object.freeze({
  manual: 1,
  workout: 2,
  integration: 3,
});

export interface ProgressGoal {
  id: string;
  activityKind: GoalActivityKind;
  metric: GoalMetricValue;
  target: number;
  period: GoalPeriodValue;
  /** `YYYY-MM-DD`. */
  startsOn: string;
}

export interface ProgressEntry {
  id: string;
  /** Local day, `YYYY-MM-DD`. */
  occurredOn: string;
  activityKind: ActivityKindValue;
  completed: boolean;
  durationSeconds: number | null;
  steps: number | null;
  distanceMeters: number | null;
  source: ActivitySourceValue;
  workoutId: string | null;
}

export interface PeriodRange {
  start: string;
  end: string;
}

export interface PeriodTotal extends PeriodRange {
  done: number;
  target: number;
  hit: boolean;
}

export interface GoalEvaluation<E extends ProgressEntry = ProgressEntry> {
  goalId: string;
  periodStart: string;
  periodEnd: string;
  done: number;
  target: number;
  remaining: number;
  /** Days from `date` to the period end, `date` included (0 once the period is over). */
  daysLeft: number;
  /** Share of the period's days fully before `date`, 0..1. */
  elapsedFraction: number;
  onTrack: boolean;
  hit: boolean;
  streakPeriods: number;
  /** The period's matching entries, oldest day first, with the losers of each day's precedence flagged. */
  entries: Array<E & { superseded: boolean }>;
}

// -----------------------------------------------------------------------------
// Periods
// -----------------------------------------------------------------------------

/** The period of `period` kind holding `date`: its Monday..Sunday week, or the day itself. */
export function periodOf(period: GoalPeriodValue, date: string): PeriodRange {
  if (period === 'day') return { start: date, end: date };
  const start = weekStartOf(date);
  return { start, end: addDays(start, 6) };
}

/** The period just before `range`. */
export function previousPeriod(period: GoalPeriodValue, range: PeriodRange): PeriodRange {
  return periodOf(period, addDays(range.start, -1));
}

export function periodLengthDays(period: GoalPeriodValue): number {
  return period === 'day' ? 1 : 7;
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// -----------------------------------------------------------------------------
// Matching and counting
// -----------------------------------------------------------------------------

const KINDS_FOR_GOAL: Readonly<Record<GoalActivityKind, readonly ActivityKindValue[]>> = {
  walk: ['walk'],
  run: ['run'],
  cardio_any: ['walk', 'run', 'cardio_any'],
  workout_any: ['workout_any'],
  custom: ['custom'],
};

/** The raw value an entry contributes to a goal's metric (seconds for minutes), or null when it carries none. */
export function entryMetricValue(metric: GoalMetricValue, entry: ProgressEntry): number | null {
  switch (metric) {
    case 'sessions':
      return entry.completed ? 1 : null;
    case 'minutes':
      return entry.durationSeconds;
    case 'distance_m':
      return entry.distanceMeters;
    case 'steps':
      return entry.steps;
  }
}

/** True when `entry` counts toward `goal` at all (kind, value, not before `startsOn`). */
export function entryMatchesGoal(goal: ProgressGoal, entry: ProgressEntry): boolean {
  if (entry.occurredOn < goal.startsOn) return false;
  if (entryMetricValue(goal.metric, entry) === null) return false;
  if (goal.metric === 'steps') return true;
  return KINDS_FOR_GOAL[goal.activityKind].includes(entry.activityKind);
}

interface DayResult {
  /** Raw units: sessions, seconds, meters or steps. */
  value: number;
  superseded: Set<string>;
}

/** One local day of one goal: precedence, then counting. `entries` all match the goal and share a day. */
export function evaluateDay(metric: GoalMetricValue, entries: readonly ProgressEntry[]): DayResult {
  const superseded = new Set<string>();
  if (entries.length === 0) return { value: 0, superseded };

  const best = Math.max(...entries.map((entry) => SOURCE_RANK[entry.source]));
  const winners: ProgressEntry[] = [];
  for (const entry of entries) {
    if (SOURCE_RANK[entry.source] === best) winners.push(entry);
    else superseded.add(entry.id);
  }

  const valueOf = (entry: ProgressEntry) => entryMetricValue(metric, entry) ?? 0;

  if (metric === 'steps') {
    return { value: Math.max(...winners.map(valueOf)), superseded };
  }

  // Workout-derived rows: one workout is one session, and its largest
  // matching value (cardio_any includes the walk's) is its contribution.
  const perWorkout = new Map<string, number>();
  let value = 0;
  for (const entry of winners) {
    if (entry.source === 'workout' && entry.workoutId) {
      const contribution = metric === 'sessions' ? 1 : valueOf(entry);
      perWorkout.set(entry.workoutId, Math.max(perWorkout.get(entry.workoutId) ?? 0, contribution));
    } else {
      value += valueOf(entry);
    }
  }
  for (const contribution of perWorkout.values()) value += contribution;

  return { value, superseded };
}

/** Raw period total to the goal's unit: whole minutes, whole meters, sessions and steps as they are. */
export function toGoalUnits(metric: GoalMetricValue, raw: number): number {
  if (metric === 'minutes') return Math.floor(raw / 60);
  if (metric === 'distance_m') return Math.floor(raw);
  return raw;
}

/** Done in `range` for `goal`, plus the ids each day's precedence superseded. */
export function evaluatePeriod(
  goal: ProgressGoal,
  entries: readonly ProgressEntry[],
  range: PeriodRange,
): { done: number; superseded: Set<string>; matching: ProgressEntry[] } {
  const matching = entries
    .filter((entry) => entry.occurredOn >= range.start && entry.occurredOn <= range.end && entryMatchesGoal(goal, entry))
    .sort((a, b) => (a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : 0));

  const byDay = new Map<string, ProgressEntry[]>();
  for (const entry of matching) {
    const day = byDay.get(entry.occurredOn) ?? [];
    day.push(entry);
    byDay.set(entry.occurredOn, day);
  }

  const superseded = new Set<string>();
  let raw = 0;
  for (const dayEntries of byDay.values()) {
    const day = evaluateDay(goal.metric, dayEntries);
    raw += day.value;
    day.superseded.forEach((id) => superseded.add(id));
  }

  return { done: toGoalUnits(goal.metric, raw), superseded, matching };
}

// -----------------------------------------------------------------------------
// Whole-goal evaluation
// -----------------------------------------------------------------------------

export interface EvaluateOptions {
  /** The earliest day the caller loaded entries from; streaks stop at a period starting before it. */
  dataFrom?: string;
}

/** Consecutive hit periods immediately before `current`. */
export function streakBefore(
  goal: ProgressGoal,
  entries: readonly ProgressEntry[],
  current: PeriodRange,
  options: EvaluateOptions = {},
): number {
  let streak = 0;
  for (let range = previousPeriod(goal.period, current); ; range = previousPeriod(goal.period, range)) {
    if (range.end < goal.startsOn) break;
    if (options.dataFrom && range.start < options.dataFrom) break;
    if (evaluatePeriod(goal, entries, range).done < goal.target) break;
    streak += 1;
  }
  return streak;
}

/** Progress of `goal` in the period holding `date`, from `entries` (any range; filtered here). */
export function evaluateGoal<E extends ProgressEntry>(
  goal: ProgressGoal,
  entries: readonly E[],
  date: string,
  options: EvaluateOptions = {},
): GoalEvaluation<E> {
  const range = periodOf(goal.period, date);
  const { done, superseded, matching } = evaluatePeriod(goal, entries, range);
  const length = periodLengthDays(goal.period);
  const daysLeft = Math.max(0, Math.min(length, daysBetween(date, range.end) + 1));
  const elapsedFraction = Math.max(0, Math.min(1, daysBetween(range.start, date) / length));
  const remaining = Math.max(0, goal.target - done);
  const hit = done >= goal.target;
  const onTrack =
    hit || (goal.metric === 'sessions' ? remaining <= daysLeft : done >= goal.target * elapsedFraction);

  return {
    goalId: goal.id,
    periodStart: range.start,
    periodEnd: range.end,
    done,
    target: goal.target,
    remaining,
    daysLeft,
    elapsedFraction,
    onTrack,
    hit,
    streakPeriods: streakBefore(goal, entries, range, options),
    entries: (matching as E[]).map((entry) => ({ ...entry, superseded: superseded.has(entry.id) })),
  };
}

/**
 * Up to `limit` periods, newest first, starting with the one holding `date`
 * and ending at the period holding `startsOn` (or the loaded data's start).
 */
export function goalHistory(
  goal: ProgressGoal,
  entries: readonly ProgressEntry[],
  date: string,
  limit: number,
  options: EvaluateOptions = {},
): PeriodTotal[] {
  const periods: PeriodTotal[] = [];
  for (let range = periodOf(goal.period, date); periods.length < limit; range = previousPeriod(goal.period, range)) {
    if (range.end < goal.startsOn) break;
    if (options.dataFrom && range.end < options.dataFrom) break;
    const { done } = evaluatePeriod(goal, entries, range);
    periods.push({ start: range.start, end: range.end, done, target: goal.target, hit: done >= goal.target });
  }
  return periods;
}
