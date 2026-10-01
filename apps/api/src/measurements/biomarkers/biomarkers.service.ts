import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { MeasurementFlag } from '../dto/measurement.dto';
import { getMetric, LAB_METRIC_KEYS, roundCanonical } from '../metric-registry';
import {
  type BiomarkerResult,
  type BiomarkerSummary,
  type BiomarkerSummaryQuery,
  OUT_OF_RANGE_FLAGS,
} from './dto/biomarker-summary.dto';

// =============================================================================
// BiomarkersService — the caller's lab results per analyte (H5, #189)
// =============================================================================
//
// ONE QUERY. A window function ranks each analyte's active results newest
// first (the same order as `GET /api/measurements`: `measuredAt`, then
// insertion time, then id) and counts them; only ranks 1 and 2 come back.
// No per-analyte round trip, whatever the catalog size.
//
// OWNER SCOPE AND ACTIVE ROWS. The SQL carries `user_id` and the `ACTIVE`
// predicate (`measurement-active.ts`) spelled as columns: superseded and
// soft-deleted rows are never ranked or counted.
//
// ⚠ NEVER LOG VALUES OR RANGES.
// =============================================================================

interface RankedRow {
  id: string;
  metric_key: string;
  value: number;
  measured_at: Date;
  flag: string | null;
  reference_low: number | null;
  reference_high: number | null;
  reference_text: string | null;
  rn: number;
  total: number;
}

const OUT_OF_RANGE: ReadonlySet<string> = new Set(OUT_OF_RANGE_FLAGS);

@Injectable()
export class BiomarkersService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(userId: string, query: BiomarkerSummaryQuery): Promise<BiomarkerSummary> {
    const keys = LAB_METRIC_KEYS.filter(
      (key) => !query.panel || getMetric(key)!.panel === query.panel,
    );

    const rows = await this.prisma.$queryRaw<RankedRow[]>(Prisma.sql`
      SELECT id, metric_key, value, measured_at, flag,
             reference_low, reference_high, reference_text, rn, total
      FROM (
        SELECT id, metric_key, value, measured_at, flag,
               reference_low, reference_high, reference_text,
               (row_number() OVER (
                 PARTITION BY metric_key
                 ORDER BY measured_at DESC, created_at DESC, id DESC
               ))::int AS rn,
               (count(*) OVER (PARTITION BY metric_key))::int AS total
        FROM measurements
        WHERE user_id = ${userId}::uuid
          AND superseded_at IS NULL
          AND deleted_at IS NULL
          AND metric_key IN (${Prisma.join(keys)})
      ) ranked
      WHERE rn <= 2
    `);

    const byKey = new Map<string, { latest?: RankedRow; previous?: RankedRow }>();
    for (const row of rows) {
      const slot = byKey.get(row.metric_key) ?? {};
      if (row.rn === 1) slot.latest = row;
      else slot.previous = row;
      byKey.set(row.metric_key, slot);
    }

    const items: BiomarkerSummary['items'] = [];

    // Registry order: panel order, then analyte order within the panel.
    for (const key of keys) {
      const slot = byKey.get(key);
      if (!slot?.latest) continue;

      const { latest, previous } = slot;
      if (query.outOfRange && !(latest.flag && OUT_OF_RANGE.has(latest.flag))) continue;

      const metric = getMetric(key)!;
      items.push({
        analyteKey: key,
        label: metric.label,
        panel: metric.panel!,
        unit: metric.canonicalUnit,
        latest: toResult(latest),
        previous: previous ? toResult(previous) : null,
        delta: previous ? roundCanonical(Number(latest.value) - Number(previous.value)) : null,
        count: Number(latest.total),
      });
    }

    return { items };
  }
}

function toResult(row: RankedRow): BiomarkerResult {
  return {
    measurementId: row.id,
    value: Number(row.value),
    measuredAt: new Date(row.measured_at).toISOString(),
    flag: row.flag as MeasurementFlag | null,
    referenceLow: row.reference_low === null ? null : Number(row.reference_low),
    referenceHigh: row.reference_high === null ? null : Number(row.reference_high),
    referenceText: row.reference_text,
  };
}
