import '../evaluation/adaptation.events';

import {
  ADAPTATION_CRITIC_INSTRUCTIONS,
  ADAPTATION_VERDICT_SCHEMA_NAME,
  type AdaptationVerdict,
  adaptationVerdictSchema,
  renderAdaptationInput,
} from '../agents/critic/critic-adaptation.prompt';
import { isInvalidStructuredOutput } from '../agents/critic/critic.agent';
import { evaluateContextOf } from '../evaluation/evaluate-context';
import {
  type ChangeSet,
  DEFAULT_REVIEW_SUMMARY,
  changeSetOf,
  composeRationale,
  composeSummary,
  evaluationStateOf,
} from '../evaluation/evaluate-state';
import { FORCED_REMOVAL_SUMMARY } from '../guardrails/safety-stop';
import type { GraphNode, NodeFn } from '../graph/node-context';
import { STRUCTURAL_OPERATIONS, TRAINING_RUN_WARNINGS } from '../graph/routes';
import type { EnvelopeFinding } from '../guardrails/envelope';
import { AgentOutputTruncated } from '../runtime/agent-caller';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import { isBudgetStop } from './evaluate.node';
import { EVALUATION_PORT_MISSING } from './load-signals.node';

// =============================================================================
// Node `critique_light`: the E5.5 critic in adaptation mode
// =============================================================================
//
// Runs (per `routeAfterEnvelope`) only when the accepted operations include a
// structural one. Reviews the model's STRUCTURAL operations only (forced
// safety removals are never reviewed and never dropped): each as a numbered,
// server-authored line (`op1` ...), with the person's limited profile, the
// pain, readiness and adherence signals, the assessment and the evidence.
// A blocker whose `path` names `opN` drops that operation (recorded as
// `CRITIC`). One structured call, one retry on a malformed answer; there is
// no second evaluator pass.
//
// Skipped, keeping the envelope's result, when the run froze no critic
// model, the budget ran out, or the critic could not answer twice (a
// warning records it): every operation already passed the envelope.
// =============================================================================

export const CRITIQUE_LIGHT_NODE = 'critique_light';
export const ADAPTATION_CRITIC_MAX_OUTPUT_TOKENS = 3_000;

async function callCritic(ctx: Parameters<NodeFn>[1], input: string): Promise<AdaptationVerdict> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { parsed } = await ctx.agent.structured({
        role: 'critic',
        node: CRITIQUE_LIGHT_NODE,
        schema: adaptationVerdictSchema,
        schemaName: ADAPTATION_VERDICT_SCHEMA_NAME,
        instructions: ADAPTATION_CRITIC_INSTRUCTIONS,
        input,
        maxOutputTokens: ADAPTATION_CRITIC_MAX_OUTPUT_TOKENS,
      });
      return parsed;
    } catch (err) {
      if (attempt >= 2 || !(err instanceof AgentOutputTruncated || isInvalidStructuredOutput(err))) throw err;
    }
  }
}

export const runCritiqueLight: NodeFn = async (state, ctx) => {
  const context = evaluateContextOf(state);
  const changeSet = changeSetOf(state);
  if (!context || !changeSet) {
    throw new TrainingRunFailedError(EVALUATION_PORT_MISSING, 'The training context is missing.');
  }

  const reviewed = changeSet.accepted.filter((op) => !op.forced && STRUCTURAL_OPERATIONS.includes(op.op));
  const skip = async (skipped: 'budget' | 'unavailable' | 'no_model' | null, warn: string | null) => {
    await ctx.emit('adaptation.critique', { verdict: 'skipped', blockers: 0, dropped: 0 });
    const next: ChangeSet = { ...changeSet, critique: { verdict: 'skipped', skipped, blockers: 0 } };
    return { changeSet: next, ...(warn ? { warnings: [warn] } : {}) };
  };
  if (reviewed.length === 0) return skip(null, null);
  if (!ctx.roleModels.critic) return skip('no_model', TRAINING_RUN_WARNINGS.UNAVAILABLE);

  const labels = new Map(reviewed.map((op, i) => [`op${i + 1}`, op]));
  const result = evaluationStateOf(state)?.result;
  const input = renderAdaptationInput(
    {
      changes: [...labels.entries()].map(([label, op]) => ({ label, op: op.op, description: op.description })),
      person: {
        goal: context.sent.profile.goal,
        experience: context.sent.profile.experience,
        limitations: context.sent.profile.limitations,
        avoidExerciseKeys: context.sent.profile.avoidExerciseKeys,
        conservative: context.sent.profile.conservative,
      },
      signals: { pain: context.sent.signals.pain, readiness: context.sent.signals.readiness, adherence: context.sent.signals.adherence },
      assessment: { status: result?.assessment.status ?? 'insufficient_data', summary: result?.assessment.summary ?? '' },
    },
    { claims: context.sent.evidence },
  );

  let verdict: AdaptationVerdict;
  try {
    verdict = await callCritic(ctx, input);
  } catch (err) {
    if (isBudgetStop(err)) return skip('budget', TRAINING_RUN_WARNINGS.SKIPPED_BUDGET);
    if (err instanceof AgentOutputTruncated || isInvalidStructuredOutput(err)) return skip('unavailable', TRAINING_RUN_WARNINGS.UNAVAILABLE);
    throw err;
  }

  const blocked = new Set(
    verdict.blockers.flatMap((b) => {
      const label = /op(\d+)/i.exec(b.path)?.[0]?.toLowerCase();
      return label && labels.has(label) ? [labels.get(label)!] : [];
    }),
  );
  const drops: EnvelopeFinding[] = [...blocked].map((op) => ({
    index: -1,
    op: op.op,
    rule: 'CRITIC',
    code: 'critic_blocked',
    message: `The coach's reviewer held back one change: ${op.description}`,
  }));
  const accepted = changeSet.accepted.filter((op) => !blocked.has(op));
  const dropped = [...changeSet.dropped, ...drops];

  await ctx.emit('adaptation.critique', { verdict: verdict.verdict, blockers: verdict.blockers.length, dropped: drops.length });

  // Every model change held back: the message no longer describes what lands.
  const nothingLeft = drops.length > 0 && accepted.every((op) => op.forced);
  const next: ChangeSet = {
    ...changeSet,
    accepted,
    dropped,
    summary: nothingLeft
      ? composeSummary(accepted.length ? FORCED_REMOVAL_SUMMARY : DEFAULT_REVIEW_SUMMARY, [], DEFAULT_REVIEW_SUMMARY)
      : changeSet.summary,
    critique: { verdict: verdict.verdict, skipped: null, blockers: verdict.blockers.length },
    rationale: drops.length
      ? composeRationale({
          assessment: result?.assessment.summary ?? '',
          followUp: result?.followUp.note ?? null,
          findings: [...changeSet.clamped, ...dropped],
        })
      : changeSet.rationale,
  };
  return { changeSet: next };
};

/** The critic's light review of structural adaptations; its blockers drop operations. */
export const critiqueLightNode: GraphNode = { name: 'critique_light', run: runCritiqueLight, implemented: true };
