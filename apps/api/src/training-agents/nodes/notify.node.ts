import { evaluateContextOf } from '../evaluation/evaluate-context';
import { changeSetOf } from '../evaluation/evaluate-state';
import type { GraphNode, NodeFn } from '../graph/node-context';

// =============================================================================
// Node `notify`: `training.plan_adapted` after an applied change
// =============================================================================
//
// Runs after `apply` and after a rejection. Raises `training.plan_adapted`
// (ids and the sanitised summary) only when the change set was applied; a
// rejection, a superseded change and a review raise nothing. The write it
// reports committed in `apply` (its own transaction), so this is after
// commit and outside any transaction. `NotificationsService.notify` is
// detached and never rejects. (A proposal's `training.plan_proposal` is
// raised by `record_proposal`, before the run pauses.)
// =============================================================================

export const PLAN_ADAPTED_EVENT = 'training.plan_adapted';

export const runNotify: NodeFn = async (state, ctx) => {
  const context = evaluateContextOf(state);
  const changeSet = changeSetOf(state);
  if (!context || !changeSet || changeSet.result !== 'applied' || !changeSet.applied) return {};

  await ctx.ports?.notifications?.notify(PLAN_ADAPTED_EVENT, ctx.userId, {
    programId: context.server.programId,
    summary: changeSet.summary,
    changeLogId: changeSet.applied.changeLogId,
  });
  return {};
};

/** Raises `training.plan_adapted` after the write committed. */
export const notifyNode: GraphNode = { name: 'notify', run: runNotify, implemented: true };
