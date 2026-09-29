import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Measurement as MeasurementRow } from '@prisma/client';

import { HealthProfileService } from '../health-profile/health-profile.service';
import { ACTIVE } from '../measurements/measurement-active';
import { PrismaService } from '../prisma/prisma.service';
import {
  CHECK_IN_EMPTY_MESSAGE,
  CHECK_IN_FIELDS,
  CHECK_IN_MAX_BACK_DAYS,
  CHECK_IN_METRIC_KEYS,
  CHECK_IN_SCALES,
  type CheckIn,
  type CheckInList,
  type PutCheckInInput,
  type TodayCheckIn,
} from './dto/check-in.dto';
import { addDays, fromDbDate, isRealDate, localDateInZone, toDbDate } from './local-date';

// =============================================================================
// CheckInsService — the daily readiness check-in (E2.4, #56)
// =============================================================================
//
// A check-in is not a table: it is the caller's ACTIVE `measurements` rows
// under the four wellness keys for one `localDate`, sharing one `entryId`,
// `method: self_report`, `origin: manual`. The note is copied onto each row.
//
// ONE PER DAY. `put` replaces the day inside a SERIALIZABLE transaction: it
// reads the day's active rows, then supersedes (`revision + 1`,
// `supersedesId`), soft-deletes or inserts. Two concurrent first saves of the
// same day both read "nothing" and both insert; Postgres aborts one of them
// with a serialization failure (P2034), which is a 409 like a lost edit (the
// conditional `supersededAt` stamp and the unique `supersedes_id`). There is
// no unique index on (user, day, key) on purpose — see `measurement-active.ts`.
//
// THE SERVER DECIDES "TODAY" from the profile time zone (UTC when unset); a
// write is accepted for today and the seven days before it.
//
// ⚠ NEVER LOG SCORES OR NOTES. Ids, dates and counts only.
// =============================================================================

export const CHECK_IN_DELETE_AUDIT_ACTION = 'check_in:delete';
export const CHECK_IN_AUDIT_TARGET = 'check_in';
export const CHECK_IN_METHOD = 'self_report';
export const CHECK_IN_ORIGIN = 'manual';

export const CHECK_IN_FUTURE_MESSAGE = 'The check-in date must not be later than today';
export const CHECK_IN_TOO_OLD_MESSAGE =
  `The check-in date must be today or at most ${CHECK_IN_MAX_BACK_DAYS} days earlier`;

type Scores = Record<(typeof CHECK_IN_FIELDS)[number]['field'], number | null>;

@Injectable()
export class CheckInsService {
  private readonly logger = new Logger(CheckInsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly healthProfile: HealthProfileService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads (exported for E5 through `CheckInsModule`)
  // ---------------------------------------------------------------------------

  /** Today's date in the caller's time zone (UTC when unset). */
  async today(userId: string, now: Date = new Date()): Promise<string> {
    return localDateInZone(now, await this.healthProfile.getTimeZone(userId));
  }

  /** Today's date and check-in (null when there is none). */
  async getToday(userId: string): Promise<TodayCheckIn> {
    const date = await this.today(userId);
    return { date, checkIn: await this.getForDate(userId, date) };
  }

  /** The caller's check-in for `date` (`YYYY-MM-DD`), or null. */
  async getForDate(userId: string, date: string): Promise<CheckIn | null> {
    if (!isRealDate(date)) {
      throw new BadRequestException('date must be a real calendar date in YYYY-MM-DD format');
    }

    const rows = await this.prisma.measurement.findMany({
      where: { userId, ...ACTIVE, localDate: toDbDate(date), metricKey: { in: [...CHECK_IN_METRIC_KEYS] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    return rows.length === 0 ? null : toCheckIn(date, rows);
  }

  /** Check-ins of the last `days` local days including today, newest first. */
  async list(userId: string, days: number): Promise<CheckInList> {
    const today = await this.today(userId);
    const from = addDays(today, -(days - 1));

    const rows = await this.prisma.measurement.findMany({
      where: {
        userId,
        ...ACTIVE,
        metricKey: { in: [...CHECK_IN_METRIC_KEYS] },
        localDate: { gte: toDbDate(from), lte: toDbDate(today) },
      },
      orderBy: [{ localDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });

    const byDate = new Map<string, MeasurementRow[]>();
    for (const row of rows) {
      if (!row.localDate) continue;
      const date = fromDbDate(row.localDate);
      const group = byDate.get(date) ?? [];
      group.push(row);
      byDate.set(date, group);
    }

    const items = [...byDate.entries()]
      .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
      .map(([date, group]) => toCheckIn(date, group));

    return { items };
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Replaces the caller's check-in for `date`. 400 outside the window or when
   * every score is empty; 409 when a concurrent save of the same day won.
   */
  async put(userId: string, date: string, input: PutCheckInInput): Promise<CheckIn> {
    await this.assertWritableDate(userId, date);

    const submitted = scoresOf(input);
    const note = input.note ?? null;

    if (CHECK_IN_FIELDS.every(({ field }) => submitted[field] === null)) {
      throw new BadRequestException({
        message: CHECK_IN_EMPTY_MESSAGE,
        details: { issues: [{ path: '', message: CHECK_IN_EMPTY_MESSAGE }] },
      });
    }

    const localDate = toDbDate(date);

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const existing = await tx.measurement.findMany({
            where: { userId, ...ACTIVE, localDate, metricKey: { in: [...CHECK_IN_METRIC_KEYS] } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          });

          // Newest active row per key; any older duplicate is retired below.
          const current = new Map<string, MeasurementRow>();
          const duplicates: MeasurementRow[] = [];
          for (const row of existing) {
            if (current.has(row.metricKey)) duplicates.push(row);
            else current.set(row.metricKey, row);
          }

          if (existing.length > 0 && duplicates.length === 0 && isUnchanged(current, submitted, note)) {
            return toCheckIn(date, existing);
          }

          const now = new Date();
          const entryId = existing[0]?.entryId ?? randomUUID();
          const revision = existing.reduce((max, row) => Math.max(max, row.revision), 0) + 1;

          const toSupersede: MeasurementRow[] = [];
          const toDelete: MeasurementRow[] = [...duplicates];
          for (const { field, metricKey } of CHECK_IN_FIELDS) {
            const row = current.get(metricKey);
            if (!row) continue;
            (submitted[field] === null ? toDelete : toSupersede).push(row);
          }

          await this.stamp(tx, toSupersede, { supersededAt: now });
          await this.stamp(tx, toDelete, { deletedAt: now });

          const created: MeasurementRow[] = [];
          for (const { field, metricKey } of CHECK_IN_FIELDS) {
            const value = submitted[field];
            if (value === null) continue;
            const previous = current.get(metricKey);

            created.push(
              await tx.measurement.create({
                data: {
                  userId,
                  entryId,
                  metricKey,
                  value,
                  unit: CHECK_IN_SCALES[field].unit,
                  measuredAt: now,
                  localDate,
                  method: CHECK_IN_METHOD,
                  origin: CHECK_IN_ORIGIN,
                  notes: note,
                  sourceRef: Prisma.DbNull,
                  revision: existing.length === 0 ? 1 : revision,
                  supersedesId: previous?.id ?? null,
                },
              }),
            );
          }

          return toCheckIn(date, created);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isWriteConflict(error)) {
        throw checkInConflict();
      }

      throw error;
    }
  }

  /** Soft-deletes the caller's check-in for `date`. 404 when there is none. */
  async remove(userId: string, date: string): Promise<void> {
    const { count } = await this.prisma.measurement.updateMany({
      where: { userId, ...ACTIVE, localDate: toDbDate(date), metricKey: { in: [...CHECK_IN_METRIC_KEYS] } },
      data: { deletedAt: new Date() },
    });

    if (count === 0) {
      throw new NotFoundException('No check-in for this date');
    }

    await this.audit(userId, date, count);
  }

  // ---------------------------------------------------------------------------

  private async assertWritableDate(userId: string, date: string): Promise<void> {
    if (!isRealDate(date)) {
      throw invalidDate('date must be a real calendar date in YYYY-MM-DD format');
    }

    const today = await this.today(userId);

    if (date > today) {
      throw invalidDate(CHECK_IN_FUTURE_MESSAGE, today);
    }

    if (date < addDays(today, -CHECK_IN_MAX_BACK_DAYS)) {
      throw invalidDate(CHECK_IN_TOO_OLD_MESSAGE, today);
    }
  }

  /** Conditional on the rows still being active; a lost race is a 409. */
  private async stamp(
    tx: Prisma.TransactionClient,
    rows: MeasurementRow[],
    data: { supersededAt: Date } | { deletedAt: Date },
  ): Promise<void> {
    if (rows.length === 0) return;

    const { count } = await tx.measurement.updateMany({
      where: { id: { in: rows.map((row) => row.id) }, ...ACTIVE },
      data,
    });

    if (count !== rows.length) {
      throw checkInConflict();
    }
  }

  /** Best-effort: the delete has committed, so an audit failure must not fail it. */
  private async audit(userId: string, date: string, scoreCount: number): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: userId,
          action: CHECK_IN_DELETE_AUDIT_ACTION,
          targetType: CHECK_IN_AUDIT_TARGET,
          targetId: date,
          meta: { scoreCount } as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      // Ids, dates and counts only; never a score, never the note.
      this.logger.error(
        `Could not audit ${CHECK_IN_DELETE_AUDIT_ACTION} for ${date} ` +
          `(user ${userId}, ${scoreCount} scores): ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

function invalidDate(message: string, today?: string): BadRequestException {
  return new BadRequestException({
    message,
    details: {
      issues: [{ path: 'date', message }],
      ...(today ? { today, maxBackDays: CHECK_IN_MAX_BACK_DAYS } : {}),
    },
  });
}

function checkInConflict(): ConflictException {
  return new ConflictException('This check-in was updated elsewhere; reload it and try again');
}

/**
 * A lost race with a concurrent save of the same day:
 *  - P2002: another save superseded the same row first (unique `supersedes_id`);
 *  - P2034: a serialization failure Prisma reports as a known request error;
 *  - a raw `DriverAdapterError` with `TransactionWriteConflict` (SQLSTATE
 *    40001): how `@prisma/adapter-pg` surfaces a serialization failure raised
 *    at COMMIT of an interactive transaction, unwrapped.
 */
export function isWriteConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2002' || error.code === 'P2034';
  }

  const cause = (error as { name?: unknown; cause?: { kind?: unknown; originalCode?: unknown } } | null)
    ?.cause;
  return (
    (error as { name?: unknown } | null)?.name === 'DriverAdapterError' &&
    (cause?.kind === 'TransactionWriteConflict' || cause?.originalCode === '40001')
  );
}

function scoresOf(input: PutCheckInInput): Scores {
  return Object.fromEntries(
    CHECK_IN_FIELDS.map(({ field }) => [field, input[field] ?? null]),
  ) as Scores;
}

function isUnchanged(current: Map<string, MeasurementRow>, submitted: Scores, note: string | null): boolean {
  return CHECK_IN_FIELDS.every(({ field, metricKey }) => {
    const row = current.get(metricKey);
    if (submitted[field] === null) return row === undefined;
    return row !== undefined && row.value === submitted[field] && (row.notes ?? null) === note;
  });
}

/**
 * Rows of one day, newest first (the first row per key wins), as the DTO.
 * `note` comes from the newest row; `updatedAt` is the newest `updatedAt`.
 */
export function toCheckIn(date: string, rows: MeasurementRow[]): CheckIn {
  const byKey = new Map<string, MeasurementRow>();
  for (const row of rows) {
    if (!byKey.has(row.metricKey)) byKey.set(row.metricKey, row);
  }

  const scores = Object.fromEntries(
    CHECK_IN_FIELDS.map(({ field, metricKey }) => [field, byKey.get(metricKey)?.value ?? null]),
  ) as Scores;

  const newest = rows.reduce((latest, row) => (row.updatedAt > latest.updatedAt ? row : latest), rows[0]);
  const noted = rows.find((row) => row.notes !== null);

  return {
    date,
    ...scores,
    note: noted?.notes ?? null,
    updatedAt: newest.updatedAt.toISOString(),
  };
}
