import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { CheckInsService } from '../check-ins/check-ins.service';
import { addDays, toDbDate } from '../check-ins/local-date';
import { GymsService } from '../gyms/gyms.service';
import { isUniqueViolation } from '../gyms/gym-views';
import { PrismaService } from '../prisma/prisma.service';
import type {
  FinishWorkoutInput,
  ListWorkoutsQuery,
  ReadinessSnapshotData,
  StartWorkoutInput,
  StartWorkoutResultData,
  UpdateWorkoutInput,
  WorkoutListData,
  WorkoutViewData,
} from './dto/workout.dto';
import {
  WORKOUT_INCLUDE,
  WORKOUT_LIST_INCLUDE,
  type WorkoutWithRelations,
  defaultWorkoutName,
  denseRenumber,
  durationBetween,
  toWorkoutListItem,
  toWorkoutView,
  workoutNotFound,
  workoutRefusal,
} from './workout-mapper';
import { WorkoutHistoryService } from './workout-history.service';
import { lockOwnedWorkout } from './workout-lock';
import { WorkoutPhotoStorageService } from './workout-photo-storage.service';
import { WORKOUT_DATE_WINDOW_DAYS, WORKOUT_FUTURE_SKEW_MS, WORKOUT_REFUSALS } from './workouts.constants';

// =============================================================================
// WorkoutsService — start, list, read, edit, finish and delete workouts (E4.2)
// =============================================================================
//
// Owner-scoped: every query filters by the caller's id; another user's workout
// is a 404, never a 403.
//
// ONE IN-PROGRESS WORKOUT PER USER is decided by the partial unique index
// `workouts_user_in_progress_uniq_idx` (migration SQL, intentional drift).
// `start` just inserts; when the index refuses (P2002) it reads the winner and
// answers it with `existing: true`. There is deliberately no findFirst
// pre-check: two taps or two tabs would both pass it.
//
// UNITS. Weights are kilograms and distances metres in and out; the web
// converts for display from the Health Profile `unitSystem`.
// =============================================================================

@Injectable()
export class WorkoutsService {
  private readonly logger = new Logger(WorkoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gyms: GymsService,
    private readonly checkIns: CheckInsService,
    private readonly history: WorkoutHistoryService,
    // Optional so a hand-built service (tests) needs none; Nest always injects it.
    @Optional() private readonly photoStorage?: WorkoutPhotoStorageService,
  ) {}

  /**
   * Starts an ad-hoc workout. `existing: true` when the caller already had a
   * workout in progress: that one is returned and nothing is created.
   */
  async start(userId: string, input: StartWorkoutInput, now: Date = new Date()): Promise<StartWorkoutResultData> {
    const today = await this.checkIns.today(userId, now);
    const date = input.date ?? today;

    if (input.date !== undefined) {
      const earliest = addDays(today, -WORKOUT_DATE_WINDOW_DAYS);
      const latest = addDays(today, WORKOUT_DATE_WINDOW_DAYS);
      if (date < earliest || date > latest) {
        throw workoutRefusal(
          400,
          WORKOUT_REFUSALS.WORKOUT_DATE_OUT_OF_RANGE,
          `date must be within ${WORKOUT_DATE_WINDOW_DAYS} days of today (${today})`,
          { path: 'date', today },
        );
      }
    }

    const startedAt = input.startedAt ? new Date(input.startedAt) : now;
    assertNotInFuture(startedAt, now, 'startedAt');

    const gymId = input.gymId
      ? (await this.gyms.findOwned(userId, input.gymId)).id
      : ((await this.prisma.gym.findFirst({ where: { userId, isDefault: true }, select: { id: true } }))?.id ?? null);

    const readinessSnapshot = await this.readinessSnapshot(userId);

    const data: Prisma.WorkoutUncheckedCreateInput = {
      userId,
      name: input.name ?? defaultWorkoutName(date),
      date: toDbDate(date),
      status: 'in_progress',
      startedAt,
      gymId,
      readinessSnapshot: readinessSnapshot ? (readinessSnapshot as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    };

    // Two attempts: the in-progress winner may finish between our failed
    // insert and the read, in which case the retry inserts cleanly.
    for (let attempt = 0; ; attempt += 1) {
      try {
        const created = await this.prisma.workout.create({ data, include: WORKOUT_INCLUDE });
        return { ...(await this.view(userId, created)), existing: false };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;

        const winner = await this.prisma.workout.findFirst({
          where: { userId, status: 'in_progress' },
          include: WORKOUT_INCLUDE,
        });
        if (winner) {
          return { ...(await this.view(userId, winner)), existing: true };
        }
        if (attempt >= 1) throw error;
      }
    }
  }

  async list(userId: string, query: ListWorkoutsQuery): Promise<WorkoutListData> {
    const date: Prisma.DateTimeFilter = {};
    if (query.from) date.gte = toDbDate(query.from);
    if (query.to) date.lte = toDbDate(query.to);

    const where: Prisma.WorkoutWhereInput = {
      userId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.gymId ? { gymId: query.gymId } : {}),
      ...(query.from || query.to ? { date } : {}),
      ...(query.exerciseId ? { exercises: { some: { exerciseId: query.exerciseId } } } : {}),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.workout.count({ where }),
      this.prisma.workout.findMany({
        where,
        orderBy: [{ date: 'desc' }, { startedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: WORKOUT_LIST_INCLUDE,
      }),
    ]);

    return {
      items: rows.map(toWorkoutListItem),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async get(userId: string, workoutId: string): Promise<WorkoutViewData> {
    const workout = await this.prisma.workout.findFirst({ where: { id: workoutId, userId }, include: WORKOUT_INCLUDE });

    if (!workout) {
      throw workoutNotFound();
    }

    return this.view(userId, workout);
  }

  /** Edits a workout, in progress or completed. */
  async update(userId: string, workoutId: string, input: UpdateWorkoutInput, now: Date = new Date()): Promise<WorkoutViewData> {
    const workout = await this.prisma.workout.findFirst({ where: { id: workoutId, userId } });

    if (!workout) {
      throw workoutNotFound();
    }

    if ((input.endedAt !== undefined || input.durationSeconds !== undefined) && workout.status !== 'completed') {
      throw workoutRefusal(
        400,
        WORKOUT_REFUSALS.WORKOUT_NOT_COMPLETED,
        'endedAt and durationSeconds can be set only on a completed workout; finish it instead',
      );
    }

    if (input.gymId) {
      await this.gyms.findOwned(userId, input.gymId);
    }

    if (input.date !== undefined) {
      const today = await this.checkIns.today(userId, now);
      const latest = addDays(today, WORKOUT_DATE_WINDOW_DAYS);
      if (input.date > latest) {
        throw workoutRefusal(
          400,
          WORKOUT_REFUSALS.WORKOUT_DATE_OUT_OF_RANGE,
          `date must not be more than ${WORKOUT_DATE_WINDOW_DAYS} days after today (${today})`,
          { path: 'date', today },
        );
      }
    }

    const startedAt = input.startedAt !== undefined ? new Date(input.startedAt) : workout.startedAt;
    const endedAt = input.endedAt !== undefined ? new Date(input.endedAt) : workout.endedAt;
    if (input.startedAt !== undefined) assertNotInFuture(startedAt, now, 'startedAt');
    if (input.endedAt !== undefined) assertNotInFuture(endedAt!, now, 'endedAt');
    if (endedAt && endedAt < startedAt) {
      throw workoutRefusal(400, WORKOUT_REFUSALS.ENDED_BEFORE_STARTED, 'endedAt must not be before startedAt', {
        path: input.endedAt !== undefined ? 'endedAt' : 'startedAt',
      });
    }

    const data: Prisma.WorkoutUncheckedUpdateManyInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.notes !== undefined) data.notes = input.notes;
    if (input.gymId !== undefined) data.gymId = input.gymId;
    if (input.date !== undefined) data.date = toDbDate(input.date);
    if (input.startedAt !== undefined) data.startedAt = startedAt;
    if (input.endedAt !== undefined) data.endedAt = endedAt;
    if (input.durationSeconds !== undefined) {
      data.durationSeconds = input.durationSeconds;
    } else if (workout.status === 'completed' && endedAt && (input.startedAt !== undefined || input.endedAt !== undefined)) {
      data.durationSeconds = durationBetween(startedAt, endedAt);
    }

    const { count } = await this.prisma.workout.updateMany({ where: { id: workoutId, userId }, data });

    if (count === 0) {
      throw workoutNotFound();
    }

    return this.get(userId, workoutId);
  }

  /**
   * `in_progress` -> `completed`. Deletes uncompleted sets that hold no value
   * (weight, reps, time, distance) and renumbers the rest densely; uncompleted
   * sets with values stay uncompleted. Idempotent on a completed workout.
   */
  async finish(userId: string, workoutId: string, input: FinishWorkoutInput, now: Date = new Date()): Promise<WorkoutViewData> {
    await this.prisma.$transaction(async (tx) => {
      const workout = await lockOwnedWorkout(tx, userId, workoutId);

      if (workout.status === 'completed') {
        return;
      }

      let endedAt: Date;
      if (input.endedAt !== undefined) {
        endedAt = new Date(input.endedAt);
        assertNotInFuture(endedAt, now, 'endedAt');
        if (endedAt < workout.startedAt) {
          throw workoutRefusal(400, WORKOUT_REFUSALS.ENDED_BEFORE_STARTED, 'endedAt must not be before startedAt', {
            path: 'endedAt',
          });
        }
      } else {
        // A startedAt inside the tolerated clock skew may lie a moment ahead.
        endedAt = now < workout.startedAt ? workout.startedAt : now;
      }

      await tx.setLog.deleteMany({
        where: {
          workoutExercise: { workoutId },
          completed: false,
          weightKg: null,
          reps: null,
          durationSeconds: null,
          distanceMeters: null,
        },
      });

      await renumberAllSets(tx, workoutId);

      await tx.workout.update({
        where: { id: workoutId },
        data: {
          status: 'completed',
          endedAt,
          durationSeconds: durationBetween(workout.startedAt, endedAt),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
      });
    });

    return this.get(userId, workoutId);
  }

  /**
   * Deletes the workout (its exercises, sets and photo links by cascade), then,
   * best effort, the storage objects of its photos that nothing else holds.
   */
  async remove(userId: string, workoutId: string): Promise<void> {
    const photos = await this.prisma.workoutPhoto.findMany({
      where: { workoutId, workout: { userId } },
      select: { storageObjectId: true },
    });
    const { count } = await this.prisma.workout.deleteMany({ where: { id: workoutId, userId } });

    if (count === 0) {
      throw workoutNotFound();
    }

    if (photos.length > 0 && this.photoStorage) {
      await this.photoStorage.deleteObjects(
        userId,
        photos.map((photo) => photo.storageObjectId),
      );
    }
  }

  // ---------------------------------------------------------------------------

  /** The view with each completed set's `prs` and the `summary.prs` (E4.4). */
  private async view(userId: string, workout: WorkoutWithRelations): Promise<WorkoutViewData> {
    return toWorkoutView(workout, await this.history.prsForWorkout(userId, workout));
  }

  /**
   * Today's readiness check-in copied by value, or null. Informational only:
   * a failure to read it never blocks starting a workout.
   */
  private async readinessSnapshot(userId: string): Promise<ReadinessSnapshotData | null> {
    try {
      const { checkIn } = await this.checkIns.getToday(userId);
      if (!checkIn) return null;
      return {
        date: checkIn.date,
        energy: checkIn.energy,
        sleepQuality: checkIn.sleepQuality,
        soreness: checkIn.soreness,
        stress: checkIn.stress,
        note: checkIn.note,
        updatedAt: checkIn.updatedAt,
      };
    } catch (error) {
      // Ids only; never a score or the note.
      this.logger.warn(
        `Could not snapshot readiness for user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}

function assertNotInFuture(instant: Date, now: Date, path: string): void {
  if (instant.getTime() > now.getTime() + WORKOUT_FUTURE_SKEW_MS) {
    throw workoutRefusal(400, WORKOUT_REFUSALS.TIME_IN_FUTURE, `${path} must not be in the future`, { path });
  }
}

/** Makes every exercise's `setNumber`s dense (1..n) again. Call with the workout locked. */
export async function renumberAllSets(tx: Prisma.TransactionClient, workoutId: string): Promise<void> {
  const sets = await tx.setLog.findMany({
    where: { workoutExercise: { workoutId } },
    select: { id: true, workoutExerciseId: true, setNumber: true },
    orderBy: [{ workoutExerciseId: 'asc' }, { setNumber: 'asc' }],
  });

  const byExercise = new Map<string, typeof sets>();
  for (const set of sets) {
    const group = byExercise.get(set.workoutExerciseId) ?? [];
    group.push(set);
    byExercise.set(set.workoutExerciseId, group);
  }

  for (const group of byExercise.values()) {
    for (const change of denseRenumber(group, (set) => set.setNumber, 1)) {
      await tx.setLog.update({ where: { id: change.id }, data: { setNumber: change.to } });
    }
  }
}
