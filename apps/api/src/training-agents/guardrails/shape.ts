import { planTreeSchema, type PlanTree, type PlanWeek } from '../../programs/contracts/plan-tree.contract';
import { GUARDRAIL_LIMITS } from './limits';
import { Findings, WEEKDAY_NAMES, allowedWeekdays, keyOf, pathOf, sortWeek, weeksOf, workoutLabel } from './tree';
import type { GuardrailContext, Violation } from './types';

// =============================================================================
// G1 Shape
// =============================================================================
//
// Every exercise must exist in the library (a compiled draft marks an unknown
// key as `unknown:<key>`), weekdays are unique per week, week numbers run
// 1..n without gaps, every week has a workout, numbers sit inside the plan
// schema's bounds, and the tree parses with the strict `planTreeSchema`.
//
// Repairs: drop unknown exercises, drop empty workouts, move a duplicate
// weekday to a free (preferred first) day, renumber weeks, bring numbers into
// schema bounds. Blocks: a week left without workouts, a workout left with
// fewer than 2 exercises by these drops, and anything the schema still
// refuses.
// =============================================================================

const RPE = { min: 1, max: 10 };
// Raised here, before G3 times the workout, so no later rule makes a workout longer.
const GUARDRAIL_LIMITS_REST_MIN = GUARDRAIL_LIMITS.restSeconds.min;

/** Moves duplicate weekdays to free days (preferred first, then any). Returns the moves. */
export function dedupeWeekdays(week: PlanWeek, ctx: GuardrailContext): Array<{ from: number; to: number | null }> {
  const moves: Array<{ from: number; to: number | null }> = [];
  const used = new Set<number>();
  const allowed = allowedWeekdays(ctx);

  for (const workout of week.workouts) {
    if (workout.weekday == null) continue;
    if (!used.has(workout.weekday)) {
      used.add(workout.weekday);
      continue;
    }
    const from = workout.weekday;
    const free = [...allowed, 1, 2, 3, 4, 5, 6, 7].find((day) => !used.has(day)) ?? null;
    workout.weekday = free;
    if (free !== null) used.add(free);
    moves.push({ from, to: free });
  }

  if (moves.length > 0) sortWeek(week);
  return moves;
}

export function checkShape(tree: PlanTree, ctx: GuardrailContext): Violation[] {
  const f = new Findings('G1');

  // Week numbers: 1..n in program order.
  weeksOf(tree).forEach(({ week }, index) => {
    if (week.weekNumber !== index + 1) {
      f.add('repair', 'week_renumbered', `week ${week.weekNumber}`, `Week ${week.weekNumber} renumbered to ${index + 1} so weeks run without gaps.`);
      week.weekNumber = index + 1;
    }
  });

  for (const { week } of weeksOf(tree)) {
    for (const workout of [...week.workouts]) {
      const before = workout.exercises.length;
      workout.exercises = workout.exercises.filter((exercise) => {
        if (ctx.library.has(exercise.exerciseId)) return true;
        f.add(
          'repair',
          'unknown_exercise',
          pathOf(ctx, week, workout, exercise),
          `Removed "${keyOf(ctx, exercise.exerciseId)}": it is not in the exercise library.`,
        );
        return false;
      });
      const dropped = before - workout.exercises.length;

      if (workout.exercises.length === 0) {
        week.workouts = week.workouts.filter((w) => w !== workout);
        f.add('repair', 'empty_workout_dropped', pathOf(ctx, week, workout), `Removed ${workoutLabel(workout)}: it has no exercises.`);
      } else if (dropped > 0 && workout.exercises.length < GUARDRAIL_LIMITS.minExercisesAfterDrops) {
        f.add(
          'block',
          'workout_too_small',
          pathOf(ctx, week, workout),
          `${workoutLabel(workout)} has fewer than ${GUARDRAIL_LIMITS.minExercisesAfterDrops} exercises after unknown exercises were removed.`,
        );
      }

      for (const exercise of workout.exercises) boundNumbers(f, ctx, week, workout, exercise);
    }

    for (const move of dedupeWeekdays(week, ctx)) {
      f.add(
        'repair',
        'duplicate_weekday',
        `week ${week.weekNumber}`,
        move.to === null
          ? `A second workout on ${WEEKDAY_NAMES[move.from]} was left unscheduled (no free day).`
          : `A second workout on ${WEEKDAY_NAMES[move.from]} moved to ${WEEKDAY_NAMES[move.to]}.`,
      );
    }
    sortWeek(week);
  }

  f.list.push(...checkWeeksNotEmpty(tree));
  return f.list;
}

/** Numbers inside the plan schema's bounds (the level caps come later, in G4). */
function boundNumbers(
  f: Findings,
  ctx: GuardrailContext,
  week: PlanWeek,
  workout: PlanWeek['workouts'][number],
  exercise: PlanWeek['workouts'][number]['exercises'][number],
): void {
  const path = pathOf(ctx, week, workout, exercise);
  const minRest = GUARDRAIL_LIMITS_REST_MIN;
  if (exercise.restSeconds < minRest) {
    f.add('repair', 'rest_bounded', path, `Rest ${exercise.restSeconds} s raised to ${minRest} s.`);
    exercise.restSeconds = minRest;
  }
  if (exercise.repMin < 1) {
    f.add('repair', 'reps_bounded', path, `Minimum reps ${exercise.repMin} raised to 1.`);
    exercise.repMin = 1;
  }
  if (exercise.repMin > exercise.repMax) {
    f.add('repair', 'rep_range_swapped', path, `Rep range ${exercise.repMin}-${exercise.repMax} reordered.`);
    [exercise.repMin, exercise.repMax] = [exercise.repMax, exercise.repMin];
  }
  if (exercise.targetRpe !== null) {
    const bounded = Math.min(RPE.max, Math.max(RPE.min, Math.round(exercise.targetRpe * 2) / 2));
    if (bounded !== exercise.targetRpe) {
      f.add('repair', 'rpe_bounded', path, `RPE ${exercise.targetRpe} set to ${bounded} (RPE runs 1 to 10 in half steps).`);
      exercise.targetRpe = bounded;
    }
  }
  if (exercise.targetLoadKg !== null && (exercise.targetLoadKg < 0 || exercise.targetLoadKg > 1000 || !Number.isFinite(exercise.targetLoadKg))) {
    f.add('repair', 'load_out_of_range', path, `Load ${exercise.targetLoadKg} kg is out of range and was removed.`);
    exercise.targetLoadKg = null;
  }
}

/** Every week needs a workout: a block otherwise. */
export function checkWeeksNotEmpty(tree: PlanTree): Violation[] {
  const f = new Findings('G1');
  for (const { week } of weeksOf(tree)) {
    if (week.workouts.length === 0) {
      f.add('block', 'empty_week', `week ${week.weekNumber}`, `Week ${week.weekNumber} has no workouts left.`);
    }
  }
  return f.list;
}

/** The final strict parse: anything the schema refuses blocks. */
export function checkSchema(tree: PlanTree): Violation[] {
  const f = new Findings('G1');
  const parsed = planTreeSchema.safeParse(tree);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 10)) {
      f.add('block', 'invalid_plan', issue.path.join('.') || 'plan', `The plan is not valid: ${issue.message}.`);
    }
  }
  return f.list;
}
