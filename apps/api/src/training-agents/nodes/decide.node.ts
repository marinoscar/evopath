import { evaluateContextOf } from '../evaluation/evaluate-context';
import { changeSetOf } from '../evaluation/evaluate-state';
import type { GraphNode, NodeFn } from '../graph/node-context';
import type { EvaluationDecision } from '../graph/routes';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import { EVALUATION_PORT_MISSING } from './load-signals.node';

// =============================================================================
// Node `decide`: how the accepted change set lands (`changeSet.decision`)
// =============================================================================
//
//   nothing accepted                              -> no_change  (record_review)
//   the plan's autonomy is ask_first and at
//   least one accepted operation is not forced    -> ask_first  (record_proposal)
//   otherwise                                     -> autonomous (apply)
//
// Forced safety removals never wait for approval: with only forced
// operations the change lands at once in either mode, and in ask-first mode
// `record_proposal` applies them before it records the proposal. The
// autonomy is the plan's (`server.autonomy`, read when the run started).
// =============================================================================

export function decisionFor(autonomy: 'autonomous' | 'ask_first', accepted: ReadonlyArray<{ forced?: true }>): EvaluationDecision {
  if (accepted.length === 0) return 'no_change';
  return autonomy === 'ask_first' && accepted.some((op) => !op.forced) ? 'ask_first' : 'autonomous';
}

export const runDecide: NodeFn = async (state) => {
  const context = evaluateContextOf(state);
  const changeSet = changeSetOf(state);
  if (!context || !changeSet) {
    throw new TrainingRunFailedError(EVALUATION_PORT_MISSING, 'The training context is missing.');
  }
  return { changeSet: { ...changeSet, decision: decisionFor(context.server.autonomy, changeSet.accepted) } };
};

/** Decides: record a review, apply at once, or propose and wait for the owner. */
export const decideNode: GraphNode = { name: 'decide', run: runDecide, implemented: true };
