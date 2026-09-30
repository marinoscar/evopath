// =============================================================================
// `ai.training.plan.run`: executes one training run's graph inside the queue
// =============================================================================
//
// Payload `{ runId }`, subject `training_run` / the run id. Enqueued by
// `TrainingRunsService` (start, resume, decision) and by this handler's own
// settle listener (the automatic resume).
//
// SERVER-ONLY, PERMANENTLY. No `nodeResultSchema` / `persistNodeResult`: the
// run spends the user's own provider key (or the org key), and no AI key may
// ever reach a worker node (CLAUDE.md queue rule 3 and AI rule 3).
//
// PROFILE `{ maxRuntimeMs: 25 min, maxAttempts: 1 }`. A model call is neither
// idempotent nor free, so the queue never retries the job. Recovery is a NEW
// job that continues the run from its last checkpoint: completed nodes are
// never repeated. A provider throttle is the exception that keeps the job: it
// is DEFERRED (`RateLimitError`), which does not charge the attempt, and the
// re-claimed job continues from the checkpoint.
//
// OUTCOMES. The run row, not the job, is what the user reads:
//
//   graph completed                   run `succeeded` (`result` set)      job returns
//   graph interrupted (ask me first)  run `awaiting_approval`, 14 d       job returns
//   cancel observed                   run `cancelled`                     job returns
//   deadline or shutdown              run `interrupted` (checkpointed)    job returns
//   terminal AI code (kill switch,    run `failed` with the code          job returns (no retry,
//     key, model, capability, ...)                                        no `jobs.job_failed`)
//   AI_RATE_LIMITED                   run back to `queued`, `run.deferred` job deferred
//   RunBudgetExceededError            run `failed` TRAINING_RUN_BUDGET_EXCEEDED   job returns
//   safety stop raised by a node      run `blocked_safety`                job returns
//   TrainingRunFailedError (a node's  run `failed` with its code          job returns
//     own reason, e.g. research)
//   anything else                     run `failed` (sanitised)            job THROWS (visible to operators)
//
// SETTLE SAFETY NET. If a job settles `failed` while its run is still
// `running` or `queued` on that job (a lost lease, a crash, a deploy, a
// throttle budget spent), the listener marks the run `interrupted` and, while
// `resume_count < 2`, queues ONE resume job; past that the run fails
// `TRAINING_RUN_LOST`. The listener only reads a row and enqueues.
//
// NO PROMPT TEXT, MODEL OUTPUT, USER TEXT OR KEY in any log line, span
// attribute, event or audit row written here: ids, statuses, codes, counts.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { type Job, Prisma, type TrainingPlanRun } from '@prisma/client';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { z } from 'zod';

import { AiConfigService } from '../../ai/config/ai-config.service';
import { AiError } from '../../ai/core/ai-error';
import { AI_RUN_TERMINAL_CODES } from '../../ai/runtime/ai-response-run.handler';
import { AiService } from '../../ai/runtime/ai.service';
import { resolveServiceName } from '../../common/otel/service-name';
import type { TrainingAgentRole } from '../../common/schemas/settings.schema';
import { JOB_SETTLED_EVENT, type JobSettledEvent } from '../../jobs/events/job-settled.event';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PlannerContextLoader } from '../context/planner-context.loader';
import { EvaluationContextLoader } from '../evaluation/evaluation-context.loader';
import type { AgentGraphRunResult } from '../graph/agent-graph-runner.interface';
import type { GraphHooks } from '../graph/create-graph';
import { trainingGraphRunner } from '../graph/graph-factory';
import type { FrozenRoleModel, NodeContext, NodeFn } from '../graph/node-context';
import { DEFAULT_MAX_CRITIC_ROUNDS, initialRunState, type RunKind, type RunState } from '../graph/run-state';
import { AgentCaller, AgentOutputTruncated, RunDeferredError } from './agent-caller';
import { ContextBudget, TrainingContextTooLargeError } from './context-budget';
import { PrismaCheckpointSaver } from './prisma-checkpoint-saver';
import { RunBudget, RunBudgetExceededError, countedTokens, parseRunUsage } from './run-budget';
import { RunEventsService } from './run-events.service';
import {
  TrainingRunAbort,
  type TrainingRunAbortReason,
  TrainingRunFailedError,
  TrainingSafetyStopError,
} from './training-run-errors';
import { TRAINING_RUN_AUDIT_ACTIONS, auditTrainingRun } from './training-run-audit';
import {
  APPROVAL_TTL_MS,
  MAX_AUTO_RESUMES,
  TERMINAL_RUN_STATUSES,
  TRAINING_REASONS,
  TRAINING_RUN_CANCEL_POLL_MS,
  TRAINING_RUN_DEADLINE_MS,
  TRAINING_RUN_HEARTBEAT_MS,
  TRAINING_RUN_JOB_TYPE,
  TRAINING_RUN_MAX_RUNTIME_MS,
  TRAINING_RUN_SUBJECT_TYPE,
  type TrainingRunStatus,
} from './training-runs.constants';
import { TrainingProgramsPort } from './training-programs.port';
import { TrainingRunsService } from './training-runs.service';

export const trainingPlanRunPayloadSchema = z.object({ runId: z.string().uuid() });

/** Root span of one job's execution of a run. */
export const TRAINING_RUN_SPAN = 'training.run';
/** Prefix of each node's span (`training.node.plan`). */
export const TRAINING_NODE_SPAN_PREFIX = 'training.node.';

const tracer = trace.getTracer(resolveServiceName());

/** Optional knobs, for tests: timings and node implementations. Never configuration. */
export const TRAINING_RUN_HANDLER_OPTIONS = Symbol('TRAINING_RUN_HANDLER_OPTIONS');

export interface TrainingRunHandlerOptions {
  deadlineMs?: number;
  cancelPollMs?: number;
  heartbeatMs?: number;
  /** Replace graph nodes (the stub graph is what runs until the agent stories ship). */
  nodes?: Partial<Record<string, NodeFn>>;
  /** The checkpointer per job; default a `PrismaCheckpointSaver` over the app's Prisma. */
  checkpointer?: () => BaseCheckpointSaver;
}

type RunRow = TrainingPlanRun;

interface StoredInput {
  request: Record<string, unknown>;
  maxCriticRounds: number;
}

function storedInput(value: unknown): StoredInput {
  const v = (value ?? {}) as Record<string, unknown>;
  const request = v.request && typeof v.request === 'object' && !Array.isArray(v.request) ? v.request : {};
  const rounds = typeof v.maxCriticRounds === 'number' ? v.maxCriticRounds : DEFAULT_MAX_CRITIC_ROUNDS;

  return { request: request as Record<string, unknown>, maxCriticRounds: rounds };
}

@Injectable()
export class TrainingPlanRunHandler implements JobHandler, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TrainingPlanRunHandler.name);
  private readonly running = new Map<string, AbortController>();
  private readonly options: TrainingRunHandlerOptions;

  /** PERMANENT once jobs of this type exist. */
  readonly type = TRAINING_RUN_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: TRAINING_RUN_MAX_RUNTIME_MS, maxAttempts: 1 };

  // NO nodeResultSchema, NO persistNodeResult: server-only, permanently.

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly aiConfig: AiConfigService,
    private readonly events: RunEventsService,
    private readonly runs: TrainingRunsService,
    @Optional() @Inject(TRAINING_RUN_HANDLER_OPTIONS) options?: TrainingRunHandlerOptions,
    @Optional() private readonly plannerContext?: PlannerContextLoader,
    @Optional() private readonly programs?: TrainingProgramsPort,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly evaluation?: EvaluationContextLoader,
  ) {
    this.options = options ?? {};
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** A shutdown stops every run this process executes; each ends `interrupted` at its checkpoint. */
  onModuleDestroy(): void {
    for (const controller of this.running.values()) controller.abort(new TrainingRunAbort('shutdown'));
  }

  async process(job: Job): Promise<void> {
    const parsed = trainingPlanRunPayloadSchema.safeParse(job.payload);

    if (!parsed.success) {
      throw new Error(`Invalid ${TRAINING_RUN_JOB_TYPE} payload: expected { runId }`);
    }

    const { runId } = parsed.data;
    const run = await this.prisma.trainingPlanRun.findUnique({ where: { id: runId } });

    if (!run) {
      this.logger.warn(`Training run ${runId} no longer exists; job ${job.id} is a no-op`);
      return;
    }

    if (run.status !== 'queued') {
      // Finished, cancelled before the claim, or already taken by another job.
      this.logger.log(`Training run ${runId} is ${run.status}; job ${job.id} is a no-op`);
      return;
    }

    if (run.cancelRequestedAt) {
      await this.finish(run, ['queued'], { status: 'cancelled' });
      return;
    }

    try {
      await this.aiConfig.assertEnabled();
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      // The kill switch: no provider call, no retry, no `jobs.job_failed`.
      await this.finish(run, ['queued'], { status: 'failed', errorCode: error.code, errorMessage: error.message });
      return;
    }

    const saver = this.options.checkpointer?.() ?? new PrismaCheckpointSaver(this.prisma);
    const hasCheckpoint = (await saver.getTuple({ configurable: { thread_id: runId } })) !== undefined;
    const now = new Date();
    const jobIds = Array.isArray(run.jobIds) ? (run.jobIds as unknown[]).map(String) : [];

    const claimed = await this.prisma.trainingPlanRun.updateMany({
      where: { id: runId, status: 'queued', cancelRequestedAt: null },
      data: {
        status: 'running',
        jobId: job.id,
        jobIds: jobIds.includes(job.id) ? jobIds : [...jobIds, job.id],
        startedAt: run.startedAt ?? now,
        heartbeatAt: now,
      },
    });

    if (claimed.count === 0) {
      this.logger.log(`Training run ${runId} changed state before it could start; job ${job.id} is a no-op`);
      return;
    }

    const decision = hasCheckpoint ? decisionOf(run.pendingDecision) : null;

    await this.events.emit(
      runId,
      hasCheckpoint ? 'run.resumed' : 'run.started',
      hasCheckpoint
        ? { resumeCount: run.resumeCount, ...(decision ? { decision: decision.decision } : {}) }
        : { kind: run.kind },
    );

    await this.execute({ ...run, status: 'running' }, job, saver, hasCheckpoint, decision);
  }

  /**
   * The safety net: a job of this type that settled FAILED while its run is
   * still executing on it. Reads one row, writes the run's status and queues
   * at most one resume job.
   */
  @OnEvent(JOB_SETTLED_EVENT)
  async onJobSettled(event: JobSettledEvent): Promise<void> {
    if (event.type !== TRAINING_RUN_JOB_TYPE || event.succeeded) return;
    if (event.subjectType !== TRAINING_RUN_SUBJECT_TYPE || !event.subjectId) return;

    try {
      const run = await this.prisma.trainingPlanRun.findUnique({ where: { id: event.subjectId } });
      if (!run || run.jobId !== event.jobId || (run.status !== 'running' && run.status !== 'queued')) return;

      if (run.resumeCount >= MAX_AUTO_RESUMES) {
        await this.finish(run, [run.status as TrainingRunStatus], {
          status: 'failed',
          errorCode: TRAINING_REASONS.RUN_LOST,
          errorMessage: 'The run was interrupted too many times.',
        });
        return;
      }

      const interrupted = await this.prisma.trainingPlanRun.updateMany({
        where: { id: run.id, status: run.status, jobId: event.jobId },
        data: { status: 'interrupted', heartbeatAt: null },
      });
      if (interrupted.count === 0) return;

      await this.events.emit(run.id, 'run.interrupted', { reason: 'lost' });

      const resumed = await this.runs.requeue(run.userId, run.id, 'interrupted', {
        resumeCount: { increment: 1 },
        resumeCountBelow: MAX_AUTO_RESUMES,
      });

      this.logger.warn(
        `Training run ${run.id} lost its job ${event.jobId}; ` +
          (resumed ? 'queued an automatic resume' : 'left interrupted'),
      );
    } catch (error) {
      this.logger.warn(
        `Could not recover training run ${event.subjectId} after job ${event.jobId} settled: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /** Refuses an admin delete of a still-runnable job whose run is active on it. */
  async canDelete(job: Job): Promise<string | null> {
    if (job.status === 'succeeded' || job.status === 'failed') return null;
    if (job.subjectType !== TRAINING_RUN_SUBJECT_TYPE || !job.subjectId) return null;

    const run = await this.prisma.trainingPlanRun.findUnique({
      where: { id: job.subjectId },
      select: { id: true, status: true, jobId: true },
    });

    if (!run || run.jobId !== job.id || !['queued', 'running'].includes(run.status)) return null;

    return (
      `Training run ${run.id} is '${run.status}' on this job; deleting it would strand the run. ` +
      'Cancel the run instead of deleting its job.'
    );
  }

  private async execute(
    run: RunRow,
    job: Job,
    saver: BaseCheckpointSaver,
    hasCheckpoint: boolean,
    decision: { decision: 'approve' | 'reject'; note?: string } | null,
  ): Promise<void> {
    const runId = run.id;
    const kind = run.kind as RunKind;
    const controller = new AbortController();
    const abort = (why: TrainingRunAbortReason) => {
      if (!controller.signal.aborted) controller.abort(new TrainingRunAbort(why));
    };

    this.running.set(runId, controller);

    const deadline = setTimeout(() => abort('deadline'), this.options.deadlineMs ?? TRAINING_RUN_DEADLINE_MS);
    const poll = setInterval(() => {
      void this.prisma.trainingPlanRun
        .findUnique({ where: { id: runId }, select: { cancelRequestedAt: true } })
        .then((row) => {
          if (!row || row.cancelRequestedAt) abort('cancel');
        })
        .catch(() => undefined);
    }, this.options.cancelPollMs ?? TRAINING_RUN_CANCEL_POLL_MS);
    const heartbeat = setInterval(() => {
      void this.prisma.trainingPlanRun
        .updateMany({ where: { id: runId, status: 'running' }, data: { heartbeatAt: new Date() } })
        .catch(() => undefined);
    }, this.options.heartbeatMs ?? TRAINING_RUN_HEARTBEAT_MS);

    deadline.unref?.();
    poll.unref?.();
    heartbeat.unref?.();

    const roleModels = (run.roleModels ?? {}) as Partial<Record<TrainingAgentRole, FrozenRoleModel>>;
    const budget = new RunBudget(run.tokenCap, parseRunUsage(run.usage));
    let usageWrite: Promise<unknown> = Promise.resolve();

    const span = tracer.startSpan(TRAINING_RUN_SPAN, {
      kind: SpanKind.INTERNAL,
      attributes: { 'run.id': runId, 'run.kind': kind, 'run.resumed': hasCheckpoint },
    });

    const agent = new AgentCaller({
      ai: this.ai.forUser(run.userId, { jobId: job.id }),
      signal: controller.signal,
      roleModels,
      budget,
      onUsage: async (report) => {
        const snapshot = budget.snapshot();
        usageWrite = usageWrite
          .then(() =>
            this.prisma.trainingPlanRun.updateMany({
              where: { id: runId },
              data: { usage: snapshot as unknown as Prisma.InputJsonValue },
            }),
          )
          .catch((error: unknown) =>
            this.logger.warn(`Could not record usage on training run ${runId}: ${errorName(error)}`),
          );

        await this.events.emit(
          runId,
          'agent.usage',
          {
            role: report.role,
            node: report.node,
            provider: report.provider,
            model: report.model,
            ...(report.round !== undefined ? { round: report.round } : {}),
            ...(report.step !== undefined ? { step: report.step } : {}),
            inputTokens: report.usage.inputTokens,
            outputTokens: report.usage.outputTokens,
            reasoningTokens: report.usage.reasoningTokens,
            latencyMs: report.latencyMs,
          },
          report.node,
        );
      },
    });

    const context: Omit<NodeContext, 'interrupt'> = {
      runId,
      userId: run.userId,
      jobId: job.id,
      kind,
      signal: controller.signal,
      roleModels,
      emit: async (type, data) => {
        await this.events.emit(runId, type, data ?? {});
      },
      agent,
      budget,
      contextBudget: new ContextBudget(),
      now: () => new Date(),
      ports: {
        ...(this.plannerContext ? { plannerContext: this.plannerContext } : {}),
        ...(this.programs ? { programs: this.programs } : {}),
        ...(this.notifications ? { notifications: this.notifications } : {}),
        ...(this.evaluation ? { evaluation: this.evaluation } : {}),
      },
    };

    const runner = trainingGraphRunner(kind, {
      checkpointer: saver,
      context,
      hooks: this.hooks(runId, budget, roleModels),
      ...(this.options.nodes ? { nodes: this.options.nodes } : {}),
    });

    const stored = storedInput(run.input);
    let status: TrainingRunStatus | 'deferred' = 'failed';

    try {
      let result: AgentGraphRunResult<RunState>;

      try {
        result = await runner.run({
          threadId: runId,
          signal: controller.signal,
          ...(!hasCheckpoint
            ? {
                input: initialRunState({
                  runId,
                  userId: run.userId,
                  kind,
                  programId: run.programId,
                  input: stored.request,
                  maxCriticRounds: stored.maxCriticRounds,
                }),
              }
            : decision
              ? { resume: decision }
              : {}),
        });
      } finally {
        clearTimeout(deadline);
        clearInterval(poll);
        clearInterval(heartbeat);
        this.running.delete(runId);
        await usageWrite;
      }

      status = await this.settleResult(run, result, budget);
    } catch (error) {
      try {
        status = await this.settleFailure(run, error, controller.signal, budget);
      } catch (rethrown) {
        status = rethrown instanceof RateLimitError ? 'deferred' : 'failed';
        throw rethrown;
      }
    } finally {
      const total = budget.snapshot().total;
      span.setAttribute('run.status', status);
      span.setAttribute('run.calls', total.calls);
      span.setAttribute('run.input_tokens', total.inputTokens);
      span.setAttribute('run.output_tokens', total.outputTokens);
      span.setAttribute('run.reasoning_tokens', total.reasoningTokens);
      span.setStatus(status === 'failed' ? { code: SpanStatusCode.ERROR, message: 'failed' } : { code: SpanStatusCode.OK });
      span.end();
    }
  }

  private async settleResult(
    run: RunRow,
    result: AgentGraphRunResult<RunState>,
    budget: RunBudget,
  ): Promise<TrainingRunStatus> {
    if (result.interrupt) {
      const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
      const moved = await this.prisma.trainingPlanRun.updateMany({
        where: { id: run.id, status: 'running' },
        data: {
          status: 'awaiting_approval',
          expiresAt,
          heartbeatAt: null,
          pendingDecision: Prisma.DbNull,
          usage: budget.snapshot() as unknown as Prisma.InputJsonValue,
        },
      });

      if (moved.count > 0) {
        await this.events.emit(run.id, 'run.awaiting_approval', {
          kind: result.interrupt.kind.slice(0, 64),
          expiresAt: expiresAt.toISOString(),
        });
      }

      return 'awaiting_approval';
    }

    const outcome = result.state.outcome;

    if (outcome?.status === 'safety_stop') {
      return this.finish(run, ['running'], {
        status: 'blocked_safety',
        errorCode: outcome.code ?? TRAINING_REASONS.SAFETY_STOP,
        budget,
      });
    }

    if (outcome?.status === 'rejected') {
      return this.finish(run, ['running'], {
        status: 'failed',
        errorCode: outcome.code ?? 'TRAINING_PLAN_REJECTED',
        errorMessage: 'The agents could not produce a plan that passes the checks.',
        budget,
      });
    }

    return this.finish(run, ['running'], {
      status: 'succeeded',
      result: {
        programId: outcome?.programId ?? result.state.programId ?? null,
        versionNumber: outcome?.versionNumber ?? null,
        changeLogId: outcome?.changeLogId ?? null,
        verdict: outcome?.verdict ?? outcome?.status ?? null,
        warnings: result.state.warnings ?? [],
      },
      budget,
    });
  }

  private async settleFailure(
    run: RunRow,
    error: unknown,
    signal: AbortSignal,
    budget: RunBudget,
  ): Promise<TrainingRunStatus | 'deferred'> {
    const why = signal.aborted && signal.reason instanceof TrainingRunAbort ? signal.reason.why : null;

    if (why === 'cancel') {
      return this.finish(run, ['running'], { status: 'cancelled', budget });
    }

    if (why === 'deadline' || why === 'shutdown') {
      const moved = await this.prisma.trainingPlanRun.updateMany({
        where: { id: run.id, status: 'running' },
        data: { status: 'interrupted', heartbeatAt: null, usage: budget.snapshot() as unknown as Prisma.InputJsonValue },
      });
      if (moved.count > 0) await this.events.emit(run.id, 'run.interrupted', { reason: why });
      this.logger.log(`Training run ${run.id} interrupted (${why}); it resumes from its checkpoint`);
      return 'interrupted';
    }

    const cause = knownCause(error);

    if (cause instanceof RunDeferredError || (cause instanceof AiError && cause.code === 'AI_RATE_LIMITED')) {
      const aiError = cause instanceof RunDeferredError ? cause.aiError : cause;
      const moved = await this.prisma.trainingPlanRun.updateMany({
        where: { id: run.id, status: 'running' },
        data: { status: 'queued', heartbeatAt: null, usage: budget.snapshot() as unknown as Prisma.InputJsonValue },
      });
      if (moved.count > 0) {
        await this.events.emit(run.id, 'run.deferred', { retryAfterMs: aiError.retryAfterMs ?? null });
      }
      throw aiError.toRateLimitError() ?? aiError;
    }

    if (cause instanceof RunBudgetExceededError) {
      return this.finish(run, ['running'], {
        status: 'failed',
        errorCode: TRAINING_REASONS.BUDGET_EXCEEDED,
        errorMessage: cause.message,
        budget,
      });
    }

    if (cause instanceof TrainingSafetyStopError) {
      return this.finish(run, ['running'], { status: 'blocked_safety', errorCode: cause.code, budget });
    }

    if (
      cause instanceof TrainingContextTooLargeError ||
      cause instanceof AgentOutputTruncated ||
      cause instanceof TrainingRunFailedError
    ) {
      return this.finish(run, ['running'], {
        status: 'failed',
        errorCode: cause.code,
        errorMessage: cause.message,
        budget,
      });
    }

    if (cause instanceof AiError) {
      await this.finish(run, ['running'], {
        status: 'failed',
        errorCode: cause.code,
        errorMessage: cause.message,
        budget,
      });

      if (AI_RUN_TERMINAL_CODES.has(cause.code)) {
        this.logger.log(`Training run ${run.id} ended with ${cause.code}`);
        return 'failed';
      }

      throw cause;
    }

    await this.finish(run, ['running'], {
      status: 'failed',
      errorCode: TRAINING_REASONS.INTERNAL_ERROR,
      errorMessage: 'The training run failed unexpectedly.',
      budget,
    });

    throw error;
  }

  /**
   * Moves the run from one of `from` to a terminal `status` (guarded, so a
   * late writer never overwrites a finished run), appends the matching event
   * and the audit row. Returns the status written (or asked for).
   */
  private async finish(
    run: RunRow,
    from: TrainingRunStatus[],
    change: {
      status: Extract<TrainingRunStatus, 'succeeded' | 'failed' | 'cancelled' | 'blocked_safety'>;
      errorCode?: string;
      errorMessage?: string;
      result?: Record<string, unknown>;
      budget?: RunBudget;
    },
  ): Promise<TrainingRunStatus> {
    const usage = change.budget?.snapshot();
    const moved = await this.prisma.trainingPlanRun.updateMany({
      where: { id: run.id, status: { in: from } },
      data: {
        status: change.status,
        completedAt: new Date(),
        heartbeatAt: null,
        pendingDecision: Prisma.DbNull,
        ...(change.errorCode ? { errorCode: change.errorCode } : {}),
        ...(change.errorMessage ? { errorMessage: change.errorMessage } : {}),
        ...(change.result ? { result: change.result as Prisma.InputJsonValue } : {}),
        ...(usage ? { usage: usage as unknown as Prisma.InputJsonValue } : {}),
      },
    });

    if (moved.count === 0) return change.status;

    const tokens = usage ? usage.total : parseRunUsage(run.usage).total;

    if (change.status === 'cancelled') {
      await this.events.emit(run.id, 'run.cancelled', {});
    } else if (change.status === 'failed') {
      await this.events.emit(run.id, 'run.failed', { code: change.errorCode ?? TRAINING_REASONS.INTERNAL_ERROR });
    } else {
      await this.events.emit(run.id, 'run.completed', { status: change.status, tokens });
    }

    await auditTrainingRun(this.prisma, this.logger, run.userId, TRAINING_RUN_AUDIT_ACTIONS.COMPLETE, {
      runId: run.id,
      kind: run.kind,
      status: change.status,
      errorCode: change.errorCode ?? null,
      tokens: countedTokens(tokens),
      roles: Object.keys((run.roleModels ?? {}) as object),
    });

    return change.status;
  }

  /** Stage column, stage events and one span per node execution. */
  private hooks(
    runId: string,
    budget: RunBudget,
    roleModels: Partial<Record<TrainingAgentRole, FrozenRoleModel>>,
  ): GraphHooks {
    const open = new Map<string, { span: Span; before: ReturnType<RunBudget['snapshot']> }>();

    return {
      nodeStarted: async (node, state) => {
        const round = roundFor(node, state);
        open.set(node, {
          span: tracer.startSpan(`${TRAINING_NODE_SPAN_PREFIX}${node}`, {
            kind: SpanKind.INTERNAL,
            attributes: { 'run.id': runId, ...(round !== undefined ? { round } : {}) },
          }),
          before: budget.snapshot(),
        });

        await this.prisma.trainingPlanRun
          .updateMany({ where: { id: runId, status: 'running' }, data: { stage: node } })
          .catch(() => undefined);
        await this.events.emit(runId, 'stage.started', { node, ...(round !== undefined ? { round } : {}) }, node);
      },
      nodeFinished: async (node, state, outcome) => {
        const round = roundFor(node, state);
        const entry = open.get(node);
        open.delete(node);

        if (entry) {
          const after = budget.snapshot();
          const roles = (Object.keys(after.byRole) as TrainingAgentRole[]).filter(
            (role) => (after.byRole[role]?.calls ?? 0) > (entry.before.byRole[role]?.calls ?? 0),
          );
          const model = roles.length === 1 ? roleModels[roles[0]] : undefined;

          entry.span.setAttributes({
            status: outcome.status,
            input_tokens: after.total.inputTokens - entry.before.total.inputTokens,
            output_tokens: after.total.outputTokens - entry.before.total.outputTokens,
            ...(roles.length > 0 ? { role: roles.join(',') } : {}),
            ...(model
              ? { provider: model.provider, model: model.modelId, ...(model.effort ? { effort: model.effort } : {}) }
              : {}),
          });
          entry.span.setStatus(
            outcome.status === 'error' ? { code: SpanStatusCode.ERROR, message: 'node failed' } : { code: SpanStatusCode.OK },
          );
          entry.span.end();
        }

        if (outcome.status === 'ok') {
          await this.events.emit(
            runId,
            'stage.completed',
            { node, ...(round !== undefined ? { round } : {}), durationMs: outcome.durationMs },
            node,
          );
        }
      },
    };
  }
}

/** The critic round a `plan` or `critique` node execution belongs to. */
function roundFor(node: string, state: RunState): number | undefined {
  const done = state.roundCounters?.critique ?? 0;
  if (node === 'critique') return done + 1;
  if (node === 'plan') return done;
  return undefined;
}

function decisionOf(value: unknown): { decision: 'approve' | 'reject'; note?: string } | null {
  const v = value as { decision?: unknown; note?: unknown } | null;
  if (!v || (v.decision !== 'approve' && v.decision !== 'reject')) return null;

  return { decision: v.decision, ...(typeof v.note === 'string' ? { note: v.note } : {}) };
}

/** The first error in the `cause` chain this handler knows how to map, else the error itself. */
function knownCause(error: unknown): unknown {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (
      current instanceof AiError ||
      current instanceof RunDeferredError ||
      current instanceof RunBudgetExceededError ||
      current instanceof TrainingSafetyStopError ||
      current instanceof TrainingContextTooLargeError ||
      current instanceof AgentOutputTruncated ||
      current instanceof TrainingRunFailedError
    ) {
      return current;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return error;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}
