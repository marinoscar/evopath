import '../agents/critic/critic.events';

import { BadRequestException, ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { TrainingPlanReadyData } from '../../notifications/channels/browser-notification.channel';
import { PROGRAM_REASONS } from '../../programs/programs.constants';
import { criticRoundOf, lowScores } from '../agents/critic/critic-verdict.contract';
import { FINALIZED_EVENT_MAX_WARNINGS } from '../agents/critic/critic.events';
import { TRAINING_CONTEXT_REASONS } from '../context/planner-context.loader';
import { citationsOf, evidenceOf } from '../finalize/plan-evidence';
import type { GraphNode, NodeContext, NodeFn, ProgramsPort, RunProgramVersion } from '../graph/node-context';
import { TRAINING_RUN_WARNINGS, type CritiqueDecision, critiqueDecision } from '../graph/routes';
import type { RunState } from '../graph/run-state';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import { TRAINING_REASONS } from '../runtime/training-runs.constants';
import { GUARDRAIL_OUTPUT_MISSING } from './critique.node';
import { type GuardrailNodeOutput, guardrailOutputOf } from './guardrails.node';
import { runContextOf } from './prepare-context.node';

// =============================================================================
// Node `finalize`: write the checked plan through the programs chokepoint
// =============================================================================
//
// 1. A guardrail report that still BLOCKS means no plan: the run ends
//    `rejected` with `TRAINING_PLAN_REJECTED` and nothing is written (the
//    unrepaired violations are in the last `guardrail.report` event).
// 2. `create`: `ProgramsService.createWithTree` (one transaction: program as
//    `draft`, `source: 'ai'`, the intake's autonomy and gym, the intake
//    snapshot, version 1 `ai_create` with the rationale, the verified
//    evidence and `meta`, one `created` change log entry with citations).
//    `revise`: `ProgramsService.applyChange` with `expectedVersion` =
//    `basedOnVersion` (`ai_adapt`, `adapted`); a stale version fails the run
//    `TRAINING_STALE_PLAN`, with no automatic merge.
// 3. After the write returned (committed, outside any transaction):
//    `notify('training.plan_ready')`, `plan.finalized`, and the outcome.
//
// `meta` records how the plan was made (frozen models and efforts, critic
// rounds, tokens, warnings, open critic notes); never prompt text.
// Idempotent across a resume: a version this run already wrote is reused.
// =============================================================================

export const PLAN_REJECTED = 'TRAINING_PLAN_REJECTED';
export const PROGRAMS_PORT_MISSING = 'TRAINING_PROGRAMS_UNAVAILABLE';
export const PLAN_READY_EVENT = 'training.plan_ready';

export const CREATE_SUMMARY = 'Created by the planning agent';
export const REVISE_SUMMARY = 'Revised at your request';
export const STALE_PLAN_MESSAGE = 'Your plan changed while the agents were working; start again from the latest version.';
const DEFAULT_PLAN_NAME = 'Training plan';

/** How the loop ended, including the paths that bypass a verdict. */
export function finalDecision(state: Pick<RunState, 'warnings' | 'guardrailReport' | 'verdicts' | 'roundCounters' | 'maxCriticRounds'>): Exclude<CritiqueDecision, 'revise'> {
  if (state.warnings.includes(TRAINING_RUN_WARNINGS.SKIPPED_BUDGET)) return 'critic_skipped_budget';
  if (state.warnings.includes(TRAINING_RUN_WARNINGS.UNAVAILABLE)) return 'critic_unavailable';
  const decision = critiqueDecision(state);
  return decision === 'revise' ? 'exhausted' : decision;
}

/** The critic's open notes on the last round (sanitised text, for `meta` only). */
function openNotes(state: Pick<RunState, 'verdicts'>) {
  const last = criticRoundOf(state.verdicts.at(-1));
  if (!last || last.skipped !== undefined) return { openBlockers: [], lowestScores: [] };
  return {
    openBlockers: last.blockers.map((b) => ({ dimension: b.dimension, path: b.path, issue: b.issue })),
    lowestScores: lowScores(last),
  };
}

function weeksOf(tree: GuardrailNodeOutput['tree']): number {
  return tree.blocks.reduce((sum, block) => sum + block.weeks.length, 0);
}

function reasonOf(error: HttpException): string | undefined {
  const body = error.getResponse() as { details?: { reason?: unknown } } | string;
  return typeof body === 'object' ? (body.details?.reason as string | undefined) : undefined;
}

/** The chokepoint's refusals as run failures (fixed messages; no user or model text). */
function mapWriteError(error: unknown): never {
  if (error instanceof ConflictException) {
    const reason = reasonOf(error);
    if (reason === PROGRAM_REASONS.STALE_PLAN) throw new TrainingRunFailedError(TRAINING_REASONS.STALE_PLAN, STALE_PLAN_MESSAGE);
    if (reason === PROGRAM_REASONS.PROGRAM_ARCHIVED) {
      throw new TrainingRunFailedError('TRAINING_PROGRAM_ARCHIVED', 'This plan was archived while the agents were working.');
    }
  }
  if (error instanceof NotFoundException) {
    throw new TrainingRunFailedError(TRAINING_CONTEXT_REASONS.PROGRAM_NOT_FOUND, 'The plan to revise no longer exists.');
  }
  if (error instanceof BadRequestException) {
    throw new TrainingRunFailedError(PLAN_REJECTED, 'The plan could not be saved because it no longer passes the checks.', {
      reason: reasonOf(error) ?? null,
    });
  }
  throw error;
}

async function write(
  state: RunState,
  ctx: NodeContext,
  programs: ProgramsPort,
  output: GuardrailNodeOutput,
  meta: Record<string, unknown>,
): Promise<RunProgramVersion> {
  const context = runContextOf(state);
  const evidence = evidenceOf(state.brief);
  const citations = citationsOf(state.brief, output.tree);
  const tree = structuredClone(output.tree);

  try {
    if (context.kind === 'revise') {
      if (!context.revise) throw new TrainingRunFailedError(TRAINING_CONTEXT_REASONS.PROGRAM_NOT_FOUND, 'The plan to revise no longer exists.');
      await programs.applyChange({
        userId: ctx.userId,
        programId: context.revise.programId,
        expectedVersion: context.revise.basedOnVersion,
        origin: 'ai_adapt',
        actor: 'ai',
        kind: 'adapted',
        mutate: () => tree,
        summary: REVISE_SUMMARY,
        ...(output.header.summary ? { rationale: output.header.summary } : {}),
        ...(output.header.rationale ? { planRationale: output.header.rationale } : {}),
        citations,
        evidence,
        runId: ctx.runId,
        meta,
      });
    } else {
      await programs.createWithTree({
        userId: ctx.userId,
        header: {
          name: output.header.title.trim() || DEFAULT_PLAN_NAME,
          goal: context.intake.goal.type,
          source: 'ai',
          autonomy: context.intake.autonomy,
          gymId: context.intake.gymId,
          intake: context.intake as unknown as Prisma.InputJsonValue,
          rationale: output.header.rationale || null,
        },
        tree,
        origin: 'ai_create',
        actor: 'ai',
        summary: CREATE_SUMMARY,
        ...(output.header.summary ? { rationale: output.header.summary } : {}),
        citations,
        evidence,
        runId: ctx.runId,
        meta,
      });
    }
  } catch (error) {
    mapWriteError(error);
  }

  const written = await programs.findRunVersion(ctx.userId, ctx.runId);
  if (!written) throw new Error('The plan was written but its version could not be read back.');
  return written;
}

export const runFinalize: NodeFn = async (state, ctx) => {
  const output = guardrailOutputOf(state);
  if (!output) throw new TrainingRunFailedError(GUARDRAIL_OUTPUT_MISSING, 'There is no checked plan to save.');

  const decision = finalDecision(state);

  if (output.report.status === 'blocked') {
    return { outcome: { status: 'rejected', code: PLAN_REJECTED, verdict: 'blocked' } };
  }

  const programs = ctx.ports?.programs;
  if (!programs) throw new TrainingRunFailedError(PROGRAMS_PORT_MISSING, 'The plan could not be saved.');

  const added = decision === 'exhausted' ? [TRAINING_RUN_WARNINGS.OPEN_NOTES] : [];
  const warnings = [...new Set([...state.warnings, ...added])];

  const meta: Record<string, unknown> = {
    models: Object.fromEntries(
      Object.entries(ctx.roleModels).map(([role, model]) => [role, { provider: model!.provider, modelId: model!.modelId, effort: model!.effort }]),
    ),
    criticRounds: state.roundCounters.critique ?? 0,
    draftRound: output.round,
    verdict: decision,
    tokens: ctx.budget.snapshot().total,
    warnings,
    guardrails: { status: output.report.status, counts: output.report.counts },
    ...openNotes(state),
  };

  const written = (await programs.findRunVersion(ctx.userId, ctx.runId)) ?? (await write(state, ctx, programs, output, meta));

  // Committed: the write returned outside any transaction.
  const ready: TrainingPlanReadyData = {
    programId: written.programId,
    programName: written.programName,
    weeks: weeksOf(output.tree),
  };
  await ctx.ports?.notifications?.notify(PLAN_READY_EVENT, ctx.userId, ready);
  await ctx.emit('plan.finalized', {
    programId: written.programId,
    versionNumber: written.versionNumber,
    warnings: warnings.slice(0, FINALIZED_EVENT_MAX_WARNINGS),
  });

  return {
    programId: written.programId,
    ...(added.length > 0 ? { warnings: added } : {}),
    outcome: {
      status: 'completed',
      programId: written.programId,
      versionNumber: written.versionNumber,
      changeLogId: written.changeLogId,
      verdict: decision,
    },
  };
};

/** Writes the checked plan and raises the notification (create or revise). */
export const finalizeNode: GraphNode = { name: 'finalize', run: runFinalize, implemented: true };
