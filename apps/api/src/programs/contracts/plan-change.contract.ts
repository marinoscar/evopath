import { z } from 'zod';

// =============================================================================
// Plan change payloads stored with a change-log entry (E5.1)
// =============================================================================
//
// `PlanChangeOperation` is a stub here: the evaluator story owns the real
// discriminated union. This story stores operations, citations and evidence as
// JSON arrays of objects under a size cap, so a runaway writer cannot bloat
// the change log.
// =============================================================================

/** Serialized size cap for `operations`, `citations` and `evidence`, each. */
export const PLAN_CHANGE_JSON_MAX_BYTES = 64 * 1024;

/** Placeholder for the evaluator's operation union. */
export type PlanChangeOperation = Record<string, unknown>;

/** One evidence item on a version (a verified citation, a signal reference). */
export type Evidence = Record<string, unknown>;

function cappedObjectArray(label: string) {
  return z
    .array(z.record(z.string(), z.unknown()))
    .refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= PLAN_CHANGE_JSON_MAX_BYTES, {
      message: `${label} must serialize to at most ${PLAN_CHANGE_JSON_MAX_BYTES} bytes`,
    });
}

export const planChangeOperationsSchema = cappedObjectArray('operations');
export const planChangeCitationsSchema = cappedObjectArray('citations');
export const planEvidenceSchema = cappedObjectArray('evidence');
