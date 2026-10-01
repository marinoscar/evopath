import { BadRequestException, ConflictException, Injectable, OnModuleInit } from '@nestjs/common';
import type { DraftItem, Prisma } from '@prisma/client';

import { PERMISSIONS } from '../../common/constants/roles.constants';
import type {
  IntakeApplyArgs,
  IntakeKind,
  IntakeKindPermissions,
  IntakeValueSource,
} from '../../intake/intake-kind.interface';
import { IntakeKindRegistry } from '../../intake/intake-kind.registry';
import { createMeasurementEntrySchema, MAX_LAB_READINGS_PER_ENTRY, type MeasurementEntry } from '../dto/measurement.dto';
import { type EntryProvenance, MeasurementsService } from '../measurements.service';
import { getMetric } from '../metric-registry';
import { LAB_REPORT_SOURCE_KIND, type LabReportAiSourceRef, type LabReportManualSourceRef } from './lab-report-source-ref';
import {
  analyteLabel,
  LAB_REPORT_ITEM_KIND,
  LAB_REPORT_JOB_TYPE,
  LAB_REPORT_KIND,
  LAB_REPORT_MAX_PHOTOS,
  labReportContextSchema,
  labResultProblems,
  labReportValueSchema,
  matchOf,
  measuredAtFor,
  sameLabResult,
  toCanonicalLabValue,
  type LabReportContext,
  type LabReportValue,
} from './lab-report.value';

// =============================================================================
// Intake kind `lab_report` (H4, #188)
// =============================================================================
//
// "Import a lab report": the user attaches a lab report PDF or photos of its
// pages, `ai.health.lab_report` drafts one item per printed result (matched to
// the lab catalog and converted to canonical units by the SERVER), the user
// reviews them, and `apply` saves the accepted ones as ONE lab entry.
//
// UNMATCHED RESULTS ARE NEVER DROPPED. An accepted result without an
// `analyteKey` refuses the whole apply with 409 `UNRESOLVED_ANALYTES`
// (`details.itemIds`) until the user maps it to a catalog key (an edit) or
// rejects it. A pending one is already refused by `PENDING_ITEMS`.
//
// VALIDATION. `normalizeValue` converts a matched result to the canonical unit
// (keeping the printed value and unit) for every write; for a USER write it
// also recomputes `match` and refuses a unit the analyte does not allow, a
// value outside the hard bounds and reversed limits with a 400 naming the
// field. An ANALYZER write is never refused (the mapper flags it).
//
// APPLY runs inside the intake module's transaction; a throw rolls back the
// entry and the status flip, so the intake stays `ready`. `measuredAt` is the
// context's `collectionDate` (noon UTC, never later than now), else the time
// of apply (`measuredAtSource: 'apply_time'` in the result and
// `collectionDate: null` in each row's provenance). The intake's health
// documents get `documentDate` = the collection date. Retention is honoured by
// the intake module after `apply` (the purge jobs of H1).
//
// PERMISSIONS. `requiredPermissions` adds `health_data:read` / `:write` to
// the intake routes' `intakes:*`.
//
// ⚠ Never log or echo a value: messages name the item, the field and the rule.
// =============================================================================

/** What `POST /api/intakes/:id/apply` answers for this kind. */
export interface LabReportApplyResult {
  /** The new lab entry, or null when every item was rejected. */
  entryId: string | null;
  items: MeasurementEntry['items'];
  /** `collection_date` when the results are dated with the report's collection date, `apply_time` otherwise. */
  measuredAtSource: 'collection_date' | 'apply_time' | null;
  /** The collection date written to the intake's health documents, or null. */
  documentDate: string | null;
}

interface ApplyIssue {
  path: string;
  message: string;
}

@Injectable()
export class LabReportIntakeKind implements IntakeKind<LabReportContext, LabReportValue>, OnModuleInit {
  readonly kind = LAB_REPORT_KIND;
  readonly contextSchema = labReportContextSchema;
  readonly valueSchema = labReportValueSchema;
  readonly analyzeJobType = LAB_REPORT_JOB_TYPE;
  readonly aiFeature = 'lab_report' as const;
  readonly maxPhotos = LAB_REPORT_MAX_PHOTOS;
  readonly itemKinds = [LAB_REPORT_ITEM_KIND] as const;
  readonly acceptedInputs = ['image', 'pdf'] as const;
  readonly healthDocumentKind = 'lab_report' as const;
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

  normalizeValue(value: LabReportValue, _context: LabReportContext, source: IntakeValueSource): LabReportValue {
    const named: LabReportValue =
      value.nameAsPrinted === null && value.analyteKey
        ? { ...value, nameAsPrinted: analyteLabel(value.analyteKey) }
        : value;

    if (source === 'analyzer') {
      return toCanonicalLabValue(named);
    }

    const defaulted: LabReportValue =
      named.analyteKey && named.unit === null ? { ...named, unit: getMetric(named.analyteKey)!.canonicalUnit } : named;
    const problems = labResultProblems(defaulted, { requireValue: false });

    if (problems.length > 0) {
      throw validationFailed(problems.map((problem) => ({ path: `value.${problem.field}`, message: problem.message })));
    }

    const normalized = toCanonicalLabValue(defaulted);
    return { ...normalized, match: matchOf(normalized.analyteKey, normalized.nameAsPrinted) };
  }

  async apply({
    tx,
    userId,
    intake,
    context,
    accepted,
    healthDocuments = [],
  }: IntakeApplyArgs<LabReportContext>): Promise<LabReportApplyResult> {
    if (intake.kind !== LAB_REPORT_KIND) {
      throw new BadRequestException({
        message: `This intake is not a ${LAB_REPORT_KIND} intake`,
        details: { reason: 'WRONG_INTAKE_KIND', kind: intake.kind },
      });
    }

    if (accepted.length === 0) {
      return { entryId: null, items: [], measuredAtSource: null, documentDate: null };
    }

    const results = this.checkAccepted(accepted);
    const collectionDate = context?.collectionDate ?? null;
    const labName = context?.labName ?? null;
    const measuredAt = collectionDate ? measuredAtFor(collectionDate) : new Date();

    const parsed = createMeasurementEntrySchema.safeParse({
      measuredAt: measuredAt.toISOString(),
      readings: results.map(({ value }) => ({
        metricKey: value.analyteKey!,
        value: value.value!,
        unit: value.unit!,
        method: 'lab',
        referenceLow: value.referenceLow,
        referenceHigh: value.referenceHigh,
        referenceText: value.referenceText,
        flag: value.flag,
      })),
    });

    if (!parsed.success) {
      // Defence in depth: `checkAccepted` enforces the same rules with messages about the items.
      throw validationFailed(
        parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
      );
    }

    const document = { collectionDate, labName };
    const provenance = results.map(({ item, value }) =>
      provenanceOf(intake.id, item, value, healthDocumentOf(item, healthDocuments), document),
    );

    const entry = await this.measurements.createEntryInTransaction(tx, userId, parsed.data, provenance);

    if (collectionDate && healthDocuments.length > 0) {
      await tx.healthDocument.updateMany({
        where: { id: { in: healthDocuments.map((doc) => doc.id) }, userId },
        data: { documentDate: new Date(`${collectionDate}T00:00:00.000Z`) },
      });
    }

    return {
      entryId: entry.entryId,
      items: entry.items,
      measuredAtSource: collectionDate ? 'collection_date' : 'apply_time',
      documentDate: collectionDate && healthDocuments.length > 0 ? collectionDate : null,
    };
  }

  /**
   * Every accepted item parsed and checked, then the set. Unmatched results
   * refuse first (409, with every unresolved item id); then every other issue
   * at once (400), so the review can show each.
   */
  private checkAccepted(accepted: readonly DraftItem[]): Array<{ item: DraftItem; value: LabReportValue }> {
    const issues: ApplyIssue[] = [];
    const unresolved: string[] = [];
    const results: Array<{ item: DraftItem; value: LabReportValue }> = [];

    for (const item of accepted) {
      const parsed = labReportValueSchema.safeParse(item.value);

      if (!parsed.success || item.kind !== LAB_REPORT_ITEM_KIND) {
        issues.push({ path: `items.${item.id}.value`, message: 'This item is not a valid lab result; edit or reject it' });
        continue;
      }

      if (!parsed.data.analyteKey) {
        unresolved.push(item.id);
        continue;
      }

      const value = toCanonicalLabValue(parsed.data);
      const label = analyteLabel(value.analyteKey!);

      for (const problem of labResultProblems(value, { requireValue: true })) {
        const prefixed = problem.message.startsWith(label) ? problem.message : `${label}: ${problem.message}`;
        const message = /reject it$/.test(prefixed) ? prefixed : `${prefixed}; edit or reject it`;
        issues.push({ path: `items.${item.id}.value.${problem.field}`, message });
      }

      results.push({ item, value });
    }

    if (unresolved.length > 0) {
      throw new ConflictException({
        message:
          unresolved.length === 1
            ? 'One result is not matched to a lab analyte; map it to an analyte or reject it'
            : `${unresolved.length} results are not matched to a lab analyte; map each to an analyte or reject it`,
        details: { reason: 'UNRESOLVED_ANALYTES', itemIds: unresolved, count: unresolved.length },
      });
    }

    const seen = new Set<string>();
    for (const { item, value } of results) {
      if (seen.has(value.analyteKey!)) {
        issues.push({
          path: `items.${item.id}.value.analyteKey`,
          message: `${analyteLabel(value.analyteKey!)} is accepted more than once; reject one of them`,
        });
      }
      seen.add(value.analyteKey!);
    }

    if (results.length > MAX_LAB_READINGS_PER_ENTRY) {
      issues.push({
        path: 'items',
        message: `One report saves at most ${MAX_LAB_READINGS_PER_ENTRY} results; reject ${results.length - MAX_LAB_READINGS_PER_ENTRY} of them`,
      });
    }

    if (issues.length > 0) {
      throw validationFailed(issues);
    }

    return results;
  }
}

/**
 * The row's provenance, from the intake's own item: an AI item keeps the
 * drafted result, the printed value and unit, the inputs it came from and
 * whether the user changed it; a user item stays `manual`, linked to the intake.
 */
function provenanceOf(
  intakeId: string,
  item: DraftItem,
  saved: LabReportValue,
  healthDocumentId: string | null,
  document: { collectionDate: string | null; labName: string | null },
): EntryProvenance {
  const link = healthDocumentId ? { healthDocumentId } : {};

  if (item.origin !== 'ai') {
    const sourceRef: LabReportManualSourceRef = {
      kind: LAB_REPORT_SOURCE_KIND,
      intakeId,
      ...link,
      userAdded: true,
      ...document,
    };
    return { origin: 'manual', sourceRef: sourceRef as unknown as Prisma.InputJsonValue };
  }

  const original = labReportValueSchema.safeParse(item.originalAiValue ?? item.value);
  const aiDraft = original.success ? toCanonicalLabValue(original.data) : saved;
  const edited = item.originalAiValue !== null && item.originalAiValue !== undefined && !sameLabResult(aiDraft, saved);

  const sourceRef: LabReportAiSourceRef = {
    kind: LAB_REPORT_SOURCE_KIND,
    intakeId,
    draftItemId: item.id,
    storageObjectIds: [...item.sourcePhotoIds],
    ...link,
    aiDraft,
    confidence: item.confidence ?? null,
    userEdited: edited,
    ...(edited ? { originalAiValue: aiDraft.value } : {}),
    nameAsPrinted: aiDraft.nameAsPrinted,
    originalValue: aiDraft.originalValue,
    originalUnit: aiDraft.originalUnit,
    match: saved.match,
    ...document,
  };

  return { origin: 'ai', sourceRef: sourceRef as unknown as Prisma.InputJsonValue };
}

/**
 * The health document a result came from: the document of the first input
 * the AI read it from, else the intake's first document; null when none.
 */
function healthDocumentOf(
  item: DraftItem,
  documents: ReadonlyArray<{ id: string; storageObjectId: string | null }>,
): string | null {
  for (const photoId of item.sourcePhotoIds) {
    const match = documents.find((document) => document.storageObjectId === photoId);
    if (match) return match.id;
  }
  return documents[0]?.id ?? null;
}

function validationFailed(issues: ApplyIssue[]): BadRequestException {
  return new BadRequestException({
    message: issues.length === 1 ? issues[0].message : 'Validation failed',
    details: { issues },
  });
}
