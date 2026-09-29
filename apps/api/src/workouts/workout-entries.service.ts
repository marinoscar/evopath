import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { exerciseNotFound } from '../exercises/exercise-views';
import { isUniqueViolation } from '../gyms/gym-views';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AddWorkoutExerciseInput,
  CreateSetInput,
  SetLogViewData,
  UpdateSetInput,
  UpdateWorkoutExerciseInput,
  WorkoutExerciseViewData,
} from './dto/workout.dto';
import { lockOwnedWorkout } from './workout-lock';
import {
  WORKOUT_EXERCISE_INCLUDE,
  denseRenumber,
  deriveRestSeconds,
  moveItem,
  setNotFound,
  toSetLogView,
  toWorkoutExerciseView,
  workoutExerciseNotFound,
  workoutRefusal,
} from './workout-mapper';
import { MAX_EXERCISES_PER_WORKOUT, MAX_SETS_PER_EXERCISE, WORKOUT_REFUSALS } from './workouts.constants';

// =============================================================================
// WorkoutEntriesService — a workout's exercises and sets (E4.2)
// =============================================================================
//
// Every write locks the workout row first (`lockOwnedWorkout`), which is also
// the owner check: a foreign workout is a 404. Under that lock the limits are
// counted, `setNumber` is allocated (max + 1) and positions / set numbers are
// renumbered densely, so concurrent taps cannot leave gaps or duplicates.
//
// Editing a completed workout's exercises and sets is allowed (fixing a typo
// after the session is normal).
// =============================================================================

/** The set fields an omitted value is copied for from the previous set. */
const COPIED_FIELDS = ['weightKg', 'reps', 'durationSeconds', 'distanceMeters'] as const;

@Injectable()
export class WorkoutEntriesService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Exercises
  // ---------------------------------------------------------------------------

  /**
   * Adds a library exercise or one of the caller's active custom exercises.
   * Appends unless `position` is given (then inserts there and shifts the rest).
   */
  async addExercise(userId: string, workoutId: string, input: AddWorkoutExerciseInput): Promise<WorkoutExerciseViewData> {
    const exercise = await this.prisma.exercise.findFirst({
      where: { id: input.exerciseId, OR: [{ ownerUserId: null }, { ownerUserId: userId }] },
      select: { id: true, status: true },
    });

    if (!exercise) {
      throw exerciseNotFound();
    }

    if (exercise.status !== 'active') {
      throw workoutRefusal(
        409,
        WORKOUT_REFUSALS.EXERCISE_PENDING_REVIEW,
        'This exercise was proposed by AI and awaits your approval; approve it before logging it',
      );
    }

    if (input.equipmentTypeId) {
      await this.assertEquipmentType(userId, input.equipmentTypeId);
    }

    const id = await this.prisma.$transaction(async (tx) => {
      await lockOwnedWorkout(tx, userId, workoutId);

      const count = await tx.workoutExercise.count({ where: { workoutId } });
      if (count >= MAX_EXERCISES_PER_WORKOUT) {
        throw workoutRefusal(
          400,
          WORKOUT_REFUSALS.WORKOUT_EXERCISE_LIMIT,
          `A workout can have at most ${MAX_EXERCISES_PER_WORKOUT} exercises`,
          { max: MAX_EXERCISES_PER_WORKOUT },
        );
      }

      const position = input.position === undefined ? count : Math.min(input.position, count);
      if (position < count) {
        await tx.workoutExercise.updateMany({
          where: { workoutId, position: { gte: position } },
          data: { position: { increment: 1 } },
        });
      }

      const created = await tx.workoutExercise.create({
        data: {
          workoutId,
          exerciseId: exercise.id,
          position,
          equipmentTypeId: input.equipmentTypeId ?? null,
          notes: input.notes ?? null,
        },
        select: { id: true },
      });
      return created.id;
    });

    return this.exerciseView(id);
  }

  /** Reorders (dense 0..n-1), and edits notes or the equipment used. */
  async updateExercise(
    userId: string,
    workoutId: string,
    workoutExerciseId: string,
    input: UpdateWorkoutExerciseInput,
  ): Promise<WorkoutExerciseViewData> {
    if (input.equipmentTypeId) {
      await this.assertEquipmentType(userId, input.equipmentTypeId);
    }

    await this.prisma.$transaction(async (tx) => {
      await lockOwnedWorkout(tx, userId, workoutId);

      const entries = await tx.workoutExercise.findMany({
        where: { workoutId },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, position: true },
      });

      const from = entries.findIndex((entry) => entry.id === workoutExerciseId);
      if (from === -1) {
        throw workoutExerciseNotFound();
      }

      if (input.position !== undefined) {
        const ordered = moveItem(entries, from, input.position);
        for (const change of denseRenumber(ordered, (entry) => entry.position, 0)) {
          await tx.workoutExercise.update({ where: { id: change.id }, data: { position: change.to } });
        }
      }

      const data: Prisma.WorkoutExerciseUncheckedUpdateInput = {};
      if (input.notes !== undefined) data.notes = input.notes;
      if (input.equipmentTypeId !== undefined) data.equipmentTypeId = input.equipmentTypeId;
      if (Object.keys(data).length > 0) {
        await tx.workoutExercise.update({ where: { id: workoutExerciseId }, data });
      }
    });

    return this.exerciseView(workoutExerciseId);
  }

  /** Removes the exercise and its sets; the remaining positions are renumbered. */
  async removeExercise(userId: string, workoutId: string, workoutExerciseId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockOwnedWorkout(tx, userId, workoutId);

      const { count } = await tx.workoutExercise.deleteMany({ where: { id: workoutExerciseId, workoutId } });
      if (count === 0) {
        throw workoutExerciseNotFound();
      }

      const remaining = await tx.workoutExercise.findMany({
        where: { workoutId },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, position: true },
      });
      for (const change of denseRenumber(remaining, (entry) => entry.position, 0)) {
        await tx.workoutExercise.update({ where: { id: change.id }, data: { position: change.to } });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Sets
  // ---------------------------------------------------------------------------

  /**
   * Appends a set (`setNumber` = max + 1). An omitted weight, reps, time or
   * distance is copied from the exercise's previous set, so "add set" is one
   * tap; an explicit null leaves it empty.
   */
  async addSet(
    userId: string,
    workoutId: string,
    workoutExerciseId: string,
    input: CreateSetInput,
    now: Date = new Date(),
  ): Promise<SetLogViewData> {
    const attempt = () =>
      this.prisma.$transaction(async (tx) => {
        await lockOwnedWorkout(tx, userId, workoutId);

        const entry = await tx.workoutExercise.findFirst({ where: { id: workoutExerciseId, workoutId }, select: { id: true } });
        if (!entry) {
          throw workoutExerciseNotFound();
        }

        const count = await tx.setLog.count({ where: { workoutExerciseId } });
        if (count >= MAX_SETS_PER_EXERCISE) {
          throw workoutRefusal(
            400,
            WORKOUT_REFUSALS.WORKOUT_SET_LIMIT,
            `An exercise can have at most ${MAX_SETS_PER_EXERCISE} sets`,
            { max: MAX_SETS_PER_EXERCISE },
          );
        }

        const previous = await tx.setLog.findFirst({
          where: { workoutExerciseId },
          orderBy: { setNumber: 'desc' },
          select: { setNumber: true, weightKg: true, reps: true, durationSeconds: true, distanceMeters: true },
        });

        const copied: Record<(typeof COPIED_FIELDS)[number], unknown> = {
          weightKg: null,
          reps: null,
          durationSeconds: null,
          distanceMeters: null,
        };
        for (const field of COPIED_FIELDS) {
          copied[field] = input[field] !== undefined ? input[field] : (previous?.[field] ?? null);
        }

        const completed = input.completed ?? false;
        let restSeconds = input.restSeconds ?? null;
        if (completed && input.restSeconds === undefined) {
          restSeconds = deriveRestSeconds(await lastCompletionIn(tx, workoutId, now, null), now);
        }

        const created = await tx.setLog.create({
          data: {
            workoutExerciseId,
            setNumber: (previous?.setNumber ?? 0) + 1,
            weightKg: copied.weightKg as number | Prisma.Decimal | null,
            reps: copied.reps as number | null,
            durationSeconds: copied.durationSeconds as number | null,
            distanceMeters: copied.distanceMeters as number | Prisma.Decimal | null,
            rpe: input.rpe ?? null,
            rir: input.rir ?? null,
            restSeconds,
            isWarmup: input.isWarmup ?? false,
            completed,
            completedAt: completed ? now : null,
            painFlag: input.painFlag ?? false,
            painNote: input.painNote ?? null,
            notes: input.notes ?? null,
          },
        });
        return toSetLogView(created);
      });

    try {
      return await attempt();
    } catch (error) {
      // The workout lock serializes allocation; one retry covers anything else.
      if (isUniqueViolation(error)) {
        return attempt();
      }
      throw error;
    }
  }

  /**
   * Edits a set. `completed: true` stamps `completedAt` and, when the set has
   * no rest recorded, derives it from the workout's previous completion if
   * that is under 15 minutes old; `completed: false` clears `completedAt`.
   */
  async updateSet(
    userId: string,
    workoutId: string,
    setId: string,
    input: UpdateSetInput,
    now: Date = new Date(),
  ): Promise<SetLogViewData> {
    return this.prisma.$transaction(async (tx) => {
      await lockOwnedWorkout(tx, userId, workoutId);

      const set = await tx.setLog.findFirst({ where: { id: setId, workoutExercise: { workoutId } } });
      if (!set) {
        throw setNotFound();
      }

      const data: Prisma.SetLogUncheckedUpdateInput = {};
      if (input.weightKg !== undefined) data.weightKg = input.weightKg;
      if (input.reps !== undefined) data.reps = input.reps;
      if (input.durationSeconds !== undefined) data.durationSeconds = input.durationSeconds;
      if (input.distanceMeters !== undefined) data.distanceMeters = input.distanceMeters;
      if (input.rpe !== undefined) data.rpe = input.rpe;
      if (input.rir !== undefined) data.rir = input.rir;
      if (input.restSeconds !== undefined) data.restSeconds = input.restSeconds;
      if (input.isWarmup !== undefined) data.isWarmup = input.isWarmup;
      if (input.painFlag !== undefined) data.painFlag = input.painFlag;
      if (input.painNote !== undefined) data.painNote = input.painNote;
      if (input.notes !== undefined) data.notes = input.notes;

      if (input.completed === true && !set.completed) {
        data.completed = true;
        data.completedAt = now;
        const rest = input.restSeconds !== undefined ? input.restSeconds : set.restSeconds;
        if (rest === null) {
          data.restSeconds = deriveRestSeconds(await lastCompletionIn(tx, workoutId, now, setId), now);
        }
      } else if (input.completed === false) {
        data.completed = false;
        data.completedAt = null;
      }

      const updated = await tx.setLog.update({ where: { id: setId }, data });
      return toSetLogView(updated);
    });
  }

  /** Deletes a set; the exercise's remaining set numbers are renumbered 1..n. */
  async removeSet(userId: string, workoutId: string, setId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockOwnedWorkout(tx, userId, workoutId);

      const set = await tx.setLog.findFirst({
        where: { id: setId, workoutExercise: { workoutId } },
        select: { id: true, workoutExerciseId: true },
      });
      if (!set) {
        throw setNotFound();
      }

      await tx.setLog.delete({ where: { id: setId } });

      const remaining = await tx.setLog.findMany({
        where: { workoutExerciseId: set.workoutExerciseId },
        orderBy: { setNumber: 'asc' },
        select: { id: true, setNumber: true },
      });
      for (const change of denseRenumber(remaining, (row) => row.setNumber, 1)) {
        await tx.setLog.update({ where: { id: change.id }, data: { setNumber: change.to } });
      }
    });
  }

  // ---------------------------------------------------------------------------

  private async exerciseView(workoutExerciseId: string): Promise<WorkoutExerciseViewData> {
    const row = await this.prisma.workoutExercise.findUnique({
      where: { id: workoutExerciseId },
      include: WORKOUT_EXERCISE_INCLUDE,
    });

    if (!row) {
      throw workoutExerciseNotFound();
    }

    return toWorkoutExerciseView(row);
  }

  /** A catalog equipment type or the caller's custom one; otherwise 404. */
  private async assertEquipmentType(userId: string, equipmentTypeId: string): Promise<void> {
    const found = await this.prisma.equipmentType.findFirst({
      where: { id: equipmentTypeId, OR: [{ ownerUserId: null }, { ownerUserId: userId }] },
      select: { id: true },
    });

    if (!found) {
      throw new NotFoundException('Equipment type not found');
    }
  }
}

/** The most recent completion in the workout at or before `now`, other than `excludeSetId`. */
async function lastCompletionIn(
  tx: Prisma.TransactionClient,
  workoutId: string,
  now: Date,
  excludeSetId: string | null,
): Promise<Date | null> {
  const previous = await tx.setLog.findFirst({
    where: {
      workoutExercise: { workoutId },
      completed: true,
      completedAt: { not: null, lte: now },
      ...(excludeSetId ? { id: { not: excludeSetId } } : {}),
    },
    orderBy: { completedAt: 'desc' },
    select: { completedAt: true },
  });

  return previous?.completedAt ?? null;
}
