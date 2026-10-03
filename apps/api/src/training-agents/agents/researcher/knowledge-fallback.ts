import { sanitizeModelText } from '../../guardrails/citations';
import {
  EVIDENCE_LIMITS,
  type EvidenceBasis,
  type EvidenceConfidence,
  type EvidenceTopic,
  type KnowledgeBrief,
  type ResearchMode,
  type VerifiedEvidenceBrief,
} from './evidence-brief.contract';

// =============================================================================
// The researcher's knowledge fallback: a research shortfall never fails a run
// =============================================================================
//
// When web research cannot produce a sufficient verified brief (too few
// verified sources after the retry, a twice cut-off answer, web search off or
// refused), the researcher asks the model once more, WITHOUT tools, for claims
// from established exercise-science consensus (`knowledgeBriefSchema`, which
// has no field a URL or citation could go in). `mergeFallbackBrief` then
// builds the stored brief:
//
// - whatever the best web attempt verified is kept (its sources and the claims
//   that rest on them, ids unchanged), so the basis is `web_partial`;
//   otherwise it is `model_knowledge` and the brief has no sources;
// - knowledge claims fill up to `maxClaims`, sanitised with an EMPTY verified
//   set (no URL survives) and carrying `sourceIds: []`;
// - when the knowledge call itself failed (or left too few usable claims),
//   the fixed `STATIC_PRINCIPLES` below fill the brief instead;
// - a fixed caution says the guidance is not web-verified; it is always kept.
//
// The basis is set here, by the server, never by the model.
// =============================================================================

/** The caution on a brief with no verified source. */
export const MODEL_KNOWLEDGE_CAUTION =
  'No web sources could be verified this time; this guidance is based on established training principles.';

/** The caution on a brief whose web sources cover only part of it. */
export const WEB_PARTIAL_CAUTION =
  'Only part of this guidance could be matched to verified web sources; the rest is based on established training principles.';

/** The summary when neither the model nor the web supplied one. */
export const STATIC_SUMMARY =
  'General, conservative resistance training principles: moderate frequency and volume, effort short of failure, gradual progression and enough recovery.';

export interface StaticPrinciple {
  topic: EvidenceTopic;
  claim: string;
  applicability: string;
  confidence: EvidenceConfidence;
}

const GENERAL = 'General guidance for most healthy adults; adjust to your level, schedule and any limitations.';

/**
 * The last resort when even the knowledge call fails: mainstream, conservative,
 * generic principles (never user-specific), with no statistics from studies.
 */
export const STATIC_PRINCIPLES: readonly StaticPrinciple[] = [
  {
    topic: 'frequency',
    claim: 'Training each major muscle group about two to three times per week works well for building muscle and strength.',
    applicability: GENERAL,
    confidence: 'high',
  },
  {
    topic: 'volume',
    claim: 'Roughly 10 to 20 hard sets per muscle group per week suits hypertrophy, starting at the low end and adding sets gradually.',
    applicability: GENERAL,
    confidence: 'moderate',
  },
  {
    topic: 'intensity',
    claim: 'Most working sets can end one to three repetitions short of failure; training to failure is not required for progress.',
    applicability: GENERAL,
    confidence: 'moderate',
  },
  {
    topic: 'progression',
    claim: 'Progress with small increments in load or repetitions once the top of the target rep range is reached with good form.',
    applicability: GENERAL,
    confidence: 'high',
  },
  {
    topic: 'recovery',
    claim: 'Allow about 48 hours before training the same muscle group hard again, and reduce load or volume when recovery is poor.',
    applicability: GENERAL,
    confidence: 'moderate',
  },
  {
    topic: 'exercise_selection',
    claim: 'Stable machine and cable variations are a sound choice for beginners or lifters avoiding injury, and cover the main movement patterns.',
    applicability: GENERAL,
    confidence: 'moderate',
  },
];

export interface FallbackBriefInput {
  /** The best verified result of the web attempts (insufficient), or `null` when none produced one. */
  partial: VerifiedEvidenceBrief | null;
  /** The knowledge call's answer, or `null` when that call failed. */
  knowledge: KnowledgeBrief | null;
  researchMode: ResearchMode;
  /** From the hosted tool results of the web attempts, never model text. */
  searchQueries: string[];
}

type StoredClaim = VerifiedEvidenceBrief['claims'][number];

/** The stored brief of a research shortfall (see the header). Pure. */
export function mergeFallbackBrief(input: FallbackBriefInput): VerifiedEvidenceBrief {
  const best = input.partial;
  const partial = best && best.claims.length > 0 && best.sources.length > 0 ? best : null;
  const basis: EvidenceBasis = partial ? 'web_partial' : 'model_knowledge';

  const claims: Array<Omit<StoredClaim, 'id'>> = (partial?.claims ?? []).map(({ id: _id, ...claim }) => claim);
  const room = () => EVIDENCE_LIMITS.maxClaims - claims.length;

  const fromKnowledge = (input.knowledge?.claims ?? [])
    .map((claim) => ({
      topic: claim.topic,
      claim: sanitizeModelText(claim.claim, EVIDENCE_LIMITS.claimChars),
      applicability: sanitizeModelText(claim.applicability, EVIDENCE_LIMITS.applicabilityChars),
      confidence: claim.confidence,
      sourceIds: [] as string[],
    }))
    .filter((claim) => claim.claim.length > 0);
  claims.push(...fromKnowledge.slice(0, Math.max(0, room())));

  // The knowledge call failed: the fixed principles fill the brief. It left
  // too few usable claims: they top it up to the minimum.
  const usedStatic = input.knowledge === null || claims.length < EVIDENCE_LIMITS.minClaims;
  if (usedStatic) {
    const known = new Set(claims.map((claim) => claim.claim));
    const wanted = input.knowledge === null ? STATIC_PRINCIPLES.length : EVIDENCE_LIMITS.minClaims - claims.length;
    const statics = STATIC_PRINCIPLES.filter((p) => !known.has(p.claim)).slice(0, Math.max(0, Math.min(wanted, room())));
    claims.push(...statics.map((p) => ({ ...p, sourceIds: [] as string[] })));
  }

  const summary =
    (input.knowledge ? sanitizeModelText(input.knowledge.summary, EVIDENCE_LIMITS.summaryChars) : '') ||
    partial?.summary ||
    STATIC_SUMMARY;

  const cautions = [
    basis === 'web_partial' ? WEB_PARTIAL_CAUTION : MODEL_KNOWLEDGE_CAUTION,
    ...(partial?.cautions ?? []),
    ...(input.knowledge?.cautions ?? []).map((caution) => sanitizeModelText(caution, EVIDENCE_LIMITS.cautionChars)),
  ].filter((caution, index, all) => caution.length > 0 && all.indexOf(caution) === index);

  // Sources the best attempt verified but no surviving claim rests on are not kept.
  const discardedSources = best && !partial ? best.sources.length : 0;

  return {
    summary,
    claims: claims.slice(0, EVIDENCE_LIMITS.maxClaims).map((claim, index) => ({ id: `E${index + 1}`, ...claim })),
    sources: partial?.sources ?? [],
    cautions: cautions.slice(0, EVIDENCE_LIMITS.maxCautions),
    searchQueries: input.searchQueries.slice(0, EVIDENCE_LIMITS.maxQueries),
    researchMode: input.researchMode,
    basis,
    droppedClaims: best?.droppedClaims ?? 0,
    droppedSources: (best?.droppedSources ?? 0) + discardedSources,
  };
}
