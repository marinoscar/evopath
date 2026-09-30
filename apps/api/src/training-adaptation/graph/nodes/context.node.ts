import '../events';

import { TrainingRunFailedError } from '../../../training-agents/runtime/training-run-errors';
import type { AdaptRunStateUpdate, AdaptRunState } from '../../../training-agents/graph/adapt-run-state';
import { ADAPTATION_EVENT_TYPES, ADAPTATION_REASONS } from '../../adaptation.constants';
import { AdaptationContextError } from '../../context/adaptation-context.contract';
import type { AdaptationNodeContext } from '../node-context';
import { requestOf } from '../state';

// =============================================================================
// Node `context` (no model): build the minimised context and screen the text
// =============================================================================
//
// Calls the same builder as the preview and create routes. Urgent-symptom
// free text (E5.5's safety screen) ends the graph here with
// `blocked_safety`: no provider call is ever made for it.
// =============================================================================

export async function runContextNode(state: AdaptRunState, ctx: AdaptationNodeContext): Promise<AdaptRunStateUpdate> {
  let context;
  try {
    context = await ctx.contextPort.build(ctx.userId, requestOf(state), ctx.now());
  } catch (error) {
    if (error instanceof AdaptationContextError) {
      throw new TrainingRunFailedError(
        error.code === 'ADAPTATION_GYM_NOT_FOUND' ? ADAPTATION_REASONS.GYM_NOT_FOUND : ADAPTATION_REASONS.STALE,
        error.code === 'ADAPTATION_GYM_NOT_FOUND'
          ? 'The gym chosen for this adaptation no longer exists.'
          : 'The equipment chosen for this adaptation is no longer in the gym.',
      );
    }
    throw error;
  }

  await ctx.emit(ADAPTATION_EVENT_TYPES.CONTEXT, {
    base: context.facts.base !== null,
    exercises: context.sent.today?.exercises.length ?? 0,
    candidates: context.sent.candidates.length,
    readiness: context.sent.readiness !== undefined,
    safety: context.safety.level,
  });

  if (context.safety.level === 'blocked') {
    return { adaptationContext: context, outcome: { status: 'blocked_safety', code: ADAPTATION_REASONS.SAFETY_STOP } };
  }

  return { adaptationContext: context };
}
