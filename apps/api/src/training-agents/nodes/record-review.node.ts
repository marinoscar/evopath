import '../evaluation/adaptation.events';

import { evaluateContextOf } from '../evaluation/evaluate-context';
import { changeSetOf } from '../evaluation/evaluate-state';
import type { GraphNode, NodeFn } from '../graph/node-context';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import { EVALUATION_PORT_MISSING } from './load-signals.node';

// =============================================================================
// Node `record_review`: an evaluation that changed nothing
// =============================================================================
//
// A `reviewed` change log entry (actor `ai`, `fromVersion = toVersion`, no
// version bump) with the change set's summary (the sanitised message) and
// rationale (the assessment and anything the server clamped or dropped).
// Weekly reviews are shown in the history and on the Train page; no
// notification is raised for a review. RESUME-SAFE: the entry this run
// already wrote is found by run id.
// =============================================================================

export const runRecordReview: NodeFn = async (state, ctx) => {
  const context = evaluateContextOf(state);
  const changeSet = changeSetOf(state);
  const port = ctx.ports?.evaluation;
  if (!context || !changeSet || !port) {
    throw new TrainingRunFailedError(EVALUATION_PORT_MISSING, 'The training context is missing.');
  }
  const programId = context.server.programId;

  const existing = await port.findRunReview(ctx.userId, ctx.runId, 'ai');
  const changeLogId =
    existing?.changeLogId ??
    (
      await port.recordReview({
        userId: ctx.userId,
        programId,
        actor: 'ai',
        summary: changeSet.summary,
        rationale: changeSet.rationale || undefined,
        citations: changeSet.citations,
        runId: ctx.runId,
      })
    ).changeLogId;

  await ctx.emit('adaptation.closed', { result: 'reviewed' });
  return {
    changeSet: { ...changeSet, result: 'reviewed' },
    outcome: { status: 'no_change', programId, changeLogId, verdict: 'reviewed' },
  };
};

/** Records a `reviewed` entry (assessment, no version bump). */
export const recordReviewNode: GraphNode = { name: 'record_review', run: runRecordReview, implemented: true };
