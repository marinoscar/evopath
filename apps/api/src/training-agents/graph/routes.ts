import { criticRoundOf, verdictPasses } from '../agents/critic/critic-verdict.contract';
import type { RunState } from './run-state';

// =============================================================================
// The graphs' conditional edges, as pure functions (no LangGraph import), so
// a hand-rolled runner can reuse them unchanged.
// =============================================================================
//
// THE SHIP DECISION belongs to the server, not the critic. After each
// critique:
//
//   ship = guardrail status !== 'blocked'
//          && verdict 'approve' && every score >= 4 && no blockers
//
// ship -> finalize. Otherwise, while critique rounds < maxCriticRounds, back
// to plan with the review. Otherwise EXHAUSTED -> finalize, which ships the
// draft with open-note warnings when the guardrails did not block it, and
// rejects the run (`TRAINING_PLAN_REJECTED`, no program) when they did.
// A skipped critique (budget spent, critic unavailable) goes to finalize too.
// =============================================================================

/** Machine warning codes the loop records in `RunState.warnings`. */
export const TRAINING_RUN_WARNINGS = {
  /** The critic rounds ran out with the critic still asking for changes. */
  OPEN_NOTES: 'critic_open_notes',
  /** The token budget ran out after a guardrail-valid draft existed; it shipped without (further) review. */
  SKIPPED_BUDGET: 'critic_skipped_budget',
  /** The critic could not produce a valid verdict; the guardrail-valid draft shipped unreviewed. */
  UNAVAILABLE: 'critic_unavailable',
} as const;

/** How the loop ended, as `finalize` records it (`outcome.verdict`). */
export type CritiqueDecision = 'approved' | 'revise' | 'exhausted' | 'critic_skipped_budget' | 'critic_unavailable';

/** The status of the latest guardrail report, or `null` when there is none. */
export function guardrailStatusOf(state: Pick<RunState, 'guardrailReport'>): 'clean' | 'repaired' | 'blocked' | null {
  const status = (state.guardrailReport as { report?: { status?: unknown } } | null)?.report?.status;
  return status === 'clean' || status === 'repaired' || status === 'blocked' ? status : null;
}

/** Whether the latest draft may ship right now: guardrails not blocked and the latest verdict passes the rubric. */
export function shipsNow(state: Pick<RunState, 'guardrailReport' | 'verdicts'>): boolean {
  const status = guardrailStatusOf(state);
  const last = criticRoundOf(state.verdicts.at(-1));
  return status !== null && status !== 'blocked' && last !== null && last.skipped === undefined && verdictPasses(last);
}

/** The decision after a critique (pure). */
export function critiqueDecision(
  state: Pick<RunState, 'guardrailReport' | 'verdicts' | 'roundCounters' | 'maxCriticRounds'>,
): CritiqueDecision {
  const last = criticRoundOf(state.verdicts.at(-1));
  if (last?.skipped === 'budget') return 'critic_skipped_budget';
  if (last?.skipped === 'unavailable') return 'critic_unavailable';
  if (shipsNow(state)) return 'approved';
  const rounds = state.roundCounters.critique ?? 0;
  return rounds < state.maxCriticRounds ? 'revise' : 'exhausted';
}

/** After `prepare_context`: only a `create` run researches; `revise` goes straight to the planner. */
export function routeAfterPrepare(state: Pick<RunState, 'kind'>): 'research' | 'plan' {
  return state.kind === 'create' ? 'research' : 'plan';
}

/**
 * After `plan`: a planner stopped by the token budget on a revision (it
 * recorded `critic_skipped_budget`) goes to `finalize` with the previous,
 * already checked draft; otherwise the new draft goes to the guardrails.
 */
export function routeAfterPlan(state: Pick<RunState, 'warnings'>): 'guardrails' | 'finalize' {
  return state.warnings.includes(TRAINING_RUN_WARNINGS.SKIPPED_BUDGET) ? 'finalize' : 'guardrails';
}

/** After `critique`: revise while rounds remain and the draft does not ship; everything else finalizes. */
export function routeAfterCritique(
  state: Pick<RunState, 'guardrailReport' | 'verdicts' | 'roundCounters' | 'maxCriticRounds'>,
): 'finalize' | 'plan' {
  return critiqueDecision(state) === 'revise' ? 'plan' : 'finalize';
}

/** After `envelope`: "ask me first" pauses for the owner, otherwise the change applies. */
export function routeAfterEnvelope(state: Pick<RunState, 'input'>): 'await_approval' | 'apply' {
  return state.input.autonomy === 'ask_first' ? 'await_approval' : 'apply';
}
