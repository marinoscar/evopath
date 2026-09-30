import { AiError } from '../../../ai/core/ai-error';
import { compactPlan } from '../../context/build-planner-context';
import type { TrainingRunContext } from '../../context/planner-context.contract';
import type { NodeContext } from '../../graph/node-context';
import { sanitizeModelText } from '../../guardrails/citations';
import type { GuardrailContext } from '../../guardrails/types';
import type { GuardrailNodeOutput } from '../../nodes/guardrails.node';
import { AgentOutputTruncated } from '../../runtime/agent-caller';
import { plannerEvidence } from '../planner/planner.prompt';
import type { VerifiedEvidenceBrief } from '../researcher/evidence-brief.contract';
import {
  CRITIC_VERDICT_SCHEMA_NAME,
  CRITIC_LIMITS,
  criticVerdictSchema,
  type CriticVerdict,
} from './critic-verdict.contract';
import {
  CRITIC_INSTRUCTIONS,
  CRITIC_INVALID_NUDGE,
  CRITIC_INVESTIGATE_NUDGE,
  CRITIC_NOTES_CHARS,
  CRITIC_VERDICT_NUDGE,
  type CriticReviewInput,
  renderCriticInput,
} from './critic.prompt';
import {
  CRITIC_MAX_STEPS,
  CRITIC_TOOL_TIMEOUT_MS,
  criticTools,
  durationTable,
  patternTable,
  weeklyVolumeTable,
} from './critic-tools';

// =============================================================================
// The critic agent: investigate with tools, then a structured verdict
// =============================================================================
//
// Two passes through `ctx.agent` (frozen model, effort, budget, kill switch):
//
//   1. `withTools`: the read-only tools of `critic-tools.ts`, bound to this
//      run's repaired tree, at most 4 round-trips, 5 s per tool. The model
//      answers with short notes. A cut-off answer here is not fatal: the
//      verdict pass runs without notes.
//   2. `structured`: the `CriticVerdict`, with the notes as data. A cut-off
//      or schema-invalid answer is retried ONCE; the second failure
//      propagates (the node decides whether the run can ship unreviewed).
//
// The verdict is sanitised before it enters the state (no URL, no markup,
// length-capped): it is shown to the user and fed back to the planner.
// =============================================================================

export const CRITIQUE_NODE = 'critique';

/** Output tokens for the investigation notes and for the verdict. */
export const CRITIC_INVESTIGATE_MAX_OUTPUT_TOKENS = 4_000;
export const CRITIC_VERDICT_MAX_OUTPUT_TOKENS = 8_000;

/** What the critic reviews, from the guardrails' output and the run context. Nothing else reaches it. */
export function buildCriticReview(
  output: GuardrailNodeOutput,
  context: TrainingRunContext,
  gctx: GuardrailContext,
  brief: VerifiedEvidenceBrief | null,
): CriticReviewInput {
  const binding = { tree: output.tree, ctx: gctx };
  const planner = context.planner;

  return {
    plan: {
      title: output.header.title,
      summary: output.header.summary,
      rationale: output.header.rationale,
      assumptions: output.header.assumptions,
      safetyNotes: output.header.safetyNotes,
      ...compactPlan(output.tree, gctx.library),
    },
    tables: {
      weeklyHardSetsPerMuscle: weeklyVolumeTable(binding),
      estimatedMinutesPerWorkout: durationTable(binding),
      exercisesPerPattern: patternTable(binding),
    },
    report: {
      status: output.report.status,
      counts: output.report.counts,
      findings: output.report.violations.map((v) => ({ rule: v.rule, severity: v.severity, path: v.path, message: v.message })),
    },
    person: {
      goal: planner.goal,
      experience: planner.experience,
      daysPerWeek: planner.daysPerWeek,
      preferredWeekdays: planner.preferredWeekdays,
      minutesPerSession: planner.minutesPerSession,
      durationWeeks: planner.durationWeeks,
      limitations: planner.limitations,
      avoidExerciseKeys: planner.avoidExerciseKeys,
      conservative: planner.conservative,
      painFlagExerciseKeys: [...gctx.painFlagKeys].sort(),
      readiness: planner.readiness ?? null,
      equipment: { hasGym: planner.equipment.hasGym, equipmentClass: planner.equipment.equipmentClass, bodyweightOnly: !planner.equipment.hasGym },
      ...(planner.request.kind === 'revise' ? { revisionRequest: planner.request.instruction } : {}),
    },
    evidence: plannerEvidence(brief),
  };
}

/** The verdict made safe to store, show and feed back: no URL, no markup, capped. */
export function sanitizeVerdict(verdict: CriticVerdict): CriticVerdict {
  const L = CRITIC_LIMITS;
  const clean = (text: string, max: number) => sanitizeModelText(text, max);
  return {
    verdict: verdict.verdict,
    scores: { ...verdict.scores },
    blockers: verdict.blockers.map((b) => ({
      dimension: b.dimension,
      path: clean(b.path, L.pathChars),
      issue: clean(b.issue, L.issueChars),
      fix: clean(b.fix, L.fixChars),
    })),
    suggestions: verdict.suggestions.map((s) => ({ dimension: s.dimension, issue: clean(s.issue, L.issueChars), fix: clean(s.fix, L.fixChars) })),
    summary: clean(verdict.summary, L.summaryChars),
  };
}

export function isInvalidStructuredOutput(err: unknown): boolean {
  return err instanceof AiError && err.code === 'AI_STRUCTURED_OUTPUT_INVALID';
}

export interface CriticOutcome {
  verdict: CriticVerdict;
  /** Tool calls the investigation made. */
  toolCalls: number;
  /** Verdict attempts (1 or 2). */
  attempts: number;
}

/** Runs the critic's two passes and returns a sanitised verdict, or throws after one retry. */
export async function runCritic(
  ctx: NodeContext,
  input: { review: CriticReviewInput; tree: GuardrailNodeOutput['tree']; gctx: GuardrailContext; round: number },
): Promise<CriticOutcome> {
  let notes = '';
  let toolCalls = 0;

  try {
    const investigation = await ctx.agent.withTools({
      role: 'critic',
      node: CRITIQUE_NODE,
      round: input.round,
      instructions: CRITIC_INSTRUCTIONS,
      input: renderCriticInput({ review: input.review, nudge: CRITIC_INVESTIGATE_NUDGE }),
      tools: criticTools({ tree: input.tree, ctx: input.gctx }),
      maxSteps: CRITIC_MAX_STEPS,
      toolTimeoutMs: CRITIC_TOOL_TIMEOUT_MS,
      maxOutputTokens: CRITIC_INVESTIGATE_MAX_OUTPUT_TOKENS,
    });
    toolCalls = investigation.steps.reduce((sum, step) => sum + step.calls.length, 0);
    notes = sanitizeModelText(investigation.final.outputText ?? '', CRITIC_NOTES_CHARS);
  } catch (err) {
    // Notes are optional: a cut-off investigation still gets a verdict pass.
    if (!(err instanceof AgentOutputTruncated)) throw err;
  }

  let nudge = CRITIC_VERDICT_NUDGE;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { parsed } = await ctx.agent.structured({
        role: 'critic',
        node: CRITIQUE_NODE,
        round: input.round,
        schema: criticVerdictSchema,
        schemaName: CRITIC_VERDICT_SCHEMA_NAME,
        instructions: CRITIC_INSTRUCTIONS,
        input: renderCriticInput({ review: input.review, notes: notes || undefined, nudge }),
        maxOutputTokens: CRITIC_VERDICT_MAX_OUTPUT_TOKENS,
      });
      return { verdict: sanitizeVerdict(parsed), toolCalls, attempts: attempt };
    } catch (err) {
      if (attempt >= 2) throw err;
      if (err instanceof AgentOutputTruncated || isInvalidStructuredOutput(err)) nudge = `${CRITIC_INVALID_NUDGE} ${CRITIC_VERDICT_NUDGE}`;
      else throw err;
    }
  }
}
