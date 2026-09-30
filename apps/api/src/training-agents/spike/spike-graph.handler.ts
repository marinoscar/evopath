// =============================================================================
// Spike job handler (THROWAWAY: replaced by the production run handler).
// =============================================================================
//
// Does what the production `ai.training.plan.run` handler will: parse the
// payload, build the graph over the Prisma checkpoint saver, run it with
// `thread_id = runId` and an abort signal, and map the outcome (completed,
// interrupted, cancelled, failed). A pause ("ask me first") ends the job at
// a checkpoint; resuming is a NEW job whose payload carries the decision.
//
// NEVER REGISTERED: it has no `onModuleInit` registration, is not a provider
// of `TrainingAgentsModule`, and is constructed only inside specs, so the
// running app's `JobHandlerRegistry.types()` has no spike type.
// =============================================================================

import { Logger } from '@nestjs/common';
import type { Job } from '@prisma/client';
import { z } from 'zod';

import type { AiService } from '../../ai/runtime/ai.service';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import type { AgentGraphInterrupt } from '../graph/agent-graph-runner.interface';
import { LangGraphRunner } from '../graph/langgraph-runner';
import { type CheckpointPrisma, PrismaCheckpointSaver } from '../runtime/prisma-checkpoint-saver';
import { type SpikeNodeName, type SpikeState, spikeApprovalSchema } from './nodes';
import { type SpikeStateDefinition, buildSpikeGraph } from './spike-graph';

/** Never enqueued in production; the string only has to be unique. */
export const SPIKE_GRAPH_JOB_TYPE = 'training.spike.run';

const MAX_RUNTIME_MS = 10 * 60_000;

/** The run's own deadline: a little inside the job's, so it aborts cleanly. */
const RUN_DEADLINE_MS = MAX_RUNTIME_MS - 15_000;

export const spikeGraphPayloadSchema = z
  .object({
    /** The checkpoint thread id. */
    runId: z.string().uuid(),
    /** Whose AI key and limits every model call uses. */
    userId: z.string().uuid(),
    /** First start. */
    goal: z.string().min(1).max(2_000).optional(),
    /** Resume after an interrupt. */
    resume: spikeApprovalSchema.optional(),
  })
  .refine((p) => !(p.goal !== undefined && p.resume !== undefined), {
    message: 'goal (first start) and resume (after an interrupt) are mutually exclusive',
  });

/** Every node id a spike graph Command may name (`START` included). */
type SpikeGraphNode = SpikeNodeName | '__start__';

export type SpikeGraphPayload = z.infer<typeof spikeGraphPayloadSchema>;

export type SpikeRunOutcome =
  | { status: 'completed'; state: SpikeState }
  | { status: 'interrupted'; state: SpikeState; interrupt: AgentGraphInterrupt }
  | { status: 'cancelled'; error: unknown }
  | { status: 'failed'; error: unknown };

export interface SpikeGraphHandlerDeps {
  ai: AiService;
  prisma: CheckpointPrisma;
  /** Model override for every node. */
  model?: string;
  /** Which state definition the graph is built with. Default `annotation`. */
  state?: SpikeStateDefinition;
  /** Run deadline in ms. Default a little under the profile's `maxRuntimeMs`. */
  deadlineMs?: number;
}

export class SpikeGraphHandler implements JobHandler {
  private readonly logger = new Logger(SpikeGraphHandler.name);
  private readonly running = new Map<string, AbortController>();

  readonly type = SPIKE_GRAPH_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: MAX_RUNTIME_MS, maxAttempts: 1 };

  constructor(private readonly deps: SpikeGraphHandlerDeps) {}

  /** Runs the job; a failed run throws so the job settles `failed`. */
  async process(job: Job): Promise<void> {
    const outcome = await this.execute(job);

    if (outcome.status === 'failed') {
      throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
    }
  }

  /** Aborts the in-flight run on `runId` (a cancel request). */
  cancel(runId: string, reason: unknown = new Error('Training run cancelled')): boolean {
    const controller = this.running.get(runId);
    if (!controller) return false;
    controller.abort(reason);
    return true;
  }

  /** Runs the graph for `job` and reports how it ended. Never throws for a run failure. */
  async execute(job: Job): Promise<SpikeRunOutcome> {
    const parsed = spikeGraphPayloadSchema.safeParse(job.payload);

    if (!parsed.success) {
      throw new Error(`Invalid ${SPIKE_GRAPH_JOB_TYPE} payload: expected { runId, userId, goal? | resume? }`);
    }

    const { runId, userId, goal, resume } = parsed.data;
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(new Error('Training run timed out')),
      this.deps.deadlineMs ?? RUN_DEADLINE_MS,
    );
    deadline.unref?.();
    this.running.set(runId, controller);

    try {
      // A fresh graph and saver per job: nothing survives in memory between
      // jobs, so a resume proves the checkpoint alone carries the run.
      const graph = buildSpikeGraph({
        ai: this.deps.ai,
        userId,
        jobId: job.id,
        checkpointer: new PrismaCheckpointSaver(this.deps.prisma),
        ...(this.deps.model ? { model: this.deps.model } : {}),
        ...(this.deps.state ? { state: this.deps.state } : {}),
      });
      const runner = new LangGraphRunner<SpikeState, SpikeGraphNode>(graph);

      const result = await runner.run({
        threadId: runId,
        ...(goal !== undefined ? { input: { goal } } : {}),
        ...(resume !== undefined ? { resume } : {}),
        signal: controller.signal,
      });

      if (result.interrupt) {
        return { status: 'interrupted', state: result.state, interrupt: result.interrupt };
      }

      return { status: 'completed', state: result.state };
    } catch (error) {
      if (controller.signal.aborted) {
        this.logger.log(`Spike run ${runId} aborted; its last checkpoint stays resumable`);
        return { status: 'cancelled', error };
      }

      return { status: 'failed', error };
    } finally {
      clearTimeout(deadline);
      this.running.delete(runId);
    }
  }
}
