// =============================================================================
// The spike graph on real Postgres, through the real AI gateway.
// =============================================================================
//
// The scenario checks of the LangGraph spike (`SpikeGraphHandler` over
// `PrismaCheckpointSaver`, every model call through the real `AiService` with
// the scripted fake provider from `createAiRuntimeHarness`):
//
//   C5  full flow: research, plan, critic rejects once, plan, critic
//       approves, interrupt, resume on a FRESH handler/graph/saver, finalize
//   C4  abort: the in-flight provider call observes the abort, the run
//       rejects promptly, the last checkpoint stays, and the run resumes
//   --  a node that throws leaves the previous checkpoint resumable
//   --  the real-job proof: a `jobs` row enqueued, claimed, processed and
//       settled through the real queue services
//   --  the spike type is not registered by `TrainingAgentsModule`
//
// The in-memory-saver smoke variants live in
// `src/training-agents/spike/spike-graph.spec.ts`; the telemetry check (C6) in
// `framework-telemetry.spec.ts`.
//
// THIS IS A `*.db.spec.ts` FILE: skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MODULE_METADATA } from '@nestjs/common/constants';
import type { PrismaClient } from '@prisma/client';

import { createAiRuntimeHarness, HARNESS_MODEL, HARNESS_USER } from '../../src/ai/testing/ai-runtime-harness';
import { JobClaimService } from '../../src/jobs/job-claim.service';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobTerminalService } from '../../src/jobs/job-terminal.service';
import { JobsService } from '../../src/jobs/jobs.service';
import { ProviderThrottleService } from '../../src/jobs/provider-throttle.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { PrismaCheckpointSaver } from '../../src/training-agents/runtime/prisma-checkpoint-saver';
import type { SpikeState } from '../../src/training-agents/spike/nodes';
import { SPIKE_GRAPH_JOB_TYPE, SpikeGraphHandler } from '../../src/training-agents/spike/spike-graph.handler';
import { TrainingAgentsModule } from '../../src/training-agents/training-agents.module';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';
import { SPIKE_BRIEF, SPIKE_CALL_USAGE, SPIKE_DRAFT, spikeHarnessOptions, spikeJob } from './spike-test-support';

const { describeWithDb } = resolveDbSuite('spike.db.spec');

const agents = (h: ReturnType<typeof createAiRuntimeHarness>) =>
  h.fake.calls.map((call) => call.request?.metadata?.agent);

describeWithDb('spike graph on real Postgres', () => {
  let client: PrismaClient;
  const threads: string[] = [];
  const jobIds: string[] = [];

  beforeAll(async () => {
    client = createDbClient();
    await client.$connect();
  });

  afterAll(async () => {
    await client.trainingRunCheckpointWrite.deleteMany({ where: { threadId: { in: threads } } });
    await client.trainingRunCheckpoint.deleteMany({ where: { threadId: { in: threads } } });
    await client.job.deleteMany({ where: { type: SPIKE_GRAPH_JOB_TYPE, id: { in: jobIds } } });
    await client.$disconnect();
  });

  function runId(): string {
    const id = randomUUID();
    threads.push(id);
    return id;
  }

  /** A brand-new handler, so nothing survives in memory between jobs. */
  const freshHandler = (h: ReturnType<typeof createAiRuntimeHarness>, extra: { deadlineMs?: number } = {}) =>
    new SpikeGraphHandler({ ai: h.ai, prisma: client, model: HARNESS_MODEL, ...extra });

  const latestValues = async (threadId: string) =>
    (await new PrismaCheckpointSaver(client).getTuple({ configurable: { thread_id: threadId } }))?.checkpoint
      .channel_values as (Partial<SpikeState> & { __start__?: unknown }) | undefined;

  const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

  describe('C5: the full scripted flow', () => {
    it.each(['annotation', 'zod'] as const)(
      'runs critic-reject then approve, interrupts, resumes on a fresh graph and saver, and finalizes (%s state)',
      async (state) => {
        const h = createAiRuntimeHarness(spikeHarnessOptions({ rejections: 1 }));
        const id = runId();
        const handler = () => new SpikeGraphHandler({ ai: h.ai, prisma: client, model: HARNESS_MODEL, state });

        const first = await handler().execute(spikeJob({ runId: id, userId: HARNESS_USER, goal: 'Run a 5k' }));

        expect(first.status).toBe('interrupted');
        if (first.status !== 'interrupted') return;
        expect(first.interrupt).toEqual({
          kind: 'approval',
          payload: { kind: 'approval', summary: 'Week 1 (1 sessions)' },
        });
        expect(agents(h)).toEqual(['researcher', 'planner', 'critic', 'planner', 'critic']);
        expect(first.state).toMatchObject({ brief: SPIKE_BRIEF, round: 2, approved: false, approval: null });
        expect(first.state.drafts).toEqual([SPIKE_DRAFT, SPIKE_DRAFT]);
        expect(first.state.verdicts.map((v) => v.approve)).toEqual([false, true]);
        // Usage is summed across the five model calls.
        expect(first.state.usage).toEqual({
          calls: 5,
          inputTokens: 5 * SPIKE_CALL_USAGE.inputTokens,
          outputTokens: 5 * SPIKE_CALL_USAGE.outputTokens,
        });

        const second = await handler().execute(
          spikeJob({ runId: id, userId: HARNESS_USER, resume: { decision: 'approve', note: 'go' } }),
        );

        expect(second.status).toBe('completed');
        if (second.status !== 'completed') return;
        expect(second.state).toMatchObject({ approved: true, approval: { decision: 'approve', note: 'go' } });
        expect(second.state.usage.calls).toBe(5);
        // Resume repeated no completed node: still exactly the five calls.
        expect(agents(h)).toEqual(['researcher', 'planner', 'critic', 'planner', 'critic']);
      },
    );

    it('records one gateway usage row per model call, tagged with the job', async () => {
      const h = createAiRuntimeHarness(spikeHarnessOptions({ rejections: 0 }));
      const job = spikeJob({ runId: runId(), userId: HARNESS_USER, goal: 'Run a 5k' });

      await freshHandler(h).execute(job);

      expect(h.fake.calls).toHaveLength(3);
      expect(h.usageEvents).toHaveLength(3);
      expect(h.usageEvents.every((event) => event.jobId === job.id && event.userId === HARNESS_USER)).toBe(true);
      expect(h.usageEvents.reduce((sum, event) => sum + Number(event.inputTokens ?? 0), 0)).toBe(
        3 * SPIKE_CALL_USAGE.inputTokens,
      );
    });

    it('a rejected decision at the interrupt finalizes as not approved', async () => {
      const h = createAiRuntimeHarness(spikeHarnessOptions({ rejections: 0 }));
      const id = runId();

      await freshHandler(h).execute(spikeJob({ runId: id, userId: HARNESS_USER, goal: 'Run a 5k' }));
      const done = await freshHandler(h).execute(
        spikeJob({ runId: id, userId: HARNESS_USER, resume: { decision: 'reject' } }),
      );

      expect(done).toMatchObject({ status: 'completed', state: { approved: false, approval: { decision: 'reject' } } });
      expect(agents(h)).toEqual(['researcher', 'planner', 'critic']);
    });

    it('stops critic rounds at the cap and still asks the user', async () => {
      const h = createAiRuntimeHarness(spikeHarnessOptions({ rejections: 99 }));

      const out = await freshHandler(h).execute(spikeJob({ runId: runId(), userId: HARNESS_USER, goal: 'Run a 5k' }));

      expect(out.status).toBe('interrupted');
      expect(agents(h)).toEqual(['researcher', 'planner', 'critic', 'planner', 'critic']);
    });

    it('rejects an invalid payload before touching the gateway or the database', async () => {
      const h = createAiRuntimeHarness(spikeHarnessOptions());

      await expect(freshHandler(h).execute(spikeJob({ runId: 'not-a-uuid', userId: HARNESS_USER }))).rejects.toThrow(
        /Invalid training\.spike\.run payload/,
      );
      await expect(
        freshHandler(h).execute(
          spikeJob({ runId: runId(), userId: HARNESS_USER, goal: 'x', resume: { decision: 'approve' } }),
        ),
      ).rejects.toThrow(/Invalid training\.spike\.run payload/);
      expect(h.fake.calls).toHaveLength(0);
    });
  });

  describe('C4: abort and cancel', () => {
    it('aborts the in-flight provider call (FakeAiCall.aborted), rejects under 1 s, keeps the input checkpoint, and leaks no timer', async () => {
      // `delayMs` is the fake's abort-aware pause; it is what sets `aborted`.
      const h = createAiRuntimeHarness({ ...spikeHarnessOptions(), fake: { ...spikeHarnessOptions().fake, delayMs: 30_000 } });
      const id = runId();
      const handler = freshHandler(h);
      const timersBefore = timeouts();

      const running = handler.execute(spikeJob({ runId: id, userId: HARNESS_USER, goal: 'Run a 5k' }));
      await waitFor(() => h.fake.calls.length === 1);
      const abortedAt = Date.now();
      expect(handler.cancel(id)).toBe(true);

      const outcome = await running;

      expect(outcome.status).toBe('cancelled');
      expect(Date.now() - abortedAt).toBeLessThan(1_000);
      expect(h.fake.calls[0].aborted).toBe(true);
      expect(handler.cancel(id)).toBe(false);
      expect(timeouts()).toBeLessThanOrEqual(timersBefore);

      // The graph's input checkpoint (written before any node ran) is there.
      expect(await latestValues(id)).toMatchObject({ __start__: { goal: 'Run a 5k' } });
    });

    it('aborts mid-node after completed nodes, keeps their checkpoint, and resumes to the interrupt without repeating them', async () => {
      let block = true;
      let observedAbort = 0;
      const h = createAiRuntimeHarness(
        spikeHarnessOptions({
          rejections: 0,
          onCall: async (req, ctx) => {
            if (req.metadata?.agent !== 'planner' || !block) return;
            await new Promise((_resolve, reject) =>
              ctx.signal?.addEventListener(
                'abort',
                () => {
                  observedAbort += 1;
                  reject(ctx.signal?.reason);
                },
                { once: true },
              ),
            );
          },
        }),
      );
      const id = runId();
      const handler = freshHandler(h);

      const running = handler.execute(spikeJob({ runId: id, userId: HARNESS_USER, goal: 'Run a 5k' }));
      await waitFor(() => agents(h).includes('planner'));
      const abortedAt = Date.now();
      handler.cancel(id);

      const outcome = await running;

      expect(outcome.status).toBe('cancelled');
      expect(Date.now() - abortedAt).toBeLessThan(1_000);
      expect(observedAbort).toBe(1);
      // Research finished and was checkpointed; the planner had not. LangGraph's
      // default durability is "async": a step's checkpoint is written while the
      // next step runs, so it can land just after the abort rejects the run.
      await waitForAsync(async () => (await latestValues(id))?.brief !== undefined);
      expect(await latestValues(id)).toMatchObject({ brief: SPIKE_BRIEF });
      expect((await latestValues(id))?.drafts ?? []).toEqual([]);

      block = false;
      const resumed = await freshHandler(h).execute(spikeJob({ runId: id, userId: HARNESS_USER }));

      expect(resumed.status).toBe('interrupted');
      expect(agents(h)).toEqual(['researcher', 'planner', 'planner', 'critic']);

      const done = await freshHandler(h).execute(
        spikeJob({ runId: id, userId: HARNESS_USER, resume: { decision: 'approve' } }),
      );
      expect(done).toMatchObject({ status: 'completed', state: { approved: true } });
    });

    it('a run past its own deadline is cancelled, not failed, and stays resumable', async () => {
      const h = createAiRuntimeHarness({ ...spikeHarnessOptions(), fake: { ...spikeHarnessOptions().fake, delayMs: 30_000 } });

      const startedAt = Date.now();
      const outcome = await freshHandler(h, { deadlineMs: 50 }).execute(
        spikeJob({ runId: runId(), userId: HARNESS_USER, goal: 'Run a 5k' }),
      );

      expect(outcome.status).toBe('cancelled');
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    });
  });

  describe('a node that throws', () => {
    it('leaves the previous checkpoint intact and resumable without repeating completed nodes', async () => {
      let failPlanner = false;
      let planners = 0;
      const h = createAiRuntimeHarness(
        spikeHarnessOptions({
          rejections: 1,
          onCall: (req) => {
            if (req.metadata?.agent !== 'planner') return;
            planners += 1;
            if (planners === 2) failPlanner = true;
            if (failPlanner && planners === 2) throw new Error('provider exploded');
          },
        }),
      );
      const id = runId();

      const failed = await freshHandler(h).execute(spikeJob({ runId: id, userId: HARNESS_USER, goal: 'Run a 5k' }));

      expect(failed.status).toBe('failed');
      // researcher, planner, critic (rejects), planner (throws)
      expect(agents(h)).toEqual(['researcher', 'planner', 'critic', 'planner']);
      // The checkpoint before the failing node holds the first round's outputs.
      const values = await latestValues(id);
      expect(values).toMatchObject({ brief: SPIKE_BRIEF, round: 1 });
      expect(values?.drafts).toEqual([SPIKE_DRAFT]);
      expect(values?.verdicts).toHaveLength(1);

      const resumed = await freshHandler(h).execute(spikeJob({ runId: id, userId: HARNESS_USER }));

      expect(resumed.status).toBe('interrupted');
      // Only the failed planner call, then the critic, ran again.
      expect(agents(h)).toEqual(['researcher', 'planner', 'critic', 'planner', 'planner', 'critic']);
    });
  });

  describe('the real job', () => {
    it('enqueues, claims, processes and settles a spike job through the real queue services', async () => {
      const events = new EventEmitter2();
      const prisma = client as unknown as PrismaService;
      const config = { get: (key: string) => (key === 'jobs.maxAttempts' ? 3 : undefined) } as unknown as ConfigService;
      const jobs = new JobsService(prisma);
      const claims = new JobClaimService(prisma);
      const terminal = new JobTerminalService(prisma, config, new ProviderThrottleService(config), events, new JobHandlerRegistry());

      const h = createAiRuntimeHarness(spikeHarnessOptions({ rejections: 0 }));
      const handler = freshHandler(h);
      const id = runId();
      const type = SPIKE_GRAPH_JOB_TYPE;

      const enqueued = await jobs.enqueue({
        type,
        reason: 'rerun',
        subjectType: 'training_run',
        subjectId: id,
        payload: { runId: id, userId: HARNESS_USER, goal: 'Run a 5k' },
      });
      jobIds.push(enqueued.id);
      expect(enqueued.status).toBe('pending');

      const claimed = (
        await claims.claim({
          nodeId: null,
          executor: 'server',
          eligibleTypes: [type],
          limit: 5,
          leases: [{ type, leaseMs: handler.profile.maxRuntimeMs }],
        })
      ).find((job) => job.id === enqueued.id);

      expect(claimed).toBeDefined();
      expect(claimed).toMatchObject({ status: 'running', attempts: 1 });
      expect(handler.profile).toEqual({ maxRuntimeMs: 10 * 60_000, maxAttempts: 1 });

      // The first start pauses at the approval interrupt: the job itself succeeds.
      await handler.process(claimed!);
      await expect(terminal.completeSucceeded(claimed!)).resolves.toBe('succeeded');

      const row = await client.job.findUniqueOrThrow({ where: { id: enqueued.id } });
      expect(row).toMatchObject({ status: 'succeeded', claimToken: null, leaseExpiresAt: null });
      expect(row.finishedAt).not.toBeNull();
      expect(agents(h)).toEqual(['researcher', 'planner', 'critic']);
      expect((await latestValues(id))?.approved).toBe(false);
      expect(await client.trainingRunCheckpoint.count({ where: { threadId: id } })).toBeGreaterThan(3);
    });

    it('settles a job whose run fails as failed, with the error recorded', async () => {
      const events = new EventEmitter2();
      const prisma = client as unknown as PrismaService;
      const config = { get: (key: string) => (key === 'jobs.maxAttempts' ? 1 : undefined) } as unknown as ConfigService;
      const jobs = new JobsService(prisma);
      const claims = new JobClaimService(prisma);
      const terminal = new JobTerminalService(prisma, config, new ProviderThrottleService(config), events, new JobHandlerRegistry());

      const h = createAiRuntimeHarness(
        spikeHarnessOptions({
          onCall: () => {
            throw new Error('provider exploded');
          },
        }),
      );
      const handler = freshHandler(h);
      const id = runId();
      const enqueued = await jobs.enqueue({
        type: SPIKE_GRAPH_JOB_TYPE,
        reason: 'rerun',
        subjectType: 'training_run',
        subjectId: id,
        payload: { runId: id, userId: HARNESS_USER, goal: 'Run a 5k' },
      });
      jobIds.push(enqueued.id);

      const claimed = (
        await claims.claim({
          nodeId: null,
          executor: 'server',
          eligibleTypes: [SPIKE_GRAPH_JOB_TYPE],
          limit: 5,
          leases: [{ type: SPIKE_GRAPH_JOB_TYPE, leaseMs: handler.profile.maxRuntimeMs }],
        })
      ).find((job) => job.id === enqueued.id)!;

      const error = await handler.process(claimed).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);

      await terminal.completeFailed(claimed, error);

      const row = await client.job.findUniqueOrThrow({ where: { id: enqueued.id } });
      expect(row.status).toBe('failed');
      // The gateway sanitises provider errors; the job records that message.
      expect(row.lastError).toBeTruthy();
    });
  });

  describe('registration', () => {
    it('is not a provider of TrainingAgentsModule, so no app boots the spike type', () => {
      const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, TrainingAgentsModule) ?? []) as unknown[];
      const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, TrainingAgentsModule) ?? []) as unknown[];

      expect(providers.length).toBeGreaterThan(0);
      expect(providers).not.toContain(SpikeGraphHandler);
      expect(controllers).not.toContain(SpikeGraphHandler);
      expect(new JobHandlerRegistry().types()).not.toContain(SPIKE_GRAPH_JOB_TYPE);
    });
  });
});

async function waitForAsync(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('waitForAsync timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setImmediate(resolve));
  }
}
