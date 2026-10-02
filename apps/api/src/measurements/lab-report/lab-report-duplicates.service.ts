import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { ACTIVE } from '../measurement-active';
import { roundCanonical } from '../metric-registry';
import type { LabReportDuplicates } from './dto/lab-report-duplicates.dto';
import { LAB_REPORT_SOURCE_KIND } from './lab-report-source-ref';
import {
  canonicalLabValueOf,
  effectiveCollectionDate,
  LAB_REPORT_KIND,
  labReportContextSchema,
  labReportValueSchema,
  todayUtc,
  utcDay,
} from './lab-report.value';

// =============================================================================
// Duplicate warning for a lab report under review (H4, #188)
// =============================================================================
//
// Re-importing a report the user already saved would write the same results
// twice. The review asks this service before apply: every draft result that
// is not rejected, is matched and has a number, compared with the caller's
// ACTIVE lab measurements of the same analyte on the same UTC day with the
// same canonical value. The day is the result's EFFECTIVE date (its own
// `collectionDate`, else the intake's report date, else today; #305), so a
// trend report is checked date by date. It only warns; `apply` never
// de-duplicates.
//
// Owner-scoped: another user's intake (or one of another kind) is a 404.
// Rows applied from this very intake are not reported against it.
// Nothing is logged: values and names never reach a log line.
// =============================================================================

@Injectable()
export class LabReportDuplicatesService {
  constructor(private readonly prisma: PrismaService) {}

  async find(userId: string, intakeId: string): Promise<LabReportDuplicates> {
    const intake = await this.prisma.photoIntake.findFirst({
      where: { id: intakeId, userId, kind: LAB_REPORT_KIND },
      select: { id: true, context: true },
    });

    if (!intake) throw new NotFoundException('Intake not found');

    const parsedContext = labReportContextSchema.safeParse(intake.context ?? undefined);
    const context = parsedContext.success ? parsedContext.data : undefined;
    const collectionDate = context?.collectionDate ?? null;
    const today = todayUtc();
    const checkedDate = collectionDate ?? today;

    const items = await this.prisma.draftItem.findMany({
      where: { intakeId, status: { not: 'rejected' } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, value: true },
    });

    const candidates = items
      .map((item) => {
        const parsed = labReportValueSchema.safeParse(item.value);
        if (!parsed.success || !parsed.data.analyteKey) return null;
        const canonical = canonicalLabValueOf(parsed.data);
        if (canonical === null) return null;
        return {
          itemId: item.id,
          analyteKey: parsed.data.analyteKey,
          value: roundCanonical(canonical),
          date: effectiveCollectionDate(parsed.data, context) ?? today,
        };
      })
      .filter((candidate): candidate is Candidate => candidate !== null);

    if (candidates.length === 0) {
      return { intakeId, checkedDate, collectionDate, duplicates: [] };
    }

    const days = [...new Set(candidates.map((candidate) => candidate.date))].map((date) => utcDay(date));
    const rows = await this.prisma.measurement.findMany({
      where: {
        userId,
        ...ACTIVE,
        metricKey: { in: [...new Set(candidates.map((candidate) => candidate.analyteKey))] },
        OR: days.map(({ start, end }) => ({ measuredAt: { gte: start, lt: end } })),
      },
      orderBy: [{ measuredAt: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, entryId: true, metricKey: true, value: true, unit: true, measuredAt: true, origin: true, sourceRef: true },
    });

    const duplicates = candidates.flatMap((candidate) => {
      const { start, end } = utcDay(candidate.date);
      const sameDay = rows.filter(
        (row) => row.metricKey === candidate.analyteKey && row.measuredAt >= start && row.measuredAt < end,
      );
      const matches = sameDay
        .filter((row) => row.value === candidate.value)
        .map((row) => ({ row, ref: refOf(row.sourceRef) }))
        .filter(({ ref }) => ref.intakeId !== intakeId)
        .map(({ row, ref }) => ({
          measurementId: row.id,
          entryId: row.entryId,
          measuredAt: row.measuredAt.toISOString(),
          origin: row.origin,
          healthDocumentId: ref.healthDocumentId,
          intakeId: ref.intakeId,
        }));

      if (matches.length === 0) return [];
      return [
        {
          itemId: candidate.itemId,
          analyteKey: candidate.analyteKey,
          value: candidate.value,
          unit: sameDay[0].unit,
          checkedDate: candidate.date,
          matches,
        },
      ];
    });

    return { intakeId, checkedDate, collectionDate, duplicates };
  }
}

interface Candidate {
  itemId: string;
  analyteKey: string;
  value: number;
  date: string;
}

/** The intake and document ids of a photo or lab-report `sourceRef`; nulls for anything else. */
function refOf(sourceRef: unknown): { intakeId: string | null; healthDocumentId: string | null } {
  if (!sourceRef || typeof sourceRef !== 'object') return { intakeId: null, healthDocumentId: null };
  const ref = sourceRef as Record<string, unknown>;
  const known = ref.kind === LAB_REPORT_SOURCE_KIND || ref.kind === 'photo_intake';
  return {
    intakeId: known && typeof ref.intakeId === 'string' ? ref.intakeId : null,
    healthDocumentId: known && typeof ref.healthDocumentId === 'string' ? ref.healthDocumentId : null,
  };
}
