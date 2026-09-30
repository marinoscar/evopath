import '../evaluation/adaptation.events';

import { evaluateContextOf } from '../evaluation/evaluate-context';
import { changeSetOf } from '../evaluation/evaluate-state';
import type { GraphNode, NodeFn } from '../graph/node-context';
import type { RunApproval } from '../graph/run-state';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import { EVALUATION_PORT_MISSING } from './load-signals.node';

// =============================================================================
// Node `await_approval`: the owner decides ("ask me first")
// =============================================================================
//
// `ctx.interrupt` is the node's first side effect: the run pauses
// (`awaiting_approval`, checkpointed: it survives a restart) until
// `POST /api/ai/training/runs/:runId/decision` resumes it in a new job; the
// node then runs again from the top and `interrupt` returns the decision.
// The interrupt payload holds identifiers and counts only.
//
//   approve -> `apply` (the version check happens there)
//   reject  -> the proposal row becomes `rejected` (its operations become
//              suppression fingerprints for 14 days); the plan is untouched
//
// The proposal's expiry is the run's (`expiresAt`; the sweep cancels the run
// and marks the row `expired`).
// =============================================================================

export const runAwaitApproval: NodeFn = async (state, ctx) => {
  const context = evaluateContextOf(state);
  const changeSet = changeSetOf(state);
  const port = ctx.ports?.evaluation;
  if (!context || !changeSet?.proposal || !port) {
    throw new TrainingRunFailedError(EVALUATION_PORT_MISSING, 'There is no proposal to decide on.');
  }
  const { proposal } = changeSet;

  const decision = ctx.interrupt<RunApproval>({
    kind: 'approval',
    payload: {
      changeLogId: proposal.changeLogId,
      expiresAt: proposal.expiresAt,
      operations: changeSet.accepted.filter((op) => !op.forced).length,
    },
  });

  if (decision?.decision === 'approve') return { approval: { decision: 'approve' } };

  await port.resolveProposal(ctx.userId, proposal.changeLogId, 'rejected');
  await ctx.emit('adaptation.closed', { result: 'rejected' });
  return {
    approval: { decision: 'reject' },
    changeSet: { ...changeSet, result: 'rejected' },
    outcome: { status: 'no_change', programId: context.server.programId, changeLogId: proposal.changeLogId, verdict: 'rejected_by_owner' },
  };
};

/** Pauses for the owner's decision ("ask me first"). */
export const awaitApprovalNode: GraphNode = { name: 'await_approval', run: runAwaitApproval, implemented: true };
