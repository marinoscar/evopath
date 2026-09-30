import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { CheckInsService } from '../../check-ins/check-ins.service';
import { fromDbDate, toDbDate } from '../../check-ins/local-date';
import { ExerciseAvailabilityService, isAvailable, type RequirementRow } from '../../exercises/exercise-availability.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { LoadGuidance, PlanExercise, PlanWorkout } from '../contracts/plan-tree.contract';
import { liveTreeOf } from '../plan-diff';
import { loadProgramRows } from '../program-mapper';
import type { ChangeActor } from '../programs.constants';
import type {
  ProgramWorkoutRefData,
  TodaySessionData,
  TodaySessionExerciseData,
  TrainingTodayData,
} from './dto/training-today.dto';
import { suggestedLoadKg, topSetOf, type LastTimeTopSet } from './planned-session';
import { resolveToday } from './resolve-today';
import { TODAY_DATE_WINDOW_DAYS, TODAY_REASONS } from './training-today.constants';

// =============================================================================
// TrainingTodayService: today's planned workout (E5.7)
// =============================================================================
//
// READ-ONLY over the plan: it resolves which planned workout occurs on the
// client's local day (`resolveToday`, pure) and hydrates it with exercises,
// last-time hints and gym availability. It computes no new prescription.
//
// The only write here is the guarded `active -> completed` flip once the
// plan's last week is over: one `updateMany ... WHERE status = 'active'`, so
// concurrent reads flip it exactly once.
//
// Owner-scoped. No AI: works with AI switched off and for manual plans.
// =============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

type Db = PrismaService | Prisma.TransactionClient;

type LinkedWorkout = { id: string; status: string; programWorkoutId: string | null; startedAt: Date; sessionProgramWorkoutId: string | null };

@Injectable()
export class TrainingTodayService {
  private readonly logger = new Logger(TrainingTodayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly checkIns: CheckInsService,
    private readonly availability: ExerciseAvailabilityService,
  ) {}

  /** 400 `TODAY_OUT_OF_RANGE` unless `date` is within the window of the server's today. */
  async assertDateInWindow(userId: string, date: string, now: Date = new Date()): Promise<void> {
    const serverToday = await this.checkIns.today(userId, now);
    const distance = Math.round(Math.abs(toDbDate(date).getTime() - toDbDate(serverToday).getTime()) / DAY_MS);
    if (distance > TODAY_DATE_WINDOW_DAYS) {
      throw new BadRequestException({
        message: `date must be within ${TODAY_DATE_WINDOW_DAYS} days of today (${serverToday})`,
        details: { reason: TODAY_REASONS.DATE_OUT_OF_RANGE, path: 'date', today: serverToday },
      });
    }
  }

  async today(userId: string, date: string, now: Date = new Date()): Promise<TrainingTodayData> {
    await this.assertDateInWindow(userId, date, now);

    const program = await this.prisma.program.findFirst({
      where: { userId, status: 'active' },
      select: { id: true, name: true, status: true, startDate: true, gymId: true, currentVersion: true },
    });
    if (!program) return { kind: 'no_program', date };

    const tree = liveTreeOf(await loadProgramRows(this.prisma, program.id));
    const workoutIds = tree.blocks.flatMap((block) => block.weeks.flatMap((week) => week.workouts.map((workout) => workout.id!)));
    const linked = await this.linkedWorkouts(userId, workoutIds);
    const completed = new Set(
      linked.filter((row) => row.status === 'completed').flatMap((row) => programWorkoutIdsOf(row)),
    );

    const result = resolveToday({
      program: { id: program.id, status: program.status, startDate: program.startDate ? fromDbDate(program.startDate) : null, tree },
      today: date,
      completedProgramWorkoutIds: completed,
      onWarning: (message) => this.logger.warn(message),
    });
    const programRef = { id: program.id, name: program.name };

    switch (result.kind) {
      case 'no_program':
        return { kind: 'no_program', date };
      case 'not_started':
        return { kind: 'not_started', date, program: programRef, startsOn: result.startsOn };
      case 'program_complete':
        await this.prisma.program.updateMany({ where: { id: program.id, userId, status: 'active' }, data: { status: 'completed' } });
        return { kind: 'program_complete', date, program: programRef };
      case 'rest_day':
        return {
          kind: 'rest_day',
          date,
          program: programRef,
          weekNumber: result.weekNumber,
          totalWeeks: result.totalWeeks,
          next: result.next
            ? { date: result.next.date, weekNumber: result.next.weekNumber, programWorkout: workoutRef(result.next.programWorkout) }
            : null,
        };
      case 'workout': {
        const programWorkoutId = result.programWorkout.id!;
        const mine = linked.filter((row) => programWorkoutIdsOf(row).includes(programWorkoutId));
        const session = await this.session(userId, date, program, result.programWorkout, {
          weekNumber: result.weekNumber,
          totalWeeks: result.totalWeeks,
          isDeload: result.isDeload,
        });
        return {
          kind: 'workout',
          date,
          program: programRef,
          programWorkout: workoutRef(result.programWorkout),
          weekNumber: result.weekNumber,
          totalWeeks: result.totalWeeks,
          isDeload: result.isDeload,
          done: result.done,
          completedWorkoutId: mine.find((row) => row.status === 'completed')?.id ?? null,
          inProgressWorkoutId: mine.find((row) => row.status === 'in_progress')?.id ?? null,
          session,
        };
      }
    }
  }

  /**
   * The caller's workouts linked to any of `programWorkoutIds`, by
   * `workouts.program_workout_id` or by a `program_sessions` row; newest first.
   */
  private async linkedWorkouts(userId: string, programWorkoutIds: string[]): Promise<LinkedWorkout[]> {
    if (programWorkoutIds.length === 0) return [];
    const rows = await this.prisma.workout.findMany({
      where: {
        userId,
        OR: [
          { programWorkoutId: { in: programWorkoutIds } },
          { programSession: { is: { programWorkoutId: { in: programWorkoutIds } } } },
        ],
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, status: true, programWorkoutId: true, startedAt: true, programSession: { select: { programWorkoutId: true } } },
    });
    return rows.map(({ programSession, ...row }) => ({ ...row, sessionProgramWorkoutId: programSession?.programWorkoutId ?? null }));
  }

  private async session(
    userId: string,
    date: string,
    program: { id: string; name: string; gymId: string | null; currentVersion: number },
    workout: PlanWorkout,
    week: { weekNumber: number; totalWeeks: number; isDeload: boolean },
  ): Promise<TodaySessionData> {
    const exerciseIds = [...new Set(workout.exercises.map((exercise) => exercise.exerciseId))];

    const [exercises, lastTimes, availability, unseenChangeCount, lastChange] = await Promise.all([
      exerciseIds.length
        ? this.prisma.exercise.findMany({
            where: { id: { in: exerciseIds } },
            select: { id: true, slug: true, name: true, trackingMode: true, isBodyweight: true, primaryMuscles: true },
          })
        : Promise.resolve([]),
      lastTimeByExercise(this.prisma, userId, exerciseIds, date),
      this.availabilityAtGym(userId, program.gymId, exerciseIds),
      this.prisma.programChangeLog.count({ where: { programId: program.id, actor: 'ai', seenAt: null } }),
      this.prisma.programChangeLog.findFirst({
        where: { programId: program.id, status: 'applied', kind: { not: 'created' } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { summary: true, actor: true, createdAt: true },
      }),
    ]);
    const byId = new Map(exercises.map((row) => [row.id, row]));

    return {
      programId: program.id,
      programName: program.name,
      programWorkoutId: workout.id!,
      name: workout.name,
      weekNumber: week.weekNumber,
      totalWeeks: week.totalWeeks,
      isDeload: week.isDeload,
      estimatedMinutes: workout.estimatedMinutes,
      planVersion: program.currentVersion,
      unseenChangeCount,
      lastChange: lastChange
        ? { summary: lastChange.summary, actor: lastChange.actor as ChangeActor, at: lastChange.createdAt.toISOString() }
        : null,
      exercises: workout.exercises.flatMap((planned): TodaySessionExerciseData[] => {
        const exercise = byId.get(planned.exerciseId);
        if (!exercise) return [];
        const lastTime = lastTimes.get(planned.exerciseId) ?? null;
        return [toSessionExercise(planned, exercise, lastTime, availability ? availability(planned.exerciseId) : null)];
      }),
    };
  }

  /** A per-exercise availability check against the plan's gym, or null when the plan has no gym. */
  private async availabilityAtGym(
    userId: string,
    gymId: string | null,
    exerciseIds: string[],
  ): Promise<((exerciseId: string) => boolean) | null> {
    if (!gymId) return null;
    const [inventory, requirements] = await Promise.all([
      this.availability.forGym(userId, gymId),
      exerciseIds.length
        ? this.prisma.exerciseRequirement.findMany({
            where: { exerciseId: { in: exerciseIds } },
            select: { exerciseId: true, groupIndex: true, equipmentTypeId: true, capabilityId: true },
          })
        : Promise.resolve([]),
    ]);
    const byExercise = new Map<string, RequirementRow[]>();
    for (const row of requirements) {
      const list = byExercise.get(row.exerciseId) ?? [];
      list.push(row);
      byExercise.set(row.exerciseId, list);
    }
    return (exerciseId) => isAvailable(byExercise.get(exerciseId) ?? [], inventory);
  }
}

function programWorkoutIdsOf(row: LinkedWorkout): string[] {
  return [row.programWorkoutId, row.sessionProgramWorkoutId].filter((id): id is string => id !== null);
}

function workoutRef(workout: PlanWorkout): ProgramWorkoutRefData {
  return { id: workout.id!, name: workout.name, weekday: workout.weekday!, estimatedMinutes: workout.estimatedMinutes };
}

function toSessionExercise(
  planned: PlanExercise,
  exercise: { id: string; slug: string; name: string; trackingMode: string; isBodyweight: boolean; primaryMuscles: string[] },
  lastTime: LastTimeTopSet | null,
  availableAtGym: boolean | null,
): TodaySessionExerciseData {
  return {
    programExerciseId: planned.id!,
    exercise,
    isPriority: planned.isPriority,
    sets: planned.targetSets,
    repMin: planned.repMin,
    repMax: planned.repMax,
    targetRpe: planned.targetRpe,
    restSeconds: planned.restSeconds,
    loadGuidance: planned.loadGuidance as LoadGuidance,
    targetLoadKg: planned.targetLoadKg,
    suggestedLoadKg: suggestedLoadKg(planned, lastTime),
    rationale: planned.rationale,
    lastTime,
    availableAtGym,
  };
}

/**
 * The most recent completed workout on or before `date` in which the caller
 * completed a set of each exercise, with its top set. One indexed read per
 * exercise (at most 20 per planned workout).
 */
export async function lastTimeByExercise(
  db: Db,
  userId: string,
  exerciseIds: readonly string[],
  date: string,
): Promise<Map<string, LastTimeTopSet>> {
  const entries = await Promise.all(
    exerciseIds.map(async (exerciseId) => {
      const workout = await db.workout.findFirst({
        where: {
          userId,
          status: 'completed',
          date: { lte: toDbDate(date) },
          exercises: { some: { exerciseId, sets: { some: { completed: true } } } },
        },
        orderBy: [{ date: 'desc' }, { startedAt: 'desc' }, { id: 'desc' }],
        select: {
          date: true,
          exercises: {
            where: { exerciseId },
            select: { sets: { where: { completed: true }, select: { weightKg: true, reps: true, completed: true, isWarmup: true } } },
          },
        },
      });
      if (!workout) return null;
      const sets = workout.exercises.flatMap((entry) =>
        entry.sets.map((set) => ({ ...set, weightKg: set.weightKg === null ? null : Number(set.weightKg) })),
      );
      return [exerciseId, { performedOn: fromDbDate(workout.date), topSet: topSetOf(sets) }] as const;
    }),
  );
  return new Map(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
}
