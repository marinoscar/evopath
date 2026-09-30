import { z } from 'zod';

import { registerRunEventType } from '../../runtime/run-events.registry';
import { CRITIC_DIMENSIONS, CRITIC_LIMITS } from './critic-verdict.contract';

// =============================================================================
// The critic's and finalize's event payloads, registered at import time
// =============================================================================
//
// `critic.round` carries scores, enums and the critic's blocker issues and
// summary AFTER `sanitizeModelText` (no URL, no markup) and length caps. No
// prompt text, no raw model JSON, no fix text. `plan.finalized` carries ids,
// the version number and machine warning codes.
// =============================================================================

const score = z.number().int().min(1).max(5);

export const CRITIC_EVENT_ISSUE_CHARS = 200;
export const FINALIZED_EVENT_MAX_WARNINGS = 20;

export const criticRoundEventSchema = z
  .object({
    round: z.number().int().min(1),
    /** `skipped` when the round produced no review (budget spent, critic unavailable). */
    verdict: z.enum(['approve', 'revise', 'skipped']),
    scores: z
      .object(Object.fromEntries(CRITIC_DIMENSIONS.map((d) => [d, score])) as Record<(typeof CRITIC_DIMENSIONS)[number], typeof score>)
      .strict()
      .nullable(),
    blockers: z
      .array(z.object({ dimension: z.enum(CRITIC_DIMENSIONS), issue: z.string().max(CRITIC_EVENT_ISSUE_CHARS) }).strict())
      .max(CRITIC_LIMITS.blockersMax),
    summary: z.string().max(CRITIC_LIMITS.summaryChars),
  })
  .strict();

export const planFinalizedEventSchema = z
  .object({
    programId: z.string().uuid(),
    versionNumber: z.number().int().min(1),
    warnings: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(FINALIZED_EVENT_MAX_WARNINGS),
  })
  .strict();

registerRunEventType('critic.round', criticRoundEventSchema);
registerRunEventType('plan.finalized', planFinalizedEventSchema);
