import type { AdaptRunState } from '../../training-agents/graph/adapt-run-state';
import { ADAPT_ROUTE_END } from '../../training-agents/graph/adapt-graph';
import { wantsRevision } from '../contracts/adaptation-critique.contract';
import { critiquesOf, isSkipped } from './state';

// =============================================================================
// The adaptation graph's conditional edges, as pure functions
// =============================================================================
//
//   context     blocked_safety -> END; otherwise adapt
//   guardrails  first pass -> critic; the revision -> finalize (never a second critic)
//   critic      revise WITH a major issue, while a revision is left -> adapt; else finalize
//
// So there are at most two planner passes and one critic round: a second
// `revise` can never happen, let alone cause a third pass.
// =============================================================================

export function routeAfterContext(state: Pick<AdaptRunState, 'outcome'>): 'adapt' | typeof ADAPT_ROUTE_END {
  return state.outcome?.status === 'blocked_safety' ? ADAPT_ROUTE_END : 'adapt';
}

export function routeAfterGuardrails(state: Pick<AdaptRunState, 'roundCounters'>): 'critic' | 'finalize' {
  return (state.roundCounters.adapt ?? 0) > 1 ? 'finalize' : 'critic';
}

export function routeAfterCritic(state: Pick<AdaptRunState, 'roundCounters' | 'maxRevisions' | 'critiques'>): 'adapt' | 'finalize' {
  const last = critiquesOf(state).at(-1);
  const passes = state.roundCounters.adapt ?? 0;
  if (!last || isSkipped(last) || !wantsRevision(last)) return 'finalize';
  return passes < 1 + state.maxRevisions ? 'adapt' : 'finalize';
}
