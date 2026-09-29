import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Measurement as MeasurementRow } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  bloodPressureProblem,
  type CreateMeasurementEntryInput,
  type LatestMeasurements,
  type ListMeasurementsQuery,
  type Measurement,
  type MeasurementEntry,
  type MeasurementSeries,
  type SeriesQuery,
  SERIES_MAX_POINTS,
  type UpdateMeasurementEntryInput,
} from './dto/measurement.dto';
import { ACTIVE } from './measurement-active';
import {
  BP_DIASTOLIC,
  BP_SYSTOLIC,
  DEFAULT_METHOD,
  getMetric,
  MEASUREMENT_METRIC_KEYS,
  type MeasurementOrigin,
  METRICS,
} from './metric-registry';

// =============================================================================
// MeasurementsService — the caller's measurements (E2.2, #50)
// =============================================================================
//
// OWNER SCOPE. Every query carries the caller's JWT user id; an id belonging
// to someone else matches nothing and is a 404, never a 403.
//
// ACTIVE ROWS. Every read spreads `ACTIVE` (`measurement-active.ts`): edited
// rows are superseded, deleted rows are soft-deleted, and neither is visible.
//
// ENTRIES. Readings saved together share an `entryId`; create, edit and delete
// are entry-level and atomic. An edit never updates a value in place: it
// stamps `supersededAt` on every active row of the entry and inserts
// superseding rows (`revision + 1`, `supersedesId` = the old row). The unique
// index on `supersedes_id` plus the `supersededAt IS NULL` condition on the
// stamp mean two concurrent edits cannot both win.
//
// ⚠ NEVER LOG VALUES OR NOTES. Log ids and counts only; the audit row for a
// delete carries the reading count and nothing else.
// =============================================================================

export const MEASUREMENT_ENTRY_DELETE_AUDIT_ACTION = 'measurement_entry:delete';
export const MEASUREMENT_ENTRY_AUDIT_TARGET = 'measurement_entry';

/** Newest first; ties on `measuredAt` broken by insertion time. */
const NEWEST_FIRST = [
  { measuredAt: 'desc' as const },
  { createdAt: 'desc' as const },
  { id: 'desc' as const },
];

/** The six body/vital metrics `latest` reports, in registry order. */
const LATEST_METRIC_KEYS = MEASUREMENT_METRIC_KEYS;

/**
 * Server-side provenance for a new entry. Clients can never supply it: the
 * HTTP route always writes `manual`; photo intake (E2.6) passes `ai` and a
 * `sourceRef` through {@link MeasurementsService.createEntryInTransaction}.
 */
export interface EntryProvenance {
  origin: MeasurementOrigin;
  sourceRef?: Prisma.InputJsonValue | null;
}

const MANUAL: EntryProvenance = { origin: 'manual' };

@Injectable()
export class MeasurementsService {
  private readonly logger = new Logger(MeasurementsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /** Creates one entry through the HTTP API (`origin: manual`). */
  async createEntry(
    userId: string,
    input: CreateMeasurementEntryInput,
  ): Promise<MeasurementEntry> {
    return this.prisma.$transaction((tx) =>
      this.createEntryInTransaction(tx, userId, input, MANUAL),
    );
  }

  /**
   * Inserts one entry inside the caller's transaction. Exposed for server-side
   * writers (photo intake applies accepted drafts atomically with its own
   * bookkeeping). `input` must already be validated and canonical — parse it
   * with `createMeasurementEntrySchema` first.
   */
  async createEntryInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    input: CreateMeasurementEntryInput,
    provenance: EntryProvenance,
  ): Promise<MeasurementEntry> {
    const entryId = randomUUID();
    const measuredAt = input.measuredAt ?? new Date();
    const rows: MeasurementRow[] = [];

    for (const reading of input.readings) {
      rows.push(
        await tx.measurement.create({
          data: {
            userId,
            entryId,
            metricKey: reading.metricKey,
            value: reading.value,
            unit: reading.unit,
            measuredAt,
            method: reading.method ?? DEFAULT_METHOD,
            origin: provenance.origin,
            notes: input.notes,
            sourceRef: provenance.sourceRef ?? Prisma.DbNull,
          },
        }),
      );
    }

    return { entryId, items: rows.map(toMeasurement) };
  }

  /**
   * Supersedes every active row of the entry with the requested changes.
   * Readings the body does not mention are copied forward unchanged. 404 when
   * the caller has no active row with this entry id; 409 when a concurrent
   * edit or delete got there first.
   */
  async updateEntry(
    userId: string,
    entryId: string,
    input: UpdateMeasurementEntryInput,
  ): Promise<MeasurementEntry> {
    const now = new Date();

    try {
      return await this.prisma.$transaction(async (tx) => {
        const old = sortByRegistry(
          await tx.measurement.findMany({ where: { userId, entryId, ...ACTIVE } }),
        );

        if (old.length === 0) {
          throw entryNotFound();
        }

        const changes = new Map((input.readings ?? []).map((reading) => [reading.metricKey, reading]));
        const present = new Set(old.map((row) => row.metricKey));

        (input.readings ?? []).forEach((reading, index) => {
          if (!present.has(reading.metricKey)) {
            throw new BadRequestException({
              message: 'Validation failed',
              details: {
                issues: [
                  {
                    path: `readings.${index}.metricKey`,
                    message: 'metricKey is not part of this entry',
                  },
                ],
              },
            });
          }
        });

        const merged = old.map((row) => {
          const change = changes.get(row.metricKey);
          return {
            row,
            value: change ? change.value : row.value,
            unit: change ? change.unit : row.unit,
            method: change?.method ?? row.method,
          };
        });

        const byKey = new Map(merged.map((reading) => [reading.row.metricKey, reading.value]));
        const problem = bloodPressureProblem(
          merged.map((reading) => reading.row.metricKey),
          byKey.get(BP_SYSTOLIC),
          byKey.get(BP_DIASTOLIC),
        );

        if (problem) {
          throw new BadRequestException({
            message: 'Validation failed',
            details: { issues: [{ path: 'readings', message: problem }] },
          });
        }

        const { count } = await tx.measurement.updateMany({
          where: { id: { in: old.map((row) => row.id) }, ...ACTIVE },
          data: { supersededAt: now },
        });

        if (count !== old.length) {
          throw entryConflict();
        }

        const rows: MeasurementRow[] = [];

        for (const reading of merged) {
          const { row } = reading;
          rows.push(
            await tx.measurement.create({
              data: {
                userId,
                entryId,
                metricKey: row.metricKey,
                value: reading.value,
                unit: reading.unit,
                measuredAt: input.measuredAt ?? row.measuredAt,
                localDate: row.localDate,
                method: reading.method,
                // Provenance is copied forward; only server code changes it.
                origin: row.origin,
                sourceRef: row.sourceRef === null ? Prisma.DbNull : (row.sourceRef as Prisma.InputJsonValue),
                notes: input.notes === undefined ? row.notes : input.notes,
                revision: row.revision + 1,
                supersedesId: row.id,
              },
            }),
          );
        }

        return { entryId, items: rows.map(toMeasurement) };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Another edit inserted a row superseding the same old row first.
        throw entryConflict();
      }

      throw error;
    }
  }

  /** Soft-deletes every active row of the entry. 404 when there is none. */
  async deleteEntry(userId: string, entryId: string): Promise<void> {
    const { count } = await this.prisma.measurement.updateMany({
      where: { userId, entryId, ...ACTIVE },
      data: { deletedAt: new Date() },
    });

    if (count === 0) {
      throw entryNotFound();
    }

    await this.audit(userId, entryId, count);
  }

  // ---------------------------------------------------------------------------
  // Reads — every one is `{ userId, ...ACTIVE }`
  // ---------------------------------------------------------------------------

  /** Active body/vital rows, newest first, flat pagination. */
  async list(userId: string, query: ListMeasurementsQuery) {
    const where: Prisma.MeasurementWhereInput = {
      userId,
      ...ACTIVE,
      metricKey: query.metricKey ?? { in: [...MEASUREMENT_METRIC_KEYS] },
      ...(query.from || query.to
        ? {
            measuredAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.measurement.findMany({
        where,
        orderBy: NEWEST_FIRST,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.measurement.count({ where }),
    ]);

    return {
      items: rows.map(toMeasurement),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  /** Latest and previous active reading for each body/vital metric. */
  async latest(userId: string): Promise<LatestMeasurements> {
    const perMetric = await Promise.all(
      LATEST_METRIC_KEYS.map((metricKey) =>
        this.prisma.measurement.findMany({
          where: { userId, metricKey, ...ACTIVE },
          orderBy: NEWEST_FIRST,
          take: 2,
        }),
      ),
    );

    return {
      items: LATEST_METRIC_KEYS.map((metricKey, index) => {
        const [latest, previous] = perMetric[index];
        return {
          metricKey,
          latest: latest ? toMeasurement(latest) : null,
          previous: previous ? toMeasurement(previous) : null,
        };
      }),
    };
  }

  /**
   * Ascending chart points for one metric in `[from, to]`, at most
   * {@link SERIES_MAX_POINTS}. When the range holds more, the NEWEST are kept
   * and `truncated` is true.
   */
  async series(userId: string, query: SeriesQuery): Promise<MeasurementSeries> {
    const rows = await this.prisma.measurement.findMany({
      where: {
        userId,
        metricKey: query.metricKey,
        ...ACTIVE,
        measuredAt: { gte: query.from, lte: query.to },
      },
      orderBy: NEWEST_FIRST,
      take: SERIES_MAX_POINTS + 1,
      select: { id: true, measuredAt: true, value: true, method: true, origin: true },
    });

    const truncated = rows.length > SERIES_MAX_POINTS;
    const kept = rows.slice(0, SERIES_MAX_POINTS).reverse();

    return {
      metricKey: query.metricKey,
      unit: getMetric(query.metricKey)!.canonicalUnit,
      points: kept.map((row) => ({
        id: row.id,
        measuredAt: row.measuredAt.toISOString(),
        value: row.value,
        method: row.method,
        origin: row.origin,
      })),
      truncated,
    };
  }

  // ---------------------------------------------------------------------------

  /** Best-effort: the delete has committed, so an audit failure must not fail it. */
  private async audit(userId: string, entryId: string, readingCount: number): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: userId,
          action: MEASUREMENT_ENTRY_DELETE_AUDIT_ACTION,
          targetType: MEASUREMENT_ENTRY_AUDIT_TARGET,
          targetId: entryId,
          meta: { readingCount } as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      // Ids and counts only; never a value, never the notes.
      this.logger.error(
        `Could not audit ${MEASUREMENT_ENTRY_DELETE_AUDIT_ACTION} for entry ${entryId} ` +
          `(user ${userId}, ${readingCount} readings): ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

function entryNotFound(): NotFoundException {
  return new NotFoundException('Measurement entry not found');
}

function entryConflict(): ConflictException {
  return new ConflictException(
    'The measurement entry was changed by another request; reload it and try again',
  );
}

const REGISTRY_ORDER: ReadonlyMap<string, number> = new Map(
  METRICS.map((metric, index) => [metric.key as string, index]),
);

/** Entry rows in registry order, so responses are stable. */
function sortByRegistry(rows: MeasurementRow[]): MeasurementRow[] {
  return [...rows].sort(
    (a, b) =>
      (REGISTRY_ORDER.get(a.metricKey) ?? Number.MAX_SAFE_INTEGER) -
      (REGISTRY_ORDER.get(b.metricKey) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function toMeasurement(row: MeasurementRow): Measurement {
  return {
    id: row.id,
    entryId: row.entryId,
    metricKey: row.metricKey,
    value: row.value,
    unit: row.unit,
    measuredAt: row.measuredAt.toISOString(),
    method: row.method,
    origin: row.origin,
    notes: row.notes,
    sourceRef: (row.sourceRef ?? null) as Record<string, unknown> | null,
    revision: row.revision,
    edited: row.revision > 1,
  };
}
