import '../agents/researcher/research.events';

import { evidenceBasisOf } from '../agents/researcher/evidence-brief.contract';
import { runResearcher } from '../agents/researcher/researcher.agent';
import { researcherContextSchema, type ResearcherContext } from '../agents/researcher/researcher-context';
import type { GraphNode, NodeContext, NodeFn } from '../graph/node-context';
import type { RunState } from '../graph/run-state';
import { RESEARCHER_PROVIDERS } from '../models/training-role-defaults';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import { TRAINING_REASONS } from '../runtime/training-runs.constants';

// =============================================================================
// Node `research`: the researcher agent, verified
// =============================================================================
//
// 1. Defence in depth: the frozen researcher model must exist and be on a
//    provider whose hosted web search the platform drives; otherwise the run
//    fails `TRAINING_ROLE_UNAVAILABLE` before any provider call (run creation
//    already refuses such a run).
// 2. Reads the minimised researcher context the context builder put at
//    `state.context.researcher`; nothing else from the state reaches a model.
// 3. Runs the researcher (single call, two-step fallback, one retry) and the
//    citation guardrail (`guardrails/citations.ts`). A research shortfall
//    never fails the run: the researcher falls back to established training
//    principles and the brief's `basis` says so (`web_partial`,
//    `model_knowledge`).
// 4. Emits `research.query`, one `research.source` per verified source and
//    `research.brief`, then returns `{ brief }`: a `VerifiedEvidenceBrief`.
//
// `stage.started` / `stage.completed` come from the graph hooks.
// =============================================================================

export const ROLE_UNAVAILABLE_MESSAGE =
  'The research agent needs an OpenAI model with web search; choose one in your agent settings.';

export const RESEARCH_CONTEXT_MISSING = 'TRAINING_RESEARCH_CONTEXT_MISSING';

function assertResearcherModel(ctx: NodeContext): void {
  const model = ctx.roleModels.researcher;

  if (!model) {
    throw new TrainingRunFailedError(TRAINING_REASONS.ROLE_UNAVAILABLE, ROLE_UNAVAILABLE_MESSAGE, {
      role: 'researcher',
      state: 'not_frozen',
    });
  }

  if (!RESEARCHER_PROVIDERS.includes(model.provider)) {
    throw new TrainingRunFailedError(TRAINING_REASONS.ROLE_UNAVAILABLE, ROLE_UNAVAILABLE_MESSAGE, {
      role: 'researcher',
      state: 'missing_capability',
    });
  }
}

/** The researcher's input from the context builder's output, validated. */
export function researcherContextOf(state: RunState): ResearcherContext {
  const context = state.context as { researcher?: unknown } | null;
  const parsed = researcherContextSchema.safeParse(context?.researcher);

  if (!parsed.success) {
    throw new TrainingRunFailedError(RESEARCH_CONTEXT_MISSING, 'The research agent received no usable context.', {
      role: 'researcher',
    });
  }

  return parsed.data;
}

export const runResearch: NodeFn = async (state, ctx) => {
  assertResearcherModel(ctx);
  const context = researcherContextOf(state);

  const { brief } = await runResearcher(ctx, context);

  await ctx.emit('research.query', { queries: brief.searchQueries });
  for (const source of brief.sources) {
    await ctx.emit('research.source', {
      id: source.id,
      url: source.url,
      title: source.title,
      domain: source.domain,
      kind: source.kind,
      verified: source.verified,
    });
  }
  await ctx.emit('research.brief', {
    claimCount: brief.claims.length,
    sourceCount: brief.sources.length,
    droppedClaims: brief.droppedClaims,
    droppedSources: brief.droppedSources,
    researchMode: brief.researchMode,
    basis: evidenceBasisOf(brief),
  });

  return { brief };
};

/** Researches the evidence for the goal (the researcher agent). */
export const researchNode: GraphNode = { name: 'research', run: runResearch, implemented: true };
