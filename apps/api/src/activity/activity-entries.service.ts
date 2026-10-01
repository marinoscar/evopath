import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma, type ActivityEntry } from '@prisma/client';

import { CheckInsService } from '../check-ins/check-ins.service';
import { isWithinWindow, toDbDate } from '../check-ins/local-date';
import { PrismaService } from '../prisma/prisma.service';
import { ACTIVITY_REASONS, ENTRY_LIST_MAX_RANGE_DAYS, ENTRY_MAX_DAYS_BACK } from './activity.constants';
import { activityRefusal, entryNotFound, toEntryView } from './activity-mapper';
import type {
  BatchActivityEntriesInput,
  BatchEntryInput,
  BatchResultData,
  CreateActivityEntryInput,
  ListActivityEntriesQuery,
  UpdateActivityEntryInput,
} from './dto/activity-entry.dto';
import type { ActivityEntryViewData } from './dto/goal.dto';
import { daysBetween } from './goal-progress';
import { WorkoutActivitySyncService } from './workout-activity-sync.service';

// =============================================================================
// ActivityEntriesService — check-ins toward goals (#267)
// =============================================================================
//
// Owner-scoped: another user's entry is a 404.
//
// SOURCES. Every entry this API writes is `source: 'manual'`, batch included:
// no client can claim `integration` in this epic, `provider`/`externalId`
// exist only so a future importer can re-send idempotently. Workout-derived
// rows (`source: 'workout'`) are written by `WorkoutActivitySyncService`
// alone; PATCH and DELETE refuse anything that is not manual (409
// ENTRY_DERIVED): edit or delete the workout instead.
//
// DAYS. `occurredOn` is a LOCAL day (Health Profile time zone, UTC when
// unset), today by default, and must lie in [today - 7, today] (400
// ENTRY_DATE_OUT_OF_RANGE), on create, edit and batch alike.
//
// BATCH IDEMPOTENCY. With both `provider` and `externalId`, a row is an
// `INSERT ... ON CONFLICT` on `activity_entries_provider_external_uniq_idx`
// (raw-SQL partial unique index: Prisma's upsert cannot target it). A repeated
// pair inside one batch keeps the last occurrence. An existing row with the
// same pair that is NOT manual is left alone and counted in neither total.
// =============================================================================

const BATCH_TX_TIMEOUT_MS = 30_000;

@Injectable()
export class ActivityEntriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checkIns: CheckInsService,
    private readonly sync: WorkoutActivitySyncService,
  ) {}

  async list(userId: string, query: ListActivityEntriesQuery, now: Date = new Date()): Promise<ActivityEntryViewData[]> {
    if (daysBetween(query.from, query.to) + 1 > ENTRY_LIST_MAX_RANGE_DAYS) {
      throw activityRefusal(
        400,
        ACTIVITY_REASONS.RANGE_TOO_LARGE,
        `from..to may span at most ${ENTRY_LIST_MAX_RANGE_DAYS} days`,
        { max: ENTRY_LIST_MAX_RANGE_DAYS },
      );
    }

    await this.sync.reconcileRecent(userId, await this.checkIns.today(userId, now));

    const entries = await this.prisma.activityEntry.findMany({
      where: {
        userId,
        occurredOn: { gte: toDbDate(query.from), lte: toDbDate(query.to) },
        ...(query.kind ? { activityKind: query.kind } : {}),
      },
      orderBy: [{ occurredOn: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    return entries.map(toEntryView);
  }

  async create(userId: string, input: CreateActivityEntryInput, now: Date = new Date()): Promise<ActivityEntryViewData> {
    const today = await this.checkIns.today(userId, now);
    const occurredOn = input.occurredOn ?? today;
    assertEntryDay(occurredOn, today);

    const entry = await this.prisma.activityEntry.create({
      data: {
        userId,
        occurredOn: toDbDate(occurredOn),
        activityKind: input.activityKind,
        completed: input.completed ?? true,
        durationSeconds: input.durationSeconds ?? null,
        steps: input.steps ?? null,
        distanceMeters: input.distanceMeters ?? null,
        note: emptyToNull(input.note),
        source: 'manual',
      },
    });
    return toEntryView(entry);
  }

  async update(
    userId: string,
    entryId: string,
    input: UpdateActivityEntryInput,
    now: Date = new Date(),
  ): Promise<ActivityEntryViewData> {
    const entry = await this.findOwnedManual(userId, entryId);

    const activityKind = input.activityKind ?? entry.activityKind;
    const steps = input.steps !== undefined ? input.steps : entry.steps;
    if (activityKind === 'steps' && steps === null) {
      throw activityRefusal(400, ACTIVITY_REASONS.INVALID_ENTRY, 'A `steps` entry needs a `steps` value', { path: 'steps' });
    }

    const data: Prisma.ActivityEntryUpdateManyMutationInput = {};
    if (input.occurredOn !== undefined) {
      assertEntryDay(input.occurredOn, await this.checkIns.today(userId, now));
      data.occurredOn = toDbDate(input.occurredOn);
    }
    if (input.activityKind !== undefined) data.activityKind = input.activityKind;
    if (input.completed !== undefined) data.completed = input.completed;
    if (input.durationSeconds !== undefined) data.durationSeconds = input.durationSeconds;
    if (input.steps !== undefined) data.steps = input.steps;
    if (input.distanceMeters !== undefined) data.distanceMeters = input.distanceMeters;
    if (input.note !== undefined) data.note = emptyToNull(input.note);

    const { count } = await this.prisma.activityEntry.updateMany({
      where: { id: entryId, userId, source: 'manual' },
      data,
    });
    if (count === 0) throw entryNotFound();

    return toEntryView(await this.prisma.activityEntry.findFirstOrThrow({ where: { id: entryId, userId } }));
  }

  async remove(userId: string, entryId: string): Promise<void> {
    await this.findOwnedManual(userId, entryId);
    const { count } = await this.prisma.activityEntry.deleteMany({ where: { id: entryId, userId, source: 'manual' } });
    if (count === 0) throw entryNotFound();
  }

  async batch(userId: string, input: BatchActivityEntriesInput, now: Date = new Date()): Promise<BatchResultData> {
    const today = await this.checkIns.today(userId, now);
    input.entries.forEach((entry, index) => assertEntryDay(entry.occurredOn ?? today, today, `entries.${index}.occurredOn`));

    const plain: BatchEntryInput[] = [];
    const keyed = new Map<string, BatchEntryInput>();
    for (const entry of input.entries) {
      if (entry.provider && entry.externalId) keyed.set(JSON.stringify([entry.provider, entry.externalId]), entry);
      else plain.push(entry);
    }

    return this.prisma.$transaction(
      async (tx) => {
        let created = 0;
        let updated = 0;

        if (plain.length > 0) {
          const result = await tx.activityEntry.createMany({
            data: plain.map((entry) => ({
              userId,
              occurredOn: toDbDate(entry.occurredOn ?? today),
              activityKind: entry.activityKind,
              completed: entry.completed ?? true,
              durationSeconds: entry.durationSeconds ?? null,
              steps: entry.steps ?? null,
              distanceMeters: entry.distanceMeters ?? null,
              note: emptyToNull(entry.note),
              // Half a pair is kept for the record but never used as a key.
              provider: entry.provider ?? null,
              externalId: entry.provider ? null : (entry.externalId ?? null),
              source: 'manual' as const,
            })),
          });
          created += result.count;
        }

        for (const entry of keyed.values()) {
          const rows = await tx.$queryRaw<Array<{ inserted: boolean }>>(upsertKeyed(userId, entry, entry.occurredOn ?? today));
          if (rows.length === 0) continue;
          if (rows[0].inserted) created += 1;
          else updated += 1;
        }

        return { created, updated };
      },
      { timeout: BATCH_TX_TIMEOUT_MS },
    );
  }

  private async findOwnedManual(userId: string, entryId: string): Promise<ActivityEntry> {
    const entry = await this.prisma.activityEntry.findFirst({ where: { id: entryId, userId } });
    if (!entry) throw entryNotFound();
    if (entry.source !== 'manual') {
      throw activityRefusal(
        409,
        ACTIVITY_REASONS.ENTRY_DERIVED,
        entry.source === 'workout'
          ? 'This entry comes from a workout: edit or delete the workout instead'
          : 'This entry was imported and cannot be changed here',
        { source: entry.source, workoutId: entry.workoutId },
      );
    }
    return entry;
  }
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

function assertEntryDay(day: string, today: string, path = 'occurredOn'): void {
  if (!isWithinWindow(day, today, ENTRY_MAX_DAYS_BACK)) {
    throw activityRefusal(
      400,
      ACTIVITY_REASONS.ENTRY_DATE_OUT_OF_RANGE,
      `The day must be today or at most ${ENTRY_MAX_DAYS_BACK} days earlier (today is ${today})`,
      { path, today },
    );
  }
}

/** One keyed batch row through the partial unique index; `inserted` tells a new row from a replaced one. */
function upsertKeyed(userId: string, entry: BatchEntryInput, occurredOn: string): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO "activity_entries" (
      "id", "user_id", "occurred_on", "activity_kind", "completed", "duration_seconds", "steps",
      "distance_meters", "source", "provider", "external_id", "note", "created_at", "updated_at"
    ) VALUES (
      ${randomUUID()}::uuid, ${userId}::uuid, ${occurredOn}::date, ${entry.activityKind}::"ActivityKind",
      ${entry.completed ?? true}, ${entry.durationSeconds ?? null}::int, ${entry.steps ?? null}::int,
      ${entry.distanceMeters ?? null}::numeric, 'manual'::"ActivitySource", ${entry.provider}, ${entry.externalId},
      ${emptyToNull(entry.note)}, now(), now()
    )
    ON CONFLICT ("user_id", "provider", "external_id") WHERE "provider" IS NOT NULL
    DO UPDATE SET
      "occurred_on" = EXCLUDED."occurred_on",
      "activity_kind" = EXCLUDED."activity_kind",
      "completed" = EXCLUDED."completed",
      "duration_seconds" = EXCLUDED."duration_seconds",
      "steps" = EXCLUDED."steps",
      "distance_meters" = EXCLUDED."distance_meters",
      "note" = EXCLUDED."note",
      "updated_at" = now()
    WHERE "activity_entries"."source" = 'manual'
    RETURNING ("xmax" = 0) AS "inserted"
  `;
}
