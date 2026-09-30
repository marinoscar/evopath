import type { PlanTree, PlanWeek } from '../../programs/contracts/plan-tree.contract';
import { reduceSessionSets } from './injury';
import { DURATION_MODEL, GUARDRAIL_LIMITS, effectiveLimits } from './limits';
import {
  Findings,
  WEEKDAY_NAMES,
  allowedWeekdays,
  countedMuscles,
  keyOf,
  pathOf,
  sessionSets,
  setsByMuscle,
  sortWeek,
  weeksOf,
  workoutLabel,
} from './tree';
import type { GuardrailContext, Violation } from './types';

// =============================================================================
// G4 Volume and intensity
// =============================================================================
//
// Per exercise: sets at most 6 (4 in conservative mode), reps 1..30, RPE at
// most the level cap (7 in conservative mode), rest 30..300 s. Per week:
// workouts at most `daysPerWeek` (surplus removed from the end of the week),
// weekdays inside the preferred weekdays (moved to a free preferred day),
// weekly hard sets per primary muscle clamped down to the level range.
// Per session: above the level's repair number trimmed.
//
// Blocks: a session still above the level's block number, or a muscle still
// above 25 weekly sets (both times 0.75 in conservative mode), after repair.
// Below the range for a goal muscle warns (never in a deload week).
// =============================================================================

export function checkVolume(tree: PlanTree, ctx: GuardrailContext): Violation[] {
  const f = new Findings('G4');
  const limits = effectiveLimits(ctx.experience, ctx.conservative);
  const L = GUARDRAIL_LIMITS;

  for (const { week } of weeksOf(tree)) {
    // Per exercise.
    for (const workout of week.workouts) {
      for (const exercise of workout.exercises) {
        const path = pathOf(ctx, week, workout, exercise);
        if (exercise.targetSets > limits.setsPerExercise) {
          f.add('repair', 'exercise_sets_clamped', path, `${exercise.targetSets} sets lowered to ${limits.setsPerExercise}.`);
          exercise.targetSets = limits.setsPerExercise;
        }
        const repMin = Math.min(L.reps.max, Math.max(L.reps.min, exercise.repMin));
        const repMax = Math.min(L.reps.max, Math.max(repMin, exercise.repMax));
        if (repMin !== exercise.repMin || repMax !== exercise.repMax) {
          f.add('repair', 'reps_clamped', path, `Reps ${exercise.repMin}-${exercise.repMax} set to ${repMin}-${repMax}.`);
          exercise.repMin = repMin;
          exercise.repMax = repMax;
        }
        if (exercise.targetRpe !== null && exercise.targetRpe > limits.rpeCap) {
          f.add('repair', 'rpe_clamped', path, `RPE ${exercise.targetRpe} lowered to ${limits.rpeCap} for this level.`);
          exercise.targetRpe = limits.rpeCap;
        }
        const rest = Math.min(L.restSeconds.max, Math.max(L.restSeconds.min, exercise.restSeconds));
        if (rest !== exercise.restSeconds) {
          f.add('repair', 'rest_clamped', path, `Rest ${exercise.restSeconds} s set to ${rest} s.`);
          exercise.restSeconds = rest;
        }
      }
    }

    trimWorkoutsPerWeek(f, ctx, week);
    moveToPreferredDays(f, ctx, week);

    // Per session.
    for (const workout of week.workouts) {
      const before = sessionSets(workout);
      if (before > limits.sessionSetsRepairAbove) {
        const done = reduceSessionSets(workout, limits.sessionSetsRepairAbove);
        const dropped = done.filter((d) => d.startsWith('drop:')).map((d) => keyOf(ctx, d.slice(5)));
        f.add(
          'repair',
          'session_sets_clamped',
          pathOf(ctx, week, workout),
          `${before} sets in one session lowered to ${sessionSets(workout)} (level cap ${limits.sessionSetsRepairAbove})` +
            (dropped.length ? `; removed ${dropped.join(', ')}.` : '.'),
        );
      }
      if (sessionSets(workout) > limits.sessionSetsBlockAbove) {
        f.add('block', 'session_sets_excessive', pathOf(ctx, week, workout), `${sessionSets(workout)} sets in one session is above ${limits.sessionSetsBlockAbove}.`);
      }
    }

    clampWeeklyMuscles(f, ctx, week, limits.weeklySetsMax);

    const totals = setsByMuscle(ctx, week.workouts, L.uncountedMuscles);
    for (const [muscle, sets] of [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (sets > limits.weeklyMuscleBlockAbove) {
        f.add('block', 'muscle_volume_excessive', `week ${week.weekNumber}`, `${sets} weekly sets for ${muscle} is above ${limits.weeklyMuscleBlockAbove}.`);
      } else if (sets > limits.weeklySetsMax) {
        f.add('warn', 'muscle_volume_high', `week ${week.weekNumber}`, `${sets} weekly sets for ${muscle} is above the ${limits.weeklySetsMax} range.`);
      }
    }
    if (!week.isDeload) {
      for (const muscle of L.goalMuscles[ctx.goal] ?? []) {
        const sets = totals.get(muscle) ?? 0;
        if (sets < limits.weeklySetsMin) {
          f.add('warn', 'muscle_volume_low', `week ${week.weekNumber}`, `${sets} weekly sets for ${muscle} is below the ${limits.weeklySetsMin} the goal needs.`);
        }
      }
    }
  }

  return f.list;
}

/** Workouts beyond `daysPerWeek` are removed from the end of the week. */
function trimWorkoutsPerWeek(f: Findings, ctx: GuardrailContext, week: PlanWeek): void {
  while (week.workouts.length > ctx.daysPerWeek) {
    const last = week.workouts[week.workouts.length - 1];
    week.workouts = week.workouts.slice(0, -1);
    f.add(
      'repair',
      'surplus_workout_removed',
      pathOf(ctx, week, last),
      `Removed ${workoutLabel(last)}: the plan has ${ctx.daysPerWeek} training days a week.`,
    );
  }
}

/** A workout on a day outside the preferred weekdays moves to a free preferred day (else warns). */
function moveToPreferredDays(f: Findings, ctx: GuardrailContext, week: PlanWeek): void {
  if (!ctx.preferredWeekdays) return;
  const allowed = allowedWeekdays(ctx);
  let moved = false;

  for (const workout of week.workouts) {
    if (workout.weekday != null && allowed.includes(workout.weekday)) continue;
    const used = new Set(week.workouts.map((w) => w.weekday).filter((d): d is number => d != null));
    const free = allowed.find((day) => !used.has(day));
    const from = workout.weekday ? WEEKDAY_NAMES[workout.weekday] : 'unscheduled';
    if (free === undefined) {
      f.add('warn', 'weekday_not_preferred', pathOf(ctx, week, workout), `${workoutLabel(workout)} is not on a preferred day and no preferred day is free.`);
      continue;
    }
    workout.weekday = free;
    moved = true;
    f.add('repair', 'weekday_moved', pathOf(ctx, week, workout), `The ${from} workout moved to ${WEEKDAY_NAMES[free]}, a preferred day.`);
  }

  if (moved) sortWeek(week);
}

/**
 * While a muscle is above `max` weekly sets: one set off the contributing
 * exercise with the most sets (accessories first, the later one first),
 * floor 2; when none can lose a set, drop the last contributing accessory
 * whose workout keeps another exercise.
 */
function clampWeeklyMuscles(f: Findings, ctx: GuardrailContext, week: PlanWeek, max: number): void {
  const uncounted = GUARDRAIL_LIMITS.uncountedMuscles;
  const floor = DURATION_MODEL.trim.setFloor;
  const changes = new Map<string, { from: number; touched: Set<string>; removed: Set<string> }>();
  const initial = setsByMuscle(ctx, week.workouts, uncounted);

  for (let guard = 0; guard < 1000; guard += 1) {
    const totals = setsByMuscle(ctx, week.workouts, uncounted);
    const over = [...totals.entries()].filter(([, sets]) => sets > max).sort(([a], [b]) => (a < b ? -1 : 1))[0];
    if (!over) break;
    const [muscle] = over;
    const change = changes.get(muscle) ?? { from: initial.get(muscle) ?? 0, touched: new Set<string>(), removed: new Set<string>() };
    changes.set(muscle, change);

    const contributing = week.workouts.flatMap((workout, w) =>
      workout.exercises
        .map((exercise, e) => ({ workout, exercise, w, e }))
        .filter(({ exercise }) => countedMuscles(ctx.library.get(exercise.exerciseId), uncounted).includes(muscle)),
    );
    const reducible = contributing
      .filter(({ exercise }) => exercise.targetSets > floor)
      .sort(
        (a, b) =>
          b.exercise.targetSets - a.exercise.targetSets ||
          Number(a.exercise.isPriority) - Number(b.exercise.isPriority) ||
          b.w - a.w ||
          b.e - a.e,
      );

    if (reducible.length > 0) {
      reducible[0].exercise.targetSets -= 1;
      change.touched.add(keyOf(ctx, reducible[0].exercise.exerciseId));
      continue;
    }

    const droppable = contributing
      .filter(({ workout, exercise }) => !exercise.isPriority && workout.exercises.length > 1)
      .sort((a, b) => b.w - a.w || b.e - a.e)[0];
    if (!droppable) break;
    droppable.workout.exercises = droppable.workout.exercises.filter((e) => e !== droppable.exercise);
    droppable.workout.exercises.forEach((e, i) => {
      e.position = i;
    });
    change.removed.add(keyOf(ctx, droppable.exercise.exerciseId));
  }

  const after = setsByMuscle(ctx, week.workouts, uncounted);
  for (const [muscle, change] of [...changes.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const parts = [
      change.touched.size ? `fewer sets on ${[...change.touched].sort().join(', ')}` : '',
      change.removed.size ? `removed ${[...change.removed].sort().join(', ')}` : '',
    ].filter(Boolean);
    f.add(
      'repair',
      'muscle_volume_clamped',
      `week ${week.weekNumber}`,
      `Weekly sets for ${muscle} lowered from ${change.from} to ${after.get(muscle) ?? 0} (range up to ${max}): ${parts.join('; ')}.`,
    );
  }
}
