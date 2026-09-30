import { critiqueDecision, guardrailStatusOf } from '../graph/routes';
import { stubNode } from './stub-node';

/** Compiles and stores the plan. STUB (the finalize story replaces it): records the loop's outcome only. */
export const finalizeNode = stubNode('finalize', async (state) => {
  if (guardrailStatusOf(state) === 'blocked') {
    return { outcome: { status: 'rejected', code: 'TRAINING_PLAN_REJECTED', verdict: 'blocked' } };
  }
  const decision = critiqueDecision(state);
  return { outcome: { status: 'completed', verdict: decision === 'revise' ? 'exhausted' : decision } };
});
