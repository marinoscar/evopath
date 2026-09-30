import type { AdaptRunState } from '../../training-agents/graph/adapt-run-state';
import type { AdaptationContext, AdaptationContextSnapshot, AdaptationSafety } from '../context/adaptation-context.contract';
import type { AdaptationCriticReport, AdaptationCritiqueRound } from '../contracts/adaptation-critique.contract';
import type { AdaptationGuardrailReport, AdaptationProposalModel, AdaptedWorkout } from '../contracts/adapted-workout.contract';
import { type AdaptationRequest, adaptationRequestSchema } from '../dto/adaptation-request.dto';

// =============================================================================
// The adaptation's narrowing of the kit's `AdaptRunState` seams
// =============================================================================

/** A critic round that ran, or one that was skipped. */
export type AdaptationCritiqueEntry = AdaptationCritiqueRound | { round: number; skipped: 'token_cap' | 'error' };

/** What `finalize` assembles and the handler writes to the adaptation row. */
export interface AdaptationResult {
  proposal: AdaptedWorkout;
  guardrailReport: AdaptationGuardrailReport;
  criticReport: AdaptationCriticReport;
  contextSnapshot: AdaptationContextSnapshot;
  safety: AdaptationSafety;
}

export function requestOf(state: Pick<AdaptRunState, 'request'>): AdaptationRequest {
  return adaptationRequestSchema.parse(state.request);
}

export const contextOf = (state: Pick<AdaptRunState, 'adaptationContext'>) =>
  (state.adaptationContext as AdaptationContext | null) ?? null;
export const draftOf = (state: Pick<AdaptRunState, 'draft'>) => (state.draft as AdaptationProposalModel | null) ?? null;
export const proposalOf = (state: Pick<AdaptRunState, 'proposal'>) => (state.proposal as AdaptedWorkout | null) ?? null;
export const guardrailReportOf = (state: Pick<AdaptRunState, 'guardrailReport'>) =>
  (state.guardrailReport as AdaptationGuardrailReport | null) ?? null;
export const critiquesOf = (state: Pick<AdaptRunState, 'critiques'>) => (state.critiques ?? []) as AdaptationCritiqueEntry[];
export const resultOf = (state: Pick<AdaptRunState, 'result'>) => (state.result as AdaptationResult | null) ?? null;

export function isSkipped(entry: AdaptationCritiqueEntry | undefined): entry is { round: number; skipped: 'token_cap' | 'error' } {
  return !!entry && 'skipped' in entry;
}

/** `workout_adaptations.critic_report` from the rounds. */
export function criticReportOf(entries: readonly AdaptationCritiqueEntry[]): AdaptationCriticReport {
  const ran = entries.filter((e): e is AdaptationCritiqueRound => !isSkipped(e));
  const lastRan = ran.at(-1);
  const last = entries.at(-1);

  return {
    verdict: lastRan?.verdict ?? null,
    checks: lastRan ? { ...lastRan.checks } : null,
    issues: lastRan ? lastRan.issues.map((i) => ({ ...i })) : [],
    rounds: ran.length,
    ...(isSkipped(last) ? { skipped: last.skipped } : {}),
  };
}
