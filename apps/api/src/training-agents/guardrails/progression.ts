import type { PlanExercise, PlanTree } from '../../programs/contracts/plan-tree.contract';
import type { ExerciseHistoryFacts, LibraryExercise } from '../context/planner-context.contract';
import { GUARDRAIL_LIMITS, PROGRESSION_LIMITS } from './limits';
import { Findings, floorHalf, pathOf, setsByMuscle, slotsOf, weeksOf } from './tree';
import type { GuardrailContext, Violation } from './types';

// =============================================================================
// G7 Progression: bounds on explicit loads between exposures (validators)
// =============================================================================
//
// Between consecutive non-deload exposures of an exercise the load rises by
// at most the implement's step (barbell 2.5 kg; dumbbell, machine and cable
// 2 kg; isolation 1 kg; bodyweight and band none: reps only) and never more
// than 10 percent of the last load; limits round down to 0.5 kg. Against the
// user's history, the first exposure with a load also obeys:
//
//   P3 a pain flag on the exercise: no increase over the last load
//   P4 a set below `repMin` on the last exposure: no increase
//   P5 a gap of more than 14 days: at most 90 percent of the last load
//
// P6 a deload week: sets at most `max(2, round(0.6 x reference))` and either
// load at most 0.9 x reference or RPE at most reference minus 2 (the
// reference is the last non-deload exposure); and never a load above the
// reference, even when the RPE was eased. P8 weekly sets for a muscle
// rising more than 20 percent week over week outside deloads WARNS (week
// types may legitimately undulate). Repairs clamp.
// =============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

/** The largest single-step increase for an exercise, kg. */
export function stepKgOf(lib: LibraryExercise): number {
  if (lib.movementPattern === 'isolation') return Math.min(PROGRESSION_LIMITS.stepKg.isolation, PROGRESSION_LIMITS.stepKg[lib.implement]);
  return PROGRESSION_LIMITS.stepKg[lib.implement];
}

/** The most a load may be one exposure after `previousKg`. */
export function nextLoadCap(lib: LibraryExercise, previousKg: number, painFlagged: boolean): number {
  if (painFlagged) return previousKg;
  const increase = Math.min(stepKgOf(lib), previousKg * PROGRESSION_LIMITS.maxIncreaseFraction);
  return Math.max(previousKg, floorHalf(previousKg + increase));
}

/**
 * The most the first planned load may be, from the user's history (`null`
 * when history gives no bound). Shared by G7 and G9 so they agree.
 */
export function firstExposureCap(lib: LibraryExercise, exercise: Pick<PlanExercise, 'repMin'>, fact: ExerciseHistoryFacts | undefined, now: Date): number | null {
  if (!fact || fact.lastLoadKg === null || fact.lastLoadKg <= 0) return null;
  const last = fact.lastLoadKg;
  let cap = nextLoadCap(lib, last, fact.painFlagged);
  if (fact.lastMinReps !== null && fact.lastMinReps < exercise.repMin) cap = Math.min(cap, last);
  if (fact.lastDate) {
    const gapDays = (now.getTime() - new Date(`${fact.lastDate}T00:00:00.000Z`).getTime()) / DAY_MS;
    if (gapDays > PROGRESSION_LIMITS.gapDays) cap = Math.min(cap, floorHalf(last * PROGRESSION_LIMITS.gapFactor));
  }
  return cap;
}

export function checkProgression(tree: PlanTree, ctx: GuardrailContext): Violation[] {
  const f = new Findings('G7');
  const lastLoad = new Map<string, number>();
  const reference = new Map<string, PlanExercise>();
  const d = PROGRESSION_LIMITS.deload;

  for (const { week, workout, exercise } of slotsOf(tree)) {
    const lib = ctx.library.get(exercise.exerciseId);
    if (!lib) continue;
    const path = pathOf(ctx, week, workout, exercise);
    const pain = ctx.painFlagKeys.has(lib.key);

    if (week.isDeload) {
      const ref = reference.get(exercise.exerciseId);
      if (!ref) continue;
      const setCap = Math.max(d.minSets, Math.round(ref.targetSets * d.setsFactor));
      if (exercise.targetSets > setCap && exercise.targetSets > d.minSets) {
        f.add('repair', 'deload_sets', path, `Deload week: ${exercise.targetSets} sets lowered to ${setCap}.`);
        exercise.targetSets = setCap;
      }
      const loadOk =
        exercise.targetLoadKg !== null && ref.targetLoadKg !== null && exercise.targetLoadKg <= floorHalf(ref.targetLoadKg * d.loadFactor);
      const rpeOk = exercise.targetRpe !== null && ref.targetRpe !== null && exercise.targetRpe <= ref.targetRpe - d.rpeDrop;
      if (!loadOk && !rpeOk) {
        if (exercise.targetLoadKg !== null && ref.targetLoadKg !== null) {
          const capped = floorHalf(ref.targetLoadKg * d.loadFactor);
          f.add('repair', 'deload_load', path, `Deload week: load ${exercise.targetLoadKg} kg lowered to ${capped} kg.`);
          exercise.targetLoadKg = capped;
        } else if (ref.targetRpe !== null && (exercise.targetRpe === null || exercise.targetRpe > ref.targetRpe - d.rpeDrop)) {
          const rpe = Math.max(1, ref.targetRpe - d.rpeDrop);
          f.add('repair', 'deload_rpe', path, `Deload week: RPE set to ${rpe}.`);
          exercise.targetRpe = rpe;
        }
      }
      // A deload never loads an exercise above its last normal week, whichever way it was eased (RPE alone does not license a heavier load).
      if (exercise.targetLoadKg !== null && ref.targetLoadKg !== null && exercise.targetLoadKg > ref.targetLoadKg) {
        f.add('repair', 'deload_load', path, `Deload week: load ${exercise.targetLoadKg} kg lowered to ${ref.targetLoadKg} kg, the last normal week's load.`);
        exercise.targetLoadKg = ref.targetLoadKg;
      }
      continue;
    }

    if (exercise.targetLoadKg !== null) {
      const previous = lastLoad.get(exercise.exerciseId);
      const cap =
        previous === undefined
          ? firstExposureCap(lib, exercise, ctx.history.get(exercise.exerciseId), ctx.now)
          : nextLoadCap(lib, previous, pain);
      if (cap !== null && exercise.targetLoadKg > cap) {
        f.add(
          'repair',
          previous === undefined ? 'first_load_over_history' : 'load_jump',
          path,
          previous === undefined
            ? `Load ${exercise.targetLoadKg} kg lowered to ${cap} kg: your recent history does not support more.`
            : `Load ${exercise.targetLoadKg} kg lowered to ${cap} kg: at most one small step (${stepKgOf(lib)} kg, 10 percent) per exposure.`,
        );
        exercise.targetLoadKg = cap;
      }
      lastLoad.set(exercise.exerciseId, exercise.targetLoadKg);
    }
    reference.set(exercise.exerciseId, exercise);
  }

  // P8 (warn): weekly sets per muscle, non-deload week over the previous non-deload week.
  let previous: Map<string, number> | null = null;
  for (const { week } of weeksOf(tree)) {
    if (week.isDeload) continue;
    const totals = setsByMuscle(ctx, week.workouts, GUARDRAIL_LIMITS.uncountedMuscles);
    if (previous) {
      for (const [muscle, sets] of [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const before = previous.get(muscle) ?? 0;
        const allowed = Math.max(before + 1, Math.floor(before * (1 + PROGRESSION_LIMITS.weeklySetIncreaseFraction)));
        if (before > 0 && sets > allowed) {
          f.add('warn', 'weekly_sets_jump', `week ${week.weekNumber}`, `Weekly sets for ${muscle} rise from ${before} to ${sets}, more than 20 percent.`);
        }
      }
    }
    previous = totals;
  }

  return f.list;
}
