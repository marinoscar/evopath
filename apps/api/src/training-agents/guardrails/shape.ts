import { PLAN_LIMITS, isRepsExercise, planTreeSchema, type PlanExercise, type PlanTree, type PlanWeek } from '../../programs/contracts/plan-tree.contract';
import { isCardioTrackingMode, prescriptionMismatch } from '../../programs/contracts/prescription';
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
//
// PRESCRIPTION SHAPE. Each exercise's prescription must fit its tracking
// mode (`programs/contracts/prescription.ts`): sets and reps for
// `weight_reps`/`bodyweight_reps`, a duration for `time`, a duration and/or
// distance for `distance_time`. A mismatch (or no prescription at all)
// blocks: the server does not guess minutes from reps or reps from minutes.
// A cardio target outside the plan bounds is clamped (a repair).
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

      for (const exercise of workout.exercises) {
        checkPrescriptionShape(f, ctx, week, workout, exercise);
        boundNumbers(f, ctx, week, workout, exercise);
      }
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
  // A cardio prescription's rest only matters between its sets: 0 stays 0.
  if (exercise.restSeconds < minRest && isRepsExercise(exercise)) {
    f.add('repair', 'rest_bounded', path, `Rest ${exercise.restSeconds} s raised to ${minRest} s.`);
    exercise.restSeconds = minRest;
  }
  if (isRepsExercise(exercise)) {
    if (exercise.repMin < 1) {
      f.add('repair', 'reps_bounded', path, `Minimum reps ${exercise.repMin} raised to 1.`);
      exercise.repMin = 1;
    }
    if (exercise.repMin > exercise.repMax) {
      f.add('repair', 'rep_range_swapped', path, `Rep range ${exercise.repMin}-${exercise.repMax} reordered.`);
      [exercise.repMin, exercise.repMax] = [exercise.repMax, exercise.repMin];
    }
  } else {
    boundCardioTargets(f, path, exercise);
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

/** The prescription's shape fits the exercise's tracking mode; a block otherwise. */
function checkPrescriptionShape(
  f: Findings,
  ctx: GuardrailContext,
  week: PlanWeek,
  workout: PlanWeek['workouts'][number],
  exercise: PlanExercise,
): void {
  const lib = ctx.library.get(exercise.exerciseId);
  if (!lib) return;
  const path = pathOf(ctx, week, workout, exercise);
  let cardio = exercise.targetDurationSeconds !== null || exercise.targetDistanceMeters !== null;
  const reps = exercise.repMin !== null || exercise.repMax !== null;
  if (cardio && reps) {
    // Both shapes at once: keep the one the tracking mode takes.
    if (isCardioTrackingMode(lib.trackingMode)) {
      f.add('repair', 'prescription_reps_cleared', path, `${lib.key} is tracked by time or distance: its reps were removed.`);
      exercise.repMin = null;
      exercise.repMax = null;
    } else {
      f.add('repair', 'prescription_targets_cleared', path, `${lib.key} is tracked in reps: its duration and distance targets were removed.`);
      exercise.targetDurationSeconds = null;
      exercise.targetDistanceMeters = null;
      cardio = false;
    }
  }
  if (!cardio && !isRepsExercise(exercise)) {
    f.add('block', 'prescription_missing', path, `${lib.key} has neither sets and reps nor a duration or distance.`);
    return;
  }
  const mismatch = prescriptionMismatch(lib.trackingMode, exercise);
  if (mismatch) f.add('block', 'prescription_shape_mismatch', path, `${lib.key} (tracked as ${lib.trackingMode}): ${mismatch}.`);
}

/** A cardio target inside the plan bounds (duration 1 min .. 10 h, distance 100 m .. 100 km, 2 decimals). */
function boundCardioTargets(f: Findings, path: string, exercise: PlanExercise): void {
  const d = PLAN_LIMITS.targetDurationSeconds;
  if (exercise.targetDurationSeconds !== null) {
    const bounded = Math.min(d.max, Math.max(d.min, Math.round(exercise.targetDurationSeconds)));
    if (bounded !== exercise.targetDurationSeconds) {
      f.add('repair', 'duration_bounded', path, `Duration ${exercise.targetDurationSeconds} s set to ${bounded} s.`);
      exercise.targetDurationSeconds = bounded;
    }
  }
  const m = PLAN_LIMITS.targetDistanceMeters;
  if (exercise.targetDistanceMeters !== null) {
    const bounded = Math.min(m.max, Math.max(m.min, Math.round(exercise.targetDistanceMeters * 100) / 100));
    if (bounded !== exercise.targetDistanceMeters) {
      f.add('repair', 'distance_bounded', path, `Distance ${exercise.targetDistanceMeters} m set to ${bounded} m.`);
      exercise.targetDistanceMeters = bounded;
    }
  }
  const sets = PLAN_LIMITS.targetSets;
  if (exercise.targetSets !== null && (exercise.targetSets < sets.min || exercise.targetSets > sets.max)) {
    const bounded = Math.min(sets.max, Math.max(sets.min, Math.round(exercise.targetSets)));
    f.add('repair', 'sets_bounded', path, `${exercise.targetSets} sets set to ${bounded}.`);
    exercise.targetSets = bounded;
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
