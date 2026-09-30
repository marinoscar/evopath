import { z } from 'zod';

import { ASSESSMENT_STATUSES } from '../agents/evaluator/evaluation-result.contract';
import { registerRunEventType } from '../runtime/run-events.registry';

// =============================================================================
// Run events of the evaluate graph's agent and write nodes. Counts, enums and
// rule codes only: no model text, no ref, no id, no signal value.
// =============================================================================

const COUNT = z.number().int().min(0);
const RULE = z.string().regex(/^(E\d{1,2}|G\d|REF|SAFETY|BOUNDS|CRITIC)$/);

/** `evaluate`: the evaluator's assessment, by enums and counts. */
export const evaluationAssessedEventSchema = z
  .object({
    status: z.enum(ASSESSMENT_STATUSES),
    decision: z.enum(['no_change', 'adjust']),
    changes: COUNT,
    confidence: z.enum(['high', 'moderate', 'low']),
    attempts: COUNT,
    skipped: z.enum(['thin_data', 'budget']).nullable(),
  })
  .strict();

/** `envelope` (and `critique_light` after it): what the server kept. */
export const adaptationEnvelopeEventSchema = z
  .object({
    accepted: COUNT,
    forced: COUNT,
    clamped: COUNT,
    dropped: COUNT,
    rules: z.array(RULE).max(40),
  })
  .strict();

/** `critique_light`: the adaptation critic's verdict. */
export const adaptationCritiqueEventSchema = z
  .object({
    verdict: z.enum(['approve', 'revise', 'skipped']),
    blockers: COUNT,
    dropped: COUNT,
  })
  .strict();

/** `record_proposal`: a proposal waits for the owner. */
export const adaptationProposedEventSchema = z.object({ operations: COUNT, expiresAt: z.string().datetime() }).strict();

/** `apply`: a new plan version. */
export const adaptationAppliedEventSchema = z
  .object({ operations: COUNT, forced: COUNT, versionNumber: COUNT, retried: z.boolean() })
  .strict();

/** How a change set ended when nothing was applied. */
export const adaptationClosedEventSchema = z
  .object({ result: z.enum(['reviewed', 'rejected', 'superseded']) })
  .strict();

registerRunEventType('evaluation.assessed', evaluationAssessedEventSchema);
registerRunEventType('adaptation.envelope', adaptationEnvelopeEventSchema);
registerRunEventType('adaptation.critique', adaptationCritiqueEventSchema);
registerRunEventType('adaptation.proposed', adaptationProposedEventSchema);
registerRunEventType('adaptation.applied', adaptationAppliedEventSchema);
registerRunEventType('adaptation.closed', adaptationClosedEventSchema);
