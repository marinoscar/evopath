import '../evaluation/evaluation.events';

import { addDays } from '../../check-ins/local-date';
import {
  type EvaluateRunContext,
  type SafetyGateResult,
  evaluateContextOf,
} from '../evaluation/evaluate-context';
import type { EvaluationPort, GraphNode, NodeContext, NodeFn } from '../graph/node-context';
import {
  PAIN_PATTERN_RATIONALE,
  PAIN_PATTERN_SUMMARY,
  SAFETY_STOP_RULES,
  SAFETY_TEXT_RATIONALE,
  SAFETY_TEXT_SUMMARY,
  forcedSafetyOperations,
  needsRecovery,
  painPattern,
} from '../guardrails/safety-stop';
import { screenFreeText } from '../guardrails/safety-screen';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import { TRAINING_REASONS } from '../runtime/training-runs.constants';
import { EVALUATION_PORT_MISSING } from './load-signals.node';

// =============================================================================
// Node `safety_gate`: the deterministic safety stops, BEFORE any model call
// =============================================================================
//
// (a) Screens the pain notes of the last 14 local days with `screenFreeText`
//     on the server. The notes are read through the port, screened, and
//     dropped: only rule codes reach the state, an event or a log. A blocked
//     screen ends the run (`outcome.status: 'safety_stop'` -> the run is
//     `blocked_safety`) with the plan untouched: a `reviewed` entry with
//     `actor: 'system'` and the fixed guidance, automation paused
//     (`safety_text`), and the mandatory `training.plan_safety_stop`.
// (b) The pain pattern pauses automation (`pain_pattern`) with the same kind
//     of entry and notification (once: not when the plan is already paused).
//     The run continues read-only; the envelope forbids any increase while
//     paused.
// (c) Forced removals of the unlocked future occurrences of an exercise
//     flagged in 2 sessions in a row: put in the profile as "already
//     decided" and in `safety.forced`, applied later in both autonomy modes.
// (d) A low-readiness streak of 5 marks the run `recover`.
//
// RESUME-SAFE: an entry this run already wrote is found by run id and not
// written (or notified) twice. Notifications go out after the write returned,
// outside any transaction.
// =============================================================================

export const SAFETY_STOP_EVENT = 'training.plan_safety_stop';

async function systemReview(
  ctx: NodeContext,
  port: EvaluationPort,
  programId: string,
  reason: 'safety_text' | 'pain_pattern',
): Promise<string> {
  const existing = await port.findRunReview(ctx.userId, ctx.runId, 'system');
  if (existing) return existing.changeLogId;

  const written = await port.recordReview({
    userId: ctx.userId,
    programId,
    actor: 'system',
    summary: reason === 'safety_text' ? SAFETY_TEXT_SUMMARY : PAIN_PATTERN_SUMMARY,
    rationale: reason === 'safety_text' ? SAFETY_TEXT_RATIONALE : PAIN_PATTERN_RATIONALE,
    runId: ctx.runId,
    pause: reason,
  });

  await ctx.ports?.notifications?.notify(SAFETY_STOP_EVENT, ctx.userId, {
    programId,
    reason,
    changeLogId: written.changeLogId,
  });
  return written.changeLogId;
}

export const runSafetyGate: NodeFn = async (state, ctx) => {
  const context = evaluateContextOf(state);
  const port = ctx.ports?.evaluation;
  if (!context || !port) {
    throw new TrainingRunFailedError(EVALUATION_PORT_MISSING, 'The training context is missing.');
  }

  const { server } = context;
  const from = addDays(server.asOf, -(SAFETY_STOP_RULES.windowDays - 1));
  const screened = screenFreeText(await port.recentPainNotes(ctx.userId, from, server.asOf));
  const text = { level: screened.level, reasons: screened.reasons };

  if (text.level === 'blocked') {
    const changeLogId = await systemReview(ctx, port, server.programId, 'safety_text');
    const safety: SafetyGateResult = {
      text,
      painPattern: { triggered: false, exerciseKeys: [], exercisesFlagged14d: 0 },
      forced: [],
      recover: false,
      paused: true,
      changeLogId,
    };
    await ctx.emit('evaluation.safety', { level: 'blocked', painPattern: false, forcedOperations: 0, recover: false, paused: true });

    return {
      context: { ...context, safety },
      outcome: {
        status: 'safety_stop',
        code: TRAINING_REASONS.SAFETY_STOP,
        programId: server.programId,
        changeLogId,
        verdict: 'safety_text',
      },
    };
  }

  const pattern = painPattern(server.pain, server.asOf);
  const forced = forcedSafetyOperations(server.pain, server.refs);
  const recover = needsRecovery(server.readinessLowStreak);
  let paused = server.autonomyPausedReason !== null;
  let changeLogId: string | null = null;

  if (pattern.triggered && !paused) {
    changeLogId = await systemReview(ctx, port, server.programId, 'pain_pattern');
    paused = true;
  }

  const safety: SafetyGateResult = { text, painPattern: pattern, forced, recover, paused, changeLogId };
  const next: EvaluateRunContext = {
    ...context,
    sent: {
      ...context.sent,
      run: { ...context.sent.run, recover, paused },
      profile: { ...context.sent.profile, alreadyDecided: forced },
    },
    safety,
  };

  await ctx.emit('evaluation.safety', {
    level: text.level,
    painPattern: pattern.triggered,
    forcedOperations: forced.length,
    recover,
    paused,
  });

  return { context: next };
};

/** Screens pain notes, applies the pain rules and pauses automation when it must. No model call. */
export const safetyGateNode: GraphNode = { name: 'safety_gate', run: runSafetyGate, implemented: true };
