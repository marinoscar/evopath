import { z } from 'zod';

import { labReportValueSchema, sameLabResult, type LabReportValue } from './lab-report.value';

// =============================================================================
// `measurements.source_ref` for a result saved from a lab report (H4, #188)
// =============================================================================
//
// Written ONLY by the `lab_report` intake kind's `apply`, derived from the
// intake's own rows inside the apply transaction; no client can supply or
// change it (`/api/measurements` bodies are `.strict()` and refuse it).
//
//   AI item   -> { kind, intakeId, draftItemId, storageObjectIds, healthDocumentId?,
//                  aiDraft, confidence, userEdited, originalAiValue?,
//                  nameAsPrinted, originalValue, originalUnit, match,
//                  collectionDate, labName }
//   user item -> { kind, intakeId, healthDocumentId?, userAdded: true,
//                  collectionDate, labName }
//
// `aiDraft` is the result the model read, as the server drafted it (matched,
// canonical); `originalValue`/`originalUnit` are what the report PRINTED, so
// a converted value (glucose in mmol/L) keeps its source. `userEdited` says
// whether the saved result differs from `aiDraft` (analyte, canonical value,
// range or flag); `originalAiValue` (the drafted canonical value) is present
// only when it does. `collectionDate` is the date the row's entry is dated
// with (the result's own date, else the report date, #305); null when it had
// neither and was dated at apply time. `MeasurementsService.updateEntry`
// recomputes `userEdited` when a later edit changes the value.
// =============================================================================

export const LAB_REPORT_SOURCE_KIND = 'lab_report';

export interface LabReportAiSourceRef {
  kind: typeof LAB_REPORT_SOURCE_KIND;
  intakeId: string;
  draftItemId: string;
  storageObjectIds: string[];
  healthDocumentId?: string;
  aiDraft: LabReportValue;
  confidence: string | null;
  userEdited: boolean;
  originalAiValue?: number | null;
  nameAsPrinted: string | null;
  originalValue: number | null;
  originalUnit: string | null;
  match: string;
  collectionDate: string | null;
  labName: string | null;
}

export interface LabReportManualSourceRef {
  kind: typeof LAB_REPORT_SOURCE_KIND;
  intakeId: string;
  healthDocumentId?: string;
  userAdded: true;
  collectionDate: string | null;
  labName: string | null;
}

const labAiSourceRefSchema = z
  .object({
    kind: z.literal(LAB_REPORT_SOURCE_KIND),
    aiDraft: labReportValueSchema,
    userEdited: z.boolean(),
  })
  .loose();

/**
 * A lab-report AI row's `sourceRef` with `userEdited` (and `originalAiValue`)
 * recomputed for a new value in `unit` (the canonical unit the row stores).
 * Returns null when `sourceRef` is not a lab-report AI ref.
 */
export function recomputeLabUserEdited(
  sourceRef: unknown,
  reading: { metricKey: string; value: number; unit: string },
): Record<string, unknown> | null {
  const parsed = labAiSourceRefSchema.safeParse(sourceRef);
  if (!parsed.success) return null;

  const draft = parsed.data.aiDraft;
  const userEdited = !sameLabResult(draft, {
    ...draft,
    analyteKey: reading.metricKey,
    value: reading.value,
    unit: reading.unit,
  });

  const { originalAiValue: _dropped, ...rest } = sourceRef as Record<string, unknown>;
  return userEdited ? { ...rest, userEdited, originalAiValue: draft.value } : { ...rest, userEdited };
}
