import { toResearchBasis, type ResearchBasis } from '../../utils/reduceRunEvents';

/**
 * A version's stored `evidence` (`{ type: 'brief' | 'claim' | 'source' }`
 * rows, written only after the API verified every source) as lookups for
 * the viewer. Only sources marked verified are ever returned.
 *
 * A claim may carry no source (`sourceIds: []`): the researcher falls back to
 * established training principles when it cannot verify enough sources, and
 * the brief's `basis` says so (absent on older versions: web-verified).
 */
export interface EvidenceSourceView {
  id: string;
  url: string;
  title: string;
  publisher: string;
  domain: string;
  kind: string;
  year: number | null;
}

export interface EvidenceClaimView {
  id: string;
  claim: string;
  applicability: string;
  confidence: string;
  sourceIds: string[];
}

export interface PlanEvidence {
  claims: Map<string, EvidenceClaimView>;
  sources: Map<string, EvidenceSourceView>;
  summary: string | null;
  cautions: string[];
  /** The brief's grounding; null when the version has no brief. */
  basis: ResearchBasis | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function parseEvidence(evidence: unknown): PlanEvidence {
  const out: PlanEvidence = { claims: new Map(), sources: new Map(), summary: null, cautions: [], basis: null };
  if (!Array.isArray(evidence)) return out;
  for (const item of evidence) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (row.type === 'brief') {
      out.summary = str(row.summary) || null;
      out.basis = toResearchBasis(row.basis);
      out.cautions = Array.isArray(row.cautions) ? row.cautions.filter((c): c is string => typeof c === 'string') : [];
    } else if (row.type === 'claim' && str(row.id)) {
      out.claims.set(str(row.id), {
        id: str(row.id),
        claim: str(row.claim),
        applicability: str(row.applicability),
        confidence: str(row.confidence),
        sourceIds: Array.isArray(row.sourceIds) ? row.sourceIds.filter((s): s is string => typeof s === 'string') : [],
      });
    } else if (row.type === 'source' && row.verified === true && str(row.id) && /^https?:\/\//.test(str(row.url))) {
      out.sources.set(str(row.id), {
        id: str(row.id),
        url: str(row.url),
        title: str(row.title),
        publisher: str(row.publisher),
        domain: str(row.domain) || hostOf(str(row.url)),
        kind: str(row.kind),
        year: typeof row.year === 'number' ? row.year : null,
      });
    }
  }
  return out;
}

/** Evidence refs (`E1`) that resolve to a claim. */
export function resolvableRefs(refs: string[] | undefined, evidence: PlanEvidence): string[] {
  return (refs ?? []).filter((ref) => evidence.claims.has(ref));
}

/** Evidence refs cited inside a rationale's text (`... (E2)`), when they resolve. */
export function refsInText(text: string | null | undefined, evidence: PlanEvidence): string[] {
  if (!text) return [];
  return [...new Set(text.match(/\bE\d{1,2}\b/g) ?? [])].filter((ref) => evidence.claims.has(ref));
}

/** A claim no verified source backs: it comes from established training principles. */
export function isPrincipleClaim(claim: EvidenceClaimView, evidence: PlanEvidence): boolean {
  return !claim.sourceIds.some((sid) => evidence.sources.has(sid));
}
