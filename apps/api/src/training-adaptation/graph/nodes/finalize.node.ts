import '../events';

import type { AdaptRunState, AdaptRunStateUpdate } from '../../../training-agents/graph/adapt-run-state';
import { TrainingRunFailedError } from '../../../training-agents/runtime/training-run-errors';
import { ADAPTATION_EVENT_TYPES, ADAPTATION_REASONS } from '../../adaptation.constants';
import { snapshotOf } from '../../context/adaptation-context.contract';
import type { AdaptationNodeContext } from '../node-context';
import { type AdaptationResult, contextOf, criticReportOf, critiquesOf, guardrailReportOf, proposalOf } from '../state';

// =============================================================================
// Node `finalize` (no model): assemble what the adaptation row stores
// =============================================================================
//
// The proposal, the guardrail report (with the run's warning codes), the
// critic report, the context snapshot and the safety level. The handler
// writes them with the `ready` status in one guarded update, together with
// the run's terminal status, so a cancelled run never turns `ready`.
// =============================================================================

export async function runFinalizeNode(state: AdaptRunState, ctx: AdaptationNodeContext): Promise<AdaptRunStateUpdate> {
  const context = contextOf(state);
  const proposal = proposalOf(state);
  const report = guardrailReportOf(state);
  if (!context || !proposal || !report) {
    throw new TrainingRunFailedError(ADAPTATION_REASONS.INVALID, 'The adaptation has no checked proposal.');
  }

  const result: AdaptationResult = {
    proposal,
    guardrailReport: { ...report, warnings: [...new Set([...report.warnings, ...state.warnings])] },
    criticReport: criticReportOf(critiquesOf(state)),
    contextSnapshot: snapshotOf(context),
    safety: context.safety,
  };

  await ctx.emit(ADAPTATION_EVENT_TYPES.READY, {
    exercises: proposal.exercises.length,
    estimatedMinutes: proposal.estimatedMinutes,
  });

  return { result, outcome: { status: 'ready' } };
}
