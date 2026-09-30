import '../evaluation/evaluation.events';

import { buildEvaluatorContext } from '../evaluation/build-evaluator-context';
import type { GraphNode, NodeFn } from '../graph/node-context';
import { TrainingRunFailedError } from '../runtime/training-run-errors';

// =============================================================================
// Node `load_signals`: the evaluate run's context (deterministic, no model)
// =============================================================================
//
// Reads through `ctx.ports.evaluation` (owner-scoped): the plan's header and
// live tree, the evaluator's signals (`TrainingSignalsService.forEvaluator`,
// the last 6 complete weeks plus the current one in the user's zone), the
// linked sessions, the last 10 change log entries and the stored evidence.
// `buildEvaluatorContext` turns them into `state.context`
// (`evaluation/evaluate-context.ts`): the SENT half with short refs and no
// uuid, name, note or pain text, and the SERVER half with the ref -> row id
// map. `state.input.trigger` and `state.input.deep` (set by the scheduler)
// become the run facts. Emits `evaluation.signals` (counts only).
// =============================================================================

export const EVALUATION_PORT_MISSING = 'TRAINING_CONTEXT_UNAVAILABLE';
export const EVALUATION_PROGRAM_MISSING = 'TRAINING_PROGRAM_NOT_FOUND';

export const runLoadSignals: NodeFn = async (state, ctx) => {
  const port = ctx.ports?.evaluation;
  if (!port) {
    throw new TrainingRunFailedError(EVALUATION_PORT_MISSING, 'The training context could not be loaded.');
  }

  const sources = state.programId ? await port.loadSources(ctx.userId, state.programId, ctx.now()) : null;
  if (!sources) {
    throw new TrainingRunFailedError(EVALUATION_PROGRAM_MISSING, 'The plan to evaluate no longer exists.');
  }

  const context = buildEvaluatorContext(sources, {
    trigger: typeof state.input.trigger === 'string' ? state.input.trigger.slice(0, 32) : null,
    deep: state.input.deep === true,
    now: ctx.now(),
  });
  const { sent } = context;

  await ctx.emit('evaluation.signals', {
    sessions: sent.signals.sessions.length,
    remainingWeeks: sent.plan.weeks.length,
    changeableWorkouts: sent.plan.weeks.reduce((n, week) => n + week.workouts.filter((w) => !w.locked).length, 0),
    historyEntries: sent.history.length,
    evidenceClaims: sent.evidence.length,
    missedStreak: sent.signals.adherence.missedStreak,
  });

  return { context };
};

/** Loads the signals, the remaining plan with short refs, the history, the evidence and the profile. */
export const loadSignalsNode: GraphNode = { name: 'load_signals', run: runLoadSignals, implemented: true };
