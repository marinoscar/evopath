import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { CheckInsService } from '../check-ins/check-ins.service';
import { fromDbDate, toDbDate } from '../check-ins/local-date';
import { liveTreeOf } from '../programs/plan-diff';
import { loadProgramRows } from '../programs/program-mapper';
import { resolveToday } from '../programs/today/resolve-today';
import { PrismaService } from '../prisma/prisma.service';
import type { QuickCardioInput, QuickCardioResultData } from './dto/quick-cardio.dto';
import { workoutRefusal } from './workout-mapper';
import {
  QUICK_CARDIO_BACKDATE_DAYS,
  WORKOUT_FUTURE_SKEW_MS,
  WORKOUT_NAME_MAX,
  WORKOUT_REFUSALS,
} from './workouts.constants';
import { WorkoutsService } from './workouts.service';

const DAY_MS = 24 * 60 * 60 * 1000;

// =============================================================================
// QuickCardioService — log a gym-free walk, run or hike in one call (E8 F4, #264)
// =============================================================================
//
// `POST /api/workouts/quick-cardio` creates, in ONE transaction, a COMPLETED
// workout with no gym, one exercise (the seeded `distance_time` exercise named
// by `exerciseKey`) and one completed set carrying the duration and/or
// distance. It is created finished, so the one-in-progress-per-user partial
// unique index (`workouts_user_in_progress_uniq_idx`) never sees it: it works
// while another workout is in progress.
//
// LINKING. When the user's active plan has a planned workout on the local day
// of `performedAt` (Health Profile time zone) and that planned workout holds
// the exercise, the workout points at it through `workouts.program_workout_id`,
// the link every reader of planned-versus-done honours (Today's `done`, the
// training signals). Resolution is READ-ONLY over the plan and reuses the pure
// `resolveToday` occurrence rule. No `program_sessions` row is written: that
// row snapshots a prescription at START, and this workout was never started
// from the plan; signals fall back to the live plan's targets without it.
//
// After commit, `workout.finished` is emitted exactly as `finish` emits it, so
// the coach, the plan evaluator and future goal auto-credit react the same way.
// =============================================================================

@Injectable()
export class QuickCardioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checkIns: CheckInsService,
    private readonly workouts: WorkoutsService,
  ) {}

  async log(userId: string, input: QuickCardioInput, now: Date = new Date()): Promise<QuickCardioResultData> {
    const performedAt = input.performedAt ? new Date(input.performedAt) : now;
    if (performedAt.getTime() > now.getTime() + WORKOUT_FUTURE_SKEW_MS) {
      throw workoutRefusal(400, WORKOUT_REFUSALS.TIME_IN_FUTURE, 'performedAt must not be in the future', {
        path: 'performedAt',
      });
    }
    if (performedAt.getTime() < now.getTime() - QUICK_CARDIO_BACKDATE_DAYS * DAY_MS) {
      throw workoutRefusal(
        400,
        WORKOUT_REFUSALS.PERFORMED_AT_OUT_OF_RANGE,
        `performedAt must not be more than ${QUICK_CARDIO_BACKDATE_DAYS} days ago`,
        { path: 'performedAt' },
      );
    }

    const exercise = await this.prisma.exercise.findFirst({
      where: { slug: input.exerciseKey, ownerUserId: null, status: 'active' },
      select: { id: true, name: true },
    });
    if (!exercise) throw new NotFoundException(`Exercise ${input.exerciseKey} is not in the library`);

    const durationSeconds = input.durationSeconds ?? null;
    const distanceMeters = input.distanceMeters ?? null;
    const startedAt = new Date(performedAt.getTime() - (durationSeconds ?? 0) * 1000);
    const date = await this.checkIns.today(userId, performedAt);

    const { workoutId, linkedProgramWorkoutId } = await this.prisma.$transaction(async (tx) => {
      const linked = await plannedWorkoutContaining(tx, userId, exercise.id, date);
      const created = await tx.workout.create({
        data: {
          userId,
          name: exercise.name.slice(0, WORKOUT_NAME_MAX),
          date: toDbDate(date),
          status: 'completed',
          startedAt,
          endedAt: performedAt,
          durationSeconds,
          gymId: null,
          notes: input.note ?? null,
          programWorkoutId: linked,
          readinessSnapshot: Prisma.DbNull,
          exercises: {
            create: [
              {
                exerciseId: exercise.id,
                position: 0,
                sets: {
                  create: [
                    { setNumber: 1, durationSeconds, distanceMeters, completed: true, completedAt: performedAt },
                  ],
                },
              },
            ],
          },
        },
        select: { id: true },
      });
      return { workoutId: created.id, linkedProgramWorkoutId: linked };
    });

    // After commit, outside the transaction.
    this.workouts.emitFinished({ userId, workoutId });

    return { workout: await this.workouts.get(userId, workoutId), linkedProgramWorkoutId };
  }
}

/**
 * The id of the active plan's planned workout on `date` (the user's local
 * day) when it holds `exerciseId`, else null. Read-only. The tree is resolved
 * without its exercises (the occurrence rule needs only weeks and weekdays);
 * the exercises are matched on the raw rows, whatever their prescription shape.
 */
export async function plannedWorkoutContaining(
  db: Prisma.TransactionClient | PrismaService,
  userId: string,
  exerciseId: string,
  date: string,
): Promise<string | null> {
  const program = await db.program.findFirst({
    where: { userId, status: 'active' },
    select: { id: true, status: true, startDate: true },
  });
  if (!program?.startDate) return null;

  const rows = await loadProgramRows(db, program.id);
  const result = resolveToday({
    program: {
      id: program.id,
      status: program.status,
      startDate: fromDbDate(program.startDate),
      tree: liveTreeOf({ ...rows, exercises: [] }),
    },
    today: date,
    completedProgramWorkoutIds: new Set(),
  });
  if (result.kind !== 'workout' || !result.programWorkout.id) return null;

  const programWorkoutId = result.programWorkout.id;
  return rows.exercises.some((row) => row.programWorkoutId === programWorkoutId && row.exerciseId === exerciseId)
    ? programWorkoutId
    : null;
}
