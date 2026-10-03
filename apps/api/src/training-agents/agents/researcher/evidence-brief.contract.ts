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

/**
 * Where a stored brief's claims come from. Set by the server, never by the model:
 *
 * - `web_verified`: every claim rests on at least one source the hosted web
 *   search returned in this run (the normal path; also what a brief stored
 *   before this field existed is read as);
 * - `web_partial`: the web research verified some sources and claims, but too
 *   few, so claims from established training principles filled the brief
 *   (those carry `sourceIds: []`);
 * - `model_knowledge`: nothing could be verified (or web search is off), so
 *   every claim comes from established training principles, with no sources.
 *
 * A research shortfall never fails a run: it lowers the basis instead.
 */
export const EVIDENCE_BASES = ['web_verified', 'web_partial', 'model_knowledge'] as const;

export type EvidenceBasis = (typeof EVIDENCE_BASES)[number];

/** The basis of a brief that predates the field (and of the normal path). */
export const DEFAULT_EVIDENCE_BASIS: EvidenceBasis = 'web_verified';

/** A brief's basis, tolerating one read back from an old checkpoint without the field. */
export function evidenceBasisOf(brief: { basis?: EvidenceBasis | null } | null | undefined): EvidenceBasis {
  return brief?.basis ?? DEFAULT_EVIDENCE_BASIS;
}

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

/**
 * The MODEL-FACING schema of the knowledge fallback (no web search): claims
 * from established exercise-science consensus, with no sources at all, so the
 * model has nowhere to put a URL or a citation. Strict-mode compatible like
 * `evidenceBriefSchema`.
 */
export const knowledgeClaimSchema = evidenceClaimSchema.omit({ sourceIds: true });

export const knowledgeBriefSchema = z.object({
  summary: z.string().max(EVIDENCE_LIMITS.summaryChars),
  claims: z.array(knowledgeClaimSchema).min(EVIDENCE_LIMITS.minClaims).max(EVIDENCE_LIMITS.maxClaims),
  cautions: z.array(z.string().max(EVIDENCE_LIMITS.cautionChars)).max(EVIDENCE_LIMITS.maxCautions),
});

/** The structured-output name the knowledge fallback's schema is sent under. */
export const KNOWLEDGE_BRIEF_SCHEMA_NAME = 'knowledge_brief';

export type KnowledgeBrief = z.infer<typeof knowledgeBriefSchema>;

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
  /** Empty for a `model_knowledge` brief; a claim from established principles has `sourceIds: []`. */
  sources: VerifiedEvidenceSource[];
  /** Set by the server (see `EVIDENCE_BASES`). */
  basis: EvidenceBasis;
  /** Taken from the hosted tool result, never from the model's text. */
  searchQueries: string[];
  researchMode: ResearchMode;
  droppedClaims: number;
  droppedSources: number;
}

/**
 * Validates a stored `VerifiedEvidenceBrief` (read back from a checkpoint or
 * a run row). Not a model-facing schema: it is never sent to a provider.
 *
 * `basis` defaults to `web_verified`, so a brief stored before the field
 * existed still parses. The basis decides what the sources must look like:
 * `web_verified` keeps the original bar (at least `minSources` sources and a
 * source on every claim), `model_knowledge` has no sources and no claim
 * cites one, `web_partial` has at least one source and one cited claim.
 */
export const verifiedEvidenceBriefSchema = z
  .object({
    summary: z.string().max(EVIDENCE_LIMITS.summaryChars),
    claims: z
      .array(
        evidenceClaimSchema.extend({
          sourceIds: z.array(z.string().regex(/^S\d{1,2}$/)).max(EVIDENCE_LIMITS.maxSourcesPerClaim),
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
      .max(EVIDENCE_LIMITS.maxSources),
    cautions: z.array(z.string().max(EVIDENCE_LIMITS.cautionChars)).max(EVIDENCE_LIMITS.maxCautions),
    searchQueries: z.array(z.string().max(EVIDENCE_LIMITS.queryChars)).max(EVIDENCE_LIMITS.maxQueries),
    researchMode: z.enum(RESEARCH_MODES),
    basis: z.enum(EVIDENCE_BASES).default(DEFAULT_EVIDENCE_BASIS),
    droppedClaims: z.number().int().min(0),
    droppedSources: z.number().int().min(0),
  })
  .strict()
  .superRefine((brief, ctx) => {
    const sourceIds = new Set(brief.sources.map((source) => source.id));
    const cited = brief.claims.filter((claim) => claim.sourceIds.length > 0);
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message, path: ['basis'] });

    for (const claim of cited) {
      if (claim.sourceIds.some((id) => !sourceIds.has(id))) {
        ctx.addIssue({ code: 'custom', message: `Claim ${claim.id} cites a source the brief does not hold.`, path: ['claims'] });
      }
    }

    if (brief.basis === 'web_verified') {
      if (brief.sources.length < EVIDENCE_LIMITS.minSources) fail(`A web_verified brief needs at least ${EVIDENCE_LIMITS.minSources} sources.`);
      if (cited.length !== brief.claims.length) fail('Every claim of a web_verified brief cites a source.');
    } else if (brief.basis === 'model_knowledge') {
      if (brief.sources.length > 0 || cited.length > 0) fail('A model_knowledge brief has no sources.');
    } else if (brief.sources.length === 0 || cited.length === 0) {
      fail('A web_partial brief keeps at least one verified source and one cited claim.');
    }
  });
