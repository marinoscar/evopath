import { randomUUID } from 'node:crypto';

import type { Job } from '@prisma/client';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { z } from 'zod';

import { AiError } from '../../ai/core/ai-error';
import { HARNESS_USER } from '../../ai/testing/ai-runtime-harness';
import { JobSettledEvent } from '../../jobs/events/job-settled.event';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { RateLimitError } from '../../jobs/rate-limit.error';
import type { NodeFn } from '../graph/node-context';
import { InMemoryRunEventLog } from '../testing/in-memory-run-event-log';
import { createInMemoryTrainingPrisma } from '../testing/in-memory-training-prisma';
import { createNodeContextHarness, HARNESS_FROZEN_MODEL } from '../testing/node-context-harness';
import { STUB_AGENT_NODES } from '../testing/stub-agent-nodes';
import { RunBudgetExceededError } from './run-budget';
import { TrainingRunFailedError, TrainingSafetyStopError } from './training-run-errors';
import {
  HEALTH_SUMMARY_PRESENT_ATTRIBUTE,
  healthSummaryPresent,
  TrainingPlanRunHandler,
  type TrainingRunHandlerOptions,
} from './training-plan-run.handler';
import { TRAINING_RUN_JOB_TYPE } from './training-runs.constants';

const ROLE_MODELS = JSON.parse(
  JSON.stringify({ planner: HARNESS_FROZEN_MODEL, critic: HARNESS_FROZEN_MODEL, researcher: HARNESS_FROZEN_MODEL }),
) as Record<string, string>;

function setup(opts: { options?: TrainingRunHandlerOptions; scripts?: Parameters<typeof createNodeContextHarness>[0] } = {}) {
  const harness = createNodeContextHarness(opts.scripts);
  const db = createInMemoryTrainingPrisma();
  const events = new InMemoryRunEventLog();
  const saver = new MemorySaver();
  const registry = new JobHandlerRegistry();
  const runs = { requeue: jest.fn(async () => true) };
  const handler = new TrainingPlanRunHandler(
    registry,
    db.prisma as never,
    harness.runtime.ai,
    harness.runtime.aiConfig,
    events as never,
    runs as never,
    {
      checkpointer: () => saver,
      cancelPollMs: 10,
      heartbeatMs: 10_000,
      ...opts.options,
      nodes: { ...STUB_AGENT_NODES, ...opts.options?.nodes },
    },
  );

  const queued = (overrides: Parameters<typeof db.add>[0] = {}) =>
    db.add({ userId: HARNESS_USER, roleModels: ROLE_MODELS, ...overrides });
  const jobFor = (runId: string, id = randomUUID()): Job =>
    ({ id, type: TRAINING_RUN_JOB_TYPE, status: 'running', subjectType: 'training_run', subjectId: runId, payload: { runId } }) as unknown as Job;

  return { harness, db, events, saver, registry, runs, handler, queued, jobFor };
}

const stageNodes = (events: InMemoryRunEventLog, runId: string) =>
  (events.events.get(runId) ?? []).filter((e) => e.type === 'stage.started').map((e) => e.data.node);

describe('TrainingPlanRunHandler', () => {
  it('is server-only with a 25 minute, single-attempt profile, and self-registers', () => {
    const { handler, registry } = setup();

    handler.onModuleInit();

    expect(handler.type).toBe('ai.training.plan.run');
    expect(handler.profile).toEqual({ maxRuntimeMs: 25 * 60_000, maxAttempts: 1 });
    expect('nodeResultSchema' in handler).toBe(false);
    expect('persistNodeResult' in handler).toBe(false);
    expect(registry.types()).toContain('ai.training.plan.run');
    expect(registry.serverOnlyTypes()).toContain('ai.training.plan.run');
  });

  describe('outcome table', () => {
    it('graph completed: run succeeded with a result, ordered events, the job returns', async () => {
      const t = setup();
      const run = t.queued();
      const job = t.jobFor(run.id);

      await expect(t.handler.process(job)).resolves.toBeUndefined();

      expect(t.db.get(run.id)).toMatchObject({
        status: 'succeeded',
        jobId: job.id,
        jobIds: [job.id],
        stage: 'finalize',
        result: { verdict: 'approved', programId: null, warnings: [] },
        heartbeatAt: null,
      });
      expect(t.db.get(run.id)?.startedAt).toBeInstanceOf(Date);
      expect(t.db.get(run.id)?.completedAt).toBeInstanceOf(Date);
      expect(t.events.types(run.id)).toEqual([
        'run.started',
        ...['prepare_context', 'research', 'plan', 'guardrails', 'critique', 'finalize'].flatMap(() => [
          'stage.started',
          'stage.completed',
        ]),
        'run.completed',
      ]);
      expect(t.db.audits).toEqual([
        expect.objectContaining({ action: 'training_run:complete', targetId: run.id }),
      ]);
    });

    it('graph interrupted (ask me first): run awaiting_approval for 14 days, the job returns; a decision resumes it', async () => {
      const t = setup();
      const run = t.queued({ kind: 'evaluate', input: { request: { autonomy: 'ask_first' }, maxCriticRounds: 2 } });

      await t.handler.process(t.jobFor(run.id));

      const paused = t.db.get(run.id)!;
      expect(paused.status).toBe('awaiting_approval');
      expect(paused.expiresAt!.getTime() - Date.now()).toBeGreaterThan(13.9 * 24 * 3600_000);
      expect(t.events.types(run.id).at(-1)).toBe('run.awaiting_approval');

      // What POST .../decision leaves behind.
      Object.assign(paused, { status: 'queued', pendingDecision: { decision: 'approve', note: 'NOTE-CANARY' } });
      await t.handler.process(t.jobFor(run.id));

      expect(t.db.get(run.id)).toMatchObject({ status: 'succeeded', pendingDecision: null, result: { verdict: 'applied' } });
      expect(stageNodes(t.events, run.id)).toEqual(['load_signals', 'safety_gate', 'evaluate', 'envelope', 'decide', 'record_proposal', 'await_approval', 'await_approval', 'apply', 'notify']);
      expect(t.events.types(run.id)).toContain('run.resumed');
      expect(JSON.stringify([...t.events.events.values()])).not.toContain('NOTE-CANARY');
    });

    it('cancel observed while running: the in-flight provider call is aborted, run cancelled, the job returns', async () => {
      const t = setup({
        scripts: { runtime: { fake: { delayMs: 30_000 } }, scripts: { planner: () => ({ outputText: '{"title":"x"}' }) } },
        options: {
          nodes: {
            plan: (async (_state, ctx) => {
              await ctx.agent.structured({
                role: 'planner',
                node: 'plan',
                schema: z.object({ title: z.string() }),
                schemaName: 'plan_draft',
                instructions: 'i',
                input: 'x',
              });
              return {};
            }) as NodeFn,
          },
        },
      });
      const run = t.queued();

      const processing = t.handler.process(t.jobFor(run.id));
      await waitFor(() => t.harness.runtime.fake.calls.length === 1);
      t.db.get(run.id)!.cancelRequestedAt = new Date();

      await expect(processing).resolves.toBeUndefined();
      expect(t.db.get(run.id)?.status).toBe('cancelled');
      expect(t.harness.runtime.fake.calls[0].aborted).toBe(true);
      expect(t.events.types(run.id).at(-1)).toBe('run.cancelled');
    });

    it('deadline reached: run interrupted (checkpointed), the job returns', async () => {
      const t = setup({ options: { deadlineMs: 50, nodes: { research: blockUntilAbort } } });
      const run = t.queued();

      await expect(t.handler.process(t.jobFor(run.id))).resolves.toBeUndefined();

      expect(t.db.get(run.id)?.status).toBe('interrupted');
      expect(t.events.events.get(run.id)?.at(-1)).toMatchObject({ type: 'run.interrupted', data: { reason: 'deadline' } });
      // `prepare_context` was checkpointed: a later job continues after it.
      const checkpoint = await t.saver.getTuple({ configurable: { thread_id: run.id } });
      expect(checkpoint?.checkpoint.channel_values).toMatchObject({ context: { stub: true } });
    });

    it('a shutdown interrupts the run the same way', async () => {
      const t = setup({ options: { nodes: { research: blockUntilAbort } } });
      const run = t.queued();

      const processing = t.handler.process(t.jobFor(run.id));
      await waitFor(() => stageNodes(t.events, run.id).includes('research'));
      t.handler.onModuleDestroy();

      await expect(processing).resolves.toBeUndefined();
      expect(t.events.events.get(run.id)?.at(-1)).toMatchObject({ type: 'run.interrupted', data: { reason: 'shutdown' } });
    });

    it('terminal AI code: run failed with the code, the job returns (no retry)', async () => {
      const t = setup({ options: { nodes: { plan: throws(new AiError('AI_KEY_INVALID', 'The key was rejected.')) } } });
      const run = t.queued();

      await expect(t.handler.process(t.jobFor(run.id))).resolves.toBeUndefined();

      expect(t.db.get(run.id)).toMatchObject({ status: 'failed', errorCode: 'AI_KEY_INVALID' });
      expect(t.events.events.get(run.id)?.at(-1)).toMatchObject({ type: 'run.failed', data: { code: 'AI_KEY_INVALID' } });
    });

    it('AI_RATE_LIMITED: run back to queued, run.deferred, the job throws the queue rate-limit error; the next job continues from the checkpoint', async () => {
      let limited = true;
      const t = setup({
        options: {
          nodes: {
            plan: async () => {
              if (limited) throw new AiError('AI_RATE_LIMITED', 'Slow down', { retryAfterMs: 4_000 });
              return { draft: { ok: true } };
            },
          },
        },
      });
      const run = t.queued();

      const error = await t.handler.process(t.jobFor(run.id)).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RateLimitError);
      expect(t.db.get(run.id)?.status).toBe('queued');
      expect(t.events.events.get(run.id)?.at(-1)).toMatchObject({ type: 'run.deferred', data: { retryAfterMs: 4_000 } });

      limited = false;
      await t.handler.process(t.jobFor(run.id));

      expect(t.db.get(run.id)?.status).toBe('succeeded');
      // prepare_context and research ran once; plan twice (the deferred attempt and the continuation).
      expect(stageNodes(t.events, run.id)).toEqual([
        'prepare_context',
        'research',
        'plan',
        'plan',
        'guardrails',
        'critique',
        'finalize',
      ]);
    });

    it('RunBudgetExceededError: run failed TRAINING_RUN_BUDGET_EXCEEDED, the job returns', async () => {
      const t = setup({ options: { nodes: { plan: throws(new RunBudgetExceededError(10_000, 10_500, 'planner')) } } });
      const run = t.queued();

      await expect(t.handler.process(t.jobFor(run.id))).resolves.toBeUndefined();

      expect(t.db.get(run.id)).toMatchObject({ status: 'failed', errorCode: 'TRAINING_RUN_BUDGET_EXCEEDED' });
    });

    it('a real budget stop: the second model call is refused at the cap', async () => {
      const t = setup({
        scripts: { scripts: { planner: () => ({ outputText: '{"title":"x"}', usage: { inputTokens: 12_000 } }) } },
        options: {
          nodes: {
            plan: (async (_state, ctx) => {
              const call = {
                role: 'planner' as const,
                node: 'plan',
                schema: z.object({ title: z.string() }),
                schemaName: 'plan_draft',
                instructions: 'PROMPT-CANARY',
                input: 'INPUT-CANARY',
              };
              await ctx.agent.structured(call);
              await ctx.agent.structured(call);
              return {};
            }) as NodeFn,
          },
        },
      });
      const run = t.queued({ tokenCap: 10_000 });

      await t.handler.process(t.jobFor(run.id));

      const stored = t.db.get(run.id)!;
      expect(stored).toMatchObject({ status: 'failed', errorCode: 'TRAINING_RUN_BUDGET_EXCEEDED' });
      expect(t.harness.runtime.fake.calls).toHaveLength(1);
      expect(stored.usage).toMatchObject({
        byRole: { planner: { calls: 1, inputTokens: 12_000 } },
        byNode: { plan: { calls: 1 } },
        total: { calls: 1, inputTokens: 12_000 },
      });
      expect(t.harness.runtime.usageEvents.map((row) => row.jobId)).toEqual([stored.jobId]);
      // Canary: no prompt text in events, the stored run or audit rows.
      const everything = JSON.stringify([[...t.events.events.values()], stored, t.db.audits]);
      expect(everything).not.toContain('CANARY');
    });

    it('safety stop raised by a node: run blocked_safety, the job returns', async () => {
      const t = setup({ options: { nodes: { plan: throws(new TrainingSafetyStopError()) } } });
      const run = t.queued();

      await expect(t.handler.process(t.jobFor(run.id))).resolves.toBeUndefined();

      expect(t.db.get(run.id)).toMatchObject({ status: 'blocked_safety', errorCode: 'TRAINING_SAFETY_STOP' });
    });

    it('a node reason (TrainingRunFailedError): run failed with its code and fixed message, the job returns', async () => {
      const t = setup({
        options: {
          nodes: {
            research: throws(
              new TrainingRunFailedError('TRAINING_RESEARCH_INSUFFICIENT', 'The research agent could not find enough reliable sources.'),
            ),
          },
        },
      });
      const run = t.queued();

      await expect(t.handler.process(t.jobFor(run.id))).resolves.toBeUndefined();

      expect(t.db.get(run.id)).toMatchObject({
        status: 'failed',
        errorCode: 'TRAINING_RESEARCH_INSUFFICIENT',
        errorMessage: 'The research agent could not find enough reliable sources.',
      });
      expect(stageNodes(t.events, run.id)).not.toContain('plan');
    });

    it('anything else: run failed INTERNAL_ERROR with a sanitised message, the job throws', async () => {
      const t = setup({ options: { nodes: { plan: throws(new Error('SECRET-DETAIL from somewhere')) } } });
      const run = t.queued();

      await expect(t.handler.process(t.jobFor(run.id))).rejects.toThrow('SECRET-DETAIL');

      expect(t.db.get(run.id)).toMatchObject({
        status: 'failed',
        errorCode: 'INTERNAL_ERROR',
        errorMessage: 'The training run failed unexpectedly.',
      });
    });

    it('AI disabled: zero provider calls, run failed AI_DISABLED, the job returns', async () => {
      const t = setup();
      t.harness.runtime.setPolicy({ enabled: false });
      const run = t.queued();

      await expect(t.handler.process(t.jobFor(run.id))).resolves.toBeUndefined();

      expect(t.db.get(run.id)).toMatchObject({ status: 'failed', errorCode: 'AI_DISABLED' });
      expect(t.harness.runtime.fake.calls).toHaveLength(0);
    });
  });

  describe('no-ops', () => {
    it('a deleted run, a finished run, or a run another job already took', async () => {
      const t = setup();
      await expect(t.handler.process(t.jobFor(randomUUID()))).resolves.toBeUndefined();

      for (const status of ['succeeded', 'running', 'awaiting_approval', 'interrupted'] as const) {
        const run = t.queued({ status });
        await t.handler.process(t.jobFor(run.id));
        expect(t.db.get(run.id)?.status).toBe(status);
        expect(t.events.types(run.id)).toEqual([]);
      }
    });

    it('a queued run with a cancel request is finished cancelled without running', async () => {
      const t = setup();
      const run = t.queued({ cancelRequestedAt: new Date() });

      await t.handler.process(t.jobFor(run.id));

      expect(t.db.get(run.id)?.status).toBe('cancelled');
      expect(stageNodes(t.events, run.id)).toEqual([]);
    });

    it('refuses an invalid payload', async () => {
      const t = setup();
      await expect(t.handler.process({ id: 'j', payload: { runId: 'nope' } } as never)).rejects.toThrow(/Invalid/);
    });
  });

  describe('settle safety net', () => {
    const settled = (job: Job, status: 'failed' | 'succeeded' = 'failed') => new JobSettledEvent({ ...job, status } as Job);

    it('a failed job whose run is still running: interrupted, and one automatic resume is queued', async () => {
      const t = setup();
      const job = t.jobFor(randomUUID());
      const run = t.queued({ id: job.subjectId!, status: 'running', jobId: job.id });

      await t.handler.onJobSettled(settled(job));

      expect(t.db.get(run.id)?.status).toBe('interrupted');
      expect(t.events.events.get(run.id)?.at(-1)).toMatchObject({ type: 'run.interrupted', data: { reason: 'lost' } });
      expect(t.runs.requeue).toHaveBeenCalledTimes(1);
      expect(t.runs.requeue).toHaveBeenCalledWith(HARNESS_USER, run.id, 'interrupted', {
        resumeCount: { increment: 1 },
        resumeCountBelow: 2,
      });
    });

    it('after two automatic resumes, the next loss fails the run TRAINING_RUN_LOST', async () => {
      const t = setup();
      const job = t.jobFor(randomUUID());
      const run = t.queued({ id: job.subjectId!, status: 'running', jobId: job.id, resumeCount: 2 });

      await t.handler.onJobSettled(settled(job));

      expect(t.db.get(run.id)).toMatchObject({ status: 'failed', errorCode: 'TRAINING_RUN_LOST' });
      expect(t.runs.requeue).not.toHaveBeenCalled();
    });

    it('ignores succeeded jobs, other types, finished runs and a run now on another job', async () => {
      const t = setup();
      const job = t.jobFor(randomUUID());
      const run = t.queued({ id: job.subjectId!, status: 'running', jobId: 'another-job' });

      await t.handler.onJobSettled(settled(job));
      await t.handler.onJobSettled(settled({ ...job, jobId: job.id } as never, 'succeeded'));
      await t.handler.onJobSettled(new JobSettledEvent({ ...job, type: 'ai.response.run', status: 'failed' } as Job));

      expect(t.db.get(run.id)?.status).toBe('running');
      expect(t.runs.requeue).not.toHaveBeenCalled();
    });
  });

  describe('canDelete', () => {
    it('refuses deleting the live job of an active run, allows everything else', async () => {
      const t = setup();
      const job = t.jobFor(randomUUID());
      t.queued({ id: job.subjectId!, status: 'running', jobId: job.id });

      await expect(t.handler.canDelete(job)).resolves.toMatch(/Cancel the run instead/);
      await expect(t.handler.canDelete({ ...job, status: 'failed' } as Job)).resolves.toBeNull();
      await expect(t.handler.canDelete({ ...job, id: 'other' } as Job)).resolves.toBeNull();
      await expect(t.handler.canDelete({ ...job, subjectId: randomUUID() } as Job)).resolves.toBeNull();
    });
  });
});

const blockUntilAbort: NodeFn = (_state, ctx) =>
  new Promise((_resolve, reject) => {
    ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
  });

function throws(error: unknown): NodeFn {
  return async () => {
    throw error;
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('healthSummary.present span attribute (H8, #192)', () => {
  it('is true only when the planner context or the evaluator profile carries the summary; a boolean, never the text', () => {
    const summary = { narrative: 'SECRET-SUMMARY', trainingConsiderations: [], dataAsOf: null };

    expect(HEALTH_SUMMARY_PRESENT_ATTRIBUTE).toBe('healthSummary.present');
    expect(healthSummaryPresent({ context: { planner: { healthSummary: summary } } })).toBe(true);
    expect(healthSummaryPresent({ context: { sent: { profile: { healthSummary: summary } } } })).toBe(true);
    expect(healthSummaryPresent({ context: { planner: {} } })).toBe(false);
    expect(healthSummaryPresent({ context: null })).toBe(false);
    expect(healthSummaryPresent({})).toBe(false);
  });
});
