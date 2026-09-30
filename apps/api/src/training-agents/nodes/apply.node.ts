import '../evaluation/adaptation.events';

import { applyChangeSet } from '../evaluation/apply-change-set';
import { storedOperation } from '../evaluation/apply-operations';
import { evaluateContextOf } from '../evaluation/evaluate-context';
import { type ChangeSet, changeSetOf } from '../evaluation/evaluate-state';
import type { GraphNode, NodeFn } from '../graph/node-context';
import type { RunStateUpdate } from '../graph/run-state';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import { EVALUATION_PORT_MISSING } from './load-signals.node';

// =============================================================================
// Node `apply`: the change set lands as a new plan version
// =============================================================================
//
// AUTONOMOUS: every accepted operation (forced safety removals first) in one
// `applyChange` based on the version the run evaluated; a stale version is
// retried once on the newer tree when every target still exists and the
// envelope still passes, otherwise a `superseded` entry is recorded and the
// run ends with no change.
//
// APPROVED (ask first): the proposal's operations on the version it was
// proposed against, and the proposal row itself becomes the applied entry
// (`toVersion`, `decidedAt`). A plan that changed since, or a target that
// is gone or started, closes the proposal as `superseded` ("Your plan
// changed after this was suggested").
//
// RESUME-SAFE: a version this run already wrote for the change set is found
// and not written twice. `notify` raises the notification after this.
// =============================================================================

export const runApply: NodeFn = async (state, ctx): Promise<RunStateUpdate> => {
  const context = evaluateContextOf(state);
  const changeSet = changeSetOf(state);
  const port = ctx.ports?.evaluation;
  const programs = ctx.ports?.programs;
  if (!context || !changeSet || !port || !programs) {
    throw new TrainingRunFailedError(EVALUATION_PORT_MISSING, 'The training context is missing.');
  }
  const programId = context.server.programId;
  const proposal = changeSet.proposal;
  const operations = proposal ? changeSet.accepted.filter((op) => !op.forced) : changeSet.accepted;
  const expectedVersion = proposal ? proposal.fromVersion : changeSet.basedOnVersion;

  const done = (next: ChangeSet, outcome: RunStateUpdate['outcome']): RunStateUpdate => ({ changeSet: next, outcome });

  // A version this run wrote after the one the change set is based on: already applied.
  const existing = await programs.findRunVersion(ctx.userId, ctx.runId);
  if (existing && existing.versionNumber > expectedVersion) {
    return done(
      { ...changeSet, applied: { versionNumber: existing.versionNumber, changeLogId: existing.changeLogId ?? '' }, result: 'applied' },
      { status: 'completed', programId, versionNumber: existing.versionNumber, changeLogId: existing.changeLogId, verdict: 'applied' },
    );
  }

  const outcome = await applyChangeSet(ctx, {
    context,
    operations,
    expectedVersion,
    summary: changeSet.summary,
    rationale: changeSet.rationale,
    citations: changeSet.citations,
    allowRetry: !proposal,
    ...(proposal ? { proposalLogId: proposal.changeLogId } : {}),
    meta: {
      evaluation: {
        accepted: changeSet.accepted.length,
        forced: changeSet.accepted.filter((op) => op.forced).length,
        clamped: changeSet.clamped.length,
        dropped: changeSet.dropped.length,
        rules: [...new Set([...changeSet.clamped, ...changeSet.dropped].map((f) => f.rule))],
        critique: changeSet.critique?.verdict ?? null,
      },
    },
  });

  if (outcome.status === 'applied') {
    await ctx.emit('adaptation.applied', {
      operations: operations.length,
      forced: operations.filter((op) => op.forced).length,
      versionNumber: outcome.versionNumber,
      retried: outcome.retried,
    });
    return done(
      { ...changeSet, applied: { versionNumber: outcome.versionNumber, changeLogId: outcome.changeLogId }, result: 'applied' },
      { status: 'completed', programId, versionNumber: outcome.versionNumber, changeLogId: outcome.changeLogId, verdict: 'applied' },
    );
  }

  let changeLogId: string | null = null;
  if (proposal) {
    await port.resolveProposal(ctx.userId, proposal.changeLogId, 'superseded');
    changeLogId = proposal.changeLogId;
  } else {
    const prior = await port.findRunUnapplied(ctx.userId, ctx.runId);
    changeLogId =
      prior?.status === 'superseded'
        ? prior.changeLogId
        : (
            await port.recordUnappliedChange({
              userId: ctx.userId,
              programId,
              status: 'superseded',
              fromVersion: expectedVersion,
              summary: changeSet.summary,
              rationale: changeSet.rationale || undefined,
              operations: operations.map(storedOperation),
              citations: changeSet.citations,
              runId: ctx.runId,
            })
          ).changeLogId;
  }

  await ctx.emit('adaptation.closed', { result: 'superseded' });
  return done({ ...changeSet, result: 'superseded' }, { status: 'no_change', programId, changeLogId, verdict: 'superseded' });
};

/** Applies the change set to the plan through `applyChange`. */
export const applyNode: GraphNode = { name: 'apply', run: runApply, implemented: true };
