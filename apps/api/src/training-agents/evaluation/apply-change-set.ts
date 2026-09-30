import { HttpException } from '@nestjs/common';

import { PROGRAM_REASONS } from '../../programs/programs.constants';
import type { NodeContext } from '../graph/node-context';
import { boundOnTree } from '../guardrails/envelope';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import { type AcceptedOperation, applyOperations, storedOperation } from './apply-operations';
import type { EvaluateRunContext } from './evaluate-context';

// =============================================================================
// applyChangeSet: accepted operations through the programs chokepoint
// =============================================================================
//
// One `ProgramsService.applyChange` (origin `ai_adapt`, actor `ai`, kind
// `adapted`) inside its one transaction, with the stored operations, the
// rationale and the citations. Before writing it re-reads the adaptation
// facts: every target must still exist and none may be locked NOW (a session
// started since the evaluation is never changed).
//
// A STALE version (the owner edited the plan meanwhile) is retried ONCE when
// `allowRetry` (autonomous mode): the same operations are re-checked on the
// newer tree (`boundOnTree`: targets exist, E4, E5 and the guardrails still
// pass) and applied on top of it. Otherwise, or when the re-check drops
// anything, the outcome is `superseded` and nothing is written here (the
// caller records it). An approval never retries: a plan that changed after
// a suggestion supersedes the suggestion.
//
// Notifications are the caller's, after this returns (after commit).
// =============================================================================

export type ApplyChangeSetOutcome =
  | { status: 'applied'; versionNumber: number; changeLogId: string; retried: boolean }
  | { status: 'superseded'; reason: 'stale' | 'locked' | 'missing' | 'envelope' };

export const APPLY_PORT_MISSING = 'TRAINING_PROGRAMS_UNAVAILABLE';

class MissingTargets extends Error {}

function isStale(err: unknown): boolean {
  if (!(err instanceof HttpException)) return false;
  const body = err.getResponse() as { details?: { reason?: unknown } } | string;
  return typeof body === 'object' && body?.details?.reason === PROGRAM_REASONS.STALE_PLAN;
}

export interface ApplyChangeSetArgs {
  context: EvaluateRunContext;
  operations: readonly AcceptedOperation[];
  expectedVersion: number;
  summary: string;
  rationale: string;
  citations: Array<Record<string, unknown>>;
  /** Approving a proposal: that row becomes the applied entry. */
  proposalLogId?: string;
  allowRetry: boolean;
  /** Provenance for the version's `meta` (counts and codes only). */
  meta?: Record<string, unknown>;
}

export async function applyChangeSet(
  ctx: NodeContext,
  args: ApplyChangeSetArgs,
  retried = false,
  attempt = 1,
): Promise<ApplyChangeSetOutcome> {
  const programs = ctx.ports?.programs;
  const port = ctx.ports?.evaluation;
  if (!programs || !port) throw new TrainingRunFailedError(APPLY_PORT_MISSING, 'The plan could not be updated.');
  const { context } = args;
  const programId = context.server.programId;

  const facts = await port.loadAdaptationFacts(ctx.userId, programId, ctx.now());
  if (!facts) return { status: 'superseded', reason: 'missing' };

  let expected = args.expectedVersion;
  if (facts.currentVersion !== expected) {
    if (!args.allowRetry || retried) return { status: 'superseded', reason: 'stale' };
    const again = boundOnTree(args.operations, facts.tree, facts.guardrails, context);
    if (again.dropped.length > 0) return { status: 'superseded', reason: 'envelope' };
    expected = facts.currentVersion;
    retried = true;
  }

  // Every target exists and none is locked now.
  if (applyOperations(facts.tree, args.operations).missing.length > 0) return { status: 'superseded', reason: 'missing' };
  const locked = new Set(facts.lockedWorkoutIds);
  const workoutOfExercise = new Map<string, string>();
  for (const block of facts.tree.blocks)
    for (const week of block.weeks)
      for (const workout of week.workouts) for (const exercise of workout.exercises) if (exercise.id && workout.id) workoutOfExercise.set(exercise.id, workout.id);
  const touchesLocked = args.operations.some(
    (op) =>
      op.targets.workoutRowIds.some((id) => locked.has(id)) ||
      op.targets.exerciseRowIds.some((id) => locked.has(workoutOfExercise.get(id) ?? '')),
  );
  if (touchesLocked) return { status: 'superseded', reason: 'locked' };

  try {
    const written = await programs.applyChange({
      userId: ctx.userId,
      programId,
      expectedVersion: expected,
      origin: 'ai_adapt',
      actor: 'ai',
      kind: 'adapted',
      mutate: (tree) => {
        const out = applyOperations(tree, args.operations);
        if (out.missing.length > 0) throw new MissingTargets();
        return out.tree;
      },
      summary: args.summary,
      rationale: args.rationale || undefined,
      operations: args.operations.map(storedOperation),
      citations: args.citations,
      runId: ctx.runId,
      ...(args.meta ? { meta: args.meta } : {}),
      ...(args.proposalLogId ? { proposalLogId: args.proposalLogId } : {}),
    });
    return { status: 'applied', versionNumber: written.versionNumber, changeLogId: written.changeLogId, retried };
  } catch (err) {
    if (err instanceof MissingTargets) return { status: 'superseded', reason: 'missing' };
    if (isStale(err)) {
      if (args.allowRetry && !retried && attempt < 3) return applyChangeSet(ctx, args, false, attempt + 1);
      return { status: 'superseded', reason: 'stale' };
    }
    throw err;
  }
}
