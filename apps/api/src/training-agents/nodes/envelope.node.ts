import '../evaluation/adaptation.events';

import { evaluateContextOf } from '../evaluation/evaluate-context';
import {
  BUDGET_NOTE,
  type ChangeSet,
  DEFAULT_ADAPTED_SUMMARY,
  DEFAULT_REVIEW_SUMMARY,
  EVALUATION_STATE_VERSION,
  composeRationale,
  composeSummary,
  evaluationStateOf,
} from '../evaluation/evaluate-state';
import { citationsForClaims } from '../finalize/plan-evidence';
import type { GraphNode, NodeContext, NodeFn } from '../graph/node-context';
import { type EnvelopeFinding, type EnvelopeResult, applyEnvelope } from '../guardrails/envelope';
import { FORCED_REMOVAL_SUMMARY } from '../guardrails/safety-stop';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import { EVALUATION_PORT_MISSING, EVALUATION_PROGRAM_MISSING } from './load-signals.node';

// =============================================================================
// Node `envelope`: guardrail G10 over the evaluator's operations
// =============================================================================
//
// Reads the adaptation facts fresh (tree, guardrail context, brief) and runs
// `applyEnvelope` over the evaluator's changes (none when it decided
// `no_change` or was skipped) together with the forced safety removals the
// gate prepared. The result becomes `state.changeSet`: the accepted
// operations with their row targets, every clamp and drop with its rule,
// the change log summary (the sanitised message plus server notes) and
// rationale (assessment, follow-up and what the server changed), and the
// citations of the claim ids the evaluator cited that the run sent.
// =============================================================================

async function emitEnvelope(ctx: NodeContext, changeSet: ChangeSet): Promise<void> {
  const rules = [...new Set([...changeSet.clamped, ...changeSet.dropped].map((f) => f.rule))].slice(0, 40);
  await ctx.emit('adaptation.envelope', {
    accepted: changeSet.accepted.length,
    forced: changeSet.accepted.filter((op) => op.forced).length,
    clamped: changeSet.clamped.length,
    dropped: changeSet.dropped.length,
    rules,
  });
}

export const runEnvelope: NodeFn = async (state, ctx) => {
  const context = evaluateContextOf(state);
  const port = ctx.ports?.evaluation;
  if (!context || !port) {
    throw new TrainingRunFailedError(EVALUATION_PORT_MISSING, 'The training context is missing.');
  }
  const evaluation = evaluationStateOf(state);
  const result = evaluation?.result ?? null;
  const ops = result && result.decision === 'adjust' ? result.changes : [];
  const forced = context.safety?.forced ?? [];

  let envelope: EnvelopeResult = { accepted: [], clamped: [], dropped: [], notes: [] };
  let citations: Array<Record<string, unknown>> = [];

  if (ops.length > 0 || forced.length > 0) {
    const facts = await port.loadAdaptationFacts(ctx.userId, context.server.programId, ctx.now());
    if (!facts) throw new TrainingRunFailedError(EVALUATION_PROGRAM_MISSING, 'The plan to evaluate no longer exists.');
    envelope = applyEnvelope(ops, {
      context,
      tree: facts.tree,
      guardrails: facts.guardrails,
      assessment: result?.assessment.status ?? 'insufficient_data',
      now: ctx.now(),
    });
    citations = citationsForClaims(facts.brief, result?.evidenceRefs ?? []);
  }

  const invented: EnvelopeFinding[] = (evaluation?.inventedClaimIds ?? []).length
    ? [{ index: -1, op: null, rule: 'REF', code: 'invented_claim', message: 'A cited source that is not in the research brief was left out.' }]
    : [];
  const modelAccepted = envelope.accepted.filter((op) => !op.forced).length;
  const forcedOnly = envelope.accepted.length > 0 && modelAccepted === 0;
  const notes = [...envelope.notes, ...(evaluation?.skipped === 'budget' ? [BUDGET_NOTE] : [])];
  const message = forcedOnly ? FORCED_REMOVAL_SUMMARY : (result?.userMessage ?? '');

  const changeSet: ChangeSet = {
    version: EVALUATION_STATE_VERSION,
    accepted: envelope.accepted,
    clamped: [...envelope.clamped, ...invented],
    dropped: envelope.dropped,
    critique: null,
    decision: null,
    summary: composeSummary(message, notes, envelope.accepted.length > 0 ? DEFAULT_ADAPTED_SUMMARY : DEFAULT_REVIEW_SUMMARY),
    rationale: composeRationale({
      assessment: result?.assessment.summary ?? (evaluation?.skipped === 'budget' ? BUDGET_NOTE : ''),
      followUp: result?.followUp.note ?? null,
      findings: [...envelope.clamped, ...invented, ...envelope.dropped],
    }),
    citations,
    basedOnVersion: context.server.planVersion,
    proposal: null,
    applied: null,
    result: null,
  };

  await emitEnvelope(ctx, changeSet);
  return { changeSet };
};

/** Clamps or drops the proposed changes to the adaptation envelope (G10). */
export const envelopeNode: GraphNode = { name: 'envelope', run: runEnvelope, implemented: true };
