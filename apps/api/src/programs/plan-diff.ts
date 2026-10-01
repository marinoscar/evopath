import { randomUUID } from 'node:crypto';

import type { LoadGuidance, PlanTree } from './contracts/plan-tree.contract';

// =============================================================================
// Row-level diff between a program's stored rows and a new PlanTree (E5.1)
// =============================================================================
//
// Pure. The chokepoint loads every row of the program (archived ones too),
// hands them here with the new tree and the set of workouts that have logged
// history, and executes the resulting plan of writes.
//
// HISTORY-PRESERVING DELETES. A removed workout with logged history is
// archived, never deleted; a removed week or block that still contains an
// archived (or otherwise kept) child is archived too. Everything else that is
// removed is deleted. A tree that names an archived row by id restores it
// (`archivedAt = null`) with the same id.
// =============================================================================

export interface BlockRow {
  id: string;
  position: number;
  name: string;
  focus: string | null;
  rationale: string | null;
  archivedAt: Date | null;
}

export interface WeekRow {
  id: string;
  blockId: string;
  weekNumber: number;
  isDeload: boolean;
  archivedAt: Date | null;
}

export interface WorkoutRow {
  id: string;
  weekId: string;
  position: number;
  weekday: number | null;
  name: string;
  estimatedMinutes: number | null;
  rationale: string | null;
  archivedAt: Date | null;
}

export interface ExerciseRow {
  id: string;
  programWorkoutId: string;
  exerciseId: string;
  position: number;
  isPriority: boolean;
  // Reps shape: targetSets/repMin/repMax set. Cardio shape: repMin/repMax null and a duration and/or distance target.
  targetSets: number | null;
  repMin: number | null;
  repMax: number | null;
  targetDurationSeconds: number | null;
  targetDistanceMeters: number | null;
  targetLoadKg: number | null;
  targetRpe: number | null;
  restSeconds: number;
  loadGuidance: string;
  rationale: string | null;
  evidenceRefs: string[];
  notes: string | null;
  equipmentTypeId: string | null;
}

export interface ProgramRows {
  blocks: BlockRow[];
  weeks: WeekRow[];
  workouts: WorkoutRow[];
  exercises: ExerciseRow[];
}

type Fields<T> = Omit<T, 'archivedAt'>;

export interface TreeWrites {
  create: {
    blocks: Fields<BlockRow>[];
    weeks: Fields<WeekRow>[];
    workouts: Fields<WorkoutRow>[];
    exercises: ExerciseRow[];
  };
  /** Changed rows (or archived rows being restored), full field set. */
  update: {
    blocks: Fields<BlockRow>[];
    weeks: Fields<WeekRow>[];
    workouts: Fields<WorkoutRow>[];
    exercises: ExerciseRow[];
  };
  archive: { blocks: string[]; weeks: string[]; workouts: string[] };
  delete: { blocks: string[]; weeks: string[]; workouts: string[]; exercises: string[] };
}

/** The tree with every missing row id filled with a fresh uuid. Mutates and returns `tree`. */
export function assignIds(tree: PlanTree): PlanTree {
  for (const block of tree.blocks) {
    block.id ??= randomUUID();
    for (const week of block.weeks) {
      week.id ??= randomUUID();
      for (const workout of week.workouts) {
        workout.id ??= randomUUID();
        for (const exercise of workout.exercises) exercise.id ??= randomUUID();
      }
    }
  }
  return tree;
}

/** Flattens a tree whose ids are all assigned into rows with parent ids. */
export function rowsOf(tree: PlanTree): Omit<ProgramRows, 'blocks' | 'weeks' | 'workouts'> & {
  blocks: Fields<BlockRow>[];
  weeks: Fields<WeekRow>[];
  workouts: Fields<WorkoutRow>[];
} {
  const out = { blocks: [] as Fields<BlockRow>[], weeks: [] as Fields<WeekRow>[], workouts: [] as Fields<WorkoutRow>[], exercises: [] as ExerciseRow[] };
  for (const block of tree.blocks) {
    const blockId = block.id!;
    out.blocks.push({ id: blockId, position: block.position, name: block.name, focus: block.focus, rationale: block.rationale });
    for (const week of block.weeks) {
      const weekId = week.id!;
      out.weeks.push({ id: weekId, blockId, weekNumber: week.weekNumber, isDeload: week.isDeload });
      for (const workout of week.workouts) {
        const workoutId = workout.id!;
        out.workouts.push({
          id: workoutId,
          weekId,
          position: workout.position,
          weekday: workout.weekday,
          name: workout.name,
          estimatedMinutes: workout.estimatedMinutes,
          rationale: workout.rationale,
        });
        for (const exercise of workout.exercises) {
          out.exercises.push({
            id: exercise.id!,
            programWorkoutId: workoutId,
            exerciseId: exercise.exerciseId,
            position: exercise.position,
            isPriority: exercise.isPriority,
            targetSets: exercise.targetSets,
            repMin: exercise.repMin,
            repMax: exercise.repMax,
            targetDurationSeconds: exercise.targetDurationSeconds,
            targetDistanceMeters: exercise.targetDistanceMeters,
            targetLoadKg: exercise.targetLoadKg,
            targetRpe: exercise.targetRpe,
            restSeconds: exercise.restSeconds,
            loadGuidance: exercise.loadGuidance,
            rationale: exercise.rationale,
            evidenceRefs: [...exercise.evidenceRefs],
            notes: exercise.notes,
            equipmentTypeId: exercise.equipmentTypeId,
          });
        }
      }
    }
  }
  return out;
}

/** The live (non-archived) tree of the stored rows, ordered by position / week number. */
export function liveTreeOf(rows: ProgramRows): PlanTree {
  const byPosition = <T extends { position: number }>(a: T, b: T) => a.position - b.position;
  const blocks = rows.blocks.filter((block) => !block.archivedAt).sort(byPosition);
  return {
    blocks: blocks.map((block) => ({
      id: block.id,
      position: block.position,
      name: block.name,
      focus: block.focus,
      rationale: block.rationale,
      weeks: rows.weeks
        .filter((week) => week.blockId === block.id && !week.archivedAt)
        .sort((a, b) => a.weekNumber - b.weekNumber)
        .map((week) => ({
          id: week.id,
          weekNumber: week.weekNumber,
          isDeload: week.isDeload,
          workouts: rows.workouts
            .filter((workout) => workout.weekId === week.id && !workout.archivedAt)
            .sort(byPosition)
            .map((workout) => ({
              id: workout.id,
              position: workout.position,
              weekday: workout.weekday,
              name: workout.name,
              estimatedMinutes: workout.estimatedMinutes,
              rationale: workout.rationale,
              exercises: rows.exercises
                .filter((exercise) => exercise.programWorkoutId === workout.id)
                .sort(byPosition)
                .map(({ programWorkoutId: _parent, ...exercise }) => ({
                  ...exercise,
                  evidenceRefs: [...exercise.evidenceRefs],
                  loadGuidance: exercise.loadGuidance as LoadGuidance,
                })),
            })),
        })),
    })),
  };
}

function sameFields<T extends object>(a: T, b: T): boolean {
  for (const key of Object.keys(b) as (keyof T)[]) {
    const x = a[key];
    const y = b[key];
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length || x.some((value, i) => value !== y[i])) return false;
    } else if (x !== y) {
      return false;
    }
  }
  return true;
}

/**
 * The writes that turn `rows` into `tree` (every id assigned). `withHistory`
 * holds the ids of workouts a logged workout points at.
 */
export function diffTree(rows: ProgramRows, tree: PlanTree, withHistory: ReadonlySet<string>): TreeWrites {
  const next = rowsOf(tree);
  const writes: TreeWrites = {
    create: { blocks: [], weeks: [], workouts: [], exercises: [] },
    update: { blocks: [], weeks: [], workouts: [], exercises: [] },
    archive: { blocks: [], weeks: [], workouts: [] },
    delete: { blocks: [], weeks: [], workouts: [], exercises: [] },
  };

  // Creates and updates, level by level.
  const level = <R extends { id: string }, N extends { id: string }>(
    stored: R[],
    wanted: N[],
    create: N[],
    update: N[],
    isArchived: (row: R) => boolean,
  ) => {
    const byId = new Map(stored.map((row) => [row.id, row]));
    for (const row of wanted) {
      const existing = byId.get(row.id);
      if (!existing) create.push(row);
      else if (isArchived(existing) || !sameFields(existing as unknown as N, row)) update.push(row);
    }
  };
  level(rows.blocks, next.blocks, writes.create.blocks, writes.update.blocks, (row) => row.archivedAt !== null);
  level(rows.weeks, next.weeks, writes.create.weeks, writes.update.weeks, (row) => row.archivedAt !== null);
  level(rows.workouts, next.workouts, writes.create.workouts, writes.update.workouts, (row) => row.archivedAt !== null);
  level(rows.exercises, next.exercises, writes.create.exercises, writes.update.exercises, () => false);

  // Removals. A row not in the new tree is handled when it was live before or
  // its (stored) parent is in the new tree; rows inside an archived subtree
  // whose parent stays out are left untouched.
  const inNext = {
    blocks: new Set(next.blocks.map((row) => row.id)),
    weeks: new Set(next.weeks.map((row) => row.id)),
    workouts: new Set(next.workouts.map((row) => row.id)),
    exercises: new Set(next.exercises.map((row) => row.id)),
  };
  const liveBlocks = new Set(rows.blocks.filter((row) => !row.archivedAt).map((row) => row.id));
  const liveWeeks = new Set(rows.weeks.filter((row) => !row.archivedAt && liveBlocks.has(row.blockId)).map((row) => row.id));
  const liveWorkouts = new Set(rows.workouts.filter((row) => !row.archivedAt && liveWeeks.has(row.weekId)).map((row) => row.id));

  const deleted = { weeks: new Set<string>(), workouts: new Set<string>() };

  for (const row of rows.exercises) {
    if (inNext.exercises.has(row.id)) continue;
    // Removed from a workout that stays: delete. Otherwise it follows its workout.
    if (inNext.workouts.has(row.programWorkoutId)) writes.delete.exercises.push(row.id);
  }

  for (const row of rows.workouts) {
    if (inNext.workouts.has(row.id)) continue;
    if (!liveWorkouts.has(row.id) && !inNext.weeks.has(row.weekId)) continue;
    if (withHistory.has(row.id)) {
      if (!row.archivedAt) writes.archive.workouts.push(row.id);
    } else {
      writes.delete.workouts.push(row.id);
      deleted.workouts.add(row.id);
    }
  }

  for (const row of rows.weeks) {
    if (inNext.weeks.has(row.id)) continue;
    if (!liveWeeks.has(row.id) && !inNext.blocks.has(row.blockId)) continue;
    const keepsChild = rows.workouts.some(
      (workout) => workout.weekId === row.id && !inNext.workouts.has(workout.id) && !deleted.workouts.has(workout.id),
    );
    if (keepsChild) {
      if (!row.archivedAt) writes.archive.weeks.push(row.id);
    } else {
      writes.delete.weeks.push(row.id);
      deleted.weeks.add(row.id);
    }
  }

  for (const row of rows.blocks) {
    if (inNext.blocks.has(row.id)) continue;
    if (!liveBlocks.has(row.id)) continue;
    const keepsChild = rows.weeks.some(
      (week) => week.blockId === row.id && !inNext.weeks.has(week.id) && !deleted.weeks.has(week.id),
    );
    if (keepsChild) {
      if (!row.archivedAt) writes.archive.blocks.push(row.id);
    } else {
      writes.delete.blocks.push(row.id);
    }
  }

  return writes;
}

/** Whether a diff writes nothing at all. */
export function isEmptyDiff(writes: TreeWrites): boolean {
  return [writes.create, writes.update, writes.archive, writes.delete].every((group) =>
    Object.values(group).every((list: unknown[]) => list.length === 0),
  );
}
