import { stubNode } from './stub-node';

/** Applies the change set to the plan. STUB (the evaluator story replaces it): records the outcome only. */
export const applyNode = stubNode('apply', async (state) => ({
  outcome:
    state.approval?.decision === 'reject'
      ? { status: 'no_change', verdict: 'rejected_by_owner' }
      : { status: 'completed', verdict: 'applied' },
}));
