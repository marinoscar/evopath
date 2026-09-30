import { EVALUATION_LIMITS, type EvaluationSkipReason } from './evaluation.constants';

// =============================================================================
// evaluationGate: may an automatic evaluation run be created now? (pure)
// =============================================================================
//
// Every gate must hold. In order (the first failing one is the answer):
//
//   ai_disabled            `ai.enabled` is off                       skip
//   graph_not_ready        the evaluate graph is not shipped yet     skip
//   no_active_program      the user has no active plan               skip
//   automation_paused      `autonomyPausedAt` is set                 skip
//   evaluator_unavailable  the evaluator role does not resolve       skip
//   proposal_pending       a `proposed` change waits for the user    skip
//   covered_by_queued_run  an evaluate run is queued, not started:   skip
//                          it will read these signals anyway
//   active_run             another run is active                     DEFER
//   daily_cap              3 automatic runs this UTC day             DEFER
//   manual_cooldown        a manual run in the last 30 minutes       DEFER
//   min_spacing            an automatic run in the last 30 minutes   DEFER
//                          (the follow-up rule is exempt)
//
// DEFER means "not now, but do not forget": the scheduler stamps
// `programs.evaluation_requested_at` (for a `workout_finished` request), and
// the follow-up rule (a run settled) or the hourly sweep honours it once the
// gates pass. A skip forgets the request.
// =============================================================================

export interface EvaluationFacts {
  aiEnabled: boolean;
  graphReady: boolean;
  program: { id: string; autonomyPausedAt: Date | null } | null;
  evaluatorUsable: boolean;
  proposalPending: boolean;
  /** The user's active run (queued, running or awaiting approval), if any. */
  activeRun: { kind: string; status: string } | null;
  /** Automatic evaluation runs created since the start of the UTC day. */
  automaticRunsToday: number;
  lastAutomaticRunAt: Date | null;
  lastManualRunAt: Date | null;
}

export type EvaluationGateDecision =
  | { allow: true }
  | { allow: false; reason: EvaluationSkipReason; defer: boolean };

export interface EvaluationGateOptions {
  /** The follow-up rule after a run settled: exempt from the 30-minute spacing. */
  followUp?: boolean;
}

const skip = (reason: EvaluationSkipReason): EvaluationGateDecision => ({ allow: false, reason, defer: false });
const defer = (reason: EvaluationSkipReason): EvaluationGateDecision => ({ allow: false, reason, defer: true });

export function evaluationGate(
  facts: EvaluationFacts,
  now: Date,
  options: EvaluationGateOptions = {},
): EvaluationGateDecision {
  if (!facts.aiEnabled) return skip('ai_disabled');
  if (!facts.graphReady) return skip('graph_not_ready');
  if (!facts.program) return skip('no_active_program');
  if (facts.program.autonomyPausedAt) return skip('automation_paused');
  if (!facts.evaluatorUsable) return skip('evaluator_unavailable');
  if (facts.proposalPending) return skip('proposal_pending');
  if (facts.activeRun) {
    return facts.activeRun.kind === 'evaluate' && facts.activeRun.status === 'queued'
      ? skip('covered_by_queued_run')
      : defer('active_run');
  }
  if (facts.automaticRunsToday >= EVALUATION_LIMITS.maxAutomaticPerUtcDay) return defer('daily_cap');
  if (facts.lastManualRunAt && now.getTime() - facts.lastManualRunAt.getTime() < EVALUATION_LIMITS.manualCooldownMs) {
    return defer('manual_cooldown');
  }
  if (
    !options.followUp &&
    facts.lastAutomaticRunAt &&
    now.getTime() - facts.lastAutomaticRunAt.getTime() < EVALUATION_LIMITS.minAutomaticSpacingMs
  ) {
    return defer('min_spacing');
  }
  return { allow: true };
}

/** Midnight UTC of `now`'s UTC day: where the daily cap counts from. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Seconds until a manual run may start again, or 0 when the cooldown is over. */
export function manualCooldownRemainingSeconds(lastManualRunAt: Date | null, now: Date): number {
  if (!lastManualRunAt) return 0;
  const remaining = EVALUATION_LIMITS.manualCooldownMs - (now.getTime() - lastManualRunAt.getTime());
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}
