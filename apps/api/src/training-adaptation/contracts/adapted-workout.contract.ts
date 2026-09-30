import { z } from 'zod';

import { ADAPTED_WORKOUT_LIMITS as L } from '../adaptation.constants';

// =============================================================================
// AdaptedWorkout: what the planner answers and what the server stores
// =============================================================================
//
// TWO SCHEMAS.
//
// - `adaptationProposalModelSchema` is the structured-output format sent to
//   the planner (`schemaName: 'training_adaptation_proposal'`, strict mode:
//   every property required, `null` instead of optional). Exercises are named
//   by their stable KEY (slug), never by uuid (the E5 minimisation rule:
//   internal ids are never sent). Its numeric bounds are deliberately LOOSE:
//   too many sets or an odd RPE is something the guardrails REPAIR and record,
//   not a structured-output failure that loses the whole answer.
//   `estimatedMinutes` is asked for and ignored: the server recomputes it.
//   There is NO LOAD FIELD: loads are never model-supplied; `apply` fills them
//   from the plan prescription or last-time values.
//
// - `adaptedWorkoutSchema` is the validated proposal the guardrails produce
//   and `workout_adaptations.proposal` stores: ids resolved server-side, names
//   from the library, the contract's tight bounds.
// =============================================================================

export const ADAPTATION_DROP_REASONS = ['time', 'sore', 'equipment', 'energy', 'other'] as const;
export type AdaptationDropReason = (typeof ADAPTATION_DROP_REASONS)[number];

export const ADAPTATION_EXERCISE_SOURCES = ['kept', 'swapped', 'added'] as const;
export type AdaptationExerciseSource = (typeof ADAPTATION_EXERCISE_SOURCES)[number];

const key = z.string().max(120);

export const adaptationProposalModelSchema = z.object({
  title: z.string().max(200),
  summary: z.string().max(1000),
  estimatedMinutes: z.number().int(),
  exercises: z
    .array(
      z.object({
        /** A key from the context's `today.exercises` or `candidates`. */
        exerciseKey: key,
        source: z.enum(ADAPTATION_EXERCISE_SOURCES),
        /** For `swapped`: the planned exercise's key it replaces. */
        replacesExerciseKey: key.nullable(),
        isPriority: z.boolean(),
        sets: z.number().int(),
        repMin: z.number().int(),
        repMax: z.number().int(),
        targetRpe: z.number().nullable(),
        restSeconds: z.number().int(),
        note: z.string().max(400).nullable(),
      }),
    )
    .min(1)
    .max(20),
  dropped: z.array(z.object({ exerciseKey: key, reason: z.enum(ADAPTATION_DROP_REASONS) })).max(20),
  rationale: z.array(z.string().max(500)).min(1).max(10),
  uncertainty: z.array(z.string().max(500)).max(10),
});

export type AdaptationProposalModel = z.infer<typeof adaptationProposalModelSchema>;
export type AdaptationProposalModelExercise = AdaptationProposalModel['exercises'][number];

const text = (max: number) => z.string().max(max);

export const adaptedExerciseSchema = z.object({
  exerciseId: z.uuid(),
  exerciseKey: z.string(),
  name: z.string(),
  position: z.number().int().min(0),
  source: z.enum(ADAPTATION_EXERCISE_SOURCES),
  replacesExerciseId: z.uuid().nullable(),
  replacesExerciseKey: z.string().nullable(),
  isPriority: z.boolean(),
  sets: z.number().int().min(L.sets.min).max(L.sets.max),
  repMin: z.number().int().min(L.reps.min).max(L.reps.max),
  repMax: z.number().int().min(L.reps.min).max(L.reps.max),
  targetRpe: z.number().min(L.rpe.min).max(L.rpe.max).nullable(),
  restSeconds: z.number().int().min(L.restSeconds.min).max(L.restSeconds.max),
  note: text(L.noteChars).nullable(),
  /** The exercise's prime movers (library), for the review's sore-muscle view. */
  primaryMuscles: z.array(z.string()),
  /** The library's tracking mode (`weight_reps`, `bodyweight_reps`, ...). */
  trackingMode: z.string(),
});

export const adaptedWorkoutSchema = z.object({
  title: text(L.titleChars),
  summary: text(L.summaryChars),
  /** Recomputed by the server (E5.5's duration model); never the model's number. */
  estimatedMinutes: z.number().int().min(0),
  exercises: z.array(adaptedExerciseSchema).min(L.exercises.min).max(L.exercises.max),
  dropped: z.array(
    z.object({
      exerciseId: z.uuid(),
      exerciseKey: z.string(),
      name: z.string(),
      reason: z.enum(ADAPTATION_DROP_REASONS),
    }),
  ),
  rationale: z.array(text(L.rationale.chars)).min(L.rationale.min).max(L.rationale.max),
  uncertainty: z.array(text(L.uncertainty.chars)).max(L.uncertainty.max),
});

export type AdaptedWorkout = z.infer<typeof adaptedWorkoutSchema>;
export type AdaptedExercise = z.infer<typeof adaptedExerciseSchema>;

/** A repair or rejection the guardrails recorded. Server-authored; quotes keys and numbers, never model text. */
export const guardrailFindingSchema = z.object({
  /** Stable machine code (`unknown_exercise_removed`, `time_sets_trimmed`, ...). */
  code: z.string(),
  exerciseKey: z.string().nullable(),
  message: z.string(),
});

export type GuardrailFinding = z.infer<typeof guardrailFindingSchema>;

export const adaptationGuardrailReportSchema = z.object({
  /** Changes the server made to keep the proposal inside the rules. */
  repairs: z.array(guardrailFindingSchema),
  /** Exercises the server removed (unknown, unsupported, painful, over the limit). */
  rejected: z.array(guardrailFindingSchema),
  estimatedMinutes: z.number().int(),
  /** `estimatedMinutes <= minutes` (true when the request set no minutes). */
  fitsRequest: z.boolean(),
  promptVersion: z.number().int(),
  /** Warning codes (`revision_rejected`, `critic_skipped`). */
  warnings: z.array(z.string()),
});

export type AdaptationGuardrailReport = z.infer<typeof adaptationGuardrailReportSchema>;
