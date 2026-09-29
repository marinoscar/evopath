import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import type { DraftItem, Prisma } from '@prisma/client';
import { z } from 'zod';

import type {
  IntakeApplyArgs,
  IntakeKind,
  IntakeKindPermissions,
  IntakeValueSource,
} from '../../intake/intake-kind.interface';
import { IntakeKindRegistry } from '../../intake/intake-kind.registry';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { createMeasurementEntrySchema, type MeasurementEntry } from '../dto/measurement.dto';
import { type EntryProvenance, MeasurementsService } from '../measurements.service';
import { BP_DIASTOLIC, BP_SYSTOLIC } from '../metric-registry';
import {
  BODY_METRIC_READING_ITEM_KIND,
  BODY_METRIC_READING_JOB_TYPE,
  BODY_METRIC_READING_KIND,
  BODY_METRIC_READING_MAX_PHOTOS,
  bodyMetricReadingValueSchema,
  canonicalUnitSpelling,
  canonicalValueOf,
  metricLabel,
  readingProblems,
  sameReading,
  type BodyMetricReadingValue,
} from './body-metric-reading.value';
import { PHOTO_INTAKE_SOURCE_KIND, type PhotoAiSourceRef, type PhotoManualSourceRef } from './photo-source-ref';

// =============================================================================
// Intake kind `body_metric_reading` (E2.6, #64)
// =============================================================================
//
// "Read a value from a photo": the user photographs a scale or a
// blood-pressure-cuff display, `ai.health.body_metric_reading` drafts one item
// per reading, the user reviews them (E3.1's review), and `apply` saves the
// accepted ones as ONE measurement entry.
//
// VALIDATION. `valueSchema` checks the shape; `normalizeValue` fixes the
// unit's spelling and, for a USER write (an edit, or an "Add missing" item),
// refuses a unit or method the metric does not allow and a value outside the
// hard bounds with a 400 naming the field. An ANALYZER write is never refused
// here (E3.1 never drops an AI item): the mapper flags it and `apply` refuses
// it until the user edits or rejects it.
//
// APPLY runs inside E3.1's transaction; a throw rolls back the entry and the
// status flip, so the intake stays `ready`. It re-checks every accepted item,
// then the set: one reading per metric, the blood-pressure pair together,
// systolic above diastolic. `measuredAt` is the time of apply.
//
// PERMISSIONS. `requiredPermissions` adds `health_data:read` / `:write` to
// E3.1's `intakes:*` route permissions (checked by `IntakeService`, 403).
//
// PROVENANCE is derived here from the intake's own rows, never from a client:
// see `photo-source-ref.ts`.
//
// ⚠ Never log or echo a value: messages name the item, the field and the rule.
// =============================================================================

const contextSchema = z.object({}).strict().optional();

type Context = z.output<typeof contextSchema>;

/** What `POST /api/intakes/:id/apply` answers for this kind. */
export interface BodyMetricApplyResult {
  /** The new measurement entry, or null when every item was rejected. */
  entryId: string | null;
  items: MeasurementEntry['items'];
}

interface ApplyIssue {
  path: string;
  message: string;
}

@Injectable()
export class BodyMetricReadingIntakeKind implements IntakeKind<Context, BodyMetricReadingValue>, OnModuleInit {
  readonly kind = BODY_METRIC_READING_KIND;
  readonly contextSchema = contextSchema;
  readonly valueSchema = bodyMetricReadingValueSchema;
  readonly analyzeJobType = BODY_METRIC_READING_JOB_TYPE;
  readonly maxPhotos = BODY_METRIC_READING_MAX_PHOTOS;
  readonly itemKinds = [BODY_METRIC_READING_ITEM_KIND] as const;
  // The intake stages and writes health data: on top of `intakes:*`, seeing
  // one needs `health_data:read` and every change (create, photos, analyze,
  // items, apply) needs `health_data:write` — the permissions
  // `/api/measurements` enforces.
  readonly requiredPermissions: IntakeKindPermissions = {
    read: [PERMISSIONS.HEALTH_DATA_READ],
    write: [PERMISSIONS.HEALTH_DATA_WRITE],
  };

  constructor(
    private readonly registry: IntakeKindRegistry,
    private readonly measurements: MeasurementsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  normalizeValue(value: BodyMetricReadingValue, _context: Context, source: IntakeValueSource): BodyMetricReadingValue {
    const normalized: BodyMetricReadingValue = { ...value, unit: canonicalUnitSpelling(value.metricKey, value.unit) };

    if (source === 'user') {
      const problems = readingProblems(normalized);

      if (problems.length > 0) {
        throw validationFailed(problems.map((problem) => ({ path: `value.${problem.field}`, message: problem.message })));
      }
    }

    return normalized;
  }

  async apply({ tx, userId, intake, accepted }: IntakeApplyArgs<Context>): Promise<BodyMetricApplyResult> {
    if (intake.kind !== BODY_METRIC_READING_KIND) {
      throw new BadRequestException({
        message: `This intake is not a ${BODY_METRIC_READING_KIND} intake`,
        details: { reason: 'WRONG_INTAKE_KIND', kind: intake.kind },
      });
    }

    if (accepted.length === 0) {
      return { entryId: null, items: [] };
    }

    const readings = this.checkAccepted(accepted);

    const parsed = createMeasurementEntrySchema.safeParse({
      readings: readings.map(({ value }) => ({
        metricKey: value.metricKey,
        value: value.value,
        unit: value.unit,
        ...(value.method !== undefined ? { method: value.method } : {}),
      })),
    });

    if (!parsed.success) {
      // Defence in depth: `checkAccepted` already enforces every rule the
      // measurements schema has, with messages about the items.
      throw validationFailed(
        parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
      );
    }

    const provenance = readings.map(({ item, value }) => provenanceOf(intake.id, item, value));

    const entry = await this.measurements.createEntryInTransaction(
      tx,
      userId,
      { ...parsed.data, measuredAt: new Date(), notes: null },
      provenance,
    );

    return { entryId: entry.entryId, items: entry.items };
  }

  /**
   * Every accepted item parsed and checked, then the set. Collects all issues
   * before throwing so the review can show each at once.
   */
  private checkAccepted(accepted: readonly DraftItem[]): Array<{ item: DraftItem; value: BodyMetricReadingValue }> {
    const issues: ApplyIssue[] = [];
    const readings: Array<{ item: DraftItem; value: BodyMetricReadingValue }> = [];

    for (const item of accepted) {
      const at = (field?: string) => ['items', item.id, 'value', ...(field ? [field] : [])].join('.');
      const parsed = bodyMetricReadingValueSchema.safeParse(item.value);

      if (!parsed.success || item.kind !== BODY_METRIC_READING_ITEM_KIND) {
        issues.push({ path: at(), message: 'This item is not a valid reading; edit or reject it' });
        continue;
      }

      const value = { ...parsed.data, unit: canonicalUnitSpelling(parsed.data.metricKey, parsed.data.unit) };
      const label = metricLabel(value.metricKey);

      for (const problem of readingProblems(value)) {
        issues.push({ path: at(problem.field), message: `${label}: ${problem.message}; edit or reject it` });
      }

      readings.push({ item, value });
    }

    const byMetric = new Map<string, number>();

    for (const { item, value } of readings) {
      if (byMetric.has(value.metricKey)) {
        issues.push({
          path: `items.${item.id}.value.metricKey`,
          message: `${metricLabel(value.metricKey)} is accepted more than once; reject one of them`,
        });
      }
      byMetric.set(value.metricKey, canonicalValueOf(value) ?? Number.NaN);
    }

    const hasSystolic = byMetric.has(BP_SYSTOLIC);
    const hasDiastolic = byMetric.has(BP_DIASTOLIC);

    if (hasSystolic !== hasDiastolic) {
      issues.push({ path: 'items', message: 'Enter both blood pressure numbers' });
    } else if (hasSystolic && hasDiastolic) {
      const systolic = byMetric.get(BP_SYSTOLIC)!;
      const diastolic = byMetric.get(BP_DIASTOLIC)!;

      if (Number.isFinite(systolic) && Number.isFinite(diastolic) && systolic <= diastolic) {
        issues.push({ path: 'items', message: 'The systolic (top) number must be higher than the diastolic (bottom) one' });
      }
    }

    if (issues.length > 0) {
      throw validationFailed(issues);
    }

    return readings;
  }
}

/**
 * The row's provenance, from the intake's own item: an AI item keeps the
 * model's original reading, the photos it came from and whether the user
 * changed it; a user item stays `manual`, linked to the intake.
 */
function provenanceOf(intakeId: string, item: DraftItem, saved: BodyMetricReadingValue): EntryProvenance {
  if (item.origin !== 'ai') {
    const sourceRef: PhotoManualSourceRef = { kind: PHOTO_INTAKE_SOURCE_KIND, intakeId };
    return { origin: 'manual', sourceRef: sourceRef as unknown as Prisma.InputJsonValue };
  }

  const original = bodyMetricReadingValueSchema.safeParse(item.originalAiValue ?? item.value);
  const aiDraft = original.success ? original.data : saved;

  const sourceRef: PhotoAiSourceRef = {
    kind: PHOTO_INTAKE_SOURCE_KIND,
    intakeId,
    draftItemId: item.id,
    storageObjectIds: [...item.sourcePhotoIds],
    aiDraft,
    confidence: item.confidence ?? null,
    userEdited: item.originalAiValue !== null && item.originalAiValue !== undefined && !sameReading(aiDraft, saved),
  };

  return { origin: 'ai', sourceRef: sourceRef as unknown as Prisma.InputJsonValue };
}

function validationFailed(issues: ApplyIssue[]): BadRequestException {
  return new BadRequestException({
    message: issues.length === 1 ? issues[0].message : 'Validation failed',
    details: { issues },
  });
}
