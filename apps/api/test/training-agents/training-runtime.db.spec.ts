// =============================================================================
// The training runtime kit on real Postgres
// =============================================================================
//
// What only a real server proves:
//
//   - `RunEventsService.append`: the one-statement `seq` allocation is
//     gapless and unique under concurrent appends; a deleted run appends
//     nothing; invalid data writes nothing.
//   - `isActiveRunConflict` recognises the driver adapter's error for
//     `training_plan_runs_active_per_user_uniq_idx`, and nothing else.
//   - The handler over `PrismaCheckpointSaver` (ported from the E5.0 spike):
//     a stub run completes; a run killed after node 2 resumes on a FRESH
//     handler and saver without repeating completed nodes; an ask-first pause
//     resumes with the decision; a real `jobs` row is enqueued, claimed,
//     processed and settled through the queue services.
//   - `training.runs.purge` deletes only finished runs' detail past retention.
//
// THIS IS A `*.db.spec.ts` FILE: skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Job, PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { TRAINING_AGENT_ROLES } from '../../src/common/schemas/settings.schema';
import { createAiRuntimeHarness, HARNESS_MODEL } from '../../src/ai/testing/ai-runtime-harness';
import { JobClaimService } from '../../src/jobs/job-claim.service';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobTerminalService } from '../../src/jobs/job-terminal.service';
import { JobsService } from '../../src/jobs/jobs.service';
import { ProviderThrottleService } from '../../src/jobs/provider-throttle.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { TRAINING_GRAPH_READY } from '../../src/training-agents/graph/training-graphs';
import type { NodeFn } from '../../src/training-agents/graph/node-context';
import { TrainingRunsPurgeHandler } from '../../src/training-agents/runtime/handlers/training-runs-purge.handler';
import { PrismaCheckpointSaver } from '../../src/training-agents/runtime/prisma-checkpoint-saver';
import { RunEventsService } from '../../src/training-agents/runtime/run-events.service';
import {
  TrainingPlanRunHandler,
  type TrainingRunHandlerOptions,
} from '../../src/training-agents/runtime/training-plan-run.handler';
import { TRAINING_RUN_JOB_TYPE, isActiveRunConflict } from '../../src/training-agents/runtime/training-runs.constants';
import { TrainingRunsService } from '../../src/training-agents/runtime/training-runs.service';
import { HARNESS_FROZEN_MODEL } from '../../src/training-agents/testing/node-context-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES } from '../../src/ai/testing/fake-ai-provider';
import type { AgentScript } from '../../src/training-agents/testing/node-context-harness';
import { STUB_AGENT_NODES } from '../../src/training-agents/testing/stub-agent-nodes';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';
import { AGENT_CALL_USAGE, AGENT_NODES, SCRIPTED_DRAFT, agentScripts, agentsCalled } from './agent-graph-support';
import { createRunBody } from '../../src/training-agents/testing/intake-fixtures';

const { describeWithDb } = resolveDbSuite('training-runtime.db.spec');

const DAY = 24 * 60 * 60 * 1000;

describeWithDb('training runtime (real Postgres)', () => {
  let client: PrismaClient;
  let prisma: PrismaService;
  let events: RunEventsService;
  const tag = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const threads: string[] = [];
  const jobIds: string[] = [];

  beforeAll(() => {
    client = createDbClient();
    prisma = client as unknown as PrismaService;
    events = new RunEventsService(prisma);
  });

  afterAll(async () => {
    await client.trainingRunCheckpointWrite.deleteMany({ where: { threadId: { in: threads } } });
    await client.trainingRunCheckpoint.deleteMany({ where: { threadId: { in: threads } } });
    await client.job.deleteMany({ where: { id: { in: jobIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  async function user(): Promise<string> {
    const row = await client.user.create({ data: { email: `rt-${randomUUID().slice(0, 8)}-${tag}@example.com` } });
    userIds.push(row.id);
    return row.id;
  }

  async function run(userId: string, data: Record<string, unknown> = {}) {
    const row = await client.trainingPlanRun.create({
      data: {
        userId,
        kind: 'create',
        input: { request: {}, maxCriticRounds: 2 },
        roleModels: { planner: HARNESS_FROZEN_MODEL, critic: HARNESS_FROZEN_MODEL, researcher: HARNESS_FROZEN_MODEL },
        tokenCap: 100_000,
        ...data,
      } as never,
    });
    threads.push(row.id);
    return row;
  }

  function handler(h: ReturnType<typeof createAiRuntimeHarness>, options: TrainingRunHandlerOptions = {}) {
    return new TrainingPlanRunHandler(
      new JobHandlerRegistry(),
      prisma,
      h.ai,
      h.aiConfig,
      events,
      { requeue: jest.fn(async () => true) } as unknown as TrainingRunsService,
      { cancelPollMs: 20, ...options, nodes: { ...STUB_AGENT_NODES, ...options.nodes } },
    );
  }

  const jobFor = (runId: string): Job =>
    ({ id: randomUUID(), type: TRAINING_RUN_JOB_TYPE, payload: { runId }, subjectType: 'training_run', subjectId: runId }) as unknown as Job;

  const stages = async (runId: string) =>
    (await events.list(runId, 0, 500)).filter((e) => e.type === 'stage.started').map((e) => e.data.node);

  describe('RunEventsService', () => {
    it('allocates a gapless, unique seq under 50 concurrent appends', async () => {
      const r = await run(await user(), { status: 'succeeded' });

      const seqs = await Promise.all(
        Array.from({ length: 50 }, (_v, i) => events.append(r.id, 'stage.started', { node: `n${i}` })),
      );

      expect([...seqs].sort((a, b) => a! - b!)).toEqual(Array.from({ length: 50 }, (_v, i) => i + 1));
      expect((await events.list(r.id, 0, 500)).map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_v, i) => i + 1));
      expect((await client.trainingPlanRun.findUniqueOrThrow({ where: { id: r.id } })).eventSeq).toBe(50);
      expect((await events.list(r.id, 45, 500)).map((e) => e.seq)).toEqual([46, 47, 48, 49, 50]);
    });

    it('appends nothing for a run that does not exist, and writes nothing for invalid data', async () => {
      const r = await run(await user(), { status: 'succeeded' });

      await expect(events.append(randomUUID(), 'run.cancelled', {})).resolves.toBeNull();
      await expect(events.append(r.id, 'run.failed', { code: 'lower case' })).rejects.toThrow(/run.failed/);
      await expect(events.emit(r.id, 'run.failed', { code: 'lower case' })).resolves.toBeNull();

      expect(await client.trainingRunEvent.count({ where: { runId: r.id } })).toBe(0);
      expect((await client.trainingPlanRun.findUniqueOrThrow({ where: { id: r.id } })).eventSeq).toBe(0);
    });
  });

  describe('the active-run index', () => {
    it('isActiveRunConflict recognises the real violation of training_plan_runs_active_per_user_uniq_idx', async () => {
      const u = await user();
      await run(u, { status: 'running' });

      const error = await run(u).catch((e: unknown) => e);

      expect(isActiveRunConflict(error)).toBe(true);
    });

    it('two simultaneous TrainingRunsService.create calls for one user: exactly one run, the other 409 with its id', async () => {
      const saved = { ...TRAINING_GRAPH_READY };
      TRAINING_GRAPH_READY.create = true;

      try {
        const u = await user();
        const ready = {
          state: 'ready',
          model: { provider: 'openai', modelId: HARNESS_MODEL, displayName: 'Fake', keySource: 'user' },
          effectiveEffort: 'high',
        };
        const resolver = {
          resolveForRun: async () => ({
            roles: Object.fromEntries(TRAINING_AGENT_ROLES.map((role) => [role, ready])),
            settings: { training: { maxRunTokens: 50_000, maxCriticRounds: 2 } },
            limits: () => ({ contextWindow: 128_000, maxOutputTokens: 16_384 }),
          }),
        };
        const service = new TrainingRunsService(
          prisma,
          new JobsService(prisma),
          resolver as never,
          events,
          { screen: async () => ({ stop: false as const }) },
        );

        const settled = await Promise.allSettled([
          service.create(u, createRunBody()),
          service.create(u, createRunBody()),
        ]);

        const won = settled.filter((r) => r.status === 'fulfilled') as Array<{ value: { runId: string } }>;
        const lost = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
        const rows = await client.trainingPlanRun.findMany({ where: { userId: u } });
        threads.push(...rows.map((r) => r.id));
        jobIds.push(...rows.flatMap((r) => r.jobIds).filter((id): id is string => typeof id === 'string'));

        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(1);
        expect(lost[0]!.reason).toBeInstanceOf(ConflictException);
        expect((lost[0]!.reason as ConflictException).getResponse()).toMatchObject({
          details: { reason: 'TRAINING_RUN_ACTIVE', runId: won[0]!.value.runId },
        });
        // One run, one job, one queued event: the loser left nothing behind.
        expect(rows.map((r) => r.id)).toEqual([won[0]!.value.runId]);
        expect(await client.job.count({ where: { subjectType: 'training_run', subjectId: { in: rows.map((r) => r.id) } } })).toBe(1);
        expect((await events.list(won[0]!.value.runId, 0, 50)).map((e) => e.type)).toEqual(['run.queued']);
      } finally {
        Object.assign(TRAINING_GRAPH_READY, saved);
      }
    });

    it('does not match another unique violation', async () => {
      const r = await run(await user(), { status: 'succeeded' });

      const error = await client.trainingRunEvent
        .createMany({ data: [{ runId: r.id, seq: 1, type: 'x' }, { runId: r.id, seq: 1, type: 'y' }] })
        .catch((e: unknown) => e);

      expect(isActiveRunConflict(error)).toBe(false);
    });
  });

  describe('the handler over PrismaCheckpointSaver', () => {
    it('runs the stub create graph to succeeded, with checkpoints and ordered events', async () => {
      const h = createAiRuntimeHarness();
      const r = await run(await user());

      await handler(h).process(jobFor(r.id));

      expect(await client.trainingPlanRun.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({
        status: 'succeeded',
        stage: 'finalize',
      });
      expect(await stages(r.id)).toEqual(['prepare_context', 'research', 'plan', 'guardrails', 'critique', 'finalize']);
      expect(await client.trainingRunCheckpoint.count({ where: { threadId: r.id } })).toBeGreaterThan(5);
      expect(h.fake.calls).toHaveLength(0);
    });

    it('a run killed after node 2 resumes on a fresh handler and saver without re-running completed nodes', async () => {
      const h = createAiRuntimeHarness();
      const ran: string[] = [];
      const track = (name: string, block = false): NodeFn => async (_state, ctx) => {
        ran.push(name);
        if (block) {
          await new Promise((_resolve, reject) =>
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }),
          );
        }
        return {};
      };
      const r = await run(await user());

      // Node 3 (plan) blocks until the deadline: prepare_context and research are checkpointed.
      await handler(h, {
        deadlineMs: 200,
        nodes: { prepare_context: track('prepare_context'), research: track('research'), plan: track('plan', true) },
      }).process(jobFor(r.id));

      expect((await client.trainingPlanRun.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('interrupted');

      // What `POST .../resume` leaves behind, then a brand-new handler (and saver).
      await client.trainingPlanRun.update({ where: { id: r.id }, data: { status: 'queued' } });
      await handler(h, {
        nodes: { prepare_context: track('prepare_context'), research: track('research'), plan: track('plan') },
      }).process(jobFor(r.id));

      expect(ran).toEqual(['prepare_context', 'research', 'plan', 'plan']);
      expect(await client.trainingPlanRun.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({
        status: 'succeeded',
      });
      expect((await events.list(r.id, 0, 500)).map((e) => e.type)).toContain('run.resumed');
    });

    it('cancel while running: the provider call observes the abort and the run is cancelled', async () => {
      const h = createAiRuntimeHarness({ fake: { delayMs: 30_000, responses: () => ({ outputText: '{}' }) } });
      const owner = await user();
      h.addUserKey(owner, 'sk-db-spec-user-key', [HARNESS_MODEL]);
      const r = await run(owner);
      const callsAgent: NodeFn = async (_state, ctx) => {
        await ctx.agent.structured({
          role: 'planner',
          node: 'plan',
          schema: z.object({}),
          schemaName: 'plan_draft',
          instructions: 'i',
          input: 'x',
        });
        return {};
      };

      const processing = handler(h, { nodes: { plan: callsAgent } }).process(jobFor(r.id));
      await waitFor(() => h.fake.calls.length === 1);
      await client.trainingPlanRun.update({ where: { id: r.id }, data: { cancelRequestedAt: new Date() } });
      const cancelledAt = Date.now();

      await processing;

      expect(Date.now() - cancelledAt).toBeLessThan(2_000);
      expect(h.fake.calls[0].aborted).toBe(true);
      expect((await client.trainingPlanRun.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('cancelled');
    });

    it('an ask-first pause is resumed with the decision on a fresh handler', async () => {
      const h = createAiRuntimeHarness();
      const r = await run(await user(), { kind: 'evaluate', input: { request: { autonomy: 'ask_first' }, maxCriticRounds: 2 } });

      await handler(h).process(jobFor(r.id));
      expect((await client.trainingPlanRun.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('awaiting_approval');

      await client.trainingPlanRun.update({
        where: { id: r.id },
        data: { status: 'queued', pendingDecision: { decision: 'approve' } },
      });
      await handler(h).process(jobFor(r.id));

      expect(await client.trainingPlanRun.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({
        status: 'succeeded',
        pendingDecision: null,
        result: expect.objectContaining({ verdict: 'applied' }),
      });
      expect(await stages(r.id)).toEqual(['load_signals', 'safety_gate', 'evaluate', 'envelope', 'decide', 'record_proposal', 'await_approval', 'await_approval', 'apply', 'notify']);
    });

    it('the real job: enqueued, claimed, processed and settled through the queue services', async () => {
      const emitter = new EventEmitter2();
      const config = { get: (key: string) => (key === 'jobs.maxAttempts' ? 3 : undefined) } as unknown as ConfigService;
      const jobs = new JobsService(prisma);
      const claims = new JobClaimService(prisma);
      const terminal = new JobTerminalService(prisma, config, new ProviderThrottleService(config), emitter, new JobHandlerRegistry());
      const h = createAiRuntimeHarness();
      const runHandler = handler(h);
      const r = await run(await user());

      const enqueued = await jobs.enqueue({
        type: TRAINING_RUN_JOB_TYPE,
        reason: 'upload',
        subjectType: 'training_run',
        subjectId: r.id,
        payload: { runId: r.id },
      });
      jobIds.push(enqueued.id);

      const claimed = (
        await claims.claim({
          nodeId: null,
          executor: 'server',
          eligibleTypes: [TRAINING_RUN_JOB_TYPE],
          limit: 5,
          leases: [{ type: TRAINING_RUN_JOB_TYPE, leaseMs: runHandler.profile.maxRuntimeMs }],
        })
      ).find((job) => job.id === enqueued.id);
      expect(claimed).toMatchObject({ status: 'running', attempts: 1 });

      await runHandler.process(claimed!);
      await expect(terminal.completeSucceeded(claimed!)).resolves.toBe('succeeded');

      expect(await client.trainingPlanRun.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({
        status: 'succeeded',
        jobId: enqueued.id,
        jobIds: [enqueued.id],
      });
    });
  });

  describe('the handler with nodes that call the model', () => {
    /** A runtime whose fake answers by role, and a key for `owner`. */
    function agentRuntime(owner: string, scripts: ReturnType<typeof agentScripts>) {
      const h = createAiRuntimeHarness({
        models: [
          {
            modelId: HARNESS_MODEL,
            capabilities: {
              ...FAKE_TEXT_MODEL_CAPABILITIES,
              capabilities: [...FAKE_TEXT_MODEL_CAPABILITIES.capabilities, 'hosted_tools'],
            },
          },
        ],
        policy: { hostedTools: { web_search: true } },
        fake: {
          hostedTools: ['web_search'],
          responses: (req, ctx) => {
            const script = scripts[req.metadata?.agent as keyof typeof scripts] as AgentScript | undefined;
            if (!script) throw new Error(`no script for ${String(req.metadata?.agent)}`);
            return script(req, ctx);
          },
        },
      });
      h.addUserKey(owner, 'sk-db-spec-user-key', [HARNESS_MODEL]);
      return h;
    }

    it('a critic that rejects once: five calls, per-role usage equal to the scripted usage, one usage row per call tagged with the job', async () => {
      const owner = await user();
      const h = agentRuntime(owner, agentScripts({ rejections: 1 }));
      const r = await run(owner);
      const job = jobFor(r.id);

      await handler(h, { nodes: AGENT_NODES }).process(job);

      const stored = await client.trainingPlanRun.findUniqueOrThrow({ where: { id: r.id } });
      expect(stored.status).toBe('succeeded');
      expect(agentsCalled(h.fake.calls)).toEqual(['researcher', 'planner', 'critic', 'planner', 'critic']);
      expect(stored.usage).toMatchObject({
        byRole: {
          researcher: { calls: 1, inputTokens: AGENT_CALL_USAGE.inputTokens },
          planner: { calls: 2, inputTokens: 2 * AGENT_CALL_USAGE.inputTokens },
          critic: { calls: 2, outputTokens: 2 * AGENT_CALL_USAGE.outputTokens },
        },
        total: { calls: 5, inputTokens: 5 * AGENT_CALL_USAGE.inputTokens, outputTokens: 5 * AGENT_CALL_USAGE.outputTokens },
      });
      expect(h.usageEvents).toHaveLength(5);
      expect(h.usageEvents.every((row) => row.jobId === job.id && row.userId === owner)).toBe(true);
      const usageEvents = (await events.list(r.id, 0, 500)).filter((e) => e.type === 'agent.usage');
      expect(usageEvents.map((e) => e.data.role)).toEqual(['researcher', 'planner', 'critic', 'planner', 'critic']);
      // Events never carry the model's output or the instructions.
      const text = JSON.stringify(await events.list(r.id, 0, 500));
      expect(text).not.toContain(SCRIPTED_DRAFT.title);
      expect(text).not.toContain('Draft the plan');
    });

    it('a node that throws leaves the previous checkpoint resumable without repeating completed nodes', async () => {
      const owner = await user();
      let planners = 0;
      const h = agentRuntime(
        owner,
        agentScripts({
          rejections: 1,
          onCall: (req) => {
            if (req.metadata?.agent !== 'planner') return;
            planners += 1;
            if (planners === 2) throw new Error('provider exploded');
          },
        }),
      );
      const r = await run(owner);

      // Not a known outcome: the run fails INTERNAL-style and the job throws.
      await expect(handler(h, { nodes: AGENT_NODES }).process(jobFor(r.id))).rejects.toBeDefined();
      expect(agentsCalled(h.fake.calls)).toEqual(['researcher', 'planner', 'critic', 'planner']);

      const values = (await new PrismaCheckpointSaver(client).getTuple({ configurable: { thread_id: r.id } }))
        ?.checkpoint.channel_values as Record<string, unknown>;
      expect(values).toMatchObject({ roundCounters: { critique: 1 }, draft: SCRIPTED_DRAFT });

      // An operator requeues it: only the failed planner call, then the critic, run again.
      await client.trainingPlanRun.update({ where: { id: r.id }, data: { status: 'queued' } });
      await handler(h, { nodes: AGENT_NODES }).process(jobFor(r.id));

      expect(agentsCalled(h.fake.calls)).toEqual(['researcher', 'planner', 'critic', 'planner', 'planner', 'critic']);
      expect((await client.trainingPlanRun.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('succeeded');
    });
  });

  describe('training.runs.purge', () => {
    it('deletes only finished runs\' events and checkpoints past 30 days, and run rows past 365 days', async () => {
      const u = await user();
      const now = new Date();
      const old = new Date(now.getTime() - 40 * DAY);
      const ancient = new Date(now.getTime() - 400 * DAY);

      const oldDone = await run(u, { status: 'succeeded', completedAt: old });
      const recentDone = await run(u, { status: 'failed', completedAt: new Date(now.getTime() - 5 * DAY) });
      const ancientDone = await run(u, { status: 'cancelled', completedAt: ancient });
      const paused = await run(u, { status: 'awaiting_approval' });
      const orphan = randomUUID();
      threads.push(orphan);

      for (const r of [oldDone, recentDone, ancientDone, paused]) {
        await events.append(r.id, 'run.cancelled', {});
      }
      const saver = new PrismaCheckpointSaver(client);
      for (const threadId of [oldDone.id, recentDone.id, paused.id, orphan]) {
        await saver.put(
          { configurable: { thread_id: threadId, checkpoint_ns: '' } },
          { v: 4, id: randomUUID(), ts: now.toISOString(), channel_values: {}, channel_versions: {}, versions_seen: {} },
          { source: 'input', step: -1, parents: {} },
          {},
        );
      }
      await client.trainingRunCheckpoint.updateMany({ where: { threadId: orphan }, data: { createdAt: old } });

      await new TrainingRunsPurgeHandler(new JobHandlerRegistry(), prisma).process({ id: 'purge' } as Job, now);

      const eventsOf = (id: string) => client.trainingRunEvent.count({ where: { runId: id } });
      const checkpointsOf = (id: string) => client.trainingRunCheckpoint.count({ where: { threadId: id } });

      expect(await eventsOf(oldDone.id)).toBe(0);
      expect(await checkpointsOf(oldDone.id)).toBe(0);
      expect(await client.trainingPlanRun.count({ where: { id: oldDone.id } })).toBe(1);

      expect(await eventsOf(recentDone.id)).toBe(1);
      expect(await checkpointsOf(recentDone.id)).toBe(1);

      expect(await eventsOf(paused.id)).toBe(1);
      expect(await checkpointsOf(paused.id)).toBe(1);

      expect(await checkpointsOf(orphan)).toBe(0);
      expect(await client.trainingPlanRun.count({ where: { id: ancientDone.id } })).toBe(0);
    });
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
