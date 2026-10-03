import { z } from 'zod';

import { registerRunEventType } from '../../runtime/run-events.registry';
import { EVIDENCE_BASES, EVIDENCE_LIMITS, EVIDENCE_SOURCE_KINDS, RESEARCH_MODES } from './evidence-brief.contract';

// =============================================================================
// The research node's event payloads, registered at import time
// =============================================================================
//
// Identifiers, enums and counts, plus two bounded exceptions the Research
// stage shows: the search queries (taken from the hosted tool result, never
// from model text) and each VERIFIED source's URL, title and domain (sanitised
// by the citation guardrail). Never instructions, prompt text or claim text.
// =============================================================================

const COUNT = z.number().int().min(0);

export const researchQueryEventSchema = z
  .object({
    queries: z.array(z.string().min(1).max(EVIDENCE_LIMITS.queryChars)).max(EVIDENCE_LIMITS.maxQueries),
  })
  .strict();

export const researchSourceEventSchema = z
  .object({
    id: z.string().regex(/^S\d{1,2}$/),
    url: z.string().url().max(EVIDENCE_LIMITS.urlChars),
    title: z.string().max(EVIDENCE_LIMITS.titleChars),
    domain: z.string().min(1).max(253),
    kind: z.enum(EVIDENCE_SOURCE_KINDS),
    verified: z.literal(true),
  })
  .strict();

export const researchBriefEventSchema = z
  .object({
    claimCount: COUNT,
    sourceCount: COUNT,
    droppedClaims: COUNT,
    droppedSources: COUNT,
    researchMode: z.enum(RESEARCH_MODES),
    /** `web_verified`, `web_partial` or `model_knowledge` (see `EVIDENCE_BASES`). */
    basis: z.enum(EVIDENCE_BASES),
  })
  .strict();

registerRunEventType('research.query', researchQueryEventSchema);
registerRunEventType('research.source', researchSourceEventSchema);
registerRunEventType('research.brief', researchBriefEventSchema);
