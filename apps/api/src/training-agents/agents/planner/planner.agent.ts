import { AiError } from '../../../ai/core/ai-error';
import type { PlannerContext } from '../../context/planner-context.contract';
import type { NodeContext } from '../../graph/node-context';
import { AgentOutputTruncated } from '../../runtime/agent-caller';
import {
  CONTEXT_REDUCTION_TARGETS,
  type ContextFitResult,
  type ContextSection,
  keepFirst,
} from '../../runtime/context-budget';
import type { VerifiedEvidenceBrief } from '../researcher/evidence-brief.contract';
import { PLAN_DRAFT_SCHEMA_NAME, planDraftSchema, type PlanDraft } from './plan-draft.contract';
import {
  PLANNER_INSTRUCTIONS,
  PLANNER_INVALID_NUDGE,
  PLANNER_TRUNCATION_NUDGE,
  type PlannerReview,
  plannerEvidence,
  renderPlannerInput,
} from './planner.prompt';

// =============================================================================
// The planner agent: one structured call, one retry
// =============================================================================
//
// Every call goes through `ctx.agent` (frozen model, effort, budget, kill
// switch, capability checks). The planner context is fitted to the model's
// window by `ctx.contextBudget` (reductions, then optional sections dropped,
// last first: bio, body metrics, profile, readiness, history); what was
// dropped is returned so the "what was sent" record can say so.
//
// A cut-off answer (`AgentOutputTruncated`) or an answer that does not match
// the schema (`AI_STRUCTURED_OUTPUT_INVALID`) is retried ONCE with a fixed
// nudge; the second failure propagates (the run fails with that code).
// =============================================================================

export const PLAN_NODE = 'plan';

/** Output tokens the planner may use (the caller clamps to the model and the budget). */
export const PLANNER_MAX_OUTPUT_TOKENS = 32_000;

/** Used when the frozen model does not declare its window. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

export interface PlannerInput {
  context: PlannerContext;
  brief: VerifiedEvidenceBrief | null;
  review: PlannerReview | null;
  /** The draft number (1 first, +1 per revision). */
  round: number;
}

export interface PlannerOutcome {
  draft: PlanDraft;
  attempts: number;
  /** Section ids the context budget dropped. */
  droppedContext: string[];
}

type SectionContent = Record<string, unknown>;

/** The planner context and evidence as budget sections: required first, droppable last (dropped last-first). */
export function plannerSections(context: PlannerContext, brief: VerifiedEvidenceBrief | null): ContextSection<SectionContent>[] {
  const {
    candidateExercises,
    currentPlan,
    history,
    readiness,
    profile,
    bodyMetrics,
    bio,
    ...core
  } = context;
  const sections: ContextSection<SectionContent>[] = [
    { id: 'core', required: true, content: core },
    {
      id: 'candidateExercises',
      required: true,
      content: { candidateExercises },
      reductions: {
        candidate_exercises: (c) => ({ candidateExercises: keepFirst(CONTEXT_REDUCTION_TARGETS.candidateExercises)(c.candidateExercises as unknown[]) }),
      },
    },
    {
      id: 'evidence',
      required: true,
      content: { evidence: plannerEvidence(brief) },
      reductions: { evidence_items: () => ({ evidence: plannerEvidence(brief, CONTEXT_REDUCTION_TARGETS.evidenceItems) }) },
    },
  ];
  if (currentPlan) sections.push({ id: 'currentPlan', required: true, content: { currentPlan } });
  if (history) {
    sections.push({
      id: 'history',
      required: false,
      content: { history },
      reductions: {
        history_rows: (c) => {
          const h = c.history as NonNullable<PlannerContext['history']>;
          return { history: { ...h, exercises: h.exercises.filter((row) => row.sessionsAgo <= CONTEXT_REDUCTION_TARGETS.historyRowsPerExercise) } };
        },
        older_sessions: (c) => {
          const h = c.history as NonNullable<PlannerContext['history']>;
          return { history: { ...h, sessionsPerWeek: [h.sessionsPerWeek.reduce((a, b) => a + b, 0)] } };
        },
      },
    });
  }
  if (readiness) sections.push({ id: 'readiness', required: false, content: { readiness } });
  if (profile) {
    sections.push({
      id: 'profile',
      required: false,
      content: { profile },
      reductions: {
        optional_profile: (c) => {
          const p = c.profile as NonNullable<PlannerContext['profile']>;
          return { profile: { ageYears: p.ageYears, sexAtBirth: p.sexAtBirth, heightCm: null, unitPreference: p.unitPreference } };
        },
      },
    });
  }
  if (bodyMetrics) {
    sections.push({
      id: 'bodyMetrics',
      required: false,
      content: { bodyMetrics },
      reductions: {
        optional_profile: (c) => {
          const b = c.bodyMetrics as NonNullable<PlannerContext['bodyMetrics']>;
          return { bodyMetrics: { weightKg: b.weightKg, bodyFatPercent: null, weightTrend: null } };
        },
      },
    });
  }
  if (bio) sections.push({ id: 'bio', required: false, content: { bio } });
  return sections;
}

/** Fits the planner context to the model and returns what is sent plus what was dropped. */
export function fitPlannerContext(
  ctx: Pick<NodeContext, 'contextBudget' | 'roleModels'>,
  context: PlannerContext,
  brief: VerifiedEvidenceBrief | null,
): { context: Record<string, unknown>; evidence: ReturnType<typeof plannerEvidence>; fit: ContextFitResult<SectionContent> } {
  const model = ctx.roleModels.planner;
  const fit = ctx.contextBudget.fit(plannerSections(context, brief), {
    contextWindow: model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    reserveOutput: Math.min(PLANNER_MAX_OUTPUT_TOKENS, model?.maxOutputTokens ?? PLANNER_MAX_OUTPUT_TOKENS),
  });

  let sent: Record<string, unknown> = {};
  let evidence = plannerEvidence(brief);
  for (const section of fit.sections) {
    if (section.id === 'evidence') evidence = section.content.evidence as ReturnType<typeof plannerEvidence>;
    else sent = { ...sent, ...section.content };
  }
  return { context: sent, evidence, fit };
}

function isInvalidStructuredOutput(err: unknown): boolean {
  return err instanceof AiError && err.code === 'AI_STRUCTURED_OUTPUT_INVALID';
}

/** Runs the planner and returns a schema-valid draft, or throws after one retry. */
export async function runPlanner(ctx: NodeContext, input: PlannerInput): Promise<PlannerOutcome> {
  const fitted = fitPlannerContext(ctx, input.context, input.brief);
  let nudge: string | undefined;

  for (let attempt = 1; ; attempt += 1) {
    try {
      const { parsed } = await ctx.agent.structured({
        role: 'planner',
        node: PLAN_NODE,
        round: input.round,
        schema: planDraftSchema,
        schemaName: PLAN_DRAFT_SCHEMA_NAME,
        instructions: PLANNER_INSTRUCTIONS,
        input: renderPlannerInput({ context: fitted.context, evidence: fitted.evidence, review: input.review, nudge }),
        maxOutputTokens: PLANNER_MAX_OUTPUT_TOKENS,
      });
      return { draft: parsed, attempts: attempt, droppedContext: fitted.fit.dropped };
    } catch (err) {
      if (attempt >= 2) throw err;
      if (err instanceof AgentOutputTruncated) nudge = PLANNER_TRUNCATION_NUDGE;
      else if (isInvalidStructuredOutput(err)) nudge = PLANNER_INVALID_NUDGE;
      else throw err;
    }
  }
}
