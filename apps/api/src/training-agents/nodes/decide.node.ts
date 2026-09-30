import { evaluateContextOf } from '../evaluation/evaluate-context';
import type { EvaluationDecision } from '../graph/routes';
import { stubNode } from './stub-node';

/**
 * Decides how the accepted change set lands: `no_change` (nothing accepted),
 * `autonomous` or `ask_first` (the plan's autonomy), recorded as
 * `changeSet.decision` for `routeAfterDecide`. STUB (part B replaces it):
 * decides from the run input's `autonomy`, else the plan's.
 */
export const decideNode = stubNode('decide', async (state) => {
  const autonomy = state.input.autonomy ?? evaluateContextOf(state)?.server.autonomy;
  const decision: EvaluationDecision = autonomy === 'ask_first' ? 'ask_first' : 'autonomous';
  return { changeSet: { ...((state.changeSet as Record<string, unknown> | null) ?? {}), decision } };
});
