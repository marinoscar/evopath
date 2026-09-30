import type { Evidence } from '../../programs/contracts/plan-change.contract';
import type { PlanTree } from '../../programs/contracts/plan-tree.contract';
import {
  type VerifiedEvidenceBrief,
  verifiedEvidenceBriefSchema,
} from '../agents/researcher/evidence-brief.contract';

// =============================================================================
// The verified brief as a version's `evidence`, the change log's
// `citations`, and back (revise runs reuse a recent brief)
// =============================================================================
//
// `program_versions.evidence` is an array of objects. A brief is stored as
// one `{ type: 'brief' }` header, one `{ type: 'claim' }` per claim and one
// `{ type: 'source' }` per VERIFIED source, so a later run can rebuild the
// exact `VerifiedEvidenceBrief` (`briefFromEvidence`) and the plan view can
// list claims and sources without parsing a blob. Only verified material is
// ever stored: the brief passed the citation guardrail before it got here.
// =============================================================================

/** A stored brief younger than this is reused by a revise run. */
export const BRIEF_REUSE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The version `evidence` for a verified brief (`[]` without one). */
export function evidenceOf(brief: VerifiedEvidenceBrief | null): Evidence[] {
  if (!brief) return [];
  return [
    {
      type: 'brief',
      summary: brief.summary,
      cautions: brief.cautions,
      searchQueries: brief.searchQueries,
      researchMode: brief.researchMode,
      droppedClaims: brief.droppedClaims,
      droppedSources: brief.droppedSources,
    },
    ...brief.claims.map((claim) => ({ type: 'claim', ...claim })),
    ...brief.sources.map((source) => ({ type: 'source', ...source })),
  ];
}

/** The claim ids the plan's exercises cite. */
export function citedClaimIds(tree: PlanTree): Set<string> {
  const ids = new Set<string>();
  for (const block of tree.blocks)
    for (const week of block.weeks) for (const workout of week.workouts) for (const exercise of workout.exercises) for (const ref of exercise.evidenceRefs) ids.add(ref);
  return ids;
}

/**
 * The change log `citations`: every verified source a cited claim rests on
 * (all sources when the plan cites no claim), with the claims citing it.
 */
export function citationsOf(brief: VerifiedEvidenceBrief | null, tree: PlanTree): Array<Record<string, unknown>> {
  if (!brief) return [];
  const cited = citedClaimIds(tree);
  const claims = brief.claims.filter((claim) => cited.size === 0 || cited.has(claim.id));
  const bySource = new Map<string, string[]>();
  for (const claim of claims) for (const sourceId of claim.sourceIds) bySource.set(sourceId, [...(bySource.get(sourceId) ?? []), claim.id]);

  return brief.sources
    .filter((source) => cited.size === 0 || bySource.has(source.id))
    .map((source) => ({
      sourceId: source.id,
      url: source.url,
      title: source.title,
      publisher: source.publisher,
      kind: source.kind,
      year: source.year,
      claimIds: bySource.get(source.id) ?? [],
    }));
}

/**
 * The change log `citations` of an adaptation: the verified sources the
 * cited claims (`claimIds`, already checked against the brief) rest on.
 */
export function citationsForClaims(brief: VerifiedEvidenceBrief | null, claimIds: readonly string[]): Array<Record<string, unknown>> {
  if (!brief || claimIds.length === 0) return [];
  const wanted = new Set(claimIds);
  const bySource = new Map<string, string[]>();
  for (const claim of brief.claims) {
    if (!wanted.has(claim.id)) continue;
    for (const sourceId of claim.sourceIds) bySource.set(sourceId, [...(bySource.get(sourceId) ?? []), claim.id]);
  }
  return brief.sources
    .filter((source) => bySource.has(source.id))
    .map((source) => ({
      sourceId: source.id,
      url: source.url,
      title: source.title,
      publisher: source.publisher,
      kind: source.kind,
      year: source.year,
      claimIds: bySource.get(source.id) ?? [],
    }));
}

/** Rebuilds a brief stored by `evidenceOf`; `null` when there is none or it no longer validates. */
export function briefFromEvidence(evidence: unknown): VerifiedEvidenceBrief | null {
  if (!Array.isArray(evidence)) return null;
  const items = evidence.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  const header = items.find((item) => item.type === 'brief');
  if (!header) return null;
  const strip = ({ type: _type, ...rest }: Record<string, unknown>) => rest;

  const parsed = verifiedEvidenceBriefSchema.safeParse({
    summary: header.summary,
    claims: items.filter((item) => item.type === 'claim').map(strip),
    sources: items.filter((item) => item.type === 'source').map(strip),
    cautions: header.cautions,
    searchQueries: header.searchQueries,
    researchMode: header.researchMode,
    droppedClaims: header.droppedClaims,
    droppedSources: header.droppedSources,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Words that mean a revise instruction touches the goal or the person's
 * limitations, so a stored brief may no longer fit (a deterministic,
 * deliberately broad check: a false positive only costs the reuse).
 */
const GOAL_OR_LIMITATION_CHANGE =
  /\b(goals?|objectives?|aim|target|focus|hypertroph\w*|strength|stronger|bulk\w*|cut(ting)?|fat|lean\w*|weight|endurance|cardio|marathon|sport\w*|injur\w*|limitation\w*|pain\w*|hurt\w*|strain\w*|sprain\w*|surgery|rehab\w*|pregnan\w*|tendon\w*|joint\w*)\b/i;

export function instructionChangesGoal(instruction: string | null | undefined): boolean {
  return typeof instruction === 'string' && GOAL_OR_LIMITATION_CHANGE.test(instruction);
}

/** Whether every source of a stored brief was retrieved within the reuse window. */
export function briefIsFresh(brief: VerifiedEvidenceBrief, now: Date, maxAgeMs = BRIEF_REUSE_MAX_AGE_MS): boolean {
  const oldest = Math.min(...brief.sources.map((source) => Date.parse(source.retrievedAt)));
  return Number.isFinite(oldest) && now.getTime() - oldest <= maxAgeMs;
}

/** The first stored brief (newest first) a revise run may reuse, or `null`. */
export function reusableBrief(stored: readonly unknown[], instruction: string | null, now: Date): VerifiedEvidenceBrief | null {
  if (instructionChangesGoal(instruction)) return null;
  for (const evidence of stored) {
    const brief = briefFromEvidence(evidence);
    if (brief) return briefIsFresh(brief, now) ? brief : null;
  }
  return null;
}
