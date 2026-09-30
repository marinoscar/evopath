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

// ---- the evaluate graph ---------------------------------------------------------
//
//   load_signals -> safety_gate --stop--> END
//                             \-> evaluate -> envelope --structural--> critique_light -> decide
//                                                      \-------------------------------^
//   decide: no_change -> record_review -> END
//           autonomous -> apply -> notify -> END
//           ask_first  -> record_proposal -> await_approval --approve--> apply -> notify -> END
//                                                            \-reject---> notify -> END
//
// The change set (`state.changeSet`) is read loosely here: `accepted` (the
// envelope's accepted operations, each with an `op`) and `decision` (set by
// `decide`). Part B's contracts narrow it; these routes only need those two.

/** Operations that change a plan's structure: the adaptation critic reviews them. */
export const STRUCTURAL_OPERATIONS: readonly string[] = [
  'swap_exercise',
  'remove_exercise',
  'add_exercise',
  'drop_workout',
  'set_weekday',
  'regenerate_remaining',
];

/** How an evaluation lands (`changeSet.decision`, set by `decide`). */
export type EvaluationDecision = 'no_change' | 'autonomous' | 'ask_first';

/** The end of the graph, as a route answer (the graph file maps it to LangGraph's END). */
export const ROUTE_END = 'end';

function changeSetOf(state: Pick<RunState, 'changeSet'>): { accepted?: unknown; decision?: unknown } {
  const changeSet = state.changeSet;
  return changeSet && typeof changeSet === 'object' ? (changeSet as { accepted?: unknown; decision?: unknown }) : {};
}

/** After `safety_gate`: a safety stop ends the run before any model call. */
export function routeAfterSafetyGate(state: Pick<RunState, 'outcome'>): 'evaluate' | typeof ROUTE_END {
  return state.outcome?.status === 'safety_stop' ? ROUTE_END : 'evaluate';
}

/** After `envelope`: structural accepted operations get the light critique first. */
export function routeAfterEnvelope(state: Pick<RunState, 'changeSet'>): 'critique_light' | 'decide' {
  const accepted = changeSetOf(state).accepted;
  const structural =
    Array.isArray(accepted) &&
    accepted.some((op) => !!op && typeof op === 'object' && STRUCTURAL_OPERATIONS.includes(String((op as { op?: unknown }).op)));
  return structural ? 'critique_light' : 'decide';
}

/** After `decide`: record a review, apply at once, or propose and wait for the owner. */
export function routeAfterDecide(state: Pick<RunState, 'changeSet'>): 'record_review' | 'apply' | 'record_proposal' {
  const decision = changeSetOf(state).decision;
  if (decision === 'no_change') return 'record_review';
  return decision === 'ask_first' ? 'record_proposal' : 'apply';
}

/** After `await_approval`: an approval applies; a rejection only notifies. */
export function routeAfterApproval(state: Pick<RunState, 'approval'>): 'apply' | 'notify' {
  return state.approval?.decision === 'approve' ? 'apply' : 'notify';
}
