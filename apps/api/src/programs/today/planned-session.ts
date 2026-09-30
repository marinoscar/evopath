import type { LoadGuidance } from '../contracts/plan-tree.contract';

// =============================================================================
// Planned sessions (E5.7): the snapshot and the prefill rules, pure
// =============================================================================
//
// The server only READS the plan: it computes no new prescription. The load a
// session shows and prefills follows the exercise's `loadGuidance`:
//
//   fixed         `targetLoadKg` (the last top-set weight when the plan left it empty)
//   from_history  the last top-set weight, when there is one
//   choose_start  none; the lifter chooses a starting load
//
// The snapshot is what planned-versus-done compares against, so it is taken
// once, at start, and never rewritten by later plan changes.
// =============================================================================

export interface PlannedExerciseInput {
  exerciseId: string;
  slug: string;
  trackingMode: string;
  targetSets: number;
  repMin: number;
  repMax: number;
  targetRpe: number | null;
  targetLoadKg: number | null;
  loadGuidance: LoadGuidance | string;
  isPriority: boolean;
}

export interface LastTimeTopSet {
  performedOn: string;
  topSet: { weightKg: number; reps: number } | null;
}

/** One entry of `program_sessions.planned_snapshot`. */
export interface PlannedSnapshotEntry {
  exerciseId: string;
  slug: string;
  sets: number;
  repMin: number;
  repMax: number;
  targetRpe: number | null;
  targetLoadKg: number | null;
  loadGuidance: string;
  isPriority: boolean;
}

export function plannedSnapshotOf(exercises: readonly PlannedExerciseInput[]): PlannedSnapshotEntry[] {
  return exercises.map((exercise) => ({
    exerciseId: exercise.exerciseId,
    slug: exercise.slug,
    sets: exercise.targetSets,
    repMin: exercise.repMin,
    repMax: exercise.repMax,
    targetRpe: exercise.targetRpe,
    targetLoadKg: exercise.targetLoadKg,
    loadGuidance: exercise.loadGuidance,
    isPriority: exercise.isPriority,
  }));
}

/** The load to show and prefill, in kilograms, or null (the lifter chooses). */
export function suggestedLoadKg(
  exercise: Pick<PlannedExerciseInput, 'loadGuidance' | 'targetLoadKg'>,
  lastTime: LastTimeTopSet | null,
): number | null {
  const lastWeight = lastTime?.topSet?.weightKg ?? null;
  switch (exercise.loadGuidance) {
    case 'fixed':
      return exercise.targetLoadKg ?? lastWeight;
    case 'from_history':
      return lastWeight;
    default:
      return null;
  }
}

export interface PrefilledSet {
  setNumber: number;
  weightKg: number | null;
  reps: number | null;
}

/**
 * `targetSets` uncompleted sets: `reps = repMin` for rep-tracked exercises,
 * the suggested load for weighted ones. The lifter confirms each set.
 */
export function prefilledSets(exercise: PlannedExerciseInput, lastTime: LastTimeTopSet | null): PrefilledSet[] {
  const weighted = exercise.trackingMode === 'weight_reps';
  const repTracked = weighted || exercise.trackingMode === 'bodyweight_reps';
  const weightKg = weighted ? suggestedLoadKg(exercise, lastTime) : null;
  return Array.from({ length: exercise.targetSets }, (_, index) => ({
    setNumber: index + 1,
    weightKg,
    reps: repTracked ? exercise.repMin : null,
  }));
}

/**
 * The top set of a logged exercise: among completed working sets with reps,
 * the heaviest (a missing weight counts as 0), then the most reps.
 */
export function topSetOf(
  sets: ReadonlyArray<{ weightKg: number | null; reps: number | null; completed: boolean; isWarmup: boolean }>,
): { weightKg: number; reps: number } | null {
  let best: { weightKg: number; reps: number } | null = null;
  for (const set of sets) {
    if (!set.completed || set.isWarmup || set.reps === null) continue;
    const weightKg = set.weightKg ?? 0;
    if (!best || weightKg > best.weightKg || (weightKg === best.weightKg && set.reps > best.reps)) {
      best = { weightKg, reps: set.reps };
    }
  }
  return best;
}
