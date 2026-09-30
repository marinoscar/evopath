import type { RunState } from './run-state';

// =============================================================================
// The graphs' conditional edges, as pure functions (no LangGraph import), so
// a hand-rolled runner can reuse them unchanged.
// =============================================================================

/** Whether the latest critic verdict approves the draft. */
export function lastVerdictApproves(state: Pick<RunState, 'verdicts'>): boolean {
  const last = state.verdicts.at(-1);

  return last !== null && typeof last === 'object' && (last as { approve?: unknown }).approve === true;
}

/** After `prepare_context`: only a `create` run researches; `revise` goes straight to the planner. */
export function routeAfterPrepare(state: Pick<RunState, 'kind'>): 'research' | 'plan' {
  return state.kind === 'create' ? 'research' : 'plan';
}

/** After `critique`: approve, or the critic rounds are spent, goes to `finalize`; otherwise revise. */
export function routeAfterCritique(
  state: Pick<RunState, 'verdicts' | 'roundCounters' | 'maxCriticRounds'>,
): 'finalize' | 'plan' {
  const rounds = state.roundCounters.critique ?? 0;

  return lastVerdictApproves(state) || rounds >= state.maxCriticRounds ? 'finalize' : 'plan';
}

/** After `envelope`: "ask me first" pauses for the owner, otherwise the change applies. */
export function routeAfterEnvelope(state: Pick<RunState, 'input'>): 'await_approval' | 'apply' {
  return state.input.autonomy === 'ask_first' ? 'await_approval' : 'apply';
}
