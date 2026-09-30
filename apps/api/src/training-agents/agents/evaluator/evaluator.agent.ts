import type { NodeContext } from '../../graph/node-context';
import type { EvaluatorInput } from '../../evaluation/evaluate-context';
import { sanitizeModelText } from '../../guardrails/citations';
import { AgentOutputTruncated } from '../../runtime/agent-caller';
import { isInvalidStructuredOutput } from '../critic/critic.agent';
import {
  EVALUATION_LIMITS,
  EVALUATION_RESULT_SCHEMA_NAME,
  type EvaluationResult,
  evaluationResultSchema,
} from './evaluation-result.contract';
import { EVALUATOR_INSTRUCTIONS, EVALUATOR_INVALID_NUDGE, renderEvaluatorInput } from './evaluator.prompt';

// =============================================================================
// The evaluator agent: one structured pass through `ctx.agent`
// =============================================================================
//
// The frozen evaluator model, effort, token budget and kill switch all apply
// (`AgentCaller`). A cut-off or schema-invalid answer is retried ONCE with a
// fixed nudge; the second failure propagates and the run fails with the
// platform code, leaving the plan untouched.
//
// The result is sanitised before it enters the state (`sanitizeEvaluation`):
// no URL, no markup, length-capped, and only claim ids the run was given.
// The operations are bounded later by the envelope, never here.
// =============================================================================

export const EVALUATE_NODE = 'evaluate';

/** Output tokens for the evaluation. */
export const EVALUATOR_MAX_OUTPUT_TOKENS = 6_000;

export interface EvaluatorOutcome {
  result: EvaluationResult;
  /** Attempts (1 or 2). */
  attempts: number;
}

/** Runs the evaluator and returns its raw (schema-valid) result, or throws after one retry. */
export async function runEvaluator(
  ctx: NodeContext,
  args: { input: EvaluatorInput; alternatives: string[] },
): Promise<EvaluatorOutcome> {
  let nudge: string | undefined;

  for (let attempt = 1; ; attempt += 1) {
    try {
      const { parsed } = await ctx.agent.structured({
        role: 'evaluator',
        node: EVALUATE_NODE,
        schema: evaluationResultSchema,
        schemaName: EVALUATION_RESULT_SCHEMA_NAME,
        instructions: EVALUATOR_INSTRUCTIONS,
        input: renderEvaluatorInput({ input: args.input, alternatives: args.alternatives, nudge }),
        maxOutputTokens: EVALUATOR_MAX_OUTPUT_TOKENS,
      });
      return { result: parsed, attempts: attempt };
    } catch (err) {
      if (attempt >= 2) throw err;
      if (err instanceof AgentOutputTruncated || isInvalidStructuredOutput(err)) nudge = EVALUATOR_INVALID_NUDGE;
      else throw err;
    }
  }
}

/**
 * The result made safe to store and show: text sanitised and capped, a
 * `no_change` decision carries no changes, and `evidenceRefs` keeps only
 * the claim ids the run sent (the rest are returned as `inventedClaimIds`).
 */
export function sanitizeEvaluation(
  result: EvaluationResult,
  claimIds: ReadonlySet<string>,
): { result: EvaluationResult; inventedClaimIds: string[] } {
  const L = EVALUATION_LIMITS;
  const clean = (text: string, max: number) => sanitizeModelText(text, max);
  const refs = [...new Set(result.evidenceRefs)];
  const kept = refs.filter((id) => claimIds.has(id));

  return {
    result: {
      assessment: {
        status: result.assessment.status,
        summary: clean(result.assessment.summary, L.summaryChars),
        observations: result.assessment.observations.map((o) => ({
          signal: clean(o.signal, L.signalChars),
          text: clean(o.text, L.observationChars),
        })),
      },
      decision: result.decision,
      changes: result.decision === 'no_change' ? [] : result.changes,
      userMessage: clean(result.userMessage, L.userMessageChars),
      followUp: {
        suggestReview: result.followUp.suggestReview,
        note: result.followUp.note === null ? null : clean(result.followUp.note, L.followUpNoteChars) || null,
      },
      confidence: result.confidence,
      evidenceRefs: kept,
    },
    inventedClaimIds: refs.filter((id) => !claimIds.has(id)).map((id) => id.slice(0, L.evidenceRefChars)),
  };
}
