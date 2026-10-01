import type { LoadGuidance } from '../contracts/plan-tree.contract';
import { isCardioPrescription } from '../contracts/prescription';

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
//
// A cardio prescription (a duration and/or distance target, no reps) starts
// as `targetSets` (default 1) empty sets: no reps, no load. The logger shows
// the targets; the person logs the time and distance they did.
// =============================================================================

export interface PlannedExerciseInput {
  exerciseId: string;
  slug: string;
  trackingMode: string;
  /** Null only for a cardio prescription that leaves the set count open. */
  targetSets: number | null;
  /** Null for a cardio prescription. */
  repMin: number | null;
  repMax: number | null;
  targetDurationSeconds: number | null;
  targetDistanceMeters: number | null;
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
  sets: number | null;
  repMin: number | null;
  repMax: number | null;
  /** Absent in snapshots taken before cardio prescriptions existed (read as null). */
  targetDurationSeconds?: number | null;
  targetDistanceMeters?: number | null;
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
    targetDurationSeconds: exercise.targetDurationSeconds,
    targetDistanceMeters: exercise.targetDistanceMeters,
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
 * the suggested load for weighted ones. The lifter confirms each set. A
 * cardio prescription gets `targetSets` (default 1) empty sets: no reps
 * target, no load.
 */
export function prefilledSets(exercise: PlannedExerciseInput, lastTime: LastTimeTopSet | null): PrefilledSet[] {
  if (isCardioPrescription(exercise)) {
    return Array.from({ length: Math.max(1, exercise.targetSets ?? 1) }, (_, index) => ({
      setNumber: index + 1,
      weightKg: null,
      reps: null,
    }));
  }
  const weighted = exercise.trackingMode === 'weight_reps';
  const repTracked = weighted || exercise.trackingMode === 'bodyweight_reps';
  const weightKg = weighted ? suggestedLoadKg(exercise, lastTime) : null;
  return Array.from({ length: Math.max(1, exercise.targetSets ?? 1) }, (_, index) => ({
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
