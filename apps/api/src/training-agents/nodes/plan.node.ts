import '../agents/planner/plan.events';

import { z } from 'zod';

import { draftCounts, planDraftSchema, type PlanDraftState } from '../agents/planner/plan-draft.contract';
import { runPlanner } from '../agents/planner/planner.agent';
import type { PlannerReview } from '../agents/planner/planner.prompt';
import type { GraphNode, NodeFn } from '../graph/node-context';
import type { RunState } from '../graph/run-state';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import type { GuardrailNodeOutput } from './guardrails.node';
import { runContextOf } from './prepare-context.node';

// =============================================================================
// Node `plan`: the planner agent (first draft, or a revision)
// =============================================================================
//
// Reads the planner half of the run context (`state.context.planner`) and the
// verified brief (`state.brief`; `null` on a revise run that skipped
// research). On a revision (a draft already exists) it also sends a
// `<review>` block: the previous draft, the critic's last blockers and
// suggestions, and the server's repair list from the last guardrail report.
//
// Emits `plan.draft { round, weeks, workouts, exercises }` and returns
// `{ draft: PlanDraftState }`. The draft is checked and repaired by the
// `guardrails` node next; nothing here decides whether it ships.
// =============================================================================

/** The critic's last verdict, read loosely (its contract belongs to the critic). */
const criticReviewSchema = z.object({
  blockers: z
    .array(z.object({ dimension: z.string(), path: z.string().default(''), issue: z.string(), fix: z.string() }))
    .default([]),
  suggestions: z.array(z.object({ dimension: z.string(), issue: z.string(), fix: z.string() })).default([]),
  summary: z.string().default(''),
});

/** At most this many server repair lines go into a review. */
export const REVIEW_MAX_REPAIRS = 40;

/** The previous draft, if it is a valid `PlanDraftState`. */
export function draftStateOf(state: Pick<RunState, 'draft'>): PlanDraftState | null {
  const value = state.draft as Partial<PlanDraftState> | null;
  if (!value || typeof value.round !== 'number') return null;
  const parsed = planDraftSchema.safeParse(value.draft);
  return parsed.success ? { round: value.round, draft: parsed.data, droppedContext: value.droppedContext ?? [] } : null;
}

/** The `<review>` block for a revision, or `null` on the first draft. */
export function reviewOf(state: Pick<RunState, 'draft' | 'verdicts' | 'guardrailReport'>): PlannerReview | null {
  const previous = draftStateOf(state);
  if (!previous) return null;

  const verdict = criticReviewSchema.safeParse(state.verdicts.at(-1));
  const report = (state.guardrailReport as Partial<GuardrailNodeOutput> | null)?.report;
  const lines = new Set<string>();
  for (const violation of report?.violations ?? []) {
    if (lines.size >= REVIEW_MAX_REPAIRS) break;
    const verb = violation.severity === 'block' ? 'BLOCKED' : violation.severity === 'repair' ? 'repaired' : 'flagged';
    lines.add(`${violation.rule} ${verb} at ${violation.path}: ${violation.message}`);
  }

  return {
    previousDraft: previous.draft,
    critic: verdict.success && state.verdicts.length > 0
      ? {
          blockers: verdict.data.blockers.map((b) => ({ dimension: b.dimension, path: b.path, issue: b.issue, fix: b.fix })),
          suggestions: verdict.data.suggestions,
          summary: verdict.data.summary,
        }
      : null,
    serverRepairs: [...lines],
  };
}

export const runPlan: NodeFn = async (state, ctx) => {
  const context = runContextOf(state);
  if (!ctx.roleModels.planner) {
    throw new TrainingRunFailedError('TRAINING_ROLE_UNAVAILABLE', 'The planning agent has no model for this run.', { role: 'planner' });
  }

  const previous = draftStateOf(state);
  const round = previous ? previous.round + 1 : 1;
  const outcome = await runPlanner(ctx, { context: context.planner, brief: state.brief, review: reviewOf(state), round });

  await ctx.emit('plan.draft', { round, ...draftCounts(outcome.draft) });

  const draft: PlanDraftState = { round, draft: outcome.draft, droppedContext: outcome.droppedContext };
  return { draft };
};

/** Drafts (or revises) the plan (the planner agent). */
export const planNode: GraphNode = { name: 'plan', run: runPlan, implemented: true };
