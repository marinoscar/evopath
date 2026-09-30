import { stubNode } from './stub-node';

/** Drafts (or revises) the plan. STUB (the planner replaces it). */
export const planNode = stubNode('plan', async (state) => ({
  draft: { stub: true, revision: state.roundCounters.critique ?? 0 },
}));
