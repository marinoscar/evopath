import { z } from 'zod';

import { LAB_REPORT_SOURCE_KIND, recomputeLabUserEdited } from '../lab-report/lab-report-source-ref';
import { bodyMetricReadingValueSchema, sameReading, type BodyMetricReadingValue } from './body-metric-reading.value';

// =============================================================================
// `measurements.source_ref` for a reading saved from a photo (E2.6, #64)
// =============================================================================
//
// Written ONLY by the `body_metric_reading` intake kind's `apply`, derived from
// the intake's own rows inside the apply transaction; no client can supply or
// change it (`/api/measurements` bodies are `.strict()` and refuse it).
//
//   AI item   -> { kind, intakeId, draftItemId, storageObjectIds, aiDraft,
//                  confidence, userEdited, healthDocumentId? }
//   user item -> { kind, intakeId, healthDocumentId? }   (added by hand in
//                  the same review, so the entry stays linked to the photos)
//
// `healthDocumentId` (H1, #185) names the health document the reading came
// from (the file of its first source photo, else the intake's first file).
// It survives the file's deletion: the document row stays with
// `file_deleted_at` set, and `/api/measurements` reports `fileDeleted`.
// Rows saved before H1 have none.
//
// `aiDraft` is the value the model proposed, as displayed on the device;
// `userEdited` says whether the saved reading differs from it (the same
// metric and canonical value = not edited). `MeasurementsService.updateEntry`
// recomputes it whenever a later edit changes the value.
// =============================================================================

export const PHOTO_INTAKE_SOURCE_KIND = 'photo_intake';

export interface PhotoAiSourceRef {
  kind: typeof PHOTO_INTAKE_SOURCE_KIND;
  intakeId: string;
  draftItemId: string;
  storageObjectIds: string[];
  aiDraft: BodyMetricReadingValue;
  confidence: string | null;
  userEdited: boolean;
  healthDocumentId?: string;
}

export interface PhotoManualSourceRef {
  kind: typeof PHOTO_INTAKE_SOURCE_KIND;
  intakeId: string;
  healthDocumentId?: string;
}

/**
 * The `healthDocumentId` of a measurement's `sourceRef`, or null (no document,
 * or neither a photo nor a lab-report ref, H4 #188).
 */
export function healthDocumentIdOf(sourceRef: unknown): string | null {
  if (!sourceRef || typeof sourceRef !== 'object') return null;
  const ref = sourceRef as Record<string, unknown>;
  if (ref.kind !== PHOTO_INTAKE_SOURCE_KIND && ref.kind !== LAB_REPORT_SOURCE_KIND) return null;
  return typeof ref.healthDocumentId === 'string' ? ref.healthDocumentId : null;
}

/** Just enough of an AI source ref to recompute `userEdited`; anything else passes through untouched. */
const aiSourceRefSchema = z
  .object({
    kind: z.literal(PHOTO_INTAKE_SOURCE_KIND),
    aiDraft: bodyMetricReadingValueSchema,
    userEdited: z.boolean(),
  })
  .loose();

/**
 * A photo-read (or lab-report, H4 #188) row's `sourceRef` with `userEdited`
 * recomputed against a new value (`value` in `unit`, normally the canonical
 * unit the row stores). Returns `sourceRef` unchanged when it is neither.
 */
export function withRecomputedUserEdited(
  sourceRef: unknown,
  reading: { metricKey: string; value: number; unit: string },
): unknown {
  const lab = recomputeLabUserEdited(sourceRef, reading);
  if (lab) return lab;

  const parsed = aiSourceRefSchema.safeParse(sourceRef);

  if (!parsed.success) return sourceRef;

  const userEdited = !sameReading(parsed.data.aiDraft, reading as BodyMetricReadingValue);

  return { ...(sourceRef as Record<string, unknown>), userEdited };
}
