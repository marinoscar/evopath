import type { RunApproval } from '../graph/run-state';
import { stubNode } from './stub-node';

/**
 * Pauses for the owner's decision ("ask me first"). STUB (part B replaces it).
 * The interrupt is the node's first side effect: on resume the node runs
 * again from the top and `interrupt` returns the decision. A rejection ends
 * the run with no change (`routeAfterApproval` skips `apply`).
 */
export const awaitApprovalNode = stubNode('await_approval', async (_state, ctx) => {
  const decision = ctx.interrupt<RunApproval>({ kind: 'approval', payload: { operations: 0 } });
  const approved = decision?.decision === 'approve';

  return {
    approval: { decision: approved ? 'approve' : 'reject' },
    ...(approved ? {} : { outcome: { status: 'no_change' as const, verdict: 'rejected_by_owner' } }),
  };
});
