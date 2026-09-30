import { lastVerdictApproves } from '../graph/routes';
import { stubNode } from './stub-node';

/** Compiles and stores the plan. STUB (the plan compiler replaces it): records the outcome only. */
export const finalizeNode = stubNode('finalize', async (state) => ({
  outcome: { status: 'completed', verdict: lastVerdictApproves(state) ? 'approved' : 'exhausted' },
}));
