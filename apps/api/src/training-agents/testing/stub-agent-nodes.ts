import type { VerifiedEvidenceBrief } from '../agents/researcher/evidence-brief.contract';
import type { NodeFn } from '../graph/node-context';

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

/** Every implemented agent node, stubbed. Spread your own overrides after it. */
export const STUB_AGENT_NODES: Readonly<Record<string, NodeFn>> = {
  research: STUB_RESEARCH_NODE,
};
