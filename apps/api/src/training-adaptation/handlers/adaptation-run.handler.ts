// =============================================================================
// `ai.training.adapt.run`: executes one quick workout adaptation's graph
// =============================================================================
//
// Payload `{ adaptationId }`, subject `training_adaptation` / the adaptation
// id. Enqueued by `AdaptationService.create` in the transaction that created
// the adaptation and its kit run (`training_plan_runs`, kind `adapt`).
//
// SERVER-ONLY, PERMANENTLY. No `nodeResultSchema` / `persistNodeResult`: the
// run spends the user's own provider key (or the org key), and no AI key may
// ever reach a worker node (CLAUDE.md queue rule 3 and AI rule 3).
//
// PROFILE `{ maxRuntimeMs: 5 min, maxAttempts: 1 }`: one generate, one
// critic, at most one revise. A model call is neither idempotent nor free,
// so the queue never retries the job; "Try again" is a new adaptation.
//
// ON THE KIT. The graph runs through the kit's LangGraph runner and
// `PrismaCheckpointSaver` (thread = the kit run id), its `AgentCaller` (the
// one door to `AiService.forUser`, the frozen models, the token budget,
// `agent.usage` events), the persisted event log (`GET
// /api/ai/training/stream/:runId` replays it) and the kit's cancel column
// (`training_plan_runs.cancel_requested_at`, polled here).
//
// OUTCOMES (the adaptation row is what the user reads; the run mirrors it):
//
//   graph ready                      adaptation `ready`, run `succeeded`      job returns
//   graph blocked (safety screen)    `blocked_safety` (no provider call)       job returns
//   cancel observed                  `cancelled`                               job returns
//   deadline or shutdown             `failed` ADAPTATION_TIMEOUT               job returns
//   terminal AI code                 `failed` with the code                    job returns
//   AI_RATE_LIMITED                  both back to `queued`, `run.deferred`     job DEFERRED; the graph
//                                                                              resumes from its checkpoint
//   RunBudgetExceededError           `failed` TRAINING_RUN_BUDGET_EXCEEDED     job returns
//   TrainingRunFailedError (a rule)  `failed` with its code and message        job returns
//   anything else                    `failed` INTERNAL_ERROR                   job THROWS
//
// SETTLE SAFETY NET. A job of this type that settles FAILED while its
// adaptation is still `queued` or `running` on it (a crash, a lost lease)
// fails the orphan `ADAPTATION_RUN_LOST` (the `AiMediaRunHandler` idiom).
//
// NO PROMPT TEXT, MODEL OUTPUT, USER TEXT OR KEY in any log line, span
// attribute or event written here: ids, statuses, codes, counts.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { type Job, Prisma, type TrainingPlanRun, type WorkoutAdaptation } from '@prisma/client';
import { z } from 'zod';

import { AiConfigService } from '../../ai/config/ai-config.service';
import { AiError } from '../../ai/core/ai-error';
import { AI_RUN_TERMINAL_CODES } from '../../ai/runtime/ai-response-run.handler';
import { AiService } from '../../ai/runtime/ai.service';
import { resolveServiceName } from '../../common/otel/telemetry-identity';
import type { TrainingAgentRole } from '../../common/schemas/settings.schema';
import { JOB_SETTLED_EVENT, type JobSettledEvent } from '../../jobs/events/job-settled.event';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { PrismaService } from '../../prisma/prisma.service';
import type { AdaptCheckpointer, AdaptGraphHooks, AdaptNodeFn } from '../../training-agents/graph/adapt-graph';
import { type AdaptGraphNodeName, type AdaptRunState, initialAdaptRunState } from '../../training-agents/graph/adapt-run-state';
import type { AgentGraphRunResult } from '../../training-agents/graph/agent-graph-runner.interface';
import type { FrozenRoleModel } from '../../training-agents/graph/node-context';
import { AgentCaller, AgentOutputTruncated, RunDeferredError } from '../../training-agents/runtime/agent-caller';
import { PrismaCheckpointSaver } from '../../training-agents/runtime/prisma-checkpoint-saver';
import { RunBudget, RunBudgetExceededError, countedTokens, parseRunUsage } from '../../training-agents/runtime/run-budget';
import { RunEventsService } from '../../training-agents/runtime/run-events.service';
import { TRAINING_RUN_AUDIT_ACTIONS, auditTrainingRun } from '../../training-agents/runtime/training-run-audit';
import {
  TrainingRunAbort,
  type TrainingRunAbortReason,
  TrainingRunFailedError,
  TrainingSafetyStopError,
} from '../../training-agents/runtime/training-run-errors';
import { TRAINING_REASONS } from '../../training-agents/runtime/training-runs.constants';
import {
  ADAPTATION_CANCEL_POLL_MS,
  ADAPTATION_HEARTBEAT_MS,
  ADAPTATION_REASONS,
  ADAPTATION_RUN_DEADLINE_MS,
  ADAPTATION_RUN_JOB_TYPE,
  ADAPTATION_RUN_MAX_RUNTIME_MS,
  ADAPTATION_SUBJECT_TYPE,
  ADAPT_MAX_REVISIONS,
  type AdaptationStatus,
} from '../adaptation.constants';
import { AdaptationContextBuilder, type AdaptationContextPort } from '../context/adaptation-context.builder';
import { adaptationGraphRunner } from '../graph/adaptation.graph';
import type { AdaptationNodeContext } from '../graph/node-context';
import { resultOf } from '../graph/state';

export const adaptationRunPayloadSchema = z.object({ adaptationId: z.string().uuid() });

/** Root span of one job's execution of an adaptation. */
export const ADAPTATION_RUN_SPAN = 'training.adaptation.run';
/** Prefix of each node's span (`training.adaptation.node.adapt`). */
export const ADAPTATION_NODE_SPAN_PREFIX = 'training.adaptation.node.';

const tracer = trace.getTracer(resolveServiceName());

/** Optional knobs, for tests: timings, node implementations, the checkpointer and the context port. Never configuration. */
export const ADAPTATION_RUN_HANDLER_OPTIONS = Symbol('ADAPTATION_RUN_HANDLER_OPTIONS');

export interface AdaptationRunHandlerOptions {
  deadlineMs?: number;
  cancelPollMs?: number;
  heartbeatMs?: number;
  nodes?: Partial<Record<AdaptGraphNodeName, AdaptNodeFn<AdaptationNodeContext>>>;
  /** The checkpointer per job; default a `PrismaCheckpointSaver` over the app's Prisma. */
  checkpointer?: () => AdaptCheckpointer;
  /** The context builder the `context` node calls; default `AdaptationContextBuilder`. */
  contextPort?: AdaptationContextPort;
}

type TerminalStatus = Extract<AdaptationStatus, 'ready' | 'failed' | 'cancelled' | 'blocked_safety'>;

/** The kit run's status for each terminal adaptation status. */
const RUN_STATUS: Record<TerminalStatus, 'succeeded' | 'failed' | 'cancelled' | 'blocked_safety'> = {
  ready: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  blocked_safety: 'blocked_safety',
};

interface Change {
  status: TerminalStatus;
  errorCode?: string;
  errorMessage?: string;
  /** Extra columns for the adaptation row (the result, the snapshot, safety). */
  data?: Prisma.WorkoutAdaptationUpdateManyMutationInput;
  budget?: RunBudget;
}

@Injectable()
export class AdaptationRunHandler implements JobHandler, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdaptationRunHandler.name);
  private readonly running = new Map<string, AbortController>();
  private readonly options: AdaptationRunHandlerOptions;

  /** PERMANENT once jobs of this type exist. */
  readonly type = ADAPTATION_RUN_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: ADAPTATION_RUN_MAX_RUNTIME_MS, maxAttempts: 1 };

  // NO nodeResultSchema, NO persistNodeResult: server-only, permanently.

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly aiConfig: AiConfigService,
    private readonly events: RunEventsService,
    private readonly contextBuilder: AdaptationContextBuilder,
    @Optional() @Inject(ADAPTATION_RUN_HANDLER_OPTIONS) options?: AdaptationRunHandlerOptions,
  ) {
    this.options = options ?? {};
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** A shutdown stops every adaptation this process executes. */
  onModuleDestroy(): void {
    for (const controller of this.running.values()) controller.abort(new TrainingRunAbort('shutdown'));
  }

  async process(job: Job): Promise<void> {
    const parsed = adaptationRunPayloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      throw new Error(`Invalid ${ADAPTATION_RUN_JOB_TYPE} payload: expected { adaptationId }`);
    }

    const { adaptationId } = parsed.data;
    const adaptation = await this.prisma.workoutAdaptation.findUnique({ where: { id: adaptationId } });

    if (!adaptation) {
      this.logger.warn(`Adaptation ${adaptationId} no longer exists; job ${job.id} is a no-op`);
      return;
    }
    if (adaptation.status !== 'queued') {
      this.logger.log(`Adaptation ${adaptationId} is ${adaptation.status}; job ${job.id} is a no-op`);
      return;
    }

    const run = adaptation.runId ? await this.prisma.trainingPlanRun.findUnique({ where: { id: adaptation.runId } }) : null;

    if (!run) {
      await this.finish(adaptation, null, ['queued'], {
        status: 'failed',
        errorCode: ADAPTATION_REASONS.RUN_LOST,
        errorMessage: 'The adaptation lost its run.',
      });
      return;
    }

    if (run.cancelRequestedAt || run.status === 'cancelled') {
      await this.finish(adaptation, run, ['queued'], { status: 'cancelled' });
      return;
    }

    try {
      await this.aiConfig.assertEnabled();
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      // The kill switch: no provider call, no retry, no `jobs.job_failed`.
      await this.finish(adaptation, run, ['queued'], { status: 'failed', errorCode: error.code, errorMessage: error.message });
      return;
    }

    const saver = this.options.checkpointer?.() ?? new PrismaCheckpointSaver(this.prisma);
    const hasCheckpoint = (await saver.getTuple({ configurable: { thread_id: run.id } })) !== undefined;
    const now = new Date();

    const claimed = await this.prisma.workoutAdaptation.updateMany({
      where: { id: adaptationId, status: 'queued' },
      data: { status: 'running', jobId: job.id },
    });
    if (claimed.count === 0) {
      this.logger.log(`Adaptation ${adaptationId} changed state before it could start; job ${job.id} is a no-op`);
      return;
    }

    const jobIds = Array.isArray(run.jobIds) ? (run.jobIds as unknown[]).map(String) : [];
    await this.prisma.trainingPlanRun.updateMany({
      where: { id: run.id, status: 'queued' },
      data: {
        status: 'running',
        jobId: job.id,
        jobIds: jobIds.includes(job.id) ? jobIds : [...jobIds, job.id],
        startedAt: run.startedAt ?? now,
        heartbeatAt: now,
      },
    });

    await this.events.emit(
      run.id,
      hasCheckpoint ? 'run.resumed' : 'run.started',
      hasCheckpoint ? { resumeCount: run.resumeCount } : { kind: run.kind },
    );

    await this.execute({ ...adaptation, status: 'running' }, { ...run, status: 'running' }, job, saver, hasCheckpoint);
  }

  /** The safety net: a job of this type settled FAILED while its adaptation is still active on it. */
  @OnEvent(JOB_SETTLED_EVENT)
  async onJobSettled(event: JobSettledEvent): Promise<void> {
    if (event.type !== ADAPTATION_RUN_JOB_TYPE || event.succeeded) return;
    if (event.subjectType !== ADAPTATION_SUBJECT_TYPE || !event.subjectId) return;

    try {
      const adaptation = await this.prisma.workoutAdaptation.findUnique({ where: { id: event.subjectId } });
      if (!adaptation || adaptation.jobId !== event.jobId) return;
      if (adaptation.status !== 'queued' && adaptation.status !== 'running') return;

      const run = adaptation.runId ? await this.prisma.trainingPlanRun.findUnique({ where: { id: adaptation.runId } }) : null;
      await this.finish(adaptation, run, ['queued', 'running'], {
        status: 'failed',
        errorCode: ADAPTATION_REASONS.RUN_LOST,
        errorMessage: 'The adaptation stopped unexpectedly. Try again.',
      });
      this.logger.warn(`Adaptation ${adaptation.id} lost its job ${event.jobId}; marked failed`);
    } catch (error) {
      this.logger.warn(
        `Could not settle adaptation ${event.subjectId} after job ${event.jobId}: ` +
          (error instanceof Error ? error.name : 'unknown error'),
      );
    }
  }

  /** Refuses an admin delete of a still-runnable job whose adaptation is active on it. */
  async canDelete(job: Job): Promise<string | null> {
    if (job.status === 'succeeded' || job.status === 'failed') return null;
    if (job.subjectType !== ADAPTATION_SUBJECT_TYPE || !job.subjectId) return null;

    const adaptation = await this.prisma.workoutAdaptation.findUnique({
      where: { id: job.subjectId },
      select: { id: true, status: true, jobId: true },
    });
    if (!adaptation || adaptation.jobId !== job.id || !['queued', 'running'].includes(adaptation.status)) return null;

    return (
      `Adaptation ${adaptation.id} is '${adaptation.status}' on this job; deleting it would strand it. ` +
      'Cancel the adaptation instead of deleting its job.'
    );
  }

  private async execute(
    adaptation: WorkoutAdaptation,
    run: TrainingPlanRun,
    job: Job,
    saver: AdaptCheckpointer,
    hasCheckpoint: boolean,
  ): Promise<void> {
    const controller = new AbortController();
    const abort = (why: TrainingRunAbortReason) => {
      if (!controller.signal.aborted) controller.abort(new TrainingRunAbort(why));
    };

    this.running.set(adaptation.id, controller);

    const deadline = setTimeout(() => abort('deadline'), this.options.deadlineMs ?? ADAPTATION_RUN_DEADLINE_MS);
    const poll = setInterval(() => {
      void this.prisma.trainingPlanRun
        .findUnique({ where: { id: run.id }, select: { cancelRequestedAt: true } })
        .then((row) => {
          if (!row || row.cancelRequestedAt) abort('cancel');
        })
        .catch(() => undefined);
    }, this.options.cancelPollMs ?? ADAPTATION_CANCEL_POLL_MS);
    const heartbeat = setInterval(() => {
      void this.prisma.trainingPlanRun
        .updateMany({ where: { id: run.id, status: 'running' }, data: { heartbeatAt: new Date() } })
        .catch(() => undefined);
    }, this.options.heartbeatMs ?? ADAPTATION_HEARTBEAT_MS);

    deadline.unref?.();
    poll.unref?.();
    heartbeat.unref?.();

    const roleModels = (run.roleModels ?? {}) as Partial<Record<TrainingAgentRole, FrozenRoleModel>>;
    const budget = new RunBudget(run.tokenCap, parseRunUsage(run.usage));
    let usageWrite: Promise<unknown> = Promise.resolve();

    const span = tracer.startSpan(ADAPTATION_RUN_SPAN, {
      kind: SpanKind.INTERNAL,
      attributes: { 'adaptation.id': adaptation.id, 'run.id': run.id, 'run.resumed': hasCheckpoint },
    });

    const agent = new AgentCaller({
      ai: this.ai.forUser(adaptation.userId, { jobId: job.id }),
      signal: controller.signal,
      roleModels,
      budget,
      onUsage: async (report) => {
        const snapshot = budget.snapshot();
        usageWrite = usageWrite
          .then(() =>
            this.prisma.trainingPlanRun.updateMany({
              where: { id: run.id },
              data: { usage: snapshot as unknown as Prisma.InputJsonValue },
            }),
          )
          .catch(() => this.logger.warn(`Could not record usage on adaptation run ${run.id}`));

        await this.events.emit(
          run.id,
          'agent.usage',
          {
            role: report.role,
            node: report.node,
            provider: report.provider,
            model: report.model,
            ...(report.round !== undefined ? { round: report.round } : {}),
            inputTokens: report.usage.inputTokens,
            outputTokens: report.usage.outputTokens,
            reasoningTokens: report.usage.reasoningTokens,
            latencyMs: report.latencyMs,
          },
          report.node,
        );
      },
    });

    const context: AdaptationNodeContext = {
      runId: run.id,
      userId: adaptation.userId,
      jobId: job.id,
      adaptationId: adaptation.id,
      signal: controller.signal,
      roleModels,
      agent,
      budget,
      emit: async (type, data) => {
        await this.events.emit(run.id, type, data ?? {});
      },
      now: () => new Date(),
      contextPort: this.options.contextPort ?? this.contextBuilder,
    };

    const runner = adaptationGraphRunner({
      checkpointer: saver,
      context,
      hooks: this.hooks(run.id, adaptation.id, budget, roleModels),
      ...(this.options.nodes ? { nodes: this.options.nodes } : {}),
    });

    let status: TerminalStatus | 'deferred' = 'failed';

    try {
      let result: AgentGraphRunResult<AdaptRunState>;
      try {
        result = await runner.run({
          threadId: run.id,
          signal: controller.signal,
          ...(!hasCheckpoint
            ? {
                input: initialAdaptRunState({
                  runId: run.id,
                  userId: adaptation.userId,
                  adaptationId: adaptation.id,
                  request: (adaptation.request ?? {}) as Record<string, unknown>,
                  maxRevisions: ADAPT_MAX_REVISIONS,
                }),
              }
            : {}),
        });
      } finally {
        clearTimeout(deadline);
        clearInterval(poll);
        clearInterval(heartbeat);
        this.running.delete(adaptation.id);
        await usageWrite;
      }

      status = await this.settleResult(adaptation, run, result.state, budget);
    } catch (error) {
      try {
        status = await this.settleFailure(adaptation, run, error, controller.signal, budget);
      } catch (rethrown) {
        status = rethrown instanceof RateLimitError ? 'deferred' : 'failed';
        throw rethrown;
      }
    } finally {
      const total = budget.snapshot().total;
      span.setAttribute('adaptation.status', status);
      span.setAttribute('run.calls', total.calls);
      span.setAttribute('run.input_tokens', total.inputTokens);
      span.setAttribute('run.output_tokens', total.outputTokens);
      span.setAttribute('run.reasoning_tokens', total.reasoningTokens);
      span.setStatus(status === 'failed' ? { code: SpanStatusCode.ERROR, message: 'failed' } : { code: SpanStatusCode.OK });
      span.end();
    }
  }

  private async settleResult(
    adaptation: WorkoutAdaptation,
    run: TrainingPlanRun,
    state: AdaptRunState,
    budget: RunBudget,
  ): Promise<TerminalStatus> {
    const context = state.adaptationContext as { safety?: unknown; sent?: unknown; summary?: unknown; version?: unknown } | null;

    if (state.outcome?.status === 'blocked_safety') {
      return this.finish(adaptation, run, ['running'], {
        status: 'blocked_safety',
        errorCode: state.outcome.code ?? ADAPTATION_REASONS.SAFETY_STOP,
        data: {
          ...(context?.safety ? { safety: context.safety as Prisma.InputJsonValue } : {}),
          ...(context?.sent
            ? { contextSnapshot: { version: context.version, sent: context.sent, summary: context.summary } as Prisma.InputJsonValue }
            : {}),
        },
        budget,
      });
    }

    const result = resultOf(state);
    if (!result) {
      return this.finish(adaptation, run, ['running'], {
        status: 'failed',
        errorCode: ADAPTATION_REASONS.INVALID,
        errorMessage: 'The adaptation finished without a proposal.',
        budget,
      });
    }

    return this.finish(adaptation, run, ['running'], {
      status: 'ready',
      data: {
        proposal: result.proposal as unknown as Prisma.InputJsonValue,
        guardrailReport: result.guardrailReport as unknown as Prisma.InputJsonValue,
        criticReport: result.criticReport as unknown as Prisma.InputJsonValue,
        contextSnapshot: result.contextSnapshot as unknown as Prisma.InputJsonValue,
        safety: result.safety as unknown as Prisma.InputJsonValue,
      },
      budget,
    });
  }

  private async settleFailure(
    adaptation: WorkoutAdaptation,
    run: TrainingPlanRun,
    error: unknown,
    signal: AbortSignal,
    budget: RunBudget,
  ): Promise<TerminalStatus | 'deferred'> {
    const why = signal.aborted && signal.reason instanceof TrainingRunAbort ? signal.reason.why : null;

    if (why === 'cancel') {
      return this.finish(adaptation, run, ['running'], { status: 'cancelled', budget });
    }

    if (why === 'deadline' || why === 'shutdown') {
      return this.finish(adaptation, run, ['running'], {
        status: 'failed',
        errorCode: ADAPTATION_REASONS.TIMEOUT,
        errorMessage: why === 'deadline' ? 'The adaptation took too long. Try again.' : 'The server restarted. Try again.',
        budget,
      });
    }

    const cause = knownCause(error);

    if (cause instanceof RunDeferredError || (cause instanceof AiError && cause.code === 'AI_RATE_LIMITED')) {
      const aiError = cause instanceof RunDeferredError ? cause.aiError : cause;
      // Back to `queued` on both rows; the deferred job re-claims them and the
      // graph continues from its last checkpoint.
      await this.prisma.workoutAdaptation.updateMany({
        where: { id: adaptation.id, status: 'running' },
        data: { status: 'queued' },
      });
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
      return this.finish(adaptation, run, ['running'], {
        status: 'failed',
        errorCode: TRAINING_REASONS.BUDGET_EXCEEDED,
        errorMessage: cause.message,
        budget,
      });
    }

    if (cause instanceof TrainingSafetyStopError) {
      return this.finish(adaptation, run, ['running'], { status: 'blocked_safety', errorCode: cause.code, budget });
    }

    if (cause instanceof TrainingRunFailedError || cause instanceof AgentOutputTruncated) {
      return this.finish(adaptation, run, ['running'], {
        status: 'failed',
        errorCode: cause.code,
        errorMessage: cause.message,
        budget,
      });
    }

    if (cause instanceof AiError) {
      await this.finish(adaptation, run, ['running'], {
        status: 'failed',
        errorCode: cause.code,
        errorMessage: cause.message,
        budget,
      });

      if (AI_RUN_TERMINAL_CODES.has(cause.code)) {
        this.logger.log(`Adaptation ${adaptation.id} ended with ${cause.code}`);
        return 'failed';
      }
      throw cause;
    }

    await this.finish(adaptation, run, ['running'], {
      status: 'failed',
      errorCode: TRAINING_REASONS.INTERNAL_ERROR,
      errorMessage: 'The adaptation failed unexpectedly.',
      budget,
    });
    throw error;
  }

  /**
   * Moves the adaptation from one of `from` to a terminal status (guarded, so
   * a late writer never overwrites a finished adaptation), mirrors it on the
   * kit run, appends the run's terminal event and the audit row.
   */
  private async finish(
    adaptation: WorkoutAdaptation,
    run: TrainingPlanRun | null,
    from: AdaptationStatus[],
    change: Change,
  ): Promise<TerminalStatus> {
    const usage = change.budget?.snapshot();

    const moved = await this.prisma.workoutAdaptation.updateMany({
      where: { id: adaptation.id, status: { in: from } },
      data: {
        status: change.status,
        ...(change.errorCode ? { errorCode: change.errorCode } : {}),
        ...(change.errorMessage ? { errorMessage: change.errorMessage } : {}),
        ...(change.data ?? {}),
      },
    });

    if (!run) return change.status;

    const runMoved = await this.prisma.trainingPlanRun.updateMany({
      where: { id: run.id, status: { in: ['queued', 'running'] } },
      data: {
        status: RUN_STATUS[change.status],
        completedAt: new Date(),
        heartbeatAt: null,
        ...(change.errorCode ? { errorCode: change.errorCode } : {}),
        ...(change.errorMessage ? { errorMessage: change.errorMessage } : {}),
        ...(change.status === 'ready' ? { result: { adaptationId: adaptation.id } as Prisma.InputJsonValue } : {}),
        ...(usage ? { usage: usage as unknown as Prisma.InputJsonValue } : {}),
      },
    });

    if (moved.count === 0 && runMoved.count === 0) return change.status;

    const tokens = usage ? usage.total : parseRunUsage(run.usage).total;
    if (runMoved.count > 0) {
      if (change.status === 'cancelled') {
        await this.events.emit(run.id, 'run.cancelled', {});
      } else if (change.status === 'failed') {
        await this.events.emit(run.id, 'run.failed', { code: change.errorCode ?? TRAINING_REASONS.INTERNAL_ERROR });
      } else {
        await this.events.emit(run.id, 'run.completed', { status: RUN_STATUS[change.status], tokens });
      }
    }

    await auditTrainingRun(this.prisma, this.logger, adaptation.userId, TRAINING_RUN_AUDIT_ACTIONS.COMPLETE, {
      runId: run.id,
      kind: run.kind,
      status: RUN_STATUS[change.status],
      errorCode: change.errorCode ?? null,
      tokens: countedTokens(tokens),
      roles: Object.keys((run.roleModels ?? {}) as object),
    });

    return change.status;
  }

  /** Stage column, stage events and one span per node execution. */
  private hooks(
    runId: string,
    adaptationId: string,
    budget: RunBudget,
    roleModels: Partial<Record<TrainingAgentRole, FrozenRoleModel>>,
  ): AdaptGraphHooks {
    const open = new Map<string, { span: Span; before: ReturnType<RunBudget['snapshot']> }>();

    return {
      nodeStarted: async (node, state) => {
        const round = roundFor(node, state);
        open.set(node, {
          span: tracer.startSpan(`${ADAPTATION_NODE_SPAN_PREFIX}${node}`, {
            kind: SpanKind.INTERNAL,
            attributes: { 'run.id': runId, 'adaptation.id': adaptationId, ...(round !== undefined ? { round } : {}) },
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
            ...(model ? { provider: model.provider, model: model.modelId, ...(model.effort ? { effort: model.effort } : {}) } : {}),
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

/** The planner pass an `adapt` node or the critic round a `critic` node belongs to. */
function roundFor(node: string, state: AdaptRunState): number | undefined {
  if (node === 'adapt') return (state.roundCounters?.adapt ?? 0) + 1;
  if (node === 'critic') return (state.roundCounters?.critic ?? 0) + 1;
  return undefined;
}

/** The first error in the `cause` chain this handler maps, else the error itself. */
function knownCause(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (
      current instanceof AiError ||
      current instanceof RunDeferredError ||
      current instanceof RunBudgetExceededError ||
      current instanceof TrainingSafetyStopError ||
      current instanceof AgentOutputTruncated ||
      current instanceof TrainingRunFailedError
    ) {
      return current;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return error;
}
