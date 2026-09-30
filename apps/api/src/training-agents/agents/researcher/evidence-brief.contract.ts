import { z } from 'zod';

// =============================================================================
// EvidenceBrief: what the researcher returns, and what the rest of the epic reads
// =============================================================================
//
// Two shapes:
//
// - `evidenceBriefSchema` is the MODEL-FACING output schema. It is strict-mode
//   compatible (every property required, `.nullable()` never `.optional()`,
//   closed objects, no `z.record`), because OpenAI structured outputs refuse
//   anything else. Its `sources[].url` is only a claim by the model.
// - `VerifiedEvidenceBrief` is what the `research` node stores in
//   `RunState.brief` after citation verification (`guardrails/citations.ts`):
//   every surviving source's URL was returned by the hosted web search in this
//   run, ids are re-mapped to `S1..Sn`, and `searchQueries` come from the
//   hosted tool result, never from model text. The planner, the critic and the
//   evaluator consume THIS shape (`verifiedEvidenceBriefSchema` validates it
//   when read back from a checkpoint or a stored run).
// =============================================================================

export const EVIDENCE_TOPICS = [
  'frequency',
  'volume',
  'intensity',
  'progression',
  'recovery',
  'exercise_selection',
  'limitation_guidance',
  'adherence',
] as const;

export type EvidenceTopic = (typeof EVIDENCE_TOPICS)[number];

export const EVIDENCE_SOURCE_KINDS = [
  'guideline',
  'position_stand',
  'systematic_review',
  'meta_analysis',
  'rct',
  'expert_article',
  'other',
] as const;

export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];

/** The kinds that count as high quality (a caution is added when none survives). */
export const HIGH_QUALITY_SOURCE_KINDS: readonly EvidenceSourceKind[] = [
  'guideline',
  'position_stand',
  'systematic_review',
  'meta_analysis',
  'rct',
];

export const EVIDENCE_CONFIDENCE = ['high', 'moderate', 'low'] as const;

export type EvidenceConfidence = (typeof EVIDENCE_CONFIDENCE)[number];

export const RESEARCH_MODES = ['single', 'two_step'] as const;

export type ResearchMode = (typeof RESEARCH_MODES)[number];

/** Bounds shared by the schema, the verifier and the node. */
export const EVIDENCE_LIMITS = {
  minClaims: 3,
  maxClaims: 20,
  minSources: 2,
  maxSources: 20,
  maxSourcesPerClaim: 4,
  maxCautions: 6,
  summaryChars: 800,
  claimChars: 400,
  applicabilityChars: 200,
  cautionChars: 200,
  titleChars: 200,
  publisherChars: 120,
  urlChars: 2048,
  /** Queries kept from the hosted tool result. */
  maxQueries: 20,
  queryChars: 300,
} as const;

export const evidenceSourceSchema = z.object({
  /** `S1..S20`, model-assigned; the verifier re-maps them. */
  id: z.string().regex(/^S\d{1,2}$/),
  url: z.string().max(EVIDENCE_LIMITS.urlChars),
  title: z.string().max(EVIDENCE_LIMITS.titleChars),
  publisher: z.string().max(EVIDENCE_LIMITS.publisherChars),
  kind: z.enum(EVIDENCE_SOURCE_KINDS),
  year: z.number().int().nullable(),
});

export const evidenceClaimSchema = z.object({
  /** `E1..E20`. */
  id: z.string().regex(/^E\d{1,2}$/),
  topic: z.enum(EVIDENCE_TOPICS),
  /** One sentence of guidance. */
  claim: z.string().max(EVIDENCE_LIMITS.claimChars),
  /** How the claim applies to THIS user (level, limits). */
  applicability: z.string().max(EVIDENCE_LIMITS.applicabilityChars),
  confidence: z.enum(EVIDENCE_CONFIDENCE),
  sourceIds: z.array(z.string()).min(1).max(EVIDENCE_LIMITS.maxSourcesPerClaim),
});

export const evidenceBriefSchema = z.object({
  summary: z.string().max(EVIDENCE_LIMITS.summaryChars),
  claims: z.array(evidenceClaimSchema).min(EVIDENCE_LIMITS.minClaims).max(EVIDENCE_LIMITS.maxClaims),
  sources: z.array(evidenceSourceSchema).min(EVIDENCE_LIMITS.minSources).max(EVIDENCE_LIMITS.maxSources),
  /** "little evidence for X", "see a professional for Y". */
  cautions: z.array(z.string().max(EVIDENCE_LIMITS.cautionChars)).max(EVIDENCE_LIMITS.maxCautions),
});

/** The structured-output name the researcher's schema is sent under. */
export const EVIDENCE_BRIEF_SCHEMA_NAME = 'evidence_brief';

export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;
export type EvidenceClaim = z.infer<typeof evidenceClaimSchema>;
export type EvidenceBrief = z.infer<typeof evidenceBriefSchema>;

/** A source the server verified: its URL was returned by this run's search. */
export interface VerifiedEvidenceSource extends EvidenceSource {
  verified: true;
  /** Lower-case host of the normalized URL. */
  domain: string;
  /** ISO timestamp of verification. */
  retrievedAt: string;
}

/** What the rest of the epic consumes: server-verified, with provenance the model cannot forge. */
export interface VerifiedEvidenceBrief extends Omit<EvidenceBrief, 'sources'> {
  sources: VerifiedEvidenceSource[];
  /** Taken from the hosted tool result, never from the model's text. */
  searchQueries: string[];
  researchMode: ResearchMode;
  droppedClaims: number;
  droppedSources: number;
}

/**
 * Validates a stored `VerifiedEvidenceBrief` (read back from a checkpoint or
 * a run row). Not a model-facing schema: it is never sent to a provider.
 */
export const verifiedEvidenceBriefSchema = z
  .object({
    summary: z.string().max(EVIDENCE_LIMITS.summaryChars),
    claims: z
      .array(
        evidenceClaimSchema.extend({
          sourceIds: z.array(z.string().regex(/^S\d{1,2}$/)).min(1).max(EVIDENCE_LIMITS.maxSourcesPerClaim),
        }).strict(),
      )
      .min(EVIDENCE_LIMITS.minClaims)
      .max(EVIDENCE_LIMITS.maxClaims),
    sources: z
      .array(
        evidenceSourceSchema
          .extend({
            verified: z.literal(true),
            domain: z.string().min(1).max(253),
            retrievedAt: z.string().datetime(),
          })
          .strict(),
      )
      .min(EVIDENCE_LIMITS.minSources)
      .max(EVIDENCE_LIMITS.maxSources),
    cautions: z.array(z.string().max(EVIDENCE_LIMITS.cautionChars)).max(EVIDENCE_LIMITS.maxCautions),
    searchQueries: z.array(z.string().max(EVIDENCE_LIMITS.queryChars)).max(EVIDENCE_LIMITS.maxQueries),
    researchMode: z.enum(RESEARCH_MODES),
    droppedClaims: z.number().int().min(0),
    droppedSources: z.number().int().min(0),
  })
  .strict();
