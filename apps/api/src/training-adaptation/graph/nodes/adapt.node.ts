import '../events';

import type { AdaptRunState, AdaptRunStateUpdate } from '../../../training-agents/graph/adapt-run-state';
import { AgentOutputTruncated } from '../../../training-agents/runtime/agent-caller';
import { RunBudgetExceededError } from '../../../training-agents/runtime/run-budget';
import { TrainingRunFailedError } from '../../../training-agents/runtime/training-run-errors';
import {
  ADAPTATION_EVENT_TYPES,
  ADAPTATION_REASONS,
  ADAPTATION_WARNINGS,
  ADAPT_PLANNER_MAX_OUTPUT_TOKENS,
} from '../../adaptation.constants';
import { adaptationProposalModelSchema } from '../../contracts/adapted-workout.contract';
import { ADAPT_INSTRUCTIONS, renderAdaptInput } from '../../prompts/adapt.prompt';
import { ADAPTATION_PROPOSAL_SCHEMA_NAME } from '../../prompts/markers';
import type { AdaptationNodeContext } from '../node-context';
import { contextOf, critiquesOf, isSkipped, proposalOf } from '../state';
import { isBudgetStop } from './critic.node';

// =============================================================================
// Node `adapt` (planner role): ONE structured call per pass
// =============================================================================
//
// `respondStructured` through the kit's `AgentCaller` with the planner's
// frozen model and effort, `schemaName: 'training_adaptation_proposal'`,
// strict mode. On the revise pass the previous checked answer and the
// critic's issues are added as the delimited `<critic-notes>` block. No
// retry: an invalid answer (`AI_STRUCTURED_OUTPUT_INVALID`) fails the run, a
// throttle defers it, a cancel aborts the call.
//
// THE TOKEN CAP (E6.3). A call the cap stops (`RunBudgetExceededError`
// before it, or an answer cut off because its output was clamped to the last
// tokens of the cap) is a cap stop, never `TRAINING_OUTPUT_TRUNCATED`:
//   - on the revise pass, the first proposal already passed the guardrails,
//     so it ships: `revision_skipped_token_cap` is recorded, `guardrails`
//     skips its re-check and the route finalizes;
//   - on the first pass there is nothing to offer: the run fails
//     `TRAINING_RUN_BUDGET_EXCEEDED` (the handler's mapping).
// =============================================================================

export const ADAPT_NODE = 'adapt';

export async function runAdaptNode(state: AdaptRunState, ctx: AdaptationNodeContext): Promise<AdaptRunStateUpdate> {
  const context = contextOf(state);
  if (!context) throw new TrainingRunFailedError(ADAPTATION_REASONS.INVALID, 'The adaptation context is missing.');

  const pass = (state.roundCounters.adapt ?? 0) + 1;
  const previous = proposalOf(state);
  const critique = critiquesOf(state).at(-1);
  const revision =
    pass > 1 && previous && critique && !isSkipped(critique)
      ? {
          previous: {
            estimatedMinutes: previous.estimatedMinutes,
            exercises: previous.exercises.map((e) => ({
              key: e.exerciseKey,
              source: e.source,
              sets: e.sets,
              repMin: e.repMin,
              repMax: e.repMax,
              targetRpe: e.targetRpe,
            })),
          },
          critique,
        }
      : undefined;

  let parsed;
  try {
    ({ parsed } = await ctx.agent.structured({
      role: 'planner',
      node: ADAPT_NODE,
      round: pass,
      schema: adaptationProposalModelSchema,
      schemaName: ADAPTATION_PROPOSAL_SCHEMA_NAME,
      instructions: ADAPT_INSTRUCTIONS,
      input: renderAdaptInput(context.sent, revision),
      maxOutputTokens: ADAPT_PLANNER_MAX_OUTPUT_TOKENS,
    }));
  } catch (err) {
    const capStop = isBudgetStop(err) || (err instanceof AgentOutputTruncated && ctx.budget.remaining() <= 0);
    if (!capStop) throw err;

    if (pass > 1 && previous) {
      return { roundCounters: { adapt: pass }, warnings: [ADAPTATION_WARNINGS.REVISION_SKIPPED_TOKEN_CAP] };
    }

    throw isBudgetStop(err) ? err : new RunBudgetExceededError(ctx.budget.cap, ctx.budget.used, 'planner');
  }

  await ctx.emit(ADAPTATION_EVENT_TYPES.PROPOSAL, {
    round: pass,
    exercises: parsed.exercises.length,
    dropped: parsed.dropped.length,
  });

  return { draft: parsed, roundCounters: { adapt: pass } };
}
