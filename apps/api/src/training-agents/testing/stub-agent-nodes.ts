import type { VerifiedEvidenceBrief } from '../agents/researcher/evidence-brief.contract';
import { CRITIC_DIMENSIONS, type CriticVerdict } from '../agents/critic/critic-verdict.contract';
import type { NodeFn } from '../graph/node-context';
import { critiqueDecision, guardrailStatusOf } from '../graph/routes';

// =============================================================================
// Stand-ins for the IMPLEMENTED agent nodes, for runtime-only tests
// =============================================================================
//
// A spec that exercises the runtime kit (handler outcomes, checkpoints,
// events, graph routing) rather than an agent passes `STUB_AGENT_NODES` as
// its node overrides, so an implemented agent node does not need a context
// and a scripted model. Each agent story adds its node here when it replaces
// a stub.
// =============================================================================

/** A canned verified brief: valid against `verifiedEvidenceBriefSchema`. */
export const STUB_VERIFIED_BRIEF: VerifiedEvidenceBrief = {
  summary: 'Train each major muscle group about twice a week with moderate volume.',
  claims: [
    { id: 'E1', topic: 'frequency', claim: 'Train each muscle about twice a week.', applicability: 'Fits three sessions a week.', confidence: 'high', sourceIds: ['S1'] },
    { id: 'E2', topic: 'volume', claim: 'Ten or more weekly sets per muscle supports growth.', applicability: 'Start lower as a beginner.', confidence: 'moderate', sourceIds: ['S1', 'S2'] },
    { id: 'E3', topic: 'progression', claim: 'Add load gradually when reps are achieved.', applicability: 'Small steps.', confidence: 'moderate', sourceIds: ['S2'] },
  ],
  sources: [
    { id: 'S1', url: 'https://www.acsm.org/guidelines', title: 'Resistance training guidelines', publisher: 'ACSM', kind: 'position_stand', year: 2021, verified: true, domain: 'acsm.org', retrievedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'S2', url: 'https://pubmed.ncbi.nlm.nih.gov/27102172', title: 'Training frequency meta-analysis', publisher: 'Sports Medicine', kind: 'meta_analysis', year: 2016, verified: true, domain: 'pubmed.ncbi.nlm.nih.gov', retrievedAt: '2026-01-01T00:00:00.000Z' },
  ],
  cautions: [],
  searchQueries: ['resistance training frequency guidelines'],
  researchMode: 'single',
  droppedClaims: 0,
  droppedSources: 0,
};

/** The research node without a model: returns the canned brief. */
export const STUB_RESEARCH_NODE: NodeFn = async () => ({ brief: STUB_VERIFIED_BRIEF });

/** `prepare_context` without a database: a marker context (the research stub ignores it). */
export const STUB_PREPARE_CONTEXT_NODE: NodeFn = async (state) => ({ context: { stub: true, kind: state.kind } });

/** The planner without a model: a marker draft per round. */
export const STUB_PLAN_NODE: NodeFn = async (state) => ({
  draft: { stub: true, revision: state.roundCounters.critique ?? 0 },
});

/** The guardrails without a draft to check: a clean marker report (the route reads `report.status`). */
export const STUB_GUARDRAILS_NODE: NodeFn = async () => ({
  guardrailReport: { stub: true, report: { status: 'clean', violations: [], counts: { block: 0, repair: 0, warn: 0 } } },
});

/** A critic verdict that passes the rubric (every score 5, no blocker). */
export function stubVerdict(verdict: 'approve' | 'revise' = 'approve'): CriticVerdict {
  const score = verdict === 'approve' ? 5 : 3;
  return {
    verdict,
    scores: Object.fromEntries(CRITIC_DIMENSIONS.map((d) => [d, score])) as CriticVerdict['scores'],
    blockers: verdict === 'approve' ? [] : [{ dimension: 'goal_fit', path: 'week 1', issue: 'Off goal.', fix: 'Refocus.' }],
    suggestions: [],
    summary: verdict === 'approve' ? 'Looks good.' : 'Needs work.',
  };
}

/** The critic without a model: approves every round. */
export const STUB_CRITIQUE_NODE: NodeFn = async (state) => {
  const round = (state.roundCounters.critique ?? 0) + 1;
  return { verdicts: [{ ...stubVerdict('approve'), round }], roundCounters: { critique: round } };
};

/** `finalize` without the programs chokepoint: records the outcome from the loop's decision only. */
export const STUB_FINALIZE_NODE: NodeFn = async (state) => {
  if (guardrailStatusOf(state) === 'blocked') {
    return { outcome: { status: 'rejected', code: 'TRAINING_PLAN_REJECTED', verdict: 'blocked' } };
  }
  const decision = critiqueDecision(state);
  return { outcome: { status: 'completed', verdict: decision === 'revise' ? 'exhausted' : decision } };
};

/** Every implemented agent node, stubbed, in graph order. Spread your own overrides after it. */
export const STUB_AGENT_NODES: Readonly<Record<string, NodeFn>> = {
  prepare_context: STUB_PREPARE_CONTEXT_NODE,
  research: STUB_RESEARCH_NODE,
  plan: STUB_PLAN_NODE,
  guardrails: STUB_GUARDRAILS_NODE,
  critique: STUB_CRITIQUE_NODE,
  finalize: STUB_FINALIZE_NODE,
};
