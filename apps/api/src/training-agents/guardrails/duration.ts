import { isRepsExercise, type PlanExercise, type PlanTree, type PlanWorkout } from '../../programs/contracts/plan-tree.contract';
import { cardioRequested, isCardioOnlyWorkout, isCardioSlot } from './cardio';
import { DURATION_MODEL, GUARDRAIL_LIMITS } from './limits';
import { Findings, keyOf, pathOf, weeksOf, workoutLabel } from './tree';
import type { GuardrailContext, Violation } from './types';

// =============================================================================
// G3 Time: the duration model and the trim ladder
// =============================================================================
//
// Estimated minutes = warm-up 5 + for each exercise: setup 60 s + the work of
// each set `clamp(repMax x 3, 20, 60)` s + rest between sets (none after the
// last), rounded up. A rest of 0 counts as unset: 90 s for a priority lift,
// 60 s for an accessory. A cardio prescription takes setup 60 s + its target
// duration (else its distance at `cardioSecondsPerMeter`), plus rest between
// its sets when it has more than one. The trim ladder never changes a cardio
// prescription's sets (its target is the session total); it may drop it.
//
// A workout may take at most `minutesPerSession x 1.05`. Trim until it fits,
// stopping at the first step that does, each change a recorded repair:
//
//   T1 accessory rest down to 45 s
//   T2 one set off each accessory (floor 2), last exercise first
//   T3 drop accessories from the end, one at a time
//   T4 one set off each priority lift (floor 2), last first
//   T5 priority rest down to 75 s
//   T6 cannot fit: drop priority lifts from the end until one is left, at
//      2 sets, and warn
//
// While the intake asks for cardio (#265) the requested cardio has its own
// time: a cardio-only workout may take the cardio session length (else
// `minutesPerSession`) plus warm-up and setup; a strength workout that also
// holds cardio gets the cardio's own minutes on top of `minutesPerSession`.
// =============================================================================

const M = DURATION_MODEL;

function restOf(exercise: PlanExercise): number {
  if (exercise.restSeconds > 0) return exercise.restSeconds;
  return exercise.isPriority ? M.defaultRestSeconds.priority : M.defaultRestSeconds.accessory;
}

/** Seconds one exercise takes. */
export function exerciseSeconds(exercise: PlanExercise): number {
  if (!isRepsExercise(exercise)) {
    const work = exercise.targetDurationSeconds ?? Math.round((exercise.targetDistanceMeters ?? 0) * M.cardioSecondsPerMeter);
    const sets = exercise.targetSets ?? 1;
    return M.setupSeconds + work + Math.max(0, sets - 1) * restOf(exercise);
  }
  const work = Math.min(M.setWorkSeconds.max, Math.max(M.setWorkSeconds.min, exercise.repMax * M.secondsPerRep));
  return M.setupSeconds + exercise.targetSets * work + Math.max(0, exercise.targetSets - 1) * restOf(exercise);
}

/** Estimated minutes of a workout (the duration model). */
export function estimateMinutes(workout: Pick<PlanWorkout, 'exercises'>): number {
  const seconds = M.warmupMinutes * 60 + workout.exercises.reduce((sum, e) => sum + exerciseSeconds(e), 0);
  return Math.ceil(seconds / 60 - 1e-9);
}

export interface TrimStep {
  step: 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6';
  exerciseId: string;
  action: string;
}

/**
 * Trims `workout` in place until it fits `budgetMinutes`, following T1..T6.
 * Returns every change made, in order, and whether it fits at the end.
 */
export function trimToFit(workout: PlanWorkout, budgetMinutes: number): { steps: TrimStep[]; fits: boolean } {
  const steps: TrimStep[] = [];
  const fits = () => estimateMinutes(workout) <= budgetMinutes;
  const floor = M.trim.setFloor;
  const reversed = () => [...workout.exercises].reverse();

  if (fits()) return { steps, fits: true };

  // T1
  for (const exercise of workout.exercises) {
    if (exercise.isPriority || restOf(exercise) <= M.trim.accessoryRestSeconds) continue;
    steps.push({ step: 'T1', exerciseId: exercise.exerciseId, action: `rest ${restOf(exercise)} s to ${M.trim.accessoryRestSeconds} s` });
    exercise.restSeconds = M.trim.accessoryRestSeconds;
  }
  if (fits()) return { steps, fits: true };

  // T2
  for (const exercise of reversed()) {
    if (exercise.isPriority || !isRepsExercise(exercise) || exercise.targetSets <= floor) continue;
    exercise.targetSets -= 1;
    steps.push({ step: 'T2', exerciseId: exercise.exerciseId, action: `one set removed (${exercise.targetSets} left)` });
    if (fits()) return { steps, fits: true };
  }

  // T3
  for (const exercise of reversed()) {
    if (exercise.isPriority || workout.exercises.length <= 1) continue;
    workout.exercises = workout.exercises.filter((e) => e !== exercise);
    steps.push({ step: 'T3', exerciseId: exercise.exerciseId, action: 'accessory removed' });
    if (fits()) break;
  }
  workout.exercises.forEach((e, i) => {
    e.position = i;
  });
  if (fits()) return { steps, fits: true };

  // T4
  for (const exercise of reversed()) {
    if (!exercise.isPriority || !isRepsExercise(exercise) || exercise.targetSets <= floor) continue;
    exercise.targetSets -= 1;
    steps.push({ step: 'T4', exerciseId: exercise.exerciseId, action: `one set removed (${exercise.targetSets} left)` });
    if (fits()) return { steps, fits: true };
  }

  // T5
  for (const exercise of workout.exercises) {
    if (!exercise.isPriority || restOf(exercise) <= M.trim.priorityRestSeconds) continue;
    steps.push({ step: 'T5', exerciseId: exercise.exerciseId, action: `rest ${restOf(exercise)} s to ${M.trim.priorityRestSeconds} s` });
    exercise.restSeconds = M.trim.priorityRestSeconds;
  }
  if (fits()) return { steps, fits: true };

  // T6
  for (const exercise of reversed()) {
    if (workout.exercises.length <= 1 || fits()) break;
    workout.exercises = workout.exercises.filter((e) => e !== exercise);
    steps.push({ step: 'T6', exerciseId: exercise.exerciseId, action: 'removed to fit the time' });
  }
  const [only] = workout.exercises;
  if (!fits() && workout.exercises.length === 1 && isRepsExercise(only) && only.targetSets > floor) {
    steps.push({ step: 'T6', exerciseId: only.exerciseId, action: `sets ${only.targetSets} to ${floor}` });
    only.targetSets = floor;
  }
  workout.exercises.forEach((e, i) => {
    e.position = i;
  });

  return { steps, fits: fits() };
}

/** The minutes a workout may take (before the tolerance) and how they read in a message. */
export function sessionBudget(ctx: GuardrailContext, workout: PlanWorkout): { minutes: number; label: number } {
  if (!cardioRequested(ctx)) return { minutes: ctx.minutesPerSession, label: ctx.minutesPerSession };
  if (isCardioOnlyWorkout(ctx, workout)) {
    const session = ctx.cardio?.minutesPerSession ?? ctx.minutesPerSession;
    const overhead = M.warmupMinutes + (workout.exercises.length * M.setupSeconds) / 60;
    return { minutes: session + overhead, label: session };
  }
  const cardioSeconds = workout.exercises.filter((e) => isCardioSlot(ctx.library.get(e.exerciseId), e)).reduce((sum, e) => sum + exerciseSeconds(e), 0);
  const minutes = ctx.minutesPerSession + cardioSeconds / 60;
  return { minutes, label: Math.ceil(minutes - 1e-9) };
}

export function checkTime(tree: PlanTree, ctx: GuardrailContext): Violation[] {
  const f = new Findings('G3');

  for (const { week } of weeksOf(tree)) {
    for (const workout of week.workouts) {
      const before = estimateMinutes(workout);
      const allowed = sessionBudget(ctx, workout);
      const budget = allowed.minutes * GUARDRAIL_LIMITS.timeTolerance;
      const { steps, fits } = trimToFit(workout, budget);

      for (const step of steps) {
        f.add(
          'repair',
          `trim_${step.step.toLowerCase()}`,
          `${pathOf(ctx, week, workout)} > ${keyOf(ctx, step.exerciseId)}`,
          `${step.step}: ${keyOf(ctx, step.exerciseId)} ${step.action} to fit ${allowed.label} minutes (was about ${before}).`,
        );
      }
      if (!fits) {
        f.add(
          'warn',
          'time_unfit',
          pathOf(ctx, week, workout),
          `${workoutLabel(workout)} still takes about ${estimateMinutes(workout)} minutes, over the ${allowed.label} available.`,
        );
      }
      workout.estimatedMinutes = estimateMinutes(workout);
    }
  }

  return f.list;
}
