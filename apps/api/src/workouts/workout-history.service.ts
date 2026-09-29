import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { CheckInsService } from '../check-ins/check-ins.service';
import { fromDbDate, toDbDate } from '../check-ins/local-date';
import { exerciseNotFound } from '../exercises/exercise-views';
import { PrismaService } from '../prisma/prisma.service';
import type {
  ExerciseHistoryData,
  ExerciseHistoryQuery,
  LastTimeData,
  RecentWorkoutData,
} from './dto/exercise-history.dto';
import type { PrsBySet } from './workout-mapper';
import { workoutNotFound } from './workout-mapper';
import {
  E1RM_MAX_REPS,
  type ExerciseRecords,
  type SetPr,
  type WeightBucket,
  classifySequence,
  e1rmKg,
  round3,
  tracksPrs,
  workingSets,
} from './workout-records';

// =============================================================================
// WorkoutHistoryService — "last time", all-time records and PRs (E4.4)
// =============================================================================
//
// Everything is computed on read (no PR table), so it stays right after an
// edit or a delete. The formulas live in `workout-records.ts`; this service
// only gathers the caller's rows. Every query joins
// `set_logs -> workout_exercises -> workouts` and filters `workouts.user_id`
// by the caller: another user's sets never enter a comparison.
//
// PRIOR HISTORY of a workout W is every working set of the same exercise in
// the caller's OTHER COMPLETED workouts earlier than W by (date, startedAt),
// aggregated in SQL per (exercise, weight) — one grouped query per call, never
// one per set — plus the working sets before each set inside W (earlier
// position, then smaller setNumber), folded in by `classifySequence`.
// =============================================================================

/** A workout as `prsForWorkout` reads it (a `WorkoutWithRelations` fits). */
export interface PrWorkout {
  id: string;
  date: Date;
  startedAt: Date;
  exercises: ReadonlyArray<{
    id: string;
    exerciseId: string;
    position: number;
    exercise: { trackingMode: string };
    sets: ReadonlyArray<{
      id: string;
      setNumber: number;
      weightKg: Prisma.Decimal | null;
      reps: number | null;
      completed: boolean;
      isWarmup: boolean;
    }>;
  }>;
}

/** Which completed workouts count as history. */
type Cutoff =
  | { kind: 'asOfDate'; date: string }
  | { kind: 'beforeWorkout'; workoutId: string; date: Date; startedAt: Date };

const PR_WORKOUT_SELECT = {
  id: true,
  date: true,
  startedAt: true,
} as const;

function toNumber(value: Prisma.Decimal | number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value.toString());
}

@Injectable()
export class WorkoutHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checkIns: CheckInsService,
  ) {}

  // ---------------------------------------------------------------------------
  // PRs
  // ---------------------------------------------------------------------------

  /**
   * The PRs of every completed working set of `workout` (which must be the
   * caller's), by set id. One grouped query for all exercises; none when the
   * workout has no completed set of a weight/bodyweight exercise.
   */
  async prsForWorkout(userId: string, workout: PrWorkout): Promise<Map<string, SetPr[]>> {
    const result = new Map<string, SetPr[]>();

    const byExercise = new Map<string, PrWorkout['exercises'][number][]>();
    for (const entry of workout.exercises) {
      if (!tracksPrs(entry.exercise.trackingMode)) continue;
      if (!entry.sets.some((set) => set.completed && !set.isWarmup)) continue;
      const group = byExercise.get(entry.exerciseId) ?? [];
      group.push(entry);
      byExercise.set(entry.exerciseId, group);
    }
    if (byExercise.size === 0) return result;

    const buckets = await this.priorBuckets(userId, [...byExercise.keys()], {
      kind: 'beforeWorkout',
      workoutId: workout.id,
      date: workout.date,
      startedAt: workout.startedAt,
    });

    for (const [exerciseId, entries] of byExercise) {
      const ordered = [...entries].sort((a, b) => a.position - b.position);
      const sequence = ordered.flatMap((entry) =>
        [...entry.sets]
          .sort((a, b) => a.setNumber - b.setNumber)
          .map((set) => ({
            key: set.id,
            set: { weightKg: toNumber(set.weightKg), reps: set.reps, completed: set.completed, isWarmup: set.isWarmup },
          })),
      );
      const classified = classifySequence(sequence, ordered[0].exercise.trackingMode, buckets.get(exerciseId) ?? []);
      for (const [setId, prs] of classified) {
        if (prs.length > 0) result.set(setId, prs);
      }
    }

    return result;
  }

  /**
   * The PRs of the sets of one exercise in one of the caller's workouts (every
   * entry of that exercise, since an earlier entry is prior history). Empty
   * when the workout or entry is not the caller's.
   */
  async prsForWorkoutExercise(userId: string, workoutId: string, workoutExerciseId: string): Promise<PrsBySet> {
    const entry = await this.prisma.workoutExercise.findFirst({
      where: { id: workoutExerciseId, workoutId, workout: { userId } },
      select: { exerciseId: true },
    });
    if (!entry?.exerciseId) return new Map();

    const workout = await this.prisma.workout.findFirst({
      where: { id: workoutId, userId },
      select: {
        ...PR_WORKOUT_SELECT,
        exercises: {
          where: { exerciseId: entry.exerciseId },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            exerciseId: true,
            position: true,
            exercise: { select: { trackingMode: true } },
            sets: {
              orderBy: { setNumber: 'asc' },
              select: { id: true, setNumber: true, weightKg: true, reps: true, completed: true, isWarmup: true },
            },
          },
        },
      },
    });
    if (!workout?.exercises) return new Map();

    return this.prsForWorkout(userId, workout);
  }

  /** The PRs one set earns (empty unless it is a completed working set). */
  async prsForSet(userId: string, workoutId: string, workoutExerciseId: string, setId: string): Promise<SetPr[]> {
    return (await this.prsForWorkoutExercise(userId, workoutId, workoutExerciseId)).get(setId) ?? [];
  }

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  /**
   * Last time, recent workouts and all-time records for a library exercise or
   * one of the caller's own; another user's custom exercise is a 404.
   */
  async history(
    userId: string,
    exerciseId: string,
    query: ExerciseHistoryQuery,
    now: Date = new Date(),
  ): Promise<ExerciseHistoryData> {
    const exercise = await this.prisma.exercise.findFirst({
      where: { id: exerciseId, OR: [{ ownerUserId: null }, { ownerUserId: userId }] },
      select: { id: true, trackingMode: true },
    });
    if (!exercise) {
      throw exerciseNotFound();
    }

    let cutoff: Cutoff;
    let preferredGymId: string | null = query.gymId ?? null;
    if (query.workoutId) {
      const context = await this.prisma.workout.findFirst({
        where: { id: query.workoutId, userId },
        select: { id: true, date: true, startedAt: true, gymId: true },
      });
      if (!context) {
        throw workoutNotFound();
      }
      cutoff = { kind: 'beforeWorkout', workoutId: context.id, date: context.date, startedAt: context.startedAt };
      preferredGymId ??= context.gymId;
    } else {
      cutoff = { kind: 'asOfDate', date: query.beforeDate ?? (await this.checkIns.today(userId, now)) };
    }

    const candidates = await this.prisma.workout.findMany({
      where: {
        userId,
        status: 'completed',
        ...cutoffWhere(cutoff),
        exercises: { some: { exerciseId, sets: { some: { completed: true } } } },
      },
      orderBy: [{ date: 'desc' }, { startedAt: 'desc' }, { id: 'desc' }],
      take: Math.max(query.limit, 2),
      select: {
        id: true,
        date: true,
        gymId: true,
        gym: { select: { id: true, name: true } },
        exercises: {
          where: { exerciseId },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
          select: {
            sets: {
              where: { completed: true },
              orderBy: { setNumber: 'asc' },
              select: {
                setNumber: true,
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

    let lastTime: LastTimeData | null = null;
    const pick =
      (preferredGymId ? candidates.slice(0, 2).find((workout) => workout.gymId === preferredGymId) : undefined) ??
      candidates[0];
    if (pick) {
      lastTime = {
        workoutId: pick.id,
        date: fromDbDate(pick.date),
        gym: pick.gym,
        sets: pick.exercises.flatMap((entry) =>
          entry.sets.map((set) => ({
            setNumber: set.setNumber,
            weightKg: toNumber(set.weightKg),
            reps: set.reps,
            durationSeconds: set.durationSeconds,
            distanceMeters: toNumber(set.distanceMeters),
            rpe: toNumber(set.rpe),
            isWarmup: set.isWarmup,
          })),
        ),
      };
    }

    const recent: RecentWorkoutData[] = candidates.slice(0, query.limit).map((workout) => {
      const working = workingSets(
        workout.exercises.flatMap((entry) =>
          entry.sets.map((set) => ({ ...set, weightKg: toNumber(set.weightKg) })),
        ),
        exercise.trackingMode,
      );
      let topSet: { weightKg: number; reps: number } | null = null;
      let best: number | null = null;
      for (const set of working) {
        if (!topSet || set.weightKg > topSet.weightKg || (set.weightKg === topSet.weightKg && set.reps > topSet.reps)) {
          topSet = { weightKg: set.weightKg, reps: set.reps };
        }
        const estimate = e1rmKg(set.weightKg, set.reps);
        if (estimate !== null && (best === null || estimate > best)) best = estimate;
      }
      return { workoutId: workout.id, date: fromDbDate(workout.date), topSet, e1rmKg: best };
    });

    const records = tracksPrs(exercise.trackingMode)
      ? await this.records(userId, exerciseId, cutoff)
      : { maxWeightKg: null, maxReps: null, bestE1rmKg: null };

    return { exerciseId, lastTime, recent, records };
  }

  // ---------------------------------------------------------------------------
  // SQL
  // ---------------------------------------------------------------------------

  /**
   * Prior working sets per exercise, grouped by exact weight: the most reps,
   * and the most reps within the e1RM range, at each weight.
   */
  async priorBuckets(userId: string, exerciseIds: string[], cutoff: Cutoff): Promise<Map<string, WeightBucket[]>> {
    const result = new Map<string, WeightBucket[]>();
    if (exerciseIds.length === 0) return result;

    const rows = await this.prisma.$queryRaw<
      Array<{ exercise_id: string; weight_kg: Prisma.Decimal; max_reps: number; max_reps_e1rm: number | null }>
    >(Prisma.sql`
      SELECT we."exercise_id",
             COALESCE(s."weight_kg", 0) AS "weight_kg",
             MAX(s."reps") AS "max_reps",
             MAX(s."reps") FILTER (WHERE s."reps" <= ${E1RM_MAX_REPS}) AS "max_reps_e1rm"
        FROM "set_logs" s
        JOIN "workout_exercises" we ON we."id" = s."workout_exercise_id"
        JOIN "workouts" w ON w."id" = we."workout_id"
        JOIN "exercises" e ON e."id" = we."exercise_id"
       WHERE w."user_id" = ${userId}::uuid
         AND w."status" = 'completed'
         AND ${cutoffSql(cutoff)}
         AND we."exercise_id" IN (${Prisma.join(exerciseIds.map((id) => Prisma.sql`${id}::uuid`))})
         AND ${WORKING_SET_SQL}
       GROUP BY we."exercise_id", COALESCE(s."weight_kg", 0)`);

    for (const row of rows ?? []) {
      if (!row?.exercise_id || !exerciseIds.includes(row.exercise_id)) continue;
      const group = result.get(row.exercise_id) ?? [];
      group.push({
        weightKg: round3(toNumber(row.weight_kg) ?? 0),
        maxReps: Number(row.max_reps),
        maxRepsForE1rm: row.max_reps_e1rm === null ? null : Number(row.max_reps_e1rm),
      });
      result.set(row.exercise_id, group);
    }
    return result;
  }

  /** All-time records as of `cutoff`, each an ORDER BY ... LIMIT 1 over the working sets. */
  private async records(userId: string, exerciseId: string, cutoff: Cutoff): Promise<ExerciseRecords> {
    const rows = await this.prisma.$queryRaw<
      Array<{ kind: 'weight' | 'reps' | 'e1rm'; weight_kg: Prisma.Decimal; reps: number; date: Date; e1rm: Prisma.Decimal | null }>
    >(Prisma.sql`
      WITH ws AS (
        SELECT COALESCE(s."weight_kg", 0) AS "weight_kg", s."reps", w."date", w."started_at"
          FROM "set_logs" s
          JOIN "workout_exercises" we ON we."id" = s."workout_exercise_id"
          JOIN "workouts" w ON w."id" = we."workout_id"
          JOIN "exercises" e ON e."id" = we."exercise_id"
         WHERE w."user_id" = ${userId}::uuid
           AND w."status" = 'completed'
           AND ${cutoffSql(cutoff)}
           AND we."exercise_id" = ${exerciseId}::uuid
           AND ${WORKING_SET_SQL}
      )
      (SELECT 'weight' AS "kind", "weight_kg", "reps", "date", NULL::numeric AS "e1rm" FROM ws
        ORDER BY "weight_kg" DESC, "reps" DESC, "date" ASC, "started_at" ASC LIMIT 1)
      UNION ALL
      (SELECT 'reps', "weight_kg", "reps", "date", NULL::numeric FROM ws
        ORDER BY "reps" DESC, "weight_kg" DESC, "date" ASC, "started_at" ASC LIMIT 1)
      UNION ALL
      (SELECT 'e1rm', "weight_kg", "reps", "date",
              ROUND(CASE WHEN "reps" = 1 THEN "weight_kg" ELSE "weight_kg" * (1 + "reps" / 30.0) END, 1) AS "e1rm"
         FROM ws
        WHERE "weight_kg" > 0 AND "reps" <= ${E1RM_MAX_REPS}
        ORDER BY 5 DESC, "date" ASC, "started_at" ASC LIMIT 1)`);

    const records: ExerciseRecords = { maxWeightKg: null, maxReps: null, bestE1rmKg: null };
    for (const row of rows ?? []) {
      const weightKg = round3(toNumber(row.weight_kg) ?? 0);
      const reps = Number(row.reps);
      const date = fromDbDate(row.date);
      if (row.kind === 'weight') records.maxWeightKg = { value: weightKg, reps, date };
      if (row.kind === 'reps') records.maxReps = { value: reps, weightKg, date };
      if (row.kind === 'e1rm') records.bestE1rmKg = { value: toNumber(row.e1rm) ?? 0, weightKg, reps, date };
    }
    return records;
  }
}

/** The working-set predicate over `s` (set_logs) and `e` (exercises); see `workout-records.ts`. */
const WORKING_SET_SQL = Prisma.sql`s."completed" AND NOT s."is_warmup" AND s."reps" >= 1
  AND e."tracking_mode" IN ('weight_reps', 'bodyweight_reps')
  AND (s."weight_kg" IS NOT NULL OR e."tracking_mode" = 'bodyweight_reps')`;

/** The cutoff over `w` (workouts). */
function cutoffSql(cutoff: Cutoff): Prisma.Sql {
  if (cutoff.kind === 'asOfDate') {
    return Prisma.sql`w."date" <= ${cutoff.date}::date`;
  }
  return Prisma.sql`w."id" <> ${cutoff.workoutId}::uuid
    AND (w."date", w."started_at") < (${fromDbDate(cutoff.date)}::date, ${cutoff.startedAt}::timestamptz)`;
}

/** The same cutoff as a Prisma filter. */
function cutoffWhere(cutoff: Cutoff): Prisma.WorkoutWhereInput {
  if (cutoff.kind === 'asOfDate') {
    return { date: { lte: toDbDate(cutoff.date) } };
  }
  return {
    id: { not: cutoff.workoutId },
    OR: [{ date: { lt: cutoff.date } }, { date: cutoff.date, startedAt: { lt: cutoff.startedAt } }],
  };
}
