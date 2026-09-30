import '../evaluation/adaptation.events';

import { applyChangeSet } from '../evaluation/apply-change-set';
import { storedOperation } from '../evaluation/apply-operations';
import { evaluateContextOf } from '../evaluation/evaluate-context';
import { type ChangeSet, changeSetOf, composeSummary } from '../evaluation/evaluate-state';
import type { GraphNode, NodeFn } from '../graph/node-context';
import { FORCED_REMOVAL_REASON, FORCED_REMOVAL_SUMMARY } from '../guardrails/safety-stop';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import { APPROVAL_TTL_MS } from '../runtime/training-runs.constants';
import { EVALUATION_PORT_MISSING } from './load-signals.node';
import { PLAN_ADAPTED_EVENT } from './notify.node';

// =============================================================================
// Node `record_proposal`: "ask me first"
// =============================================================================
//
// 1. FORCED SAFETY REMOVALS NEVER WAIT: they only lower risk, so they are
//    applied now as their own version (and notified as an adjustment), and
//    the proposal is based on that version.
// 2. The rest becomes ONE `proposed` change log row (kind `adapted`, actor
//    `ai`, `fromVersion`, no `toVersion`) with the accepted operations, the
//    summary, rationale and citations; `training.plan_proposal` is raised
//    after the write. `await_approval` then pauses the run.
//
// A proposal expires with its run (`APPROVAL_TTL_MS`, 14 days; the sweep
// marks it `expired`). Only one open proposal per plan: the scheduler does
// not start an evaluation while one is pending. RESUME-SAFE: a proposal or a
// forced version this run already wrote is found and not written twice.
// =============================================================================

export const PLAN_PROPOSAL_EVENT = 'training.plan_proposal';

export const runRecordProposal: NodeFn = async (state, ctx) => {
  const context = evaluateContextOf(state);
  const changeSet = changeSetOf(state);
  const port = ctx.ports?.evaluation;
  const programs = ctx.ports?.programs;
  if (!context || !changeSet || !port || !programs) {
    throw new TrainingRunFailedError(EVALUATION_PORT_MISSING, 'The training context is missing.');
  }
  const programId = context.server.programId;
  const forced = changeSet.accepted.filter((op) => op.forced);
  const rest = changeSet.accepted.filter((op) => !op.forced);
  let next: ChangeSet = changeSet;

  // 1. Forced removals first, as their own version.
  if (forced.length > 0) {
    const already = await programs.findRunVersion(ctx.userId, ctx.runId);
    if (already && already.versionNumber > changeSet.basedOnVersion) {
      next = { ...next, basedOnVersion: already.versionNumber, applied: { versionNumber: already.versionNumber, changeLogId: already.changeLogId ?? '' } };
    } else {
      const outcome = await applyChangeSet(ctx, {
        context,
        operations: forced,
        expectedVersion: changeSet.basedOnVersion,
        summary: composeSummary(FORCED_REMOVAL_SUMMARY, [], FORCED_REMOVAL_SUMMARY),
        rationale: FORCED_REMOVAL_REASON,
        citations: [],
        allowRetry: true,
      });
      if (outcome.status === 'applied') {
        next = {
          ...next,
          basedOnVersion: outcome.versionNumber,
          applied: { versionNumber: outcome.versionNumber, changeLogId: outcome.changeLogId },
        };
        await ctx.emit('adaptation.applied', { operations: forced.length, forced: forced.length, versionNumber: outcome.versionNumber, retried: outcome.retried });
        await ctx.ports?.notifications?.notify(PLAN_ADAPTED_EVENT, ctx.userId, {
          programId,
          summary: FORCED_REMOVAL_SUMMARY,
          changeLogId: outcome.changeLogId,
        });
      }
    }
  }

  // 2. The proposal.
  const expiresAt = new Date(ctx.now().getTime() + APPROVAL_TTL_MS).toISOString();
  const prior = await port.findRunUnapplied(ctx.userId, ctx.runId);
  let changeLogId: string;
  if (prior?.status === 'proposed') {
    changeLogId = prior.changeLogId;
    next = { ...next, basedOnVersion: prior.fromVersion ?? next.basedOnVersion };
  } else {
    changeLogId = (
      await port.recordUnappliedChange({
        userId: ctx.userId,
        programId,
        status: 'proposed',
        fromVersion: next.basedOnVersion,
        summary: next.summary,
        rationale: next.rationale || undefined,
        operations: rest.map(storedOperation),
        citations: next.citations,
        runId: ctx.runId,
      })
    ).changeLogId;
    await ctx.emit('adaptation.proposed', { operations: rest.length, expiresAt });
    await ctx.ports?.notifications?.notify(PLAN_PROPOSAL_EVENT, ctx.userId, {
      programId,
      summary: next.summary,
      changeLogId,
      runId: ctx.runId,
    });
  }

  return {
    changeSet: { ...next, proposal: { changeLogId, fromVersion: next.basedOnVersion, expiresAt }, result: 'proposed' },
  };
};

/** Writes the `proposed` change log row an "ask me first" plan decides on (after applying forced safety changes). */
export const recordProposalNode: GraphNode = { name: 'record_proposal', run: runRecordProposal, implemented: true };
