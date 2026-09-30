import { z } from 'zod';

import { planChangeOperationSchema } from '../../../programs/contracts/plan-change.contract';

// =============================================================================
// EvaluationResult: the evaluator's structured output
// =============================================================================
//
// Strict-mode compatible (every property required, nullable instead of
// optional, closed objects): the schema is sent to the provider as the
// structured output format. The evaluator proposes TYPED OPERATIONS
// (`PlanChangeOperation`), never a rewritten plan; the server bounds them
// (`guardrails/envelope.ts`) and decides what lands.
//
// Everything here is model text until the server sanitises it
// (`sanitizeEvaluation`): `userMessage` becomes the change log summary,
// `assessment.summary` its rationale; neither is ever an instruction.
// =============================================================================

export const EVALUATION_RESULT_SCHEMA_NAME = 'evaluation_result';

export const ASSESSMENT_STATUSES = [
  'on_track',
  'ahead',
  'behind',
  'stalled',
  'needs_recovery',
  'adherence_gap',
  'insufficient_data',
] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];

export const EVALUATION_LIMITS = {
  summaryChars: 500,
  observationsMax: 6,
  signalChars: 60,
  observationChars: 200,
  changesMax: 8,
  userMessageChars: 400,
  followUpNoteChars: 200,
  evidenceRefsMax: 4,
  evidenceRefChars: 60,
} as const;

const L = EVALUATION_LIMITS;

export const evaluationResultSchema = z.object({
  assessment: z.object({
    status: z.enum(ASSESSMENT_STATUSES),
    summary: z.string().max(L.summaryChars),
    observations: z
      .array(z.object({ signal: z.string().max(L.signalChars), text: z.string().max(L.observationChars) }))
      .max(L.observationsMax),
  }),
  decision: z.enum(['no_change', 'adjust']),
  changes: z.array(planChangeOperationSchema).max(L.changesMax),
  /** Plain language: what changed and why. */
  userMessage: z.string().max(L.userMessageChars),
  /** For example: see a qualified professional. */
  followUp: z.object({ suggestReview: z.boolean(), note: z.string().max(L.followUpNoteChars).nullable() }),
  confidence: z.enum(['high', 'moderate', 'low']),
  /** Brief claim ids only. */
  evidenceRefs: z.array(z.string().max(L.evidenceRefChars)).max(L.evidenceRefsMax),
});

export type EvaluationResult = z.infer<typeof evaluationResultSchema>;
