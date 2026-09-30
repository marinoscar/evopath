import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import { CheckInsService } from '../check-ins/check-ins.service';
import { addDays, fromDbDate, toDbDate } from '../check-ins/local-date';
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
import type { WorkoutSummaryData, WorkoutSummaryQuery } from './dto/workout-summary.dto';
import {
  computeTotals,
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
import { WORKOUT_FINISHED_EVENT, type WorkoutFinishedEvent } from './workout-events';
import { WorkoutHistoryService } from './workout-history.service';
import { lockOwnedWorkout } from './workout-lock';
import { WorkoutPhotoStorageService } from './workout-photo-storage.service';
import { daysBetween, isoWeekStart, topLifts } from './workout-summary';
import {
  MAX_EXERCISES_PER_WORKOUT,
  MAX_SETS_PER_EXERCISE,
  WORKOUT_DATE_WINDOW_DAYS,
  WORKOUT_FUTURE_SKEW_MS,
  WORKOUT_NAME_MAX,
  WORKOUT_REFUSALS,
} from './workouts.constants';

/** A workout started from a plan (E5.7): exercises in order, each with its prefilled sets. */
export interface PrefilledWorkoutInput {
  name: string;
  /** The local calendar day, `YYYY-MM-DD`, already validated by the caller. */
  date: string;
  gymId: string | null;
  programWorkoutId: string | null;
  exercises: Array<{
    exerciseId: string;
    equipmentTypeId: string | null;
    sets: Array<{ setNumber: number; weightKg: number | null; reps: number | null }>;
  }>;
}

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
    // Optional for the same reason: `workout.finished` is only emitted when present.
    @Optional() private readonly events?: EventEmitter2,
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

  /**
   * Creates an in-progress workout with its exercises and UNCOMPLETED sets
   * inside the caller's transaction: the seam a planned session (E5.7) starts
   * through, so the programs module never writes E4 tables. The caller
   * validates `date`; this checks the gym belongs to the caller (404) and the
   * per-workout limits (400).
   *
   * One in-progress workout per user still holds: when
   * `workouts_user_in_progress_uniq_idx` refuses the insert, the unique
   * violation (P2002) propagates unchanged. The caller's transaction is then
   * aborted, so the caller reads the winner outside it.
   */
  async startPrefilled(
    tx: Prisma.TransactionClient,
    userId: string,
    input: PrefilledWorkoutInput,
    now: Date = new Date(),
  ): Promise<{ id: string }> {
    if (input.exercises.length > MAX_EXERCISES_PER_WORKOUT) {
      throw workoutRefusal(400, WORKOUT_REFUSALS.WORKOUT_EXERCISE_LIMIT, `A workout holds at most ${MAX_EXERCISES_PER_WORKOUT} exercises`);
    }
    if (input.exercises.some((exercise) => exercise.sets.length > MAX_SETS_PER_EXERCISE)) {
      throw workoutRefusal(400, WORKOUT_REFUSALS.WORKOUT_SET_LIMIT, `An exercise holds at most ${MAX_SETS_PER_EXERCISE} sets`);
    }
    if (input.gymId) await this.gyms.findOwned(userId, input.gymId, tx);

    const readinessSnapshot = await this.readinessSnapshot(userId);

    return tx.workout.create({
      data: {
        userId,
        name: input.name.slice(0, WORKOUT_NAME_MAX),
        date: toDbDate(input.date),
        status: 'in_progress',
        startedAt: now,
        gymId: input.gymId,
        programWorkoutId: input.programWorkoutId,
        readinessSnapshot: readinessSnapshot ? (readinessSnapshot as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        exercises: {
          create: input.exercises.map((exercise, position) => ({
            exerciseId: exercise.exerciseId,
            position,
            equipmentTypeId: exercise.equipmentTypeId,
            sets: {
              create: exercise.sets.map((set) => ({
                setNumber: set.setNumber,
                weightKg: set.weightKg,
                reps: set.reps,
                completed: false,
              })),
            },
          })),
        },
      },
      select: { id: true },
    });
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
    const finished = await this.prisma.$transaction(async (tx) => {
      const workout = await lockOwnedWorkout(tx, userId, workoutId);

      if (workout.status === 'completed') {
        return false;
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

      return true;
    });

    // After commit, outside the transaction; only when this call finished it.
    if (finished) this.emitFinished({ userId, workoutId });

    return this.get(userId, workoutId);
  }

  /** `workout.finished` for its listeners. A listener's failure never fails the finish. */
  private emitFinished(event: WorkoutFinishedEvent): void {
    try {
      this.events?.emit(WORKOUT_FINISHED_EVENT, event);
    } catch (error) {
      this.logger.warn(
        `A ${WORKOUT_FINISHED_EVENT} listener threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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

  /**
   * The Today page's training card (E4.6): the workout in progress, the last
   * completed workout with its totals and top lifts, and this ISO week's
   * completed-workout count. `query.today` is the client's local day (within
   * 2 days of the server's today, else 400 `TODAY_OUT_OF_RANGE`); without it,
   * today in the Health Profile time zone (UTC when unset).
   *
   * Three owner-scoped reads: the in-progress workout (`user_id, status`), the
   * latest completed one with its sets (`user_id, date desc`) and the week's
   * count. No PR data: the card does not show it and it would cost a history scan.
   */
  async summary(userId: string, query: WorkoutSummaryQuery, now: Date = new Date()): Promise<WorkoutSummaryData> {
    const serverToday = await this.checkIns.today(userId, now);
    let today = serverToday;

    if (query.today !== undefined) {
      if (Math.abs(daysBetween(serverToday, query.today)) > WORKOUT_DATE_WINDOW_DAYS) {
        throw workoutRefusal(
          400,
          WORKOUT_REFUSALS.TODAY_OUT_OF_RANGE,
          `today must be within ${WORKOUT_DATE_WINDOW_DAYS} days of the server's today (${serverToday})`,
          { path: 'today', today: serverToday },
        );
      }
      today = query.today;
    }

    const weekStart = isoWeekStart(today);
    const weekEnd = addDays(weekStart, 6);

    const [inProgress, last, workoutCount] = await Promise.all([
      this.prisma.workout.findFirst({
        where: { userId, status: 'in_progress' },
        select: {
          id: true,
          name: true,
          startedAt: true,
          gym: { select: { id: true, name: true } },
          exercises: { select: { _count: { select: { sets: { where: { completed: true } } } } } },
        },
      }),
      this.prisma.workout.findFirst({
        where: { userId, status: 'completed' },
        orderBy: [{ date: 'desc' }, { startedAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          name: true,
          date: true,
          durationSeconds: true,
          gym: { select: { id: true, name: true } },
          exercises: {
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
            select: {
              exercise: { select: { name: true } },
              sets: {
                select: { setNumber: true, weightKg: true, reps: true, completed: true, isWarmup: true },
              },
            },
          },
        },
      }),
      this.prisma.workout.count({
        where: { userId, status: 'completed', date: { gte: toDbDate(weekStart), lte: toDbDate(weekEnd) } },
      }),
    ]);

    let lastData: WorkoutSummaryData['last'] = null;
    let daysSinceLast: number | null = null;
    if (last) {
      const date = fromDbDate(last.date);
      const totals = computeTotals(last.exercises.flatMap((entry) => entry.sets));
      lastData = {
        id: last.id,
        name: last.name,
        date,
        durationSeconds: last.durationSeconds,
        gym: last.gym,
        exerciseCount: last.exercises.length,
        setCount: totals.setCount,
        volumeKg: totals.volumeKg,
        topLifts: topLifts(last.exercises),
      };
      daysSinceLast = Math.max(0, daysBetween(date, today));
    }

    return {
      inProgress: inProgress
        ? {
            id: inProgress.id,
            name: inProgress.name,
            startedAt: inProgress.startedAt.toISOString(),
            gym: inProgress.gym,
            exerciseCount: inProgress.exercises.length,
            completedSetCount: inProgress.exercises.reduce((sum, entry) => sum + entry._count.sets, 0),
          }
        : null,
      last: lastData,
      thisWeek: { workoutCount, weekStart },
      daysSinceLast,
    };
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
