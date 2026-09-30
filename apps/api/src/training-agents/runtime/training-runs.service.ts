import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import type { Prisma, TrainingPlanRun } from '@prisma/client';

import { TRAINING_MAX_RUN_TOKENS, TRAINING_MIN_RUN_TOKENS } from '../../common/schemas/settings.schema';
import { gymNotFound } from '../../gyms/gym-views';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { programNotFound } from '../../programs/programs.service';
import type { FrozenRoleModel } from '../graph/node-context';
import {
  EVALUATION_COOLDOWN_REASON,
  EVALUATION_LIMITS,
  MANUAL_EVALUATION_TRIGGER,
} from '../evaluation/evaluation.constants';
import { manualCooldownRemainingSeconds } from '../evaluation/evaluation-gates';
import { DEFAULT_MAX_CRITIC_ROUNDS, type RunKind } from '../graph/run-state';
import { graphForKind, isGraphReady } from '../graph/training-graphs';
import { effectiveTokenCap } from '../models/token-estimate';
import { TrainingModelResolver } from '../models/training-model-resolver.service';
import { runnable } from '../models/training-models.service';
import { TRAINING_KIND_OPTIONAL_ROLES, TRAINING_KIND_ROLES } from '../models/training-role-defaults';
import {
  type ListTrainingRunsQuery,
  type StartTrainingRunInput,
  startTrainingRunSchema,
  toRunRequest,
  type TrainingRunDecisionInput,
  type TrainingRunListData,
  type TrainingRunStartedData,
  type TrainingRunViewData,
} from './dto/training-runs.dto';
import { parseRunUsage, runCapState } from './run-budget';
import { RunEventsService } from './run-events.service';
import { type SafetyScreen, TRAINING_SAFETY_SCREEN } from './safety-screen';
import { TRAINING_RUN_AUDIT_ACTIONS, auditTrainingRun } from './training-run-audit';
import {
  ACTIVE_RUN_STATUSES,
  ADAPT_RUN_KIND,
  CANCELLABLE_RUN_STATUSES,
  MAX_RUN_RESUMES,
  TRAINING_REASONS,
  TRAINING_RUN_JOB_TYPE,
  TRAINING_RUN_SUBJECT_TYPE,
  type TrainingRunTrigger,
  isActiveRunConflict,
} from './training-runs.constants';

// =============================================================================
// TrainingRunsService: start, read, cancel, resume and decide training runs
// =============================================================================
//
// OWNER-SCOPED. Every read and write matches on (run id, caller): another
// user's run is a 404, indistinguishable from one that does not exist.
//
// START. The request is validated (`create` carries the intake, `revise` the
// program, `basedOnVersion` and the instruction). Then the safety screen (a
// stop records `blocked_safety` with no job and no provider call), the graph
// readiness constant (`501 TRAINING_NOT_IMPLEMENTED` while the kind's graph is
// stubbed), the request's targets (the intake's gym must be the caller's and
// the revised program too, else `404`; `basedOnVersion` must be the program's
// `currentVersion`, else `409 TRAINING_STALE_PLAN`), then role resolution
// (`409 TRAINING_ROLE_UNAVAILABLE` naming the role and its state).
// The models and the token cap are FROZEN on the run, and the run row and its
// `ai.training.plan.run` job are created in ONE transaction. A second active
// run for the user trips `training_plan_runs_active_per_user_uniq_idx`; that
// violation, positively matched by index name, is `409 TRAINING_RUN_ACTIVE`
// with the existing run's id. Never a `findFirst` pre-check: the database
// decides a race.
//
// THE STORED INPUT is `{ request, maxCriticRounds }`: the validated request
// and the critic round limit frozen at start. It is never returned.
// =============================================================================

type RunRow = TrainingPlanRun;

@Injectable()
export class TrainingRunsService {
  private readonly logger = new Logger(TrainingRunsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly resolver: TrainingModelResolver,
    private readonly events: RunEventsService,
    @Inject(TRAINING_SAFETY_SCREEN) private readonly safety: SafetyScreen,
  ) {}

  async create(
    userId: string,
    dto: StartTrainingRunInput,
    trigger: TrainingRunTrigger = 'user',
  ): Promise<TrainingRunStartedData> {
    const parsed = startTrainingRunSchema.safeParse(dto);

    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid training run request',
        details: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
      });
    }

    const body = parsed.data;
    const kind = body.kind;
    // What the run stores and the graph reads as `state.input`.
    const { request: input, programId } = toRunRequest(body);
    const screened = await this.safety.screen({ userId, kind, input });

    if (screened.stop) {
      return this.recordSafetyStop(userId, kind, programId, trigger, screened.guidance, screened.code);
    }

    if (!isGraphReady(kind)) {
      throw new NotImplementedException({
        message: `Training runs of kind "${kind}" are not available yet.`,
        details: { reason: TRAINING_REASONS.NOT_IMPLEMENTED, graph: graphForKind(kind) },
      });
    }

    if (body.kind === 'create' && body.intake?.gymId) {
      const gym = await this.prisma.gym.findFirst({ where: { id: body.intake.gymId, userId }, select: { id: true } });
      if (!gym) throw gymNotFound();
    }

    if (body.kind === 'revise' && programId) {
      const program = await this.prisma.program.findFirst({
        where: { id: programId, userId },
        select: { currentVersion: true },
      });
      if (!program) throw programNotFound();
      if (program.currentVersion !== body.basedOnVersion) {
        throw new ConflictException({
          message: 'Your plan changed since you opened it; start again from the latest version.',
          details: { reason: TRAINING_REASONS.STALE_PLAN, currentVersion: program.currentVersion },
        });
      }
    }

    const { roles, settings, limits } = await this.resolver.resolveForRun(userId);
    const roleModels: Partial<Record<string, FrozenRoleModel>> = {};

    for (const role of TRAINING_KIND_ROLES[kind]) {
      const resolution = roles[role];

      if (!runnable(resolution) || !resolution.model) {
        throw new ConflictException({
          message: `The ${role} agent has no usable model.`,
          details: { reason: TRAINING_REASONS.ROLE_UNAVAILABLE, role, state: resolution.state },
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

    for (const role of TRAINING_KIND_OPTIONAL_ROLES[kind]) {
      const resolution = roles[role];
      if (!runnable(resolution) || !resolution.model) continue;
      roleModels[role] = {
        provider: resolution.model.provider,
        modelId: resolution.model.modelId,
        effort: resolution.effectiveEffort,
        keySource: resolution.model.keySource,
        ...limits(resolution.model.provider, resolution.model.modelId),
      };
    }

    let evaluateProgramId: string | null = null;
    if (kind === 'evaluate') {
      evaluateProgramId = await this.evaluateTarget(userId, programId);
      if (trigger === MANUAL_EVALUATION_TRIGGER) await this.assertManualCooldown(userId);
    }

    const tokenCap = Math.min(
      TRAINING_MAX_RUN_TOKENS,
      Math.max(TRAINING_MIN_RUN_TOKENS, effectiveTokenCap(kind, settings)),
    );
    const maxCriticRounds = settings?.training?.maxCriticRounds ?? DEFAULT_MAX_CRITIC_ROUNDS;

    let created: { run: RunRow; jobId: string };

    try {
      created = await this.prisma.$transaction(async (tx) => {
        const run = await tx.trainingPlanRun.create({
          data: {
            userId,
            kind,
            trigger,
            programId: evaluateProgramId ?? programId,
            input: { request: input, maxCriticRounds } as Prisma.InputJsonValue,
            roleModels: roleModels as Prisma.InputJsonValue,
            tokenCap,
          },
        });
        const job = await this.enqueueRunJob(tx, run.id);
        const updated = await tx.trainingPlanRun.update({
          where: { id: run.id },
          data: { jobId: job.id, jobIds: [job.id] },
        });

        return { run: updated, jobId: job.id };
      });
    } catch (error) {
      if (!isActiveRunConflict(error)) throw error;

      const existing = await this.prisma.trainingPlanRun.findFirst({
        where: { userId, status: { in: [...ACTIVE_RUN_STATUSES] }, kind: { not: ADAPT_RUN_KIND } },
        select: { id: true, status: true },
      });

      throw new ConflictException({
        message: 'You already have a training run in progress.',
        details: {
          reason: TRAINING_REASONS.RUN_ACTIVE,
          ...(existing ? { runId: existing.id, status: existing.status } : {}),
        },
      });
    }

    await this.events.emit(created.run.id, 'run.queued', { kind, trigger });
    await auditTrainingRun(this.prisma, this.logger, userId, TRAINING_RUN_AUDIT_ACTIONS.START, {
      runId: created.run.id,
      kind,
      status: created.run.status,
      roles: Object.keys(roleModels),
    });

    return { runId: created.run.id, jobId: created.jobId, status: 'queued' };
  }

  async get(userId: string, runId: string): Promise<TrainingRunViewData> {
    return toTrainingRunView(await this.load(userId, runId));
  }

  /** The run's status, or `null` once it no longer exists (the stream's tail reads it). */
  async statusOf(userId: string, runId: string): Promise<string | null> {
    const run = await this.prisma.trainingPlanRun.findFirst({ where: { id: runId, userId }, select: { status: true } });

    return run?.status ?? null;
  }

  async list(userId: string, query: ListTrainingRunsQuery): Promise<TrainingRunListData> {
    const where: Prisma.TrainingPlanRunWhereInput = {
      userId,
      // Quick adaptations' runs are read through their own routes.
      kind: { not: ADAPT_RUN_KIND },
      ...(query.programId ? { programId: query.programId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.trainingPlanRun.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.trainingPlanRun.count({ where }),
    ]);

    return {
      items: rows.map(toTrainingRunView),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  /**
   * Requests a cancel. A run no job is executing (`queued` before a claim,
   * `awaiting_approval`, `interrupted`) is finished as `cancelled` here; a
   * `running` run is stopped by its handler within one cancel poll.
   * Idempotent: a finished run is returned unchanged.
   */
  async cancel(userId: string, runId: string): Promise<TrainingRunViewData> {
    const now = new Date();

    await this.prisma.trainingPlanRun.updateMany({
      where: { id: runId, userId, status: { in: [...CANCELLABLE_RUN_STATUSES] }, cancelRequestedAt: null },
      data: { cancelRequestedAt: now },
    });

    const finished = await this.prisma.trainingPlanRun.updateMany({
      where: { id: runId, userId, status: { in: ['queued', 'awaiting_approval', 'interrupted'] } },
      data: { status: 'cancelled', completedAt: now, stage: null },
    });

    const run = await this.load(userId, runId);

    if (finished.count > 0) {
      // An open proposal of the cancelled run is declined (it never blocks the next evaluation).
      if (run.kind === 'evaluate') await this.prisma.programChangeLog.updateMany({
        where: { runId, userId, status: 'proposed' },
        data: { status: 'rejected', decidedAt: now },
      });
      await this.events.emit(runId, 'run.cancelled', {});
      await auditTrainingRun(this.prisma, this.logger, userId, TRAINING_RUN_AUDIT_ACTIONS.CANCEL, {
        runId,
        kind: run.kind,
        status: run.status,
      });
    }

    return toTrainingRunView(run);
  }

  /** Resumes an `interrupted` run from its checkpoint, in a new job. */
  async resume(userId: string, runId: string): Promise<TrainingRunViewData> {
    const run = await this.load(userId, runId);

    if (run.kind === ADAPT_RUN_KIND) {
      // A quick adaptation is never resumed: "Try again" starts a new one.
      throw new ConflictException({
        message: 'A workout adaptation cannot be resumed; start a new one instead.',
        details: { reason: TRAINING_REASONS.NOT_RESUMABLE, status: run.status, resumeCount: run.resumeCount },
      });
    }

    if (run.status !== 'interrupted' || run.resumeCount >= MAX_RUN_RESUMES) {
      throw new ConflictException({
        message:
          run.status !== 'interrupted'
            ? `Only an interrupted run can be resumed; this one is ${run.status}.`
            : `This run has been resumed ${run.resumeCount} times; start a new run instead.`,
        details: { reason: TRAINING_REASONS.NOT_RESUMABLE, status: run.status, resumeCount: run.resumeCount },
      });
    }

    const requeued = await this.requeue(userId, runId, 'interrupted', {
      resumeCount: { increment: 1 },
      resumeCountBelow: MAX_RUN_RESUMES,
    });

    if (!requeued) {
      throw new ConflictException({
        message: 'The run changed state; reload it and try again.',
        details: { reason: TRAINING_REASONS.NOT_RESUMABLE },
      });
    }

    await auditTrainingRun(this.prisma, this.logger, userId, TRAINING_RUN_AUDIT_ACTIONS.RESUME, {
      runId,
      kind: run.kind,
      status: 'queued',
    });

    return this.get(userId, runId);
  }

  /** Records the owner's decision on an `awaiting_approval` run and resumes it in a new job. */
  async decide(userId: string, runId: string, dto: TrainingRunDecisionInput): Promise<TrainingRunViewData> {
    const run = await this.load(userId, runId);

    const requeued =
      run.status === 'awaiting_approval' &&
      (await this.requeue(userId, runId, 'awaiting_approval', {
        pendingDecision: {
          decision: dto.decision,
          ...(dto.note ? { note: dto.note } : {}),
          decidedAt: new Date().toISOString(),
        },
      }));

    if (!requeued) {
      throw new ConflictException({
        message: 'This run is not waiting for a decision.',
        details: { reason: TRAINING_REASONS.NOT_AWAITING_DECISION, status: run.status },
      });
    }

    await auditTrainingRun(this.prisma, this.logger, userId, TRAINING_RUN_AUDIT_ACTIONS.DECISION, {
      runId,
      kind: run.kind,
      status: 'queued',
      decision: dto.decision,
    });

    return this.get(userId, runId);
  }

  /**
   * Moves a run from `from` back to `queued` and enqueues a new job for it, in
   * one transaction. Guarded by status (and the resume ceiling), so of two
   * concurrent callers exactly one wins. Returns `false` when the guard did
   * not match. A second active run of the user surfaces as `409
   * TRAINING_RUN_ACTIVE`.
   *
   * Also used by the handler's settle listener for the automatic resume.
   */
  async requeue(
    userId: string,
    runId: string,
    from: 'interrupted' | 'awaiting_approval',
    change: {
      resumeCount?: { increment: number };
      resumeCountBelow?: number;
      pendingDecision?: Record<string, unknown>;
    } = {},
  ): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const moved = await tx.trainingPlanRun.updateMany({
          where: {
            id: runId,
            userId,
            status: from,
            cancelRequestedAt: null,
            ...(change.resumeCountBelow !== undefined ? { resumeCount: { lt: change.resumeCountBelow } } : {}),
          },
          data: {
            status: 'queued',
            expiresAt: null,
            errorCode: null,
            errorMessage: null,
            ...(change.resumeCount ? { resumeCount: change.resumeCount } : {}),
            ...(change.pendingDecision ? { pendingDecision: change.pendingDecision as Prisma.InputJsonValue } : {}),
          },
        });

        if (moved.count === 0) return false;

        const job = await this.enqueueRunJob(tx, runId);
        await tx.trainingPlanRun.update({ where: { id: runId }, data: { jobId: job.id } });

        return true;
      });
    } catch (error) {
      if (!isActiveRunConflict(error)) throw error;

      throw new ConflictException({
        message: 'You already have another training run in progress.',
        details: { reason: TRAINING_REASONS.RUN_ACTIVE },
      });
    }
  }

  /** An evaluation's program: the one named (the caller's, else 404) or the active plan (404 when none). */
  private async evaluateTarget(userId: string, programId: string | null): Promise<string> {
    const program = await this.prisma.program.findFirst({
      where: programId ? { id: programId, userId } : { userId, status: 'active' },
      select: { id: true },
    });
    if (!program) throw programNotFound();
    return program.id;
  }

  /**
   * "Re-evaluate now" at most once per 30 minutes: `409
   * TRAINING_EVALUATION_COOLDOWN` with `details.retryAfterSeconds`. The
   * active-run index still decides two concurrent clicks.
   */
  private async assertManualCooldown(userId: string, now: Date = new Date()): Promise<void> {
    const last = await this.prisma.trainingPlanRun.findFirst({
      where: {
        userId,
        kind: 'evaluate',
        trigger: MANUAL_EVALUATION_TRIGGER,
        createdAt: { gt: new Date(now.getTime() - EVALUATION_LIMITS.manualCooldownMs) },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const retryAfterSeconds = manualCooldownRemainingSeconds(last?.createdAt ?? null, now);
    if (retryAfterSeconds > 0) {
      throw new ConflictException({
        message: 'Your plan was evaluated a moment ago; try again later.',
        details: { reason: EVALUATION_COOLDOWN_REASON, retryAfterSeconds },
      });
    }
  }

  private enqueueRunJob(tx: Prisma.TransactionClient, runId: string) {
    return this.jobs.enqueueWithin(tx, {
      type: TRAINING_RUN_JOB_TYPE,
      reason: 'upload',
      subjectType: TRAINING_RUN_SUBJECT_TYPE,
      subjectId: runId,
      payload: { runId },
      // A resume may be queued while the previous job for the run is still
      // settling; the run's own status guard already allows one executor.
      skipDedup: true,
    });
  }

  private async recordSafetyStop(
    userId: string,
    kind: RunKind,
    programId: string | null,
    trigger: TrainingRunTrigger,
    guidance: string,
    code: string | undefined,
  ): Promise<TrainingRunStartedData> {
    const now = new Date();
    const run = await this.prisma.trainingPlanRun.create({
      data: {
        userId,
        kind,
        trigger,
        programId,
        status: 'blocked_safety',
        // Nothing the user typed is kept for a stopped run.
        input: {},
        tokenCap: TRAINING_MIN_RUN_TOKENS,
        errorCode: code ?? TRAINING_REASONS.SAFETY_STOP,
        completedAt: now,
      },
    });

    await auditTrainingRun(this.prisma, this.logger, userId, TRAINING_RUN_AUDIT_ACTIONS.START, {
      runId: run.id,
      kind,
      status: 'blocked_safety',
      errorCode: run.errorCode,
    });

    return { runId: run.id, jobId: null, status: 'blocked_safety', guidance };
  }

  private async load(userId: string, runId: string): Promise<RunRow> {
    const run = await this.prisma.trainingPlanRun.findFirst({ where: { id: runId, userId } });

    if (!run) throw new NotFoundException('Training run not found');

    return run;
  }
}

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

/** The published view of a run: no request, no context, no job ids, no note, no key. */
export function toTrainingRunView(run: RunRow): TrainingRunViewData {
  const roleModels = Object.fromEntries(
    Object.entries((run.roleModels ?? {}) as unknown as Record<string, FrozenRoleModel>).map(([role, model]) => [
      role,
      { provider: model.provider, modelId: model.modelId, effort: model.effort ?? null, keySource: model.keySource },
    ]),
  );
  const decision = (run.pendingDecision as { decision?: unknown } | null)?.decision;

  return {
    id: run.id,
    kind: run.kind as RunKind,
    trigger: run.trigger as TrainingRunViewData['trigger'],
    status: run.status as TrainingRunViewData['status'],
    stage: run.stage,
    programId: run.programId,
    roleModels: roleModels as TrainingRunViewData['roleModels'],
    tokenCap: run.tokenCap,
    cap: runCapState(run.tokenCap, run.usage, run.errorCode),
    usage: parseRunUsage(run.usage) as TrainingRunViewData['usage'],
    result: (run.result as Record<string, unknown> | null) ?? null,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    pendingDecision: decision === 'approve' || decision === 'reject' ? decision : null,
    cancelRequested: run.cancelRequestedAt !== null,
    resumeCount: run.resumeCount,
    lastEventSeq: run.eventSeq,
    heartbeatAt: iso(run.heartbeatAt),
    expiresAt: iso(run.expiresAt),
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    startedAt: iso(run.startedAt),
    completedAt: iso(run.completedAt),
  };
}
