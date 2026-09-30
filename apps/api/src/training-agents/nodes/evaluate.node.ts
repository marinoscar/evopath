import '../evaluation/adaptation.events';

import type { EvaluationResult } from '../agents/evaluator/evaluation-result.contract';
import { runEvaluator, sanitizeEvaluation } from '../agents/evaluator/evaluator.agent';
import type { LibraryExercise } from '../context/planner-context.contract';
import { supportedBy } from '../context/build-planner-context';
import { type EvaluateRunContext, evaluateContextOf } from '../evaluation/evaluate-context';
import { EVALUATION_STATE_VERSION, type EvaluationState, THIN_DATA_SUMMARY } from '../evaluation/evaluate-state';
import type { GraphNode, NodeContext, NodeFn } from '../graph/node-context';
import type { GuardrailContext } from '../guardrails/types';
import { RunBudgetExceededError } from '../runtime/run-budget';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import { TRAINING_REASONS } from '../runtime/training-runs.constants';
import { EVALUATION_PORT_MISSING, EVALUATION_PROGRAM_MISSING } from './load-signals.node';

// =============================================================================
// Node `evaluate`: the evaluator agent, one pass
// =============================================================================
//
// Reads `state.context.sent` (what `load_signals` and `safety_gate` built)
// and adds the ALTERNATIVES: exercise keys the plan's gym supports that are
// neither avoided nor pain-flagged nor already in the plan (at most 40,
// related movement patterns first), so a swap or an add names only keys the
// server can check. Then `runEvaluator` (one structured call, one retry) and
// `sanitizeEvaluation` (text capped, invented claim ids dropped).
//
// No model call at all when no session was completed yet: the result is a
// server-authored `insufficient_data` / `no_change` (`skipped: thin_data`).
// A token budget that runs out ends the review as `no_change` with a budget
// note (`skipped: budget`); a partial change is never applied. Two
// malformed answers fail the run with the platform code; the plan is
// untouched.
// =============================================================================

export const MAX_ALTERNATIVES = 40;

/** Completed or partly completed sessions in the signals. */
export function completedSessions(context: EvaluateRunContext): number {
  return context.sent.signals.sessions.filter((s) => s.status === 'done' || s.status === 'partial').length;
}

/** Gym-supported keys outside the plan, minus the avoid list and pain flags; related patterns first. */
export function alternativesOf(context: EvaluateRunContext, g: GuardrailContext): string[] {
  const inPlan = new Set(Object.values(context.server.refs).flatMap((ref) => (ref.exerciseKey ? [ref.exerciseKey] : [])));
  const patterns = new Set(
    [...inPlan].flatMap((key) => {
      const lib = g.libraryByKey.get(key);
      return lib ? [lib.movementPattern] : [];
    }),
  );
  const pain = new Set([...g.painFlagKeys, ...context.server.pain.map((row) => row.key)]);
  const rank = (lib: LibraryExercise) => (patterns.has(lib.movementPattern) ? 0 : 1);

  return [...g.library.values()]
    .filter((lib) => !inPlan.has(lib.key) && !g.avoidExerciseKeys.has(lib.key) && !pain.has(lib.key) && supportedBy(lib, g.gym))
    .sort((a, b) => rank(a) - rank(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, MAX_ALTERNATIVES)
    .map((lib) => lib.key);
}

function thinDataResult(): EvaluationResult {
  return {
    assessment: { status: 'insufficient_data', summary: THIN_DATA_SUMMARY, observations: [] },
    decision: 'no_change',
    changes: [],
    userMessage: THIN_DATA_SUMMARY,
    followUp: { suggestReview: false, note: null },
    confidence: 'low',
    evidenceRefs: [],
  };
}

export function isBudgetStop(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof RunBudgetExceededError) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function emitAssessed(ctx: NodeContext, evaluation: EvaluationState): Promise<void> {
  const result = evaluation.result;
  await ctx.emit('evaluation.assessed', {
    status: result?.assessment.status ?? 'insufficient_data',
    decision: result?.decision ?? 'no_change',
    changes: result?.changes.length ?? 0,
    confidence: result?.confidence ?? 'low',
    attempts: evaluation.attempts,
    skipped: evaluation.skipped,
  });
}

export const runEvaluate: NodeFn = async (state, ctx) => {
  const context = evaluateContextOf(state);
  const port = ctx.ports?.evaluation;
  if (!context || !port) {
    throw new TrainingRunFailedError(EVALUATION_PORT_MISSING, 'The training context is missing.');
  }
  if (!ctx.roleModels.evaluator) {
    throw new TrainingRunFailedError(TRAINING_REASONS.ROLE_UNAVAILABLE, 'The evaluator agent has no model for this run.', { role: 'evaluator' });
  }

  if (completedSessions(context) === 0) {
    const evaluation: EvaluationState = {
      version: EVALUATION_STATE_VERSION,
      result: thinDataResult(),
      skipped: 'thin_data',
      alternatives: [],
      attempts: 0,
      inventedClaimIds: [],
    };
    await emitAssessed(ctx, evaluation);
    return { evaluation };
  }

  const facts = await port.loadAdaptationFacts(ctx.userId, context.server.programId, ctx.now());
  if (!facts) throw new TrainingRunFailedError(EVALUATION_PROGRAM_MISSING, 'The plan to evaluate no longer exists.');
  const alternatives = alternativesOf(context, facts.guardrails);

  let evaluation: EvaluationState;
  try {
    const { result, attempts } = await runEvaluator(ctx, { input: context.sent, alternatives });
    const sanitized = sanitizeEvaluation(result, new Set(context.sent.evidence.map((claim) => claim.id)));
    evaluation = {
      version: EVALUATION_STATE_VERSION,
      result: sanitized.result,
      skipped: null,
      alternatives,
      attempts,
      inventedClaimIds: sanitized.inventedClaimIds,
    };
  } catch (err) {
    if (!isBudgetStop(err)) throw err;
    evaluation = { version: EVALUATION_STATE_VERSION, result: null, skipped: 'budget', alternatives, attempts: 0, inventedClaimIds: [] };
  }

  await emitAssessed(ctx, evaluation);
  return { evaluation };
};

/** Assesses progress and proposes typed changes (the evaluator agent). */
export const evaluateNode: GraphNode = { name: 'evaluate', run: runEvaluate, implemented: true };
