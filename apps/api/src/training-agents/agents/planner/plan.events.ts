import { z } from 'zod';

import { GUARDRAIL_RULES } from '../../guardrails/types';
import { registerRunEventType } from '../../runtime/run-events.registry';

// =============================================================================
// The planner's and the guardrails' event payloads, registered at import time
// =============================================================================
//
// Counts, enums and server-authored repair summaries only: never the draft,
// a rationale, a workout name or any other model text. Repair summaries are
// written by the guardrails (`guardrails/*.ts`) and quote exercise keys and
// numbers, not model words.
// =============================================================================

const COUNT = z.number().int().min(0);

/** At most this many repair summaries ride on one `guardrail.report`. */
export const GUARDRAIL_EVENT_MAX_REPAIRS = 50;
export const GUARDRAIL_EVENT_SUMMARY_CHARS = 300;

export const planDraftEventSchema = z
  .object({
    /** 1 for the first draft, +1 per revision. */
    round: z.number().int().min(1),
    weeks: COUNT,
    workouts: COUNT,
    exercises: COUNT,
  })
  .strict();

export const guardrailReportEventSchema = z
  .object({
    round: z.number().int().min(1),
    status: z.enum(['clean', 'repaired', 'blocked']),
    counts: z.object({ block: COUNT, repair: COUNT, warn: COUNT }).strict(),
    repairs: z
      .array(z.object({ rule: z.enum(GUARDRAIL_RULES), summary: z.string().max(GUARDRAIL_EVENT_SUMMARY_CHARS) }).strict())
      .max(GUARDRAIL_EVENT_MAX_REPAIRS),
  })
  .strict();

registerRunEventType('plan.draft', planDraftEventSchema);
registerRunEventType('guardrail.report', guardrailReportEventSchema);
