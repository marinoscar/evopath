import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { fromDbDate } from '../check-ins/local-date';
import type { ExerciseStatus, ExerciseTrackingMode } from '../common/constants/training.constants';
import type {
  ReadinessSnapshotData,
  SetLogViewData,
  WorkoutExerciseViewData,
  WorkoutListItemData,
  WorkoutTotalsData,
  WorkoutViewData,
} from './dto/workout.dto';
import { bestPerType, type EarnedPr, type SetPr } from './workout-records';
import { REST_DERIVATION_WINDOW_SECONDS, type WorkoutStatus } from './workouts.constants';

/** The PRs each set earns, by set id (from `WorkoutHistoryService`); a missing id means none. */
export type PrsBySet = ReadonlyMap<string, SetPr[]>;

const NO_PRS: PrsBySet = new Map();

// =============================================================================
// Workouts (E4.2) — Prisma includes, row-to-view mappers, pure rules, errors
// =============================================================================

export const WORKOUT_EXERCISE_INCLUDE = {
  exercise: {
    select: {
      id: true,
      slug: true,
      name: true,
      trackingMode: true,
      isBodyweight: true,
      isUnilateral: true,
      primaryMuscles: true,
      ownerUserId: true,
      status: true,
    },
  },
  equipmentType: { select: { id: true, slug: true, name: true } },
  sets: { orderBy: { setNumber: 'asc' as const } },
} satisfies Prisma.WorkoutExerciseInclude;

export type WorkoutExerciseWithRelations = Prisma.WorkoutExerciseGetPayload<{ include: typeof WORKOUT_EXERCISE_INCLUDE }>;

export const WORKOUT_INCLUDE = {
  gym: { select: { id: true, name: true } },
  exercises: { orderBy: [{ position: 'asc' as const }, { createdAt: 'asc' as const }], include: WORKOUT_EXERCISE_INCLUDE },
} satisfies Prisma.WorkoutInclude;

export type WorkoutWithRelations = Prisma.WorkoutGetPayload<{ include: typeof WORKOUT_INCLUDE }>;

export const WORKOUT_LIST_INCLUDE = {
  gym: { select: { id: true, name: true } },
  exercises: {
    orderBy: [{ position: 'asc' as const }, { createdAt: 'asc' as const }],
    select: {
      exercise: { select: { id: true, name: true } },
      sets: { select: { weightKg: true, reps: true, completed: true, isWarmup: true } },
    },
  },
} satisfies Prisma.WorkoutInclude;

export type WorkoutListRow = Prisma.WorkoutGetPayload<{ include: typeof WORKOUT_LIST_INCLUDE }>;

// -----------------------------------------------------------------------------
// Pure rules
// -----------------------------------------------------------------------------

function toNumber(value: Prisma.Decimal | null): number | null {
  return value === null ? null : value.toNumber();
}

/** The fields the totals read from a set. */
export interface SetForTotals {
  weightKg: Prisma.Decimal | number | null;
  reps: number | null;
  completed: boolean;
  isWarmup: boolean;
}

/**
 * Completed working sets and their volume (weight x reps, kilograms). Warm-up
 * and uncompleted sets never count; a set without weight or reps adds to the
 * count but not the volume. Rounded to 3 decimals.
 */
export function computeTotals(sets: readonly SetForTotals[]): { setCount: number; volumeKg: number } {
  let setCount = 0;
  let volume = new Prisma.Decimal(0);

  for (const set of sets) {
    if (!set.completed || set.isWarmup) continue;
    setCount += 1;
    if (set.weightKg !== null && set.reps !== null) {
      volume = volume.plus(new Prisma.Decimal(set.weightKg).times(set.reps));
    }
  }

  return { setCount, volumeKg: volume.toDecimalPlaces(3).toNumber() };
}

/**
 * The rest before a set completed at `now`, from the most recent earlier
 * completion in the same workout: whole seconds when it is less than 15
 * minutes old, otherwise (or without one) null.
 */
export function deriveRestSeconds(previousCompletedAt: Date | null, now: Date): number | null {
  if (!previousCompletedAt) return null;
  const seconds = Math.floor((now.getTime() - previousCompletedAt.getTime()) / 1000);
  if (seconds < 0 || seconds >= REST_DERIVATION_WINDOW_SECONDS) return null;
  return seconds;
}

/**
 * The updates that make `items` (already in the desired order) number densely
 * from `start`: only the rows whose number changes, in ascending order of
 * their new number. Applied in that order, a renumbering that only moves rows
 * down (after a delete) never collides with a unique (parent, number) index.
 */
export function denseRenumber<T extends { id: string }>(
  items: readonly T[],
  current: (item: T) => number,
  start: 0 | 1,
): Array<{ id: string; to: number }> {
  const changes: Array<{ id: string; to: number }> = [];
  items.forEach((item, index) => {
    const to = index + start;
    if (current(item) !== to) changes.push({ id: item.id, to });
  });
  return changes;
}

/** `items` with the element at `from` moved to `to` (both clamped). */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const result = [...items];
  if (from < 0 || from >= result.length) return result;
  const [moved] = result.splice(from, 1);
  const target = Math.max(0, Math.min(to, result.length));
  result.splice(target, 0, moved);
  return result;
}

/** A set with no recorded value (weight, reps, time or distance). */
export function isEmptySet(set: {
  weightKg: unknown;
  reps: unknown;
  durationSeconds: unknown;
  distanceMeters: unknown;
}): boolean {
  return set.weightKg === null && set.reps === null && set.durationSeconds === null && set.distanceMeters === null;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** "Tuesday workout" for a `YYYY-MM-DD` day. */
export function defaultWorkoutName(date: string): string {
  return `${WEEKDAYS[new Date(`${date}T00:00:00.000Z`).getUTCDay()]} workout`;
}

/** Whole seconds from `startedAt` to `endedAt`, never negative. */
export function durationBetween(startedAt: Date, endedAt: Date): number {
  return Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));
}

// -----------------------------------------------------------------------------
// Mappers
// -----------------------------------------------------------------------------

export function toSetLogView(set: WorkoutExerciseWithRelations['sets'][number], prs: SetPr[] = []): SetLogViewData {
  return {
    id: set.id,
    workoutExerciseId: set.workoutExerciseId,
    setNumber: set.setNumber,
    weightKg: toNumber(set.weightKg),
    reps: set.reps,
    durationSeconds: set.durationSeconds,
    distanceMeters: toNumber(set.distanceMeters),
    rpe: toNumber(set.rpe),
    rir: set.rir,
    restSeconds: set.restSeconds,
    isWarmup: set.isWarmup,
    completed: set.completed,
    completedAt: set.completedAt ? set.completedAt.toISOString() : null,
    painFlag: set.painFlag,
    painNote: set.painNote,
    notes: set.notes,
    prs,
  };
}

export function toWorkoutExerciseView(row: WorkoutExerciseWithRelations, prsBySet: PrsBySet = NO_PRS): WorkoutExerciseViewData {
  return {
    id: row.id,
    workoutId: row.workoutId,
    exerciseId: row.exerciseId,
    position: row.position,
    equipmentTypeId: row.equipmentTypeId,
    equipmentType: row.equipmentType,
    notes: row.notes,
    exercise: {
      id: row.exercise.id,
      slug: row.exercise.slug,
      name: row.exercise.name,
      trackingMode: row.exercise.trackingMode as ExerciseTrackingMode,
      isBodyweight: row.exercise.isBodyweight,
      isUnilateral: row.exercise.isUnilateral,
      primaryMuscles: row.exercise.primaryMuscles,
      isCustom: row.exercise.ownerUserId !== null,
      status: row.exercise.status as ExerciseStatus,
    },
    sets: row.sets.map((set) => toSetLogView(set, prsBySet.get(set.id) ?? [])),
    createdAt: row.createdAt.toISOString(),
  };
}

function readinessOf(value: Prisma.JsonValue | null): ReadinessSnapshotData | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as unknown as ReadinessSnapshotData;
}

export function toWorkoutTotals(workout: WorkoutWithRelations, prsBySet: PrsBySet = NO_PRS): WorkoutTotalsData {
  const totals = computeTotals(workout.exercises.flatMap((exercise) => exercise.sets));

  const earned: EarnedPr[] = [];
  for (const entry of workout.exercises) {
    for (const set of entry.sets) {
      for (const pr of prsBySet.get(set.id) ?? []) {
        earned.push({
          exerciseId: entry.exerciseId,
          exerciseName: entry.exercise.name,
          workoutExerciseId: entry.id,
          setId: set.id,
          setNumber: set.setNumber,
          position: entry.position,
          pr,
        });
      }
    }
  }

  return {
    durationSeconds: workout.durationSeconds,
    exerciseCount: workout.exercises.length,
    ...totals,
    prs: bestPerType(earned),
  };
}

export function toWorkoutView(workout: WorkoutWithRelations, prsBySet: PrsBySet = NO_PRS): WorkoutViewData {
  return {
    id: workout.id,
    name: workout.name,
    date: fromDbDate(workout.date),
    status: workout.status as WorkoutStatus,
    startedAt: workout.startedAt.toISOString(),
    endedAt: workout.endedAt ? workout.endedAt.toISOString() : null,
    durationSeconds: workout.durationSeconds,
    gymId: workout.gymId,
    gym: workout.gym,
    notes: workout.notes,
    programWorkoutId: workout.programWorkoutId,
    readinessSnapshot: readinessOf(workout.readinessSnapshot),
    exercises: workout.exercises.map((entry) => toWorkoutExerciseView(entry, prsBySet)),
    summary: toWorkoutTotals(workout, prsBySet),
    createdAt: workout.createdAt.toISOString(),
    updatedAt: workout.updatedAt.toISOString(),
  };
}

export function toWorkoutListItem(workout: WorkoutListRow): WorkoutListItemData {
  const totals = computeTotals(workout.exercises.flatMap((exercise) => exercise.sets));
  return {
    id: workout.id,
    name: workout.name,
    date: fromDbDate(workout.date),
    status: workout.status as WorkoutStatus,
    startedAt: workout.startedAt.toISOString(),
    endedAt: workout.endedAt ? workout.endedAt.toISOString() : null,
    durationSeconds: workout.durationSeconds,
    gym: workout.gym,
    exerciseCount: workout.exercises.length,
    setCount: totals.setCount,
    volumeKg: totals.volumeKg,
    exercises: workout.exercises.map(({ exercise }) => ({ id: exercise.id, name: exercise.name })),
  };
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export function workoutNotFound(): NotFoundException {
  return new NotFoundException('Workout not found');
}

export function workoutExerciseNotFound(): NotFoundException {
  return new NotFoundException('Workout exercise not found');
}

export function setNotFound(): NotFoundException {
  return new NotFoundException('Set not found');
}

/** A refusal with a machine-readable `details.reason` (and a `path` when a field is at fault). */
export function workoutRefusal(
  status: 400 | 409,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): BadRequestException | ConflictException {
  const body = { message, details: { reason, ...extra } };
  return status === 400 ? new BadRequestException(body) : new ConflictException(body);
}
