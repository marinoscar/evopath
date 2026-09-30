import { z } from 'zod';

// =============================================================================
// Plan change payloads stored with a change-log entry (E5.1), and the typed
// plan-change operations the evaluator proposes (E5.8)
// =============================================================================
//
// STORAGE. Operations, citations and evidence are stored as JSON arrays of
// objects under a size cap, so a runaway writer cannot bloat the change log.
// The storage schemas stay generic (objects), so entries written before the
// operation union existed still read back.
//
// THE OPERATION UNION. `PlanChangeOperation` is what the evaluator may ask
// for: small, typed, describable, boundable and revertible edits of the
// remaining plan, never a rewritten plan. It is strict-mode compatible
// (closed objects, nullable instead of optional) because it is part of the
// evaluator's structured output. Plan rows are named by SHORT REF
// (`W3-2-4` = week 3, workout 2, exercise 4; `W3-2` = the workout); the
// server maps refs back to row ids and never trusts one it did not issue.
// Exercises are named by stable key (slug). `null` in a `set_prescription`
// field means "leave it as it is".
//
// A server-prepared SAFETY operation (a forced removal after repeated pain)
// is a `remove_exercise` with `forced: true`; the model never sends `forced`.
// =============================================================================

/** Serialized size cap for `operations`, `citations` and `evidence`, each. */
export const PLAN_CHANGE_JSON_MAX_BYTES = 64 * 1024;

export const PLAN_CHANGE_LIMITS = {
  reasonChars: 200,
  instructionChars: 300,
  refChars: 16,
  keyChars: 120,
  weekMax: 52,
} as const;

const L = PLAN_CHANGE_LIMITS;

const reason = z.string().max(L.reasonChars);
const ref = z.string().max(L.refChars);
const exerciseKey = z.string().max(L.keyChars);
const week = z.number().int().min(1).max(L.weekMax);

export const weekRangeSchema = z.object({ from: week, to: week });
export type PlanChangeWeekRange = z.infer<typeof weekRangeSchema>;

export const operationTargetSchema = z.object({ exerciseRef: ref, weeks: weekRangeSchema });
export type PlanChangeTarget = z.infer<typeof operationTargetSchema>;

export const setPrescriptionOperationSchema = z.object({
  op: z.literal('set_prescription'),
  target: operationTargetSchema,
  sets: z.number().int().nullable(),
  repMin: z.number().int().nullable(),
  repMax: z.number().int().nullable(),
  targetRpe: z.number().nullable(),
  restSeconds: z.number().int().nullable(),
  targetLoadKg: z.number().nullable(),
  loadGuidance: z.enum(['choose_start', 'from_history', 'fixed']).nullable(),
  reason,
});

export const swapExerciseOperationSchema = z.object({
  op: z.literal('swap_exercise'),
  target: operationTargetSchema,
  withExerciseKey: exerciseKey,
  reason,
});

export const removeExerciseOperationSchema = z.object({
  op: z.literal('remove_exercise'),
  target: operationTargetSchema,
  reason,
});

export const addExerciseOperationSchema = z.object({
  op: z.literal('add_exercise'),
  workoutRef: ref,
  weeks: weekRangeSchema,
  exerciseKey,
  sets: z.number().int(),
  repMin: z.number().int(),
  repMax: z.number().int(),
  targetRpe: z.number().nullable(),
  restSeconds: z.number().int(),
  reason,
});

export const setWeekdayOperationSchema = z.object({
  op: z.literal('set_weekday'),
  workoutRef: ref,
  weeks: weekRangeSchema,
  weekday: z.number().int().min(1).max(7),
  reason,
});

export const dropWorkoutOperationSchema = z.object({
  op: z.literal('drop_workout'),
  workoutRef: ref,
  weeks: weekRangeSchema,
  reason,
});

export const markDeloadOperationSchema = z.object({
  op: z.literal('mark_deload'),
  weekNumber: week,
  reason,
});

export const regenerateRemainingOperationSchema = z.object({
  op: z.literal('regenerate_remaining'),
  fromWeek: week,
  instruction: z.string().max(L.instructionChars),
  reason,
});

/** What the evaluator may ask for (its structured output's `changes[]`). */
export const planChangeOperationSchema = z.discriminatedUnion('op', [
  setPrescriptionOperationSchema,
  swapExerciseOperationSchema,
  removeExerciseOperationSchema,
  addExerciseOperationSchema,
  setWeekdayOperationSchema,
  dropWorkoutOperationSchema,
  markDeloadOperationSchema,
  regenerateRemainingOperationSchema,
]);

export type PlanChangeOperation = z.infer<typeof planChangeOperationSchema>;
export type PlanChangeOperationName = PlanChangeOperation['op'];
export type PlanChangeOperationOf<K extends PlanChangeOperationName> = Extract<PlanChangeOperation, { op: K }>;

export const PLAN_CHANGE_OPERATION_NAMES: readonly PlanChangeOperationName[] = [
  'set_prescription',
  'swap_exercise',
  'remove_exercise',
  'add_exercise',
  'set_weekday',
  'drop_workout',
  'mark_deload',
  'regenerate_remaining',
];

/** A server-prepared safety removal (`guardrails/safety-stop.ts`): applied in every autonomy mode. */
export type ForcedPlanChangeOperation = PlanChangeOperationOf<'remove_exercise'> & { forced: true };

/**
 * An accepted operation as the change log stores it: the (possibly clamped)
 * operation, `forced` for a safety removal, the suppression `fingerprint`
 * (envelope E9) and the server-authored `description` the history shows.
 */
export type StoredPlanChangeOperation = PlanChangeOperation & {
  forced?: true;
  fingerprint: string;
  description: string;
};

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
