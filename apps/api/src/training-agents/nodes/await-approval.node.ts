import type { RunApproval } from '../graph/run-state';
import { stubNode } from './stub-node';

/**
 * Pauses for the owner's decision ("ask me first"). STUB (the evaluator story
 * replaces it). The interrupt is the node's first side effect: on resume the
 * node runs again from the top and `interrupt` returns the decision.
 */
export const awaitApprovalNode = stubNode('await_approval', async (_state, ctx) => {
  const decision = ctx.interrupt<RunApproval>({ kind: 'approval', payload: { operations: 0 } });

  return { approval: { decision: decision?.decision === 'approve' ? 'approve' : 'reject' } };
});
