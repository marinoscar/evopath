import type { PlanTree, PlanWeek, PlanWorkout } from '../../programs/contracts/plan-tree.contract';
import { GUARDRAIL_LIMITS, PROGRESSION_LIMITS } from './limits';
import { Findings, WEEKDAY_NAMES, allowedWeekdays, floorHalf, setsByMuscle, sortWeek, weeksOf } from './tree';
import type { GuardrailContext, Violation } from './types';

// =============================================================================
// G5 Recovery
// =============================================================================
//
// - No primary muscle trained with 6 or more hard sets on each of two
//   consecutive days: the later workout moves to another allowed free day
//   that removes the conflict (smallest such day), else a warning.
// - At least one rest day a week: seven workouts in a week warns.
// - Plans of 6 weeks or more: at most 5 non-deload weeks in a row; the 6th
//   is marked deload and gets the deload transform (sets x 0.6, minimum 2;
//   load x 0.9, or RPE minus 2 when there is no load).
// =============================================================================

/** The deload transform (P6), in place. */
export function applyDeloadTransform(week: PlanWeek): void {
  const d = PROGRESSION_LIMITS.deload;
  for (const workout of week.workouts) {
    for (const exercise of workout.exercises) {
      exercise.targetSets = Math.min(exercise.targetSets, Math.max(d.minSets, Math.round(exercise.targetSets * d.setsFactor)));
      if (exercise.targetLoadKg !== null) {
        exercise.targetLoadKg = floorHalf(exercise.targetLoadKg * d.loadFactor);
      } else if (exercise.targetRpe !== null) {
        exercise.targetRpe = Math.max(1, exercise.targetRpe - d.rpeDrop);
      }
    }
  }
}

/** Pairs of workouts on consecutive days sharing a muscle with at least `threshold` sets each. */
function conflicts(ctx: GuardrailContext, workouts: readonly PlanWorkout[]): Array<{ later: PlanWorkout; muscle: string }> {
  const threshold = GUARDRAIL_LIMITS.consecutiveDayHardSets;
  const out: Array<{ later: PlanWorkout; muscle: string }> = [];
  const scheduled = workouts.filter((w) => w.weekday != null).sort((a, b) => a.weekday! - b.weekday!);

  for (let i = 1; i < scheduled.length; i += 1) {
    const [a, b] = [scheduled[i - 1], scheduled[i]];
    if (b.weekday! - a.weekday! !== 1) continue;
    const setsA = setsByMuscle(ctx, [a], GUARDRAIL_LIMITS.uncountedMuscles);
    const setsB = setsByMuscle(ctx, [b], GUARDRAIL_LIMITS.uncountedMuscles);
    const muscle = [...setsA.keys()].sort().find((m) => (setsA.get(m) ?? 0) >= threshold && (setsB.get(m) ?? 0) >= threshold);
    if (muscle) out.push({ later: b, muscle });
  }
  return out;
}

export function checkRecovery(tree: PlanTree, ctx: GuardrailContext): Violation[] {
  const f = new Findings('G5');
  const allowed = allowedWeekdays(ctx);

  for (const { week } of weeksOf(tree)) {
    const unresolved = new Set<string>();
    for (let guard = 0; guard < 14; guard += 1) {
      const found = conflicts(ctx, week.workouts).find((c) => !unresolved.has(c.later.name + c.later.weekday));
      if (!found) break;

      const { later, muscle } = found;
      const from = later.weekday!;
      const used = new Set(week.workouts.map((w) => w.weekday).filter((d): d is number => d != null));
      const target = allowed.find((day) => {
        if (used.has(day)) return false;
        later.weekday = day;
        const ok = conflicts(ctx, week.workouts).length < conflicts(ctx, week.workouts.map((w) => (w === later ? { ...w, weekday: from } : w))).length;
        later.weekday = from;
        return ok;
      });

      if (target === undefined) {
        unresolved.add(later.name + later.weekday);
        f.add(
          'warn',
          'consecutive_days',
          `week ${week.weekNumber}`,
          `${muscle} gets ${GUARDRAIL_LIMITS.consecutiveDayHardSets} or more sets on consecutive days (${WEEKDAY_NAMES[from - 1] ?? ''} and ${WEEKDAY_NAMES[from]}), and no free day fixes it.`,
        );
        continue;
      }

      later.weekday = target;
      f.add(
        'repair',
        'consecutive_days_moved',
        `week ${week.weekNumber}`,
        `"${later.name}" moved from ${WEEKDAY_NAMES[from]} to ${WEEKDAY_NAMES[target]} so ${muscle} is not trained hard on consecutive days.`,
      );
      sortWeek(week);
    }

    if (week.workouts.length >= 7) {
      f.add('warn', 'no_rest_day', `week ${week.weekNumber}`, `Week ${week.weekNumber} has no rest day.`);
    }
  }

  const weeks = weeksOf(tree).map(({ week }) => week);
  if (weeks.length >= GUARDRAIL_LIMITS.deloadMinPlanWeeks) {
    let streak = 0;
    for (const week of weeks) {
      if (week.isDeload) {
        streak = 0;
        continue;
      }
      streak += 1;
      if (streak >= GUARDRAIL_LIMITS.deloadEveryWeeks) {
        week.isDeload = true;
        applyDeloadTransform(week);
        streak = 0;
        f.add(
          'repair',
          'deload_added',
          `week ${week.weekNumber}`,
          `Week ${week.weekNumber} made a deload week (fewer sets, lighter): plans need a deload at least every ${GUARDRAIL_LIMITS.deloadEveryWeeks} weeks.`,
        );
      }
    }
  }

  return f.list;
}
