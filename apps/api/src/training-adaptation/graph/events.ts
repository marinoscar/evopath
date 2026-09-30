import { z } from 'zod';

import { registerRunEventType } from '../../training-agents/runtime/run-events.registry';
import { ADAPTATION_EVENT_TYPES as T } from '../adaptation.constants';

// =============================================================================
// Run events of the quick adaptation graph (E6.1)
// =============================================================================
//
// Registered at import time with the kit's registry, next to the nodes that
// emit them. Every schema is strict and carries counts, enums and booleans
// only: no model text, no exercise key, no user text, no id. The kit's own
// `stage.started` / `stage.completed` (node names `context`, `adapt`,
// `guardrails`, `critic`, `finalize`) and `agent.usage` events come with them.
// =============================================================================

const COUNT = z.number().int().min(0);

/** `context`: what the context holds. */
export const adaptationContextEventSchema = z
  .object({
    base: z.boolean(),
    exercises: COUNT,
    candidates: COUNT,
    readiness: z.boolean(),
    safety: z.enum(['ok', 'conservative', 'blocked']),
  })
  .strict();

/** `adapt`: one planner pass answered. */
export const adaptationProposalEventSchema = z.object({ round: COUNT, exercises: COUNT, dropped: COUNT }).strict();

/** `guardrails`: what the server changed. `kept_previous`: the revision broke a hard rule; the checked first answer stays. */
export const adaptationGuardrailsEventSchema = z
  .object({
    round: COUNT,
    repairs: COUNT,
    rejected: COUNT,
    estimatedMinutes: COUNT,
    fitsRequest: z.boolean(),
    status: z.enum(['ok', 'kept_previous']),
  })
  .strict();

/** `critic`: the light review. */
export const adaptationCritiqueEventSchema = z
  .object({
    round: COUNT,
    verdict: z.enum(['accept', 'revise', 'skipped']),
    major: COUNT,
    minor: COUNT,
    skipped: z.enum(['token_cap', 'error']).nullable(),
  })
  .strict();

/** `finalize`: the proposal is ready for review. */
export const adaptationReadyEventSchema = z.object({ exercises: COUNT, estimatedMinutes: COUNT }).strict();

registerRunEventType(T.CONTEXT, adaptationContextEventSchema);
registerRunEventType(T.PROPOSAL, adaptationProposalEventSchema);
registerRunEventType(T.GUARDRAILS, adaptationGuardrailsEventSchema);
registerRunEventType(T.CRITIQUE, adaptationCritiqueEventSchema);
registerRunEventType(T.READY, adaptationReadyEventSchema);
