import '../events';

import type { AdaptRunState, AdaptRunStateUpdate } from '../../../training-agents/graph/adapt-run-state';
import { TrainingRunFailedError } from '../../../training-agents/runtime/training-run-errors';
import { ADAPTATION_EVENT_TYPES, ADAPTATION_PROMPT_VERSION, ADAPTATION_REASONS, ADAPTATION_WARNINGS } from '../../adaptation.constants';
import type { AdaptationGuardrailReport } from '../../contracts/adapted-workout.contract';
import { applyAdaptationRules } from '../../rules/adaptation-rules';
import type { AdaptationNodeContext } from '../node-context';
import { contextOf, draftOf, proposalOf, requestOf } from '../state';

// =============================================================================
// Node `guardrails` (no model): the server decides what may ship
// =============================================================================
//
// Runs `applyAdaptationRules` on EVERY planner answer, whatever the prompt
// said. A hard violation after repair fails the run with its code
// (`ADAPTATION_INVALID`, `ADAPTATION_CANNOT_FIT` and its message) on the
// first pass; on the revise pass the first, already checked proposal is kept
// and `revision_rejected` is recorded instead. A revision the token cap
// stopped (`revision_skipped_token_cap`, set by `adapt`) produced no new
// answer: nothing to re-check, the first proposal stands.
// =============================================================================

export async function runGuardrailsNode(state: AdaptRunState, ctx: AdaptationNodeContext): Promise<AdaptRunStateUpdate> {
  const context = contextOf(state);
  const draft = draftOf(state);
  if (!context || !draft) throw new TrainingRunFailedError(ADAPTATION_REASONS.INVALID, 'The adaptation has no proposal to check.');

  const round = state.roundCounters.adapt ?? 1;
  if (round > 1 && proposalOf(state) && state.warnings.includes(ADAPTATION_WARNINGS.REVISION_SKIPPED_TOKEN_CAP)) {
    return {};
  }

  const request = requestOf(state);
  const outcome = applyAdaptationRules(draft, context.facts, {
    minutes: request.minutes ?? null,
    soreness: request.soreness ?? null,
  });

  if (!outcome.ok) {
    if (round > 1 && proposalOf(state)) {
      await ctx.emit(ADAPTATION_EVENT_TYPES.GUARDRAILS, {
        round,
        repairs: outcome.report.repairs.length,
        rejected: outcome.report.rejected.length,
        estimatedMinutes: outcome.report.estimatedMinutes,
        fitsRequest: outcome.report.fitsRequest,
        status: 'kept_previous',
      });
      return { warnings: [ADAPTATION_WARNINGS.REVISION_REJECTED] };
    }
    throw new TrainingRunFailedError(outcome.code, outcome.message);
  }

  const report: AdaptationGuardrailReport = {
    ...outcome.report,
    promptVersion: ADAPTATION_PROMPT_VERSION,
    warnings: [],
  };

  await ctx.emit(ADAPTATION_EVENT_TYPES.GUARDRAILS, {
    round,
    repairs: report.repairs.length,
    rejected: report.rejected.length,
    estimatedMinutes: report.estimatedMinutes,
    fitsRequest: report.fitsRequest,
    status: 'ok',
  });

  return { proposal: outcome.proposal, guardrailReport: report };
}
