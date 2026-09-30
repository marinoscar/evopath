import '../events';

import { isInvalidStructuredOutput } from '../../../training-agents/agents/critic/critic.agent';
import type { AdaptRunState, AdaptRunStateUpdate } from '../../../training-agents/graph/adapt-run-state';
import { AgentOutputTruncated } from '../../../training-agents/runtime/agent-caller';
import { RunBudgetExceededError } from '../../../training-agents/runtime/run-budget';
import { TrainingRunFailedError } from '../../../training-agents/runtime/training-run-errors';
import {
  ADAPTATION_EVENT_TYPES,
  ADAPTATION_REASONS,
  ADAPTATION_WARNINGS,
  ADAPT_CRITIC_MAX_OUTPUT_TOKENS,
} from '../../adaptation.constants';
import { adaptationCritiqueModelSchema, toCritiqueRound } from '../../contracts/adaptation-critique.contract';
import { CRITIC_INSTRUCTIONS, renderCriticInput } from '../../prompts/critic.prompt';
import { ADAPTATION_CRITIQUE_SCHEMA_NAME } from '../../prompts/markers';
import type { AdaptationNodeContext } from '../node-context';
import { type AdaptationCritiqueEntry, contextOf, guardrailReportOf, proposalOf } from '../state';

// =============================================================================
// Node `critic` (critic role): one light structured review
// =============================================================================
//
// `schemaName: 'training_adaptation_critique'`. Skipped, keeping the checked
// proposal, when the run's token cap is spent (`token_cap`) or the critic's
// answer is unusable (`error`: truncated or invalid structured output); a
// critic answer cut off because its output was clamped to the last tokens of
// the cap is `token_cap` too (the budget is spent after the charge). The
// warning `critic_skipped` records it and the review page shows "Not
// reviewed by the critic". Any other error (a throttle, a key, the kill
// switch) propagates to the handler.
// =============================================================================

export const CRITIC_NODE = 'critic';

export function isBudgetStop(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof RunBudgetExceededError) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function runCriticNode(state: AdaptRunState, ctx: AdaptationNodeContext): Promise<AdaptRunStateUpdate> {
  const context = contextOf(state);
  const proposal = proposalOf(state);
  const report = guardrailReportOf(state);
  if (!context || !proposal || !report) {
    throw new TrainingRunFailedError(ADAPTATION_REASONS.INVALID, 'The adaptation has no checked proposal to review.');
  }

  const round = (state.roundCounters.critic ?? 0) + 1;

  const skip = async (skipped: 'token_cap' | 'error'): Promise<AdaptRunStateUpdate> => {
    await ctx.emit(ADAPTATION_EVENT_TYPES.CRITIQUE, { round, verdict: 'skipped', major: 0, minor: 0, skipped });
    const entry: AdaptationCritiqueEntry = { round, skipped };
    return { critiques: [entry], roundCounters: { critic: round }, warnings: [ADAPTATION_WARNINGS.CRITIC_SKIPPED] };
  };

  if (!ctx.roleModels.critic) return skip('error');

  let answer;
  try {
    ({ parsed: answer } = await ctx.agent.structured({
      role: 'critic',
      node: CRITIC_NODE,
      round,
      schema: adaptationCritiqueModelSchema,
      schemaName: ADAPTATION_CRITIQUE_SCHEMA_NAME,
      instructions: CRITIC_INSTRUCTIONS,
      input: renderCriticInput(context.sent, proposal, report),
      maxOutputTokens: ADAPT_CRITIC_MAX_OUTPUT_TOKENS,
    }));
  } catch (err) {
    if (isBudgetStop(err)) return skip('token_cap');
    if (err instanceof AgentOutputTruncated && ctx.budget.remaining() <= 0) return skip('token_cap');
    if (err instanceof AgentOutputTruncated || isInvalidStructuredOutput(err)) return skip('error');
    throw err;
  }

  const entry = toCritiqueRound(round, answer);
  await ctx.emit(ADAPTATION_EVENT_TYPES.CRITIQUE, {
    round,
    verdict: entry.verdict,
    major: entry.issues.filter((i) => i.severity === 'major').length,
    minor: entry.issues.filter((i) => i.severity === 'minor').length,
    skipped: null,
  });

  return { critiques: [entry], roundCounters: { critic: round } };
}
