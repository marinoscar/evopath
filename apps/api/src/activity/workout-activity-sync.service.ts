import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type ActivityEntry } from '@prisma/client';

import { addDays, fromDbDate, toDbDate } from '../check-ins/local-date';
import { PrismaService } from '../prisma/prisma.service';
import { DERIVED_RECONCILE_DAYS } from './activity.constants';
import { derivedEntriesFor, type CreditWorkout, type DerivedEntry } from './workout-activity';

// =============================================================================
// WorkoutActivitySyncService — keeps workout-derived activity entries current
// =============================================================================
//
// Workout-derived entries are MATERIALISED (source 'workout', `workoutId`
// set). Three paths keep them equal to `derivedEntriesFor(workout)`:
//
//   1. `workout.finished` (after the finish committed) -> `syncWorkout`, so a
//      goal is credited the moment a workout is finished.
//   2. Every progress and entry read first calls `reconcileRecent`, which
//      re-derives the last DERIVED_RECONCILE_DAYS local days: edits to a
//      completed workout (sets, date), a workout created already completed
//      without the event, and a workout that is no longer completed.
//   3. Deleting a workout CASCADES its entries (FK).
//
// Writes are bounded (at most four rows per workout) and diffed: an unchanged
// workout writes nothing. The upsert goes through
// `activity_entries_workout_kind_uniq_idx` (raw-SQL partial unique index,
// which Prisma's upsert cannot target), so concurrent syncs of one workout
// converge on one row per kind.
// =============================================================================

const CREDIT_SELECT = {
  id: true,
  date: true,
  status: true,
  durationSeconds: true,
  endedAt: true,
  exercises: {
    select: {
      exercise: { select: { slug: true, movementPattern: true } },
      sets: { select: { completed: true, durationSeconds: true, distanceMeters: true } },
    },
  },
} satisfies Prisma.WorkoutSelect;

type CreditRow = Prisma.WorkoutGetPayload<{ select: typeof CREDIT_SELECT }>;

export function toCreditWorkout(row: CreditRow): CreditWorkout {
  return {
    id: row.id,
    date: fromDbDate(row.date),
    status: row.status,
    durationSeconds: row.durationSeconds,
    endedAt: row.endedAt,
    exercises: row.exercises.map((entry) => ({
      slug: entry.exercise.slug,
      movementPattern: entry.exercise.movementPattern,
      sets: entry.sets.map((set) => ({
        completed: set.completed,
        durationSeconds: set.durationSeconds,
        distanceMeters: set.distanceMeters === null ? null : Number(set.distanceMeters),
      })),
    })),
  };
}

/** True when the stored derived row already says what `desired` says. */
function sameEntry(stored: ActivityEntry, desired: DerivedEntry): boolean {
  return (
    fromDbDate(stored.occurredOn) === desired.occurredOn &&
    (stored.occurredAt?.getTime() ?? null) === (desired.occurredAt?.getTime() ?? null) &&
    stored.durationSeconds === desired.durationSeconds &&
    (stored.distanceMeters === null ? null : Number(stored.distanceMeters)) === desired.distanceMeters &&
    stored.completed &&
    stored.source === 'workout'
  );
}

@Injectable()
export class WorkoutActivitySyncService {
  private readonly logger = new Logger(WorkoutActivitySyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Re-derives one workout's entries. A workout that is gone has none (cascade). */
  async syncWorkout(userId: string, workoutId: string): Promise<void> {
    const workouts = await this.prisma.workout.findMany({ where: { id: workoutId, userId }, select: CREDIT_SELECT });
    await this.apply(userId, workouts);
  }

  /**
   * Re-derives every workout dated in the last DERIVED_RECONCILE_DAYS local
   * days up to `today` (completed ones, plus any that a derived entry in the
   * window still names: a reopened or re-dated workout).
   */
  async reconcileRecent(userId: string, today: string): Promise<void> {
    const from = toDbDate(addDays(today, -(DERIVED_RECONCILE_DAYS - 1)));
    const to = toDbDate(today);

    const [completed, derived] = await Promise.all([
      this.prisma.workout.findMany({
        where: { userId, status: 'completed', date: { gte: from, lte: to } },
        select: { id: true },
      }),
      this.prisma.activityEntry.findMany({
        where: { userId, source: 'workout', workoutId: { not: null }, occurredOn: { gte: from, lte: to } },
        select: { workoutId: true },
      }),
    ]);

    const ids = new Set<string>(completed.map((row) => row.id));
    derived.forEach((row) => row.workoutId && ids.add(row.workoutId));
    if (ids.size === 0) return;

    const workouts = await this.prisma.workout.findMany({ where: { userId, id: { in: [...ids] } }, select: CREDIT_SELECT });
    await this.apply(userId, workouts);
  }

  private async apply(userId: string, workouts: CreditRow[]): Promise<void> {
    if (workouts.length === 0) return;

    const existing = await this.prisma.activityEntry.findMany({
      where: { userId, workoutId: { in: workouts.map((workout) => workout.id) } },
    });

    for (const row of workouts) {
      const desired = derivedEntriesFor(toCreditWorkout(row));
      const current = existing.filter((entry) => entry.workoutId === row.id);

      try {
        const stale = current.filter((entry) => !desired.some((wanted) => wanted.activityKind === entry.activityKind));
        if (stale.length > 0) {
          await this.prisma.activityEntry.deleteMany({ where: { id: { in: stale.map((entry) => entry.id) } } });
        }

        for (const wanted of desired) {
          const stored = current.find((entry) => entry.activityKind === wanted.activityKind);
          if (stored && sameEntry(stored, wanted)) continue;
          await this.upsert(userId, row.id, wanted);
        }
      } catch (error) {
        // A workout deleted mid-sync (FK) is not an error: its rows cascade.
        this.logger.warn(
          `Could not sync activity entries of workout ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async upsert(userId: string, workoutId: string, entry: DerivedEntry): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "activity_entries" (
        "id", "user_id", "occurred_on", "occurred_at", "activity_kind", "completed",
        "duration_seconds", "distance_meters", "source", "workout_id", "created_at", "updated_at"
      ) VALUES (
        ${randomUUID()}::uuid, ${userId}::uuid, ${entry.occurredOn}::date, ${entry.occurredAt}::timestamptz,
        ${entry.activityKind}::"ActivityKind", true, ${entry.durationSeconds}::int, ${entry.distanceMeters}::numeric,
        'workout'::"ActivitySource", ${workoutId}::uuid, now(), now()
      )
      ON CONFLICT ("workout_id", "activity_kind") WHERE "workout_id" IS NOT NULL
      DO UPDATE SET
        "occurred_on" = EXCLUDED."occurred_on",
        "occurred_at" = EXCLUDED."occurred_at",
        "duration_seconds" = EXCLUDED."duration_seconds",
        "distance_meters" = EXCLUDED."distance_meters",
        "completed" = true,
        "source" = 'workout'::"ActivitySource",
        "updated_at" = now()
    `);
  }
}
