import type { StoredPlanChangeOperation } from '../../programs/contracts/plan-change.contract';
import type { PlanExercise, PlanTree, PlanWorkout } from '../../programs/contracts/plan-tree.contract';
import { PROGRESSION_LIMITS } from '../guardrails/limits';
import { floorHalf } from '../guardrails/tree';

// =============================================================================
// applyOperations: typed plan-change operations applied to a PlanTree (pure)
// =============================================================================
//
// The envelope (`guardrails/envelope.ts`) resolves every accepted operation's
// short refs to ROW IDS once (`targets`), so applying never re-reads a ref:
// the same accepted set can be applied to the tree the run evaluated, to a
// newer tree after a stale write (every target must still exist), or after
// an approval days later. A target that no longer exists is reported in
// `missing`, never guessed.
//
//   set_prescription   the non-null fields on every targeted exercise row
//   swap_exercise      the targeted rows' exercise; the load is reset (the
//                      lifter chooses a start), the prescription is kept
//   remove_exercise    the targeted rows go
//   add_exercise       a new row at the end of every targeted workout
//   set_weekday        the targeted workouts move to the weekday
//   drop_workout       the targeted workouts go
//   mark_deload        the week becomes a deload; its targeted (unlocked)
//                      workouts get the documented transform: sets x 0.6
//                      (at least 2), load x 0.9 when a load is set, else
//                      RPE minus 2
//   regenerate_remaining  never applied here (the envelope drops it)
// =============================================================================

/** The rows an accepted operation touches, resolved from its refs by the envelope. */
export interface OperationTargets {
  /** `program_exercises` rows (set_prescription, swap_exercise, remove_exercise). */
  exerciseRowIds: string[];
  /** `program_workouts` rows (add_exercise, set_weekday, drop_workout, mark_deload). */
  workoutRowIds: string[];
  /** Weeks by number (mark_deload). */
  weekNumbers: number[];
  /** The library exercise a swap or an add puts in. */
  exerciseId: string | null;
}

/** An accepted operation: what the change log stores plus its resolved row targets (server only). */
export type AcceptedOperation = StoredPlanChangeOperation & { targets: OperationTargets };

export interface ApplyOperationsResult {
  tree: PlanTree;
  /** Row ids an operation named that the tree no longer has. */
  missing: string[];
}

export const DELOAD_TRANSFORM = PROGRESSION_LIMITS.deload;

/** The operation as the change log stores it (targets are server-only row ids). */
export function storedOperation(accepted: AcceptedOperation): StoredPlanChangeOperation {
  const { targets: _targets, ...stored } = accepted;
  return stored as StoredPlanChangeOperation;
}

function nextPosition(workout: PlanWorkout): number {
  return workout.exercises.reduce((max, exercise) => Math.max(max, exercise.position), -1) + 1;
}

/** The documented deload transform of one exercise row. */
export function deloadExercise(exercise: PlanExercise): void {
  exercise.targetSets = Math.max(DELOAD_TRANSFORM.minSets, Math.round(exercise.targetSets * DELOAD_TRANSFORM.setsFactor));
  if (exercise.targetLoadKg !== null && exercise.targetLoadKg !== undefined && exercise.targetLoadKg > 0) {
    exercise.targetLoadKg = floorHalf(exercise.targetLoadKg * DELOAD_TRANSFORM.loadFactor);
  } else if (exercise.targetRpe !== null && exercise.targetRpe !== undefined) {
    exercise.targetRpe = Math.max(1, exercise.targetRpe - DELOAD_TRANSFORM.rpeDrop);
  }
}

/** Applies `operations` in order to a deep copy of `tree`. Pure. */
export function applyOperations(tree: PlanTree, operations: readonly AcceptedOperation[]): ApplyOperationsResult {
  const copy: PlanTree = structuredClone(tree);
  const missing = new Set<string>();

  const exerciseRows = new Map<string, { workout: PlanWorkout; exercise: PlanExercise }>();
  const workoutRows = new Map<string, { week: PlanTree['blocks'][number]['weeks'][number]; workout: PlanWorkout }>();
  const index = () => {
    exerciseRows.clear();
    workoutRows.clear();
    for (const block of copy.blocks)
      for (const week of block.weeks)
        for (const workout of week.workouts) {
          if (workout.id) workoutRows.set(workout.id, { week, workout });
          for (const exercise of workout.exercises) if (exercise.id) exerciseRows.set(exercise.id, { workout, exercise });
        }
  };
  index();

  const exercisesOf = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const row = exerciseRows.get(id);
      if (!row) missing.add(id);
      return row ? [row] : [];
    });
  const workoutsOf = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const row = workoutRows.get(id);
      if (!row) missing.add(id);
      return row ? [row] : [];
    });

  for (const op of operations) {
    switch (op.op) {
      case 'set_prescription': {
        for (const { exercise } of exercisesOf(op.targets.exerciseRowIds)) {
          if (op.sets !== null) exercise.targetSets = op.sets;
          if (op.repMin !== null) exercise.repMin = op.repMin;
          if (op.repMax !== null) exercise.repMax = op.repMax;
          if (exercise.repMin > exercise.repMax) exercise.repMax = exercise.repMin;
          if (op.targetRpe !== null) exercise.targetRpe = op.targetRpe;
          if (op.restSeconds !== null) exercise.restSeconds = op.restSeconds;
          if (op.targetLoadKg !== null) {
            exercise.targetLoadKg = op.targetLoadKg;
            exercise.loadGuidance = op.loadGuidance ?? 'fixed';
          } else if (op.loadGuidance !== null) {
            exercise.loadGuidance = op.loadGuidance;
          }
        }
        break;
      }
      case 'swap_exercise': {
        for (const { exercise } of exercisesOf(op.targets.exerciseRowIds)) {
          if (!op.targets.exerciseId) continue;
          exercise.exerciseId = op.targets.exerciseId;
          exercise.targetLoadKg = null;
          exercise.loadGuidance = 'choose_start';
          exercise.evidenceRefs = [];
          exercise.equipmentTypeId = null;
        }
        break;
      }
      case 'remove_exercise': {
        const gone = new Set(exercisesOf(op.targets.exerciseRowIds).map(({ exercise }) => exercise.id));
        for (const { workout } of workoutRows.values()) {
          workout.exercises = workout.exercises.filter((exercise) => !exercise.id || !gone.has(exercise.id));
        }
        index();
        break;
      }
      case 'add_exercise': {
        for (const { workout } of workoutsOf(op.targets.workoutRowIds)) {
          if (!op.targets.exerciseId) continue;
          workout.exercises.push({
            exerciseId: op.targets.exerciseId,
            position: nextPosition(workout),
            isPriority: false,
            targetSets: op.sets,
            repMin: op.repMin,
            repMax: Math.max(op.repMin, op.repMax),
            targetLoadKg: null,
            targetRpe: op.targetRpe,
            restSeconds: op.restSeconds,
            loadGuidance: 'choose_start',
            rationale: null,
            evidenceRefs: [],
            notes: null,
            equipmentTypeId: null,
          });
        }
        index();
        break;
      }
      case 'set_weekday': {
        for (const { workout } of workoutsOf(op.targets.workoutRowIds)) workout.weekday = op.weekday;
        break;
      }
      case 'drop_workout': {
        const gone = new Set(workoutsOf(op.targets.workoutRowIds).map(({ workout }) => workout.id));
        for (const block of copy.blocks)
          for (const week of block.weeks) week.workouts = week.workouts.filter((workout) => !workout.id || !gone.has(workout.id));
        index();
        break;
      }
      case 'mark_deload': {
        const weeks = new Set(op.targets.weekNumbers);
        for (const block of copy.blocks) for (const week of block.weeks) if (weeks.has(week.weekNumber)) week.isDeload = true;
        for (const { workout } of workoutsOf(op.targets.workoutRowIds)) for (const exercise of workout.exercises) deloadExercise(exercise);
        break;
      }
      case 'regenerate_remaining':
        break;
    }
  }

  return { tree: copy, missing: [...missing] };
}

/** Every row id the operations target (for "does every target still exist"). */
export function targetRowIds(operations: readonly AcceptedOperation[]): { exercises: string[]; workouts: string[] } {
  const exercises = new Set<string>();
  const workouts = new Set<string>();
  for (const op of operations) {
    for (const id of op.targets.exerciseRowIds) exercises.add(id);
    for (const id of op.targets.workoutRowIds) workouts.add(id);
  }
  return { exercises: [...exercises], workouts: [...workouts] };
}
