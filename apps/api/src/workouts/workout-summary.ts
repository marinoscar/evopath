import { Prisma } from '@prisma/client';

import { addDays, toDbDate } from '../check-ins/local-date';
import { WORKOUT_SUMMARY_TOP_LIFTS, type WorkoutSummaryTopLiftData } from './dto/workout-summary.dto';

// =============================================================================
// GET /api/workouts/summary (E4.6) — pure rules
// =============================================================================
//
// Days are `YYYY-MM-DD` strings, as in `check-ins/local-date.ts`. No Nest or
// Prisma client imports (the Decimal type only).
// =============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Monday of the ISO week containing `date` (a Sunday belongs to the week that began six days earlier). */
export function isoWeekStart(date: string): string {
  const weekday = toDbDate(date).getUTCDay(); // 0 = Sunday .. 6 = Saturday
  return addDays(date, -((weekday + 6) % 7));
}

/** Whole calendar days from `from` to `to` (negative when `from` is later). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toDbDate(to).getTime() - toDbDate(from).getTime()) / DAY_MS);
}

/** The fields `topLifts` reads from a workout's exercises and sets. */
export interface TopLiftEntry {
  exercise: { name: string };
  sets: ReadonlyArray<{
    setNumber: number;
    weightKg: Prisma.Decimal | number | null;
    reps: number | null;
    completed: boolean;
    isWarmup: boolean;
  }>;
}

/**
 * Per exercise, the heaviest completed working set with a weight above 0 and
 * at least one rep (more reps, then the lower set number, on a tie); the
 * heaviest {@link WORKOUT_SUMMARY_TOP_LIFTS} of those, heaviest first, the
 * earlier exercise on a tie. `entries` are in workout (position) order.
 */
export function topLifts(entries: readonly TopLiftEntry[]): WorkoutSummaryTopLiftData[] {
  const best: Array<{ exerciseName: string; weight: Prisma.Decimal; reps: number; order: number }> = [];

  entries.forEach((entry, order) => {
    let top: { weight: Prisma.Decimal; reps: number; setNumber: number } | null = null;

    for (const set of entry.sets) {
      if (!set.completed || set.isWarmup || set.weightKg === null || set.reps === null || set.reps < 1) continue;
      const weight = new Prisma.Decimal(set.weightKg);
      if (weight.lte(0)) continue;

      const better =
        top === null ||
        weight.gt(top.weight) ||
        (weight.eq(top.weight) && (set.reps > top.reps || (set.reps === top.reps && set.setNumber < top.setNumber)));
      if (better) top = { weight, reps: set.reps, setNumber: set.setNumber };
    }

    if (top) best.push({ exerciseName: entry.exercise.name, weight: top.weight, reps: top.reps, order });
  });

  return best
    .sort((x, y) => y.weight.comparedTo(x.weight) || x.order - y.order)
    .slice(0, WORKOUT_SUMMARY_TOP_LIFTS)
    .map(({ exerciseName, weight, reps }) => ({ exerciseName, weightKg: weight.toNumber(), reps }));
}
