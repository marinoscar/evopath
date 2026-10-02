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
import { createMeasurementEntrySchema, type MeasurementEntry } from '../dto/measurement.dto';
import { type EntryProvenance, MeasurementsService } from '../measurements.service';
import { getMetric } from '../metric-registry';
import { labApplyIssues, type LabApplyIssue, type LabDateGroup } from './lab-report-issues';
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
  effectiveCollectionDate,
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
// reviews them, and `apply` saves the accepted ones as ONE lab entry PER
// COLLECTION DATE (a trend report carries several dates, #305).
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
// APPLY runs inside the intake module's transaction; a throw rolls back
// every entry and the status flip, so the intake stays `ready`. Accepted
// items are GROUPED by their effective date (`effectiveCollectionDate`: the
// item's own `collectionDate`, else the context's report date, else none)
// and each group is saved as one lab entry: `measuredAt` is noon UTC of that
// date (never later than now), or the time of apply for the undated group.
// `MAX_LAB_READINGS_PER_ENTRY` and "one analyte once" hold PER GROUP, and
// their refusals name the date. `measuredAtSource` is `collection_date` when
// every group is dated, `apply_time` when none is, `mixed` otherwise; each
// row's provenance carries its group's `collectionDate` (null = apply time).
// The intake's health documents get `documentDate` = the newest group date.
// Retention is honoured by the intake module after `apply` (the purge jobs
// of H1).
//
// PERMISSIONS. `requiredPermissions` adds `health_data:read` / `:write` to
// the intake routes' `intakes:*`.
//
// ⚠ Never log or echo a value: messages name the item, the field and the rule.
// =============================================================================

/** One lab entry `apply` wrote: the results of one collection date. */
export interface LabReportAppliedEntry {
  entryId: string;
  /** The date the entry's results are dated with; null = the time of apply. */
  collectionDate: string | null;
  items: MeasurementEntry['items'];
}

/** What `POST /api/intakes/:id/apply` answers for this kind. */
export interface LabReportApplyResult {
  /** The first entry of `entries` (the newest date), or null when every item was rejected. Kept for older clients. */
  entryId: string | null;
  /** Every entry written, in `entries` order. */
  entryIds: string[];
  /** One entry per collection date, newest date first, the undated one (apply time) last. */
  entries: LabReportAppliedEntry[];
  /** Every saved row, across `entries`, in their order. */
  items: MeasurementEntry['items'];
  /**
   * `collection_date` when every entry is dated with a collection date,
   * `apply_time` when none is, `mixed` when some are; null when nothing was saved.
   */
  measuredAtSource: 'collection_date' | 'mixed' | 'apply_time' | null;
  /** The (newest) collection date written to the intake's health documents, or null. */
  documentDate: string | null;
}

type DateGroup = LabDateGroup<DraftItem>;

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
      return { entryId: null, entryIds: [], entries: [], items: [], measuredAtSource: null, documentDate: null };
    }

    const groups = this.checkAccepted(accepted, context);
    const labName = context?.labName ?? null;
    const now = new Date();
    const prepared = groups.map((group) => {
      const measuredAt = group.collectionDate ? measuredAtFor(group.collectionDate, now) : now;
      const parsed = createMeasurementEntrySchema.safeParse({
        measuredAt: measuredAt.toISOString(),
        readings: group.results.map(({ value }) => ({
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

      return { group, input: parsed.data };
    });

    const entries: LabReportAppliedEntry[] = [];
    for (const { group, input } of prepared) {
      const document = { collectionDate: group.collectionDate, labName };
      const provenance = group.results.map(({ item, value }) =>
        provenanceOf(intake.id, item, value, healthDocumentOf(item, healthDocuments), document),
      );
      const entry = await this.measurements.createEntryInTransaction(tx, userId, input, provenance);
      entries.push({ entryId: entry.entryId, collectionDate: group.collectionDate, items: entry.items });
    }

    // Groups are ordered newest date first, so the first dated one is the newest.
    const documentDate = groups.find((group) => group.collectionDate !== null)?.collectionDate ?? null;
    if (documentDate && healthDocuments.length > 0) {
      await tx.healthDocument.updateMany({
        where: { id: { in: healthDocuments.map((doc) => doc.id) }, userId },
        data: { documentDate: new Date(`${documentDate}T00:00:00.000Z`), version: { increment: 1 } },
      });
    }

    const dated = entries.filter((entry) => entry.collectionDate !== null).length;

    return {
      entryId: entries[0].entryId,
      entryIds: entries.map((entry) => entry.entryId),
      entries,
      items: entries.flatMap((entry) => entry.items),
      measuredAtSource: dated === entries.length ? 'collection_date' : dated === 0 ? 'apply_time' : 'mixed',
      documentDate: documentDate && healthDocuments.length > 0 ? documentDate : null,
    };
  }

  /**
   * Every accepted item checked by `labApplyIssues` (the function the review's
   * issues route shares, #317) and grouped by effective date. Unmatched
   * results refuse first (409, with every unresolved item id); then every
   * other issue at once (400), so the review can show each. Groups come back
   * newest date first, the undated one last.
   */
  private checkAccepted(accepted: readonly DraftItem[], context: LabReportContext): DateGroup[] {
    const { issues, groups } = labApplyIssues(accepted, context);
    const unresolved = issues.filter((issue) => issue.code === 'UNMATCHED').flatMap((issue) => issue.itemIds);

    if (unresolved.length > 0) {
      throw new ConflictException({
        message:
          unresolved.length === 1
            ? 'One result is not matched to a lab analyte; map it to an analyte or reject it'
            : `${unresolved.length} results are not matched to a lab analyte; map each to an analyte or reject it`,
        details: { reason: 'UNRESOLVED_ANALYTES', itemIds: unresolved, count: unresolved.length },
      });
    }

    if (issues.length > 0) {
      throw validationFailed(issues.map(applyIssueOf));
    }

    return groups;
  }
}

/** A shared issue as apply's 400 `details.issues` entry: the path names the item and field. */
function applyIssueOf(issue: LabApplyIssue): ApplyIssue {
  if (issue.code === 'DATE_CAP') return { path: 'items', message: issue.message };
  const base = `items.${issue.itemIds[0]}.value`;
  return { path: issue.field ? `${base}.${issue.field}` : base, message: issue.message };
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
