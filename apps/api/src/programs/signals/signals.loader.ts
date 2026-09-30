import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { CHECK_IN_FIELDS, CHECK_IN_METRIC_KEYS } from '../../check-ins/dto/check-in.dto';
import { addDays, fromDbDate, localDateInZone, toDbDate } from '../../check-ins/local-date';
import { ACTIVE } from '../../measurements/measurement-active';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkoutHistoryService } from '../../workouts/workout-history.service';
import { loadProgramRows } from '../program-mapper';
import { REVIEW_KINDS } from '../programs.constants';
import {
  occurrencesInRange,
  type SignalsCheckIn,
  type SignalsInput,
  type SignalsPainSession,
  type SignalsPlannedWorkout,
  type SignalsReading,
  type SignalsWorkout,
} from './aggregate-signals';
import { BODY_WINDOW_DAYS, PAIN_WINDOW_DAYS, READINESS_WINDOW_DAYS, SIGNALS_MAX_SET_ROWS } from './plan-signals.contract';

// =============================================================================
// SignalsLoader: the bounded row set `aggregateSignals` reads (E5.9)
// =============================================================================
//
// One user, one program. Every workout, set, check-in and measurement query
// filters by `userId`; the program tree is read by id only after the caller
// proved the program is the user's. Reads:
//
//   - the program tree, archived rows included (four indexed reads);
//   - completed and in-progress workouts dated in the range (the
//     `workouts(user_id, date desc)` index), plus workouts linked to a
//     planned workout that occurs in the range, with their exercises and sets
//     (numbers and flags only: no note or pain-note text);
//   - E4.4's working-set buckets before the range (one grouped query);
//   - one flag per workout exercise over the last 28 days (pain);
//   - check-in scores of the last 7 days, weight and body fat of the last 8
//     weeks (active measurement rows only);
//   - the latest applied plan change.
//
// ROW CAP. At most `SIGNALS_MAX_SET_ROWS` set rows: a grouped count per day
// runs first, and when the range holds more, `from` moves forward to the
// oldest day that still fits and the result says `truncated`.
// =============================================================================

export interface SignalsProgram {
  id: string;
  startDate: Date | null;
  currentVersion: number;
}

export interface SignalsLoadParams {
  program: SignalsProgram | null;
  from: string;
  to: string;
  asOf: string;
  /** The row cap; the default is `SIGNALS_MAX_SET_ROWS` (tests lower it). */
  maxSetRows?: number;
}

const toNumber = (value: Prisma.Decimal | number | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value.toString());

const WEIGHT_KEY = 'weight';
const BODY_FAT_KEY = 'body_fat_pct';

@Injectable()
export class SignalsLoader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly history: WorkoutHistoryService,
  ) {}

  async load(userId: string, params: SignalsLoadParams): Promise<SignalsInput> {
    const { program, to, asOf } = params;
    const timeZone = (await this.prisma.healthProfile.findUnique({ where: { userId }, select: { timeZone: true } }))?.timeZone ?? null;

    const { from, truncated } = await this.capRange(userId, params.from, to, params.maxSetRows ?? SIGNALS_MAX_SET_ROWS);
    const range = { from, to };

    const planned = program ? await this.plannedWorkouts(program.id) : [];
    const startDate = program?.startDate ? fromDbDate(program.startDate) : null;
    const signalsProgram = program ? { id: program.id, startDate, planVersion: program.currentVersion } : null;
    const inRangeIds = occurrencesInRange(
      { program: signalsProgram, planned, range },
      new Set(planned.map((row) => row.programWorkoutId)),
    ).map((occurrence) => occurrence.planned.programWorkoutId);

    const [workouts, pain, checkIns, body, planChangedOn] = await Promise.all([
      this.workouts(userId, range, program?.id ?? null, inRangeIds),
      this.painSessions(userId, asOf),
      this.checkIns(userId, asOf),
      this.body(userId, asOf, timeZone),
      program ? this.planChangedOn(userId, program.id, range, timeZone) : Promise.resolve(null),
    ]);

    const liftIds = [
      ...new Set(
        workouts
          .filter((row) => row.status === 'completed' && row.date >= from && row.date <= to)
          .flatMap((row) => row.exercises.map((entry) => entry.exerciseId)),
      ),
    ];
    const exerciseIds = [
      ...new Set([
        ...planned.flatMap((row) => row.exercises.map((entry) => entry.exerciseId)),
        ...workouts.flatMap((row) => row.exercises.map((entry) => entry.exerciseId)),
        ...pain.map((row) => row.exerciseId),
      ]),
    ];

    const [exercises, buckets] = await Promise.all([
      exerciseIds.length
        ? this.prisma.exercise.findMany({
            where: { id: { in: exerciseIds } },
            select: { id: true, slug: true, name: true, primaryMuscles: true, trackingMode: true },
          })
        : Promise.resolve([]),
      this.history.priorBuckets(userId, liftIds, { kind: 'asOfDate', date: addDays(from, -1) }),
    ]);

    return {
      range,
      asOf,
      program: signalsProgram,
      planned,
      planChangedOn,
      truncated,
      workouts,
      exercises,
      priorBuckets: Object.fromEntries(buckets),
      pain,
      checkIns,
      weights: body.weights,
      bodyFat: body.bodyFat,
    };
  }

  /** `from` moved forward until the range holds at most `maxRows` set rows. */
  async capRange(userId: string, from: string, to: string, maxRows: number): Promise<{ from: string; truncated: boolean }> {
    const rows = await this.prisma.$queryRaw<Array<{ date: Date; sets: bigint | number }>>(Prisma.sql`
      SELECT w."date", COUNT(s."id") AS "sets"
        FROM "workouts" w
        JOIN "workout_exercises" we ON we."workout_id" = w."id"
        JOIN "set_logs" s ON s."workout_exercise_id" = we."id"
       WHERE w."user_id" = ${userId}::uuid
         AND w."date" BETWEEN ${from}::date AND ${to}::date
       GROUP BY w."date"
       ORDER BY w."date" DESC`);

    let total = 0;
    for (const row of rows ?? []) {
      total += Number(row.sets);
      if (total > maxRows) {
        const day = fromDbDate(row.date);
        return { from: day >= to ? to : addDays(day, 1), truncated: true };
      }
    }
    return { from, truncated: false };
  }

  /** The program's workouts with their week number; archived rows flagged. */
  private async plannedWorkouts(programId: string): Promise<SignalsPlannedWorkout[]> {
    const rows = await loadProgramRows(this.prisma, programId);
    const blocks = new Map(rows.blocks.map((block) => [block.id, block]));
    const weeks = new Map(rows.weeks.map((week) => [week.id, week]));
    const exercises = new Map<string, Array<{ exerciseId: string; targetSets: number; position: number }>>();
    for (const row of rows.exercises) {
      const list = exercises.get(row.programWorkoutId) ?? [];
      list.push({ exerciseId: row.exerciseId, targetSets: row.targetSets, position: row.position });
      exercises.set(row.programWorkoutId, list);
    }

    return rows.workouts.flatMap((workout): SignalsPlannedWorkout[] => {
      const week = weeks.get(workout.weekId);
      if (!week) return [];
      const block = blocks.get(week.blockId);
      return [
        {
          programWorkoutId: workout.id,
          name: workout.name,
          weekNumber: week.weekNumber,
          weekday: workout.weekday,
          position: workout.position,
          archived: Boolean(workout.archivedAt || week.archivedAt || block?.archivedAt),
          exercises: (exercises.get(workout.id) ?? [])
            .sort((a, b) => a.position - b.position)
            .map(({ exerciseId, targetSets }) => ({ exerciseId, targetSets })),
        },
      ];
    });
  }

  private async workouts(
    userId: string,
    range: { from: string; to: string },
    programId: string | null,
    inRangeProgramWorkoutIds: string[],
  ): Promise<SignalsWorkout[]> {
    const linkedElsewhere: Prisma.WorkoutWhereInput[] =
      programId && inRangeProgramWorkoutIds.length > 0
        ? [
            { programWorkoutId: { in: inRangeProgramWorkoutIds } },
            { programSession: { is: { programId, programWorkoutId: { in: inRangeProgramWorkoutIds } } } },
          ]
        : [];

    const rows = await this.prisma.workout.findMany({
      where: {
        userId,
        status: { in: ['completed', 'in_progress'] },
        OR: [{ date: { gte: toDbDate(range.from), lte: toDbDate(range.to) } }, ...linkedElsewhere],
      },
      orderBy: [{ date: 'asc' }, { startedAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        date: true,
        startedAt: true,
        status: true,
        programWorkoutId: true,
        programSession: { select: { programWorkoutId: true, plannedSnapshot: true } },
        exercises: {
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
          select: {
            exerciseId: true,
            sets: {
              orderBy: { setNumber: 'asc' },
              select: {
                weightKg: true,
                reps: true,
                durationSeconds: true,
                distanceMeters: true,
                rpe: true,
                isWarmup: true,
                completed: true,
              },
            },
          },
        },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      date: fromDbDate(row.date),
      startedAt: row.startedAt.toISOString(),
      status: row.status,
      linked: Boolean(row.programSession || row.programWorkoutId),
      programWorkoutId: row.programSession?.programWorkoutId ?? row.programWorkoutId ?? null,
      plannedSets: plannedSetsOf(row.programSession?.plannedSnapshot),
      exercises: row.exercises.map((entry) => ({
        exerciseId: entry.exerciseId,
        sets: entry.sets.map((set) => ({
          weightKg: toNumber(set.weightKg),
          reps: set.reps,
          durationSeconds: set.durationSeconds,
          distanceMeters: toNumber(set.distanceMeters),
          rpe: toNumber(set.rpe),
          isWarmup: set.isWarmup,
          completed: set.completed,
        })),
      })),
    }));
  }

  /** One row per workout exercise of the last 28 days: whether any of its sets carries the pain flag. */
  private async painSessions(userId: string, asOf: string): Promise<SignalsPainSession[]> {
    const rows = await this.prisma.workout.findMany({
      where: {
        userId,
        date: { gte: toDbDate(addDays(asOf, -(PAIN_WINDOW_DAYS - 1))), lte: toDbDate(asOf) },
      },
      select: {
        id: true,
        date: true,
        startedAt: true,
        exercises: { select: { exerciseId: true, sets: { where: { painFlag: true }, select: { id: true }, take: 1 } } },
      },
    });
    return rows.flatMap((row) =>
      row.exercises.map((entry) => ({
        exerciseId: entry.exerciseId,
        workoutId: row.id,
        date: fromDbDate(row.date),
        startedAt: row.startedAt.toISOString(),
        flagged: entry.sets.length > 0,
      })),
    );
  }

  /** Check-in scores of the last 7 days (newest active row per day and score); notes are never read. */
  private async checkIns(userId: string, asOf: string): Promise<SignalsCheckIn[]> {
    const rows = await this.prisma.measurement.findMany({
      where: {
        userId,
        ...ACTIVE,
        metricKey: { in: [...CHECK_IN_METRIC_KEYS] },
        localDate: { gte: toDbDate(addDays(asOf, -(READINESS_WINDOW_DAYS - 1))), lte: toDbDate(asOf) },
      },
      orderBy: [{ localDate: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
      select: { metricKey: true, value: true, localDate: true },
    });

    const byDate = new Map<string, SignalsCheckIn>();
    for (const row of rows) {
      if (!row.localDate) continue;
      const date = fromDbDate(row.localDate);
      const entry = byDate.get(date) ?? { date, energy: null, sleepQuality: null, soreness: null, stress: null };
      const field = CHECK_IN_FIELDS.find((candidate) => candidate.metricKey === row.metricKey)?.field;
      if (field && entry[field] === null) entry[field] = row.value;
      byDate.set(date, entry);
    }
    return [...byDate.values()];
  }

  /** Weight (kg) and body fat (%) of the last 8 weeks, by local day. */
  private async body(userId: string, asOf: string, timeZone: string | null): Promise<{ weights: SignalsReading[]; bodyFat: SignalsReading[] }> {
    const rows = await this.prisma.measurement.findMany({
      where: {
        userId,
        ...ACTIVE,
        metricKey: { in: [WEIGHT_KEY, BODY_FAT_KEY] },
        // A day of margin each side; the aggregator keeps the window by local day.
        measuredAt: { gte: toDbDate(addDays(asOf, -BODY_WINDOW_DAYS)), lt: toDbDate(addDays(asOf, 2)) },
      },
      orderBy: [{ measuredAt: 'asc' }, { id: 'asc' }],
      select: { metricKey: true, value: true, localDate: true, measuredAt: true },
    });
    const weights: SignalsReading[] = [];
    const bodyFat: SignalsReading[] = [];
    for (const row of rows) {
      const date = row.localDate ? fromDbDate(row.localDate) : localDateInZone(row.measuredAt, timeZone);
      (row.metricKey === WEIGHT_KEY ? weights : bodyFat).push({ date, value: row.value });
    }
    return { weights, bodyFat };
  }

  /** The local day of the latest applied plan change (not the creation) around the range. */
  private async planChangedOn(
    userId: string,
    programId: string,
    range: { from: string; to: string },
    timeZone: string | null,
  ): Promise<string | null> {
    const change = await this.prisma.programChangeLog.findFirst({
      where: {
        programId,
        userId,
        status: 'applied',
        kind: { notIn: ['created', ...REVIEW_KINDS] },
        createdAt: { gte: toDbDate(addDays(range.from, -1)), lt: toDbDate(addDays(range.to, 2)) },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true },
    });
    return change ? localDateInZone(change.createdAt, timeZone) : null;
  }
}

/** Total planned sets of a `program_sessions.planned_snapshot`, or null when it is not the expected shape. */
function plannedSetsOf(snapshot: Prisma.JsonValue | undefined): number | null {
  if (!Array.isArray(snapshot)) return null;
  let total = 0;
  for (const entry of snapshot) {
    const sets = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as { sets?: unknown }).sets : undefined;
    if (typeof sets === 'number' && Number.isFinite(sets) && sets > 0) total += sets;
  }
  return total;
}
