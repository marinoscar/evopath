import '../agents/critic/critic.events';

import { AgentOutputTruncated } from '../runtime/agent-caller';
import { buildCriticReview, isInvalidStructuredOutput, runCritic } from '../agents/critic/critic.agent';
import type { CriticRoundState, CriticSkipReason } from '../agents/critic/critic-verdict.contract';
import { CRITIC_EVENT_ISSUE_CHARS } from '../agents/critic/critic.events';
import type { GraphNode, NodeContext, NodeFn } from '../graph/node-context';
import { TRAINING_RUN_WARNINGS } from '../graph/routes';
import { guardrailContextOf } from '../guardrails/types';
import { RunBudgetExceededError } from '../runtime/run-budget';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import { TRAINING_REASONS } from '../runtime/training-runs.constants';
import { guardrailOutputOf } from './guardrails.node';
import { runContextOf } from './prepare-context.node';

// =============================================================================
// Node `critique`: the critic agent scores the repaired draft (one round)
// =============================================================================
//
// Reviews the guardrails' REPAIRED tree (never the raw draft) with the
// server's tables and report, the limited person context and the brief's
// claims (`buildCriticReview`). Appends the sanitised verdict to
// `state.verdicts` with its round and bumps `roundCounters.critique`; the
// route (`graph/routes.ts`) then decides: ship, revise or finalize as is.
//
// No review, but the run can still ship: when the token budget runs out
// (`RunBudgetExceededError`), or the critic fails to produce a valid verdict
// twice, AND the guardrails did not block the draft, the round is recorded as
// skipped (`critic_skipped_budget` / `critic_unavailable`) and the route
// finalizes the checked draft. With a blocked draft the error propagates
// (the run fails with the budget or AI code). Other errors always propagate.
//
// Emits `critic.round { round, verdict, scores, blockers[{dimension, issue}], summary }`.
// =============================================================================

export const GUARDRAIL_OUTPUT_MISSING = 'TRAINING_GUARDRAIL_REPORT_MISSING';

/** The first budget error in the cause chain, if any. */
function isBudgetStop(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof RunBudgetExceededError) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function skipReasonOf(err: unknown): CriticSkipReason | null {
  if (isBudgetStop(err)) return 'budget';
  if (err instanceof AgentOutputTruncated || isInvalidStructuredOutput(err)) return 'unavailable';
  return null;
}

async function emitRound(ctx: NodeContext, entry: CriticRoundState): Promise<void> {
  if (entry.skipped !== undefined) {
    await ctx.emit('critic.round', { round: entry.round, verdict: 'skipped', scores: null, blockers: [], summary: '' });
    return;
  }
  await ctx.emit('critic.round', {
    round: entry.round,
    verdict: entry.verdict,
    scores: entry.scores,
    blockers: entry.blockers.map((b) => ({ dimension: b.dimension, issue: b.issue.slice(0, CRITIC_EVENT_ISSUE_CHARS) })),
    summary: entry.summary,
  });
}

export const runCritique: NodeFn = async (state, ctx) => {
  const round = (state.roundCounters.critique ?? 0) + 1;
  const output = guardrailOutputOf(state);
  if (!output) {
    throw new TrainingRunFailedError(GUARDRAIL_OUTPUT_MISSING, 'There is no checked plan to review.');
  }
  if (!ctx.roleModels.critic) {
    throw new TrainingRunFailedError(TRAINING_REASONS.ROLE_UNAVAILABLE, 'The critic agent has no model for this run.', { role: 'critic' });
  }

  const context = runContextOf(state);
  const gctx = guardrailContextOf(context, state.brief);
  const review = buildCriticReview(output, context, gctx, state.brief);

  let entry: CriticRoundState;
  let warnings: string[] = [];
  try {
    const { verdict } = await runCritic(ctx, { review, tree: output.tree, gctx, round });
    entry = { ...verdict, round };
  } catch (err) {
    const skipped = skipReasonOf(err);
    if (!skipped || output.report.status === 'blocked') throw err;
    entry = { round, skipped };
    warnings = [skipped === 'budget' ? TRAINING_RUN_WARNINGS.SKIPPED_BUDGET : TRAINING_RUN_WARNINGS.UNAVAILABLE];
  }

  await emitRound(ctx, entry);

  return { verdicts: [entry], roundCounters: { critique: round }, ...(warnings.length > 0 ? { warnings } : {}) };
};

/** Scores the draft; one call is one critic round (the critic agent). */
export const critiqueNode: GraphNode = { name: 'critique', run: runCritique, implemented: true };
