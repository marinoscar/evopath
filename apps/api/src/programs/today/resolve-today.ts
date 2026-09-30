import { addDays, isRealDate, toDbDate } from '../../check-ins/local-date';
import type { PlanTree, PlanWorkout } from '../contracts/plan-tree.contract';

// =============================================================================
// resolveToday: what the active plan asks for on one local day (E5.7)
// =============================================================================
//
// Pure: no Nest, no Prisma, no clock. `today` is the client's local calendar
// day (`YYYY-MM-DD`); the server never guesses it.
//
// THE OCCURRENCE RULE. Plan week N is the seven-day window
// `startDate + 7(N-1)` .. `startDate + 7N - 1`. A workout of week N occurs on
// the first date inside that window whose ISO weekday equals its `weekday`.
// A plan that starts on a Wednesday is therefore well defined: its Monday
// workouts fall on the following Mondays, inside the same plan week.
//
// Only the CURRENT week's workouts can be today's. A workout of an earlier
// week that was never done is not surfaced (missed sessions are the
// evaluator's concern). A rest day looks forward up to `NEXT_LOOKAHEAD_DAYS`
// days, across week boundaries, for the next occurrence.
// =============================================================================

/** How far a rest day looks ahead for the next session. */
export const NEXT_LOOKAHEAD_DAYS = 14;

export interface ResolverProgram {
  id: string;
  /** `YYYY-MM-DD`; null for a plan that was never activated. */
  startDate: string | null;
  status: string;
  /** The live tree (archived rows excluded); workouts carry their ids. */
  tree: PlanTree;
}

export interface ResolveTodayInput {
  program: ResolverProgram | null;
  today: string;
  /** Program workouts with at least one completed linked workout. */
  completedProgramWorkoutIds: ReadonlySet<string>;
  /** Called for data that breaks a plan invariant (two workouts on one date). */
  onWarning?: (message: string) => void;
}

export interface Occurrence {
  date: string;
  weekNumber: number;
  isDeload: boolean;
  programWorkout: PlanWorkout;
}

export type TodayResult =
  | { kind: 'no_program' }
  | { kind: 'not_started'; startsOn: string }
  | { kind: 'program_complete' }
  | {
      kind: 'workout';
      programWorkout: PlanWorkout;
      weekNumber: number;
      totalWeeks: number;
      isDeload: boolean;
      done: boolean;
    }
  | {
      kind: 'rest_day';
      weekNumber: number;
      totalWeeks: number;
      next: { date: string; programWorkout: PlanWorkout; weekNumber: number } | null;
    };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysFrom(from: string, to: string): number {
  return Math.round((toDbDate(to).getTime() - toDbDate(from).getTime()) / DAY_MS);
}

/** ISO weekday of a `YYYY-MM-DD` day: 1 (Monday) .. 7 (Sunday). */
export function isoWeekday(date: string): number {
  const day = toDbDate(date).getUTCDay();
  return day === 0 ? 7 : day;
}

interface WeekEntry {
  weekNumber: number;
  isDeload: boolean;
  workouts: PlanWorkout[];
}

function weeksOf(tree: PlanTree): Map<number, WeekEntry> {
  const weeks = new Map<number, WeekEntry>();
  for (const block of tree.blocks) {
    for (const week of block.weeks) {
      const entry = weeks.get(week.weekNumber) ?? { weekNumber: week.weekNumber, isDeload: false, workouts: [] };
      entry.isDeload ||= week.isDeload;
      entry.workouts.push(...week.workouts);
      weeks.set(week.weekNumber, entry);
    }
  }
  return weeks;
}

/** The date a workout with `weekday` occurs on inside week `weekNumber`'s window. */
export function occurrenceDate(startDate: string, weekNumber: number, weekday: number): string {
  const windowStart = addDays(startDate, 7 * (weekNumber - 1));
  const offset = (weekday - isoWeekday(windowStart) + 7) % 7;
  return addDays(windowStart, offset);
}

/** Every scheduled workout of `week`, with its date, ordered by date then position. */
function occurrencesOf(startDate: string, week: WeekEntry): Occurrence[] {
  return week.workouts
    .filter((workout) => workout.weekday != null)
    .map((workout) => ({
      date: occurrenceDate(startDate, week.weekNumber, workout.weekday!),
      weekNumber: week.weekNumber,
      isDeload: week.isDeload,
      programWorkout: workout,
    }))
    .sort((a, b) => (a.date === b.date ? a.programWorkout.position - b.programWorkout.position : a.date < b.date ? -1 : 1));
}

/** The number of plan weeks: the highest `weekNumber` (numbering is dense by contract). */
export function totalWeeksOf(tree: PlanTree): number {
  let max = 0;
  for (const block of tree.blocks) for (const week of block.weeks) max = Math.max(max, week.weekNumber);
  return max;
}

export function resolveToday(input: ResolveTodayInput): TodayResult {
  const { program, today, completedProgramWorkoutIds, onWarning } = input;
  if (!isRealDate(today)) throw new RangeError('today must be a real calendar date in YYYY-MM-DD format');

  if (!program || program.status !== 'active' || !program.startDate) return { kind: 'no_program' };

  const startDate = program.startDate;
  if (today < startDate) return { kind: 'not_started', startsOn: startDate };

  const totalWeeks = totalWeeksOf(program.tree);
  const weekNumber = Math.floor(daysFrom(startDate, today) / 7) + 1;
  if (weekNumber > totalWeeks) return { kind: 'program_complete' };

  const weeks = weeksOf(program.tree);
  const current = weeks.get(weekNumber);
  const todays = current ? occurrencesOf(startDate, current).filter((occurrence) => occurrence.date === today) : [];

  if (todays.length > 0) {
    if (todays.length > 1) {
      onWarning?.(
        `Program ${program.id}: ${todays.length} workouts occur on ${today} in week ${weekNumber}; using the lowest position`,
      );
    }
    const [chosen] = todays;
    return {
      kind: 'workout',
      programWorkout: chosen.programWorkout,
      weekNumber,
      totalWeeks,
      isDeload: chosen.isDeload,
      done: chosen.programWorkout.id != null && completedProgramWorkoutIds.has(chosen.programWorkout.id),
    };
  }

  // Look forward across week boundaries. 14 days span at most three windows.
  const horizon = addDays(today, NEXT_LOOKAHEAD_DAYS);
  let next: Occurrence | null = null;
  for (let number = weekNumber; number <= Math.min(totalWeeks, weekNumber + 2) && !next; number += 1) {
    const week = weeks.get(number);
    if (!week) continue;
    next = occurrencesOf(startDate, week).find((occurrence) => occurrence.date > today && occurrence.date <= horizon) ?? null;
  }

  return {
    kind: 'rest_day',
    weekNumber,
    totalWeeks,
    next: next ? { date: next.date, programWorkout: next.programWorkout, weekNumber: next.weekNumber } : null,
  };
}
