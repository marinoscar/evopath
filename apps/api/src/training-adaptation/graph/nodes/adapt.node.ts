import '../events';

import type { AdaptRunState, AdaptRunStateUpdate } from '../../../training-agents/graph/adapt-run-state';
import { TrainingRunFailedError } from '../../../training-agents/runtime/training-run-errors';
import { ADAPTATION_EVENT_TYPES, ADAPTATION_REASONS, ADAPT_PLANNER_MAX_OUTPUT_TOKENS } from '../../adaptation.constants';
import { adaptationProposalModelSchema } from '../../contracts/adapted-workout.contract';
import { ADAPT_INSTRUCTIONS, renderAdaptInput } from '../../prompts/adapt.prompt';
import { ADAPTATION_PROPOSAL_SCHEMA_NAME } from '../../prompts/markers';
import type { AdaptationNodeContext } from '../node-context';
import { contextOf, critiquesOf, isSkipped, proposalOf } from '../state';

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

  const { parsed } = await ctx.agent.structured({
    role: 'planner',
    node: ADAPT_NODE,
    round: pass,
    schema: adaptationProposalModelSchema,
    schemaName: ADAPTATION_PROPOSAL_SCHEMA_NAME,
    instructions: ADAPT_INSTRUCTIONS,
    input: renderAdaptInput(context.sent, revision),
    maxOutputTokens: ADAPT_PLANNER_MAX_OUTPUT_TOKENS,
  });

  await ctx.emit(ADAPTATION_EVENT_TYPES.PROPOSAL, {
    round: pass,
    exercises: parsed.exercises.length,
    dropped: parsed.dropped.length,
  });

  return { draft: parsed, roundCounters: { adapt: pass } };
}
