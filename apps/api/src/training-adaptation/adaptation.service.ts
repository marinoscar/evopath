import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type WorkoutAdaptation } from '@prisma/client';

import { toDbDate } from '../check-ins/local-date';
import type { TrainingAgentRole } from '../common/schemas/settings.schema';
import { TRAINING_MIN_RUN_TOKENS } from '../common/schemas/settings.schema';
import { isUniqueViolation } from '../gyms/gym-views';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import type { PlanExercise, PlanTree } from '../programs/contracts/plan-tree.contract';
import { PROGRAM_REASONS } from '../programs/programs.constants';
import { ProgramsService } from '../programs/programs.service';
import { plannedSnapshotOf, prefilledSets, type PlannedExerciseInput } from '../programs/today/planned-session';
import { lastTimeByExercise } from '../programs/today/training-today.service';
import { WorkoutsService } from '../workouts/workouts.service';
import { PlannerContextLoader } from '../training-agents/context/planner-context.loader';
import type { FrozenRoleModel } from '../training-agents/graph/node-context';
import { SAFETY_STOP_GUIDANCE } from '../training-agents/guardrails/safety-keywords';
import type { RoleResolution } from '../training-agents/models/dto/role-resolution.dto';
import { TrainingModelResolver } from '../training-agents/models/training-model-resolver.service';
import { runnable } from '../training-agents/models/training-models.service';
import { RunEventsService } from '../training-agents/runtime/run-events.service';
import { TRAINING_RUN_AUDIT_ACTIONS, auditTrainingRun } from '../training-agents/runtime/training-run-audit';
import { ADAPT_RUN_KIND } from '../training-agents/runtime/training-runs.constants';
import { TrainingRunsService } from '../training-agents/runtime/training-runs.service';
import {
  ACTIVE_ADAPTATION_STATUSES,
  ADAPTATION_MAX_RUN_TOKENS,
  ADAPTATION_PROMPT_VERSION,
  ADAPTATION_REASONS,
  ADAPTATION_RUN_JOB_TYPE,
  ADAPTATION_SUBJECT_TYPE,
  ADAPTATION_TTL_MS,
  isActiveAdaptationConflict,
} from './adaptation.constants';
import { AdaptationContextBuilder } from './context/adaptation-context.builder';
import {
  type AdaptationBaseRef,
  type AdaptationContext,
  AdaptationContextError,
  type AdaptationContextSnapshot,
  snapshotOf,
} from './context/adaptation-context.contract';
import { type AdaptedWorkout, adaptedWorkoutSchema } from './contracts/adapted-workout.contract';
import {
  type AdaptationPreviewData,
  type AdaptationStartedData,
  type AdaptationViewData,
  type ApplyPlanResultData,
  type ApplyWorkoutResultData,
} from './dto/adaptation.dto';
import {
  type AdaptationRequest,
  NOTHING_TO_CHANGE_MESSAGE,
  adaptationRequestSchema,
  onlyGymChanges,
} from './dto/adaptation-request.dto';
import { staleFindings } from './rules/adaptation-rules';

// =============================================================================
// AdaptationService: preview, create, read, cancel, discard and apply
// =============================================================================
//
// OWNER-SCOPED. Every read and write matches on (adaptation id, caller):
// another user's adaptation is a 404.
//
// CREATE. Validate; build the context through the ONE builder (the preview
// renders the same object, so "what will be sent" is what is sent); refuse a
// request that changes nothing; the safety screen (an urgent-symptom note
// records `blocked_safety` with no run, no job and no provider call); resolve
// the planner and critic through E5.2's resolver (409
// `TRAINING_ROLE_UNAVAILABLE` naming the role and its state). Then, in ONE
// transaction: the kit run (`training_plan_runs`, kind `adapt`, models and
// token cap frozen), the adaptation row (`queued`, `expires_at = created_at +
// 30 days`) and its `ai.training.adapt.run` job. A second active adaptation
// trips `workout_adaptations_active_per_user_uniq_idx`; that violation,
// positively matched by name, is `409 ADAPTATION_IN_PROGRESS` with the
// existing id. Never a `findFirst` pre-check.
//
// APPLY. Both modes are idempotent (a repeat answers the same result; the
// other mode after one succeeded is `409 ADAPTATION_ALREADY_APPLIED`),
// require `ready`, and RE-RUN THE GUARDRAILS against current data (the gym's
// equipment, the library, pain flags; `409 ADAPTATION_STALE` with the
// findings). Loads are filled here, never by the model.
// =============================================================================

type Row = WorkoutAdaptation;

const ROLES: readonly TrainingAgentRole[] = ['planner', 'critic'];

class ApplyRaceError extends Error {}
class StaleTreeError extends Error {}

@Injectable()
export class AdaptationService {
  private readonly logger = new Logger(AdaptationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly resolver: TrainingModelResolver,
    private readonly events: RunEventsService,
    private readonly runs: TrainingRunsService,
    private readonly contextBuilder: AdaptationContextBuilder,
    private readonly library: PlannerContextLoader,
    private readonly workouts: WorkoutsService,
    private readonly programs: ProgramsService,
  ) {}

  // ===========================================================================
  // Preview and create
  // ===========================================================================

  /** The context that WOULD be sent, the models and whether a provider would be called. No call, nothing stored. */
  async preview(userId: string, dto: unknown, now: Date = new Date()): Promise<AdaptationPreviewData> {
    const request = parseRequest(dto);
    const context = await this.buildContext(userId, request, now);
    this.assertChanges(request, context);

    const { roles } = await this.resolver.resolveForRun(userId);
    const blocked = context.safety.level === 'blocked';
    const base = context.facts.base;

    return {
      baseWorkout: base ? 'planned' : 'none',
      base: base ? { programWorkoutId: base.programWorkoutId, name: base.name, date: base.date, planVersion: base.planVersion } : null,
      sentData: context.summary,
      models: { planner: roleView('planner', roles.planner), critic: roleView('critic', roles.critic) },
      willCallProvider: !blocked && ROLES.every((role) => runnable(roles[role])),
      safety: context.safety,
      blocked: blocked ? { reason: ADAPTATION_REASONS.SAFETY_STOP, guidance: SAFETY_STOP_GUIDANCE } : null,
    };
  }

  async create(userId: string, dto: unknown, now: Date = new Date()): Promise<AdaptationStartedData> {
    const request = parseRequest(dto);
    const context = await this.buildContext(userId, request, now);
    this.assertChanges(request, context);

    if (context.safety.level === 'blocked') return this.recordSafetyStop(userId, request, context, now);

    const { roles, settings, limits } = await this.resolver.resolveForRun(userId);
    const roleModels: Partial<Record<TrainingAgentRole, FrozenRoleModel>> = {};

    for (const role of ROLES) {
      const resolution = roles[role];
      if (!runnable(resolution) || !resolution.model) {
        throw new ConflictException({
          message: `The ${role} agent has no usable model.`,
          details: { reason: ADAPTATION_REASONS.ROLE_UNAVAILABLE, role, state: resolution.state, fix: resolution.fix },
        });
      }
      roleModels[role] = {
        provider: resolution.model.provider,
        modelId: resolution.model.modelId,
        effort: resolution.effectiveEffort,
        keySource: resolution.model.keySource,
        ...limits(resolution.model.provider, resolution.model.modelId),
      };
    }

    const tokenCap = Math.max(
      TRAINING_MIN_RUN_TOKENS,
      Math.min(ADAPTATION_MAX_RUN_TOKENS, settings?.training?.maxRunTokens ?? ADAPTATION_MAX_RUN_TOKENS),
    );
    const adaptationId = randomUUID();
    const models = Object.fromEntries(
      ROLES.map((role) => [role, { provider: roleModels[role]!.provider, modelId: roleModels[role]!.modelId }]),
    );

    let created: { runId: string; jobId: string };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const run = await tx.trainingPlanRun.create({
          data: {
            userId,
            kind: ADAPT_RUN_KIND,
            trigger: 'user',
            // The request lives on the adaptation row; the run only points at it.
            input: { request: { adaptationId }, maxCriticRounds: 1 } as Prisma.InputJsonValue,
            roleModels: roleModels as Prisma.InputJsonValue,
            tokenCap,
          },
          select: { id: true },
        });

        await tx.workoutAdaptation.create({
          data: {
            id: adaptationId,
            userId,
            status: 'queued',
            request: request as unknown as Prisma.InputJsonValue,
            gymId: context.facts.gymId,
            baseRef: context.baseRef ? (context.baseRef as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            contextSnapshot: snapshotOf(context) as unknown as Prisma.InputJsonValue,
            safety: context.safety as unknown as Prisma.InputJsonValue,
            models: models as Prisma.InputJsonValue,
            runId: run.id,
            expiresAt: new Date(now.getTime() + ADAPTATION_TTL_MS),
          },
        });

        const job = await this.jobs.enqueueWithin(tx, {
          type: ADAPTATION_RUN_JOB_TYPE,
          reason: 'upload',
          subjectType: ADAPTATION_SUBJECT_TYPE,
          subjectId: adaptationId,
          payload: { adaptationId },
        });

        await tx.workoutAdaptation.update({ where: { id: adaptationId }, data: { jobId: job.id } });
        await tx.trainingPlanRun.update({ where: { id: run.id }, data: { jobId: job.id, jobIds: [job.id] } });

        return { runId: run.id, jobId: job.id };
      });
    } catch (error) {
      if (!isActiveAdaptationConflict(error)) throw error;

      const existing = await this.prisma.workoutAdaptation.findFirst({
        where: { userId, status: { in: [...ACTIVE_ADAPTATION_STATUSES] } },
        select: { id: true, status: true, runId: true },
      });
      throw new ConflictException({
        message: 'You already have a workout adaptation in progress.',
        details: {
          reason: ADAPTATION_REASONS.IN_PROGRESS,
          ...(existing ? { adaptationId: existing.id, status: existing.status, runId: existing.runId } : {}),
        },
      });
    }

    await this.events.emit(created.runId, 'run.queued', { kind: ADAPT_RUN_KIND, trigger: 'user' });
    await auditTrainingRun(this.prisma, this.logger, userId, TRAINING_RUN_AUDIT_ACTIONS.START, {
      runId: created.runId,
      kind: ADAPT_RUN_KIND,
      status: 'queued',
      roles: [...ROLES],
    });

    return { adaptationId, jobId: created.jobId, runId: created.runId, status: 'queued' };
  }

  // ===========================================================================
  // Read, cancel, discard
  // ===========================================================================

  async get(userId: string, id: string): Promise<AdaptationViewData> {
    const row = await this.load(userId, id);
    const stage = row.runId
      ? ((await this.prisma.trainingPlanRun.findFirst({ where: { id: row.runId, userId }, select: { stage: true } }))?.stage ?? null)
      : null;
    return toAdaptationView(row, stage);
  }

  /** Cancels a queued or running adaptation through the kit's cancel. Idempotent; `409` once finished otherwise. */
  async cancel(userId: string, id: string): Promise<AdaptationViewData> {
    const row = await this.load(userId, id);
    if (row.status === 'cancelled') return this.get(userId, id);
    if (!ACTIVE_ADAPTATION_STATUSES.includes(row.status as never)) {
      throw new ConflictException({
        message: `This adaptation is ${row.status} and can no longer be cancelled.`,
        details: { reason: ADAPTATION_REASONS.NOT_CANCELLABLE, status: row.status },
      });
    }

    // The kit sets `cancel_requested_at` (a running handler aborts its
    // in-flight provider call within a poll) and finishes a queued run at once.
    if (row.runId) await this.runs.cancel(userId, row.runId).catch((error: unknown) => this.logCancel(row.id, error));
    await this.prisma.workoutAdaptation.updateMany({
      where: { id, userId, status: 'queued' },
      data: { status: 'cancelled' },
    });

    return this.get(userId, id);
  }

  /** Marks the adaptation `discarded` (cancelling it first while it runs). Idempotent. */
  async discard(userId: string, id: string): Promise<void> {
    const row = await this.load(userId, id);
    if (row.status === 'discarded') return;
    if (row.status === 'applied') {
      throw new ConflictException({
        message: 'This adaptation was already applied.',
        details: { reason: ADAPTATION_REASONS.ALREADY_APPLIED, appliedAs: row.appliedAs },
      });
    }

    if (ACTIVE_ADAPTATION_STATUSES.includes(row.status as never) && row.runId) {
      await this.runs.cancel(userId, row.runId).catch((error: unknown) => this.logCancel(row.id, error));
    }
    await this.prisma.workoutAdaptation.updateMany({
      where: { id, userId, status: { notIn: ['applied', 'discarded'] } },
      data: { status: 'discarded' },
    });
  }

  // ===========================================================================
  // Apply
  // ===========================================================================

  /** One-off: an in-progress E4 workout for today with the adapted exercises, prefilled. The plan is untouched. */
  async applyWorkout(userId: string, id: string, now: Date = new Date()): Promise<ApplyWorkoutResultData> {
    const row = await this.load(userId, id);

    if (row.appliedAs === 'one_off' && row.appliedWorkoutId) return this.oneOffResult(row.appliedWorkoutId);
    if (row.appliedAs === 'plan_change') throw alreadyApplied(row);
    assertReady(row);

    const request = parseRequest(row.request);
    const proposal = proposalOfRow(row);
    const baseRef = baseRefOf(row);
    const { context } = await this.recheck(userId, request, proposal, now);
    const today = context.facts.today;
    const planChanged =
      baseRef !== null &&
      (context.baseRef?.planVersion !== baseRef.planVersion || context.baseRef?.planWorkoutId !== baseRef.planWorkoutId);
    const freshBase = !planChanged ? context.facts.base : null;

    const ids = [...new Set(proposal.exercises.map((e) => e.exerciseId))];
    const lastTimes = await lastTimeByExercise(this.prisma, userId, ids, today);

    const planned: PlannedExerciseInput[] = proposal.exercises.map((e) => {
      const counterpart = e.source === 'kept' ? freshBase?.exercises.find((b) => b.exerciseId === e.exerciseId) : undefined;
      // A kept exercise keeps its plan's load rule; anything else starts from
      // the last time (none: the lifter chooses). More reps than planned: no
      // prefilled load (never escalate).
      const moreReps = counterpart !== undefined && e.repMin > counterpart.repMin;
      return {
        exerciseId: e.exerciseId,
        slug: e.exerciseKey,
        trackingMode: e.trackingMode,
        targetSets: e.sets,
        repMin: e.repMin,
        repMax: e.repMax,
        targetRpe: e.targetRpe,
        targetLoadKg: counterpart && !moreReps ? counterpart.targetLoadKg : null,
        loadGuidance: moreReps ? 'choose_start' : (counterpart?.loadGuidance ?? 'from_history'),
        isPriority: e.isPriority,
      };
    });

    try {
      const workoutId = await this.prisma.$transaction(async (tx) => {
        const link = baseRef ? await linkTarget(tx, userId, baseRef) : null;

        const created = await this.workouts.startPrefilled(
          tx,
          userId,
          {
            name: proposal.title,
            date: today,
            gymId: row.gymId,
            programWorkoutId: link?.programWorkoutId ?? null,
            exercises: planned.map((p) => ({
              exerciseId: p.exerciseId,
              equipmentTypeId: null,
              sets: prefilledSets(p, lastTimes.get(p.exerciseId) ?? null),
            })),
          },
          now,
        );

        await tx.workout.update({ where: { id: created.id }, data: { notes: adaptedNote(request, snapshotOfRow(row)) } });

        if (link) {
          await tx.programSession.create({
            data: {
              userId,
              programId: link.programId,
              programWorkoutId: link.programWorkoutId,
              workoutId: created.id,
              versionNumber: link.currentVersion,
              // Planned-versus-done compares against what was adapted for today.
              plannedSnapshot: plannedSnapshotOf(planned) as unknown as Prisma.InputJsonValue,
              plannedFor: toDbDate(today),
              startedAt: now,
            },
          });
        }

        const applied = await tx.workoutAdaptation.updateMany({
          where: { id, userId, status: 'ready' },
          data: { status: 'applied', appliedAs: 'one_off', appliedWorkoutId: created.id, appliedAt: now },
        });
        if (applied.count === 0) throw new ApplyRaceError();

        return created.id;
      });

      return { workoutId, linkedToPlan: !!baseRef && (await this.isLinked(workoutId)), planChanged };
    } catch (error) {
      if (error instanceof ApplyRaceError) {
        const winner = await this.load(userId, id);
        if (winner.appliedAs === 'one_off' && winner.appliedWorkoutId) return this.oneOffResult(winner.appliedWorkoutId);
        throw this.raceRefusal(winner);
      }
      if (isUniqueViolation(error)) {
        // Two taps at once: the other one created THIS adaptation's workout and committed first (the index
        // only fires once it has), so this tap is the idempotent repeat, not a "another workout" conflict.
        const current = await this.load(userId, id);
        if (current.appliedAs === 'one_off' && current.appliedWorkoutId) return this.oneOffResult(current.appliedWorkoutId);

        const winner = await this.prisma.workout.findFirst({ where: { userId, status: 'in_progress' }, select: { id: true } });
        if (winner) {
          throw new ConflictException({
            message: 'Another workout is in progress. Resume or finish it first.',
            details: { reason: ADAPTATION_REASONS.WORKOUT_IN_PROGRESS, workoutId: winner.id },
          });
        }
      }
      throw error;
    }
  }

  /** Plan change: a new plan version in which today's planned workout is the adapted one. */
  async applyPlan(userId: string, id: string, now: Date = new Date()): Promise<ApplyPlanResultData> {
    const row = await this.load(userId, id);

    if (row.appliedAs === 'plan_change' && row.appliedPlanVersionId) return this.planResult(userId, row);
    if (row.appliedAs === 'one_off') throw alreadyApplied(row);
    assertReady(row);

    const baseRef = baseRefOf(row);
    if (!baseRef) {
      throw new ConflictException({
        message: 'This adaptation was not made from a planned workout, so there is no plan to update. Use it for today only.',
        details: { reason: ADAPTATION_REASONS.NO_BASE },
      });
    }

    const request = parseRequest(row.request);
    const proposal = proposalOfRow(row);
    await this.recheck(userId, request, proposal, now);

    const program = await this.prisma.program.findFirst({
      where: { id: baseRef.planId, userId },
      select: { currentVersion: true },
    });
    if (!program || program.currentVersion !== baseRef.planVersion) {
      throw stale('Your plan changed since this adaptation was made. Adjust again.', [
        { code: 'plan_changed', exerciseKey: null, message: 'The plan has a newer version.' },
      ]);
    }

    // Claim first, so the one-off apply cannot also win; undone if the plan write fails.
    const claimed = await this.prisma.workoutAdaptation.updateMany({
      where: { id, userId, status: 'ready' },
      data: { status: 'applied', appliedAs: 'plan_change', appliedAt: now },
    });
    if (claimed.count === 0) {
      const winner = await this.load(userId, id);
      if (winner.appliedAs === 'plan_change' && winner.appliedPlanVersionId) return this.planResult(userId, winner);
      throw this.raceRefusal(winner);
    }

    const models = (row.models ?? {}) as Record<string, unknown>;
    let result;
    try {
      result = await this.programs.applyChange({
        userId,
        programId: baseRef.planId,
        expectedVersion: baseRef.planVersion,
        origin: 'ai_adapt',
        actor: 'ai',
        kind: 'adapted',
        mutate: (tree) => replaceWorkout(tree, baseRef.planWorkoutId, proposal),
        summary: clip(`Adapted today's workout (${describeRequest(request, snapshotOfRow(row))})`, 300),
        rationale: clip([proposal.summary, ...proposal.rationale.map((r) => `- ${r}`)].filter(Boolean).join('\n'), 2000),
        ...(row.runId ? { runId: row.runId } : {}),
        meta: {
          source: 'workout_adaptation',
          adaptationId: row.id,
          promptVersion: ADAPTATION_PROMPT_VERSION,
          models,
        },
      });
    } catch (error) {
      await this.prisma.workoutAdaptation.updateMany({
        where: { id, userId, status: 'applied', appliedAs: 'plan_change', appliedPlanVersionId: null },
        data: { status: 'ready', appliedAs: null, appliedAt: null },
      });
      if (error instanceof StaleTreeError || isStalePlan(error)) {
        throw stale('Your plan changed since this adaptation was made. Adjust again.', [
          { code: 'plan_changed', exerciseKey: null, message: "Today's planned workout changed." },
        ]);
      }
      throw error;
    }

    const version = await this.prisma.programVersion.findUniqueOrThrow({
      where: { programId_versionNumber: { programId: baseRef.planId, versionNumber: result.versionNumber } },
      select: { id: true },
    });
    await this.prisma.workoutAdaptation.updateMany({
      where: { id, userId },
      data: { appliedPlanVersionId: version.id },
    });

    return {
      programId: baseRef.planId,
      planVersionId: version.id,
      versionNumber: result.versionNumber,
      changeLogId: result.changeLogId,
    };
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private async buildContext(userId: string, request: AdaptationRequest, now: Date): Promise<AdaptationContext> {
    try {
      return await this.contextBuilder.build(userId, request, now);
    } catch (error) {
      if (error instanceof AdaptationContextError) {
        if (error.code === 'ADAPTATION_GYM_NOT_FOUND') throw new NotFoundException('Gym not found');
        throw new BadRequestException({
          message: error.message,
          details: { reason: ADAPTATION_REASONS.EQUIPMENT_NOT_IN_GYM, path: 'equipment.equipmentTypeIds', ...error.details },
        });
      }
      throw error;
    }
  }

  /** "Tell us what to change": a `gymId` that is the planned workout's own gym changes nothing. */
  private assertChanges(request: AdaptationRequest, context: AdaptationContext): void {
    const planGym = context.facts.base?.gymId ?? null;
    if (onlyGymChanges(request) && context.facts.base && request.gymId === planGym) {
      throw new BadRequestException({
        message: NOTHING_TO_CHANGE_MESSAGE,
        details: { reason: ADAPTATION_REASONS.NOTHING_TO_CHANGE, issues: [{ path: 'gymId', message: NOTHING_TO_CHANGE_MESSAGE }] },
      });
    }
  }

  /** Re-runs the guardrails' checks against current data; `409 ADAPTATION_STALE` with the findings. */
  private async recheck(
    userId: string,
    request: AdaptationRequest,
    proposal: AdaptedWorkout,
    now: Date,
  ): Promise<{ context: AdaptationContext }> {
    let context: AdaptationContext;
    try {
      context = await this.contextBuilder.build(userId, request, now);
    } catch (error) {
      if (error instanceof AdaptationContextError) {
        throw stale('The gym or its equipment changed since this adaptation was made. Adjust again.', [
          { code: 'equipment_changed', exerciseKey: null, message: error.message },
        ]);
      }
      throw error;
    }

    const library = await this.library.loadLibrary(userId);
    const findings = staleFindings(proposal, {
      library: new Map(library.map((e) => [e.id, e])),
      inventory: context.facts.inventory,
      painFlagKeys: context.facts.painFlagKeys,
      avoidKeys: context.facts.avoidKeys,
    });
    if (findings.length > 0) {
      throw stale('Something changed since this adaptation was made (equipment, exercises or pain flags). Adjust again.', findings);
    }
    return { context };
  }

  private async recordSafetyStop(
    userId: string,
    request: AdaptationRequest,
    context: AdaptationContext,
    now: Date,
  ): Promise<AdaptationStartedData> {
    // Nothing the user typed is kept for a stopped request (the E5 rule).
    const { freeText: _freeText, ...kept } = request;
    const row = await this.prisma.workoutAdaptation.create({
      data: {
        userId,
        status: 'blocked_safety',
        request: kept as unknown as Prisma.InputJsonValue,
        gymId: context.facts.gymId,
        baseRef: context.baseRef ? (context.baseRef as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        safety: context.safety as unknown as Prisma.InputJsonValue,
        errorCode: ADAPTATION_REASONS.SAFETY_STOP,
        expiresAt: new Date(now.getTime() + ADAPTATION_TTL_MS),
      },
      select: { id: true },
    });
    return { adaptationId: row.id, jobId: null, runId: null, status: 'blocked_safety', guidance: SAFETY_STOP_GUIDANCE };
  }

  private async load(userId: string, id: string): Promise<Row> {
    const row = await this.prisma.workoutAdaptation.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException('Adaptation not found');
    return row;
  }

  private async isLinked(workoutId: string): Promise<boolean> {
    return (await this.prisma.programSession.count({ where: { workoutId } })) > 0;
  }

  private async oneOffResult(workoutId: string): Promise<ApplyWorkoutResultData> {
    return { workoutId, linkedToPlan: await this.isLinked(workoutId), planChanged: false };
  }

  private async planResult(userId: string, row: Row): Promise<ApplyPlanResultData> {
    const version = await this.prisma.programVersion.findFirst({
      where: { id: row.appliedPlanVersionId!, program: { userId } },
      select: { id: true, programId: true, versionNumber: true },
    });
    if (!version) throw new NotFoundException('The plan version this adaptation created no longer exists');
    const log = await this.prisma.programChangeLog.findFirst({
      where: { programId: version.programId, userId, toVersion: version.versionNumber, kind: 'adapted' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return {
      programId: version.programId,
      planVersionId: version.id,
      versionNumber: version.versionNumber,
      changeLogId: log?.id ?? version.id,
    };
  }

  /** After a lost race on the `ready` guard (the winner's result was not available): the right 409. */
  private raceRefusal(row: Row): HttpException {
    if (row.appliedAs) return alreadyApplied(row);
    return new ConflictException({
      message: `This adaptation is ${row.status}; reload it.`,
      details: { reason: ADAPTATION_REASONS.NOT_READY, status: row.status },
    });
  }

  private logCancel(id: string, error: unknown): void {
    this.logger.warn(`Could not cancel the run of adaptation ${id}: ${error instanceof Error ? error.name : 'unknown error'}`);
  }
}

// =============================================================================
// Pure helpers
// =============================================================================

function parseRequest(value: unknown): AdaptationRequest {
  const parsed = adaptationRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException({
      message: parsed.error.issues[0]?.message ?? 'Invalid adaptation request',
      details: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
    });
  }
  return parsed.data;
}

function roleView(role: 'planner' | 'critic', resolution: RoleResolution) {
  return {
    role,
    state: resolution.state,
    model: resolution.model
      ? { provider: resolution.model.provider, modelId: resolution.model.modelId, displayName: resolution.model.displayName }
      : null,
    effectiveEffort: resolution.effectiveEffort,
    fix: resolution.fix,
    runnable: runnable(resolution),
  };
}

function assertReady(row: Row): void {
  if (row.status !== 'ready') {
    throw new ConflictException({
      message: `This adaptation is ${row.status}; only a ready adaptation can be applied.`,
      details: { reason: ADAPTATION_REASONS.NOT_READY, status: row.status },
    });
  }
}

function alreadyApplied(row: Row): HttpException {
  return new ConflictException({
    message:
      row.appliedAs === 'one_off'
        ? 'This adaptation was already used for today only.'
        : 'This adaptation was already applied to your plan.',
    details: {
      reason: ADAPTATION_REASONS.ALREADY_APPLIED,
      appliedAs: row.appliedAs,
      ...(row.appliedWorkoutId ? { workoutId: row.appliedWorkoutId } : {}),
      ...(row.appliedPlanVersionId ? { planVersionId: row.appliedPlanVersionId } : {}),
    },
  });
}

function stale(message: string, findings: Array<{ code: string; exerciseKey: string | null; message: string }>): HttpException {
  return new ConflictException({ message, details: { reason: ADAPTATION_REASONS.STALE, findings } });
}

function isStalePlan(error: unknown): boolean {
  if (!(error instanceof HttpException)) return false;
  const body = error.getResponse() as { details?: { reason?: unknown } } | string;
  return typeof body === 'object' && body?.details?.reason === PROGRAM_REASONS.STALE_PLAN;
}

function proposalOfRow(row: Row): AdaptedWorkout {
  const parsed = adaptedWorkoutSchema.safeParse(row.proposal);
  if (!parsed.success) {
    throw new ConflictException({
      message: 'This adaptation has no usable proposal.',
      details: { reason: ADAPTATION_REASONS.NOT_READY, status: row.status },
    });
  }
  return parsed.data;
}

export function baseRefOf(row: Pick<Row, 'baseRef'>): AdaptationBaseRef | null {
  const v = row.baseRef as Partial<AdaptationBaseRef> | null;
  if (!v || typeof v.planId !== 'string' || typeof v.planWorkoutId !== 'string' || typeof v.planVersion !== 'number') return null;
  return {
    planId: v.planId,
    planVersionId: typeof v.planVersionId === 'string' ? v.planVersionId : null,
    planVersion: v.planVersion,
    planWorkoutId: v.planWorkoutId,
    date: typeof v.date === 'string' ? v.date : '',
  };
}

function snapshotOfRow(row: Pick<Row, 'contextSnapshot'>): AdaptationContextSnapshot | null {
  const v = row.contextSnapshot as Partial<AdaptationContextSnapshot> | null;
  return v && typeof v === 'object' && v.sent ? (v as AdaptationContextSnapshot) : null;
}

/** Where a one-off links to (as E5.7's start links): the planned workout, when it and its active plan still exist. */
async function linkTarget(
  tx: Prisma.TransactionClient,
  userId: string,
  baseRef: AdaptationBaseRef,
): Promise<{ programId: string; programWorkoutId: string; currentVersion: number } | null> {
  const workout = await tx.programWorkout.findFirst({
    where: {
      id: baseRef.planWorkoutId,
      archivedAt: null,
      week: { archivedAt: null, block: { archivedAt: null }, program: { userId, status: 'active' } },
    },
    select: { id: true, week: { select: { programId: true, program: { select: { currentVersion: true } } } } },
  });
  if (!workout) return null;
  return { programId: workout.week.programId, programWorkoutId: workout.id, currentVersion: workout.week.program.currentVersion };
}

const clip = (text: string, max: number) => [...text].slice(0, max).join('');

/** "30 min, sore chest (mild), low energy, only dumbbells": what the user asked for, as a short label. */
export function describeRequest(request: AdaptationRequest, snapshot: AdaptationContextSnapshot | null): string {
  const parts: string[] = [];
  if (request.minutes !== undefined) parts.push(`${request.minutes} min`);
  if (request.soreness) parts.push(`sore ${request.soreness.muscles.join(', ').replace(/_/g, ' ')} (${request.soreness.level})`);
  if (request.lowEnergy) parts.push('low energy');
  if (request.equipment?.mode === 'only') {
    const names = snapshot?.sent.request.equipment.names ?? [];
    parts.push(names.length ? `only ${names.join(', ').toLowerCase()}` : 'limited equipment');
  }
  if (request.equipment?.mode === 'bodyweight') parts.push('bodyweight only');
  if (request.gymId) parts.push('different gym');
  if (request.freeText) parts.push('your note');
  return parts.length ? parts.join(', ') : 'adjusted';
}

/** The workout note that marks an adapted session: "Adapted: 30 min, sore chest (mild)". */
export function adaptedNote(request: AdaptationRequest, snapshot: AdaptationContextSnapshot | null): string {
  return clip(`Adapted: ${describeRequest(request, snapshot)}`, 1000);
}

/** The tree with today's planned workout's exercises replaced by the adapted ones (kept rows keep their ids and load rules). */
export function replaceWorkout(tree: PlanTree, programWorkoutId: string, proposal: AdaptedWorkout): PlanTree {
  for (const block of tree.blocks) {
    for (const week of block.weeks) {
      const workout = week.workouts.find((w) => w.id === programWorkoutId);
      if (!workout) continue;

      const existing = new Map(workout.exercises.map((e) => [e.exerciseId, e]));
      workout.exercises = proposal.exercises.map((e, position): PlanExercise => {
        const kept = e.source === 'kept' ? existing.get(e.exerciseId) : undefined;
        if (kept) {
          existing.delete(e.exerciseId);
          return {
            ...kept,
            position,
            isPriority: e.isPriority,
            targetSets: e.sets,
            repMin: e.repMin,
            repMax: e.repMax,
            targetRpe: e.targetRpe,
            restSeconds: e.restSeconds,
          };
        }
        return {
          exerciseId: e.exerciseId,
          position,
          isPriority: e.isPriority,
          targetSets: e.sets,
          repMin: e.repMin,
          repMax: e.repMax,
          targetLoadKg: null,
          targetRpe: e.targetRpe,
          restSeconds: e.restSeconds,
          loadGuidance: 'from_history',
          rationale: e.note ? clip(e.note, 300) : null,
          evidenceRefs: [],
          notes: null,
          equipmentTypeId: null,
        };
      });
      workout.estimatedMinutes = Math.max(1, proposal.estimatedMinutes);
      return tree;
    }
  }
  throw new StaleTreeError('The planned workout is no longer in the plan');
}

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

/** The published view: no job internals beyond ids, no key, no prompt. */
export function toAdaptationView(row: Row, stage: string | null = null): AdaptationViewData {
  const models = (row.models ?? {}) as Record<string, { provider?: unknown; modelId?: unknown } | undefined>;
  const modelRef = (role: string) => {
    const m = models[role];
    return m && typeof m.provider === 'string' && typeof m.modelId === 'string' ? { provider: m.provider, modelId: m.modelId } : null;
  };
  const proposal = adaptedWorkoutSchema.safeParse(row.proposal);
  const report = row.guardrailReport as Record<string, unknown> | null;
  const snapshot = snapshotOfRow(row);
  const safety = row.safety as { level?: unknown; reasons?: unknown } | null;

  return {
    id: row.id,
    status: row.status as AdaptationViewData['status'],
    request: (row.request ?? {}) as Record<string, unknown>,
    gymId: row.gymId,
    baseRef: baseRefOf(row),
    proposal: proposal.success ? proposal.data : null,
    guardrailReport: report && Array.isArray(report.repairs) ? (report as AdaptationViewData['guardrailReport']) : null,
    criticReport: (row.criticReport as AdaptationViewData['criticReport']) ?? null,
    safety:
      safety && (safety.level === 'ok' || safety.level === 'conservative' || safety.level === 'blocked')
        ? { level: safety.level, reasons: Array.isArray(safety.reasons) ? safety.reasons.map(String) : [] }
        : null,
    sentData: snapshot?.summary ?? null,
    models: { planner: modelRef('planner'), critic: modelRef('critic') },
    runId: row.runId,
    jobId: row.jobId,
    stage,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    appliedAs: (row.appliedAs as AdaptationViewData['appliedAs']) ?? null,
    appliedWorkoutId: row.appliedWorkoutId,
    appliedPlanVersionId: row.appliedPlanVersionId,
    appliedAt: iso(row.appliedAt),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    guidance: row.status === 'blocked_safety' ? SAFETY_STOP_GUIDANCE : null,
  };
}
