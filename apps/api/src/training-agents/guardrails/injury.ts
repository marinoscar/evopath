import type { PlanTree, PlanWorkout } from '../../programs/contracts/plan-tree.contract';
import { DURATION_MODEL, GUARDRAIL_LIMITS, LIMITATION_PATTERN_MAP } from './limits';
import { findSubstitutes, substituteInPlace } from './substitution';
import { Findings, keyOf, pathOf, sessionSets, weeksOf, workoutLabel } from './tree';
import type { GuardrailContext, Violation } from './types';

// =============================================================================
// G6 Injury and pain
// =============================================================================
//
// - An exercise on the avoid list or pain-flagged in the last 28 days never
//   appears: substituted within its pattern (the ladder) or removed.
// - Conservative mode caps: RPE at most 7, sets per exercise at most 4,
//   sets per session at most 22 (clamped).
// - A declared limitation area lists its higher-risk patterns
//   (`LIMITATION_PATTERN_MAP`); each such exercise is a WARNING the critic
//   must address. The library has no injury tags; this is a net, not a
//   judgement.
// =============================================================================

/**
 * Brings a workout down to `max` sets: one set off each accessory from the
 * last (floor 2), repeated; then accessories dropped from the end; then one
 * set off each priority lift (floor 2). Returns what it did, in order.
 */
export function reduceSessionSets(workout: PlanWorkout, max: number): string[] {
  const done: string[] = [];
  const floor = DURATION_MODEL.trim.setFloor;
  const over = () => sessionSets(workout) > max;

  const trimSets = (priority: boolean) => {
    let changed = true;
    while (over() && changed) {
      changed = false;
      for (const exercise of [...workout.exercises].reverse()) {
        if (!over()) break;
        if (exercise.isPriority !== priority || exercise.targetSets <= floor) continue;
        exercise.targetSets -= 1;
        done.push(`set:${exercise.exerciseId}`);
        changed = true;
      }
    }
  };

  trimSets(false);
  while (over()) {
    const accessories = workout.exercises.filter((e) => !e.isPriority);
    if (accessories.length === 0 || workout.exercises.length <= 1) break;
    const last = accessories[accessories.length - 1];
    workout.exercises = workout.exercises.filter((e) => e !== last);
    done.push(`drop:${last.exerciseId}`);
  }
  trimSets(true);
  workout.exercises.forEach((e, i) => {
    e.position = i;
  });
  return done;
}

export function checkInjury(tree: PlanTree, ctx: GuardrailContext): Violation[] {
  const f = new Findings('G6');
  const warned = new Set<string>();

  for (const { week } of weeksOf(tree)) {
    for (const workout of [...week.workouts]) {
      for (const exercise of [...workout.exercises]) {
        const lib = ctx.library.get(exercise.exerciseId);
        if (!lib) continue;
        const avoided = ctx.avoidExerciseKeys.has(lib.key);
        const painful = ctx.painFlagKeys.has(lib.key);
        if (!avoided && !painful) continue;

        const why = avoided ? 'it is on your avoid list' : 'you flagged pain on it in the last 4 weeks';
        const path = pathOf(ctx, week, workout, exercise);
        const [substitute] = findSubstitutes(lib, ctx, new Set(workout.exercises.map((e) => e.exerciseId)));

        if (substitute) {
          substituteInPlace(exercise, substitute);
          f.add('repair', avoided ? 'avoided_substituted' : 'pain_substituted', path, `Replaced "${lib.key}" with "${substitute.key}": ${why}.`);
        } else {
          workout.exercises = workout.exercises.filter((e) => e !== exercise);
          f.add('repair', avoided ? 'avoided_removed' : 'pain_removed', path, `Removed "${lib.key}": ${why}.`);
          if (exercise.isPriority) f.add('warn', 'priority_removed', path, `A main lift was removed and not replaced.`);
        }
      }

      if (workout.exercises.length === 0) {
        week.workouts = week.workouts.filter((w) => w !== workout);
        f.add('warn', 'empty_workout_dropped', pathOf(ctx, week, workout), `Removed ${workoutLabel(workout)}: every exercise in it was excluded.`);
        continue;
      }
      workout.exercises.forEach((e, i) => {
        e.position = i;
      });

      if (ctx.conservative) applyConservativeCaps(f, ctx, week, workout);
      warnLimitations(f, ctx, week, workout, warned);
    }
  }

  return f.list;
}

function applyConservativeCaps(f: Findings, ctx: GuardrailContext, week: PlanTree['blocks'][number]['weeks'][number], workout: PlanWorkout): void {
  const caps = GUARDRAIL_LIMITS.conservative;

  for (const exercise of workout.exercises) {
    const path = pathOf(ctx, week, workout, exercise);
    if (exercise.targetRpe !== null && exercise.targetRpe > caps.rpeCap) {
      f.add('repair', 'conservative_rpe', path, `RPE ${exercise.targetRpe} lowered to ${caps.rpeCap} (conservative mode).`);
      exercise.targetRpe = caps.rpeCap;
    }
    if (exercise.targetSets > caps.setsPerExercise) {
      f.add('repair', 'conservative_sets', path, `${exercise.targetSets} sets lowered to ${caps.setsPerExercise} (conservative mode).`);
      exercise.targetSets = caps.setsPerExercise;
    }
  }

  const before = sessionSets(workout);
  if (before > caps.sessionSets) {
    const done = reduceSessionSets(workout, caps.sessionSets);
    f.add(
      'repair',
      'conservative_session_sets',
      pathOf(ctx, week, workout),
      `${before} sets in the session lowered to ${sessionSets(workout)} (conservative mode, at most ${caps.sessionSets})` +
        (done.some((d) => d.startsWith('drop:')) ? `; removed ${done.filter((d) => d.startsWith('drop:')).map((d) => keyOf(ctx, d.slice(5))).join(', ')}.` : '.'),
    );
  }
}

/** One warning per (area, exercise) across the plan, at its first occurrence. */
function warnLimitations(
  f: Findings,
  ctx: GuardrailContext,
  week: PlanTree['blocks'][number]['weeks'][number],
  workout: PlanWorkout,
  warned: Set<string>,
): void {
  for (const area of ctx.limitationAreas) {
    const risk = LIMITATION_PATTERN_MAP[area];
    if (!risk) continue;
    for (const exercise of workout.exercises) {
      const lib = ctx.library.get(exercise.exerciseId);
      if (!lib) continue;
      if (warned.has(`${area}:${lib.key}`)) continue;
      if (risk.patterns.includes(lib.movementPattern) || (risk.keys && risk.keys.test(lib.key))) {
        warned.add(`${area}:${lib.key}`);
        f.add(
          'warn',
          'limitation_risk',
          pathOf(ctx, week, workout, exercise),
          `"${lib.key}" involves ${risk.label}, a higher-risk pattern for the declared ${area} limitation.`,
        );
      }
    }
  }
}
