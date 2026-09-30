// =============================================================================
// Quick workout adaptation on the real database (E6.1)
// =============================================================================
//
//   - `create` writes the adaptation (queued, `expires_at` = +30 days), its
//     kit run (kind `adapt`) and its `ai.training.adapt.run` job in one
//     transaction; a second one is `409 ADAPTATION_IN_PROGRESS` decided by
//     `workout_adaptations_active_per_user_uniq_idx`.
//   - An `adapt` run neither blocks nor is blocked by an active plan run
//     (`training_plan_runs_active_per_user_uniq_idx` excludes it).
//   - The handler runs the graph on the fake provider over
//     `PrismaCheckpointSaver` and persists the proposal: `ready` / `succeeded`.
//   - `training.adaptations.purge` deletes only expired rows.
//
// THIS IS A `*.db.spec.ts` FILE: skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { ConflictException } from '@nestjs/common';
import type { Job, PrismaClient } from '@prisma/client';

import { createAiRuntimeHarness, HARNESS_MODEL } from '../../src/ai/testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES } from '../../src/ai/testing/fake-ai-provider';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobsService } from '../../src/jobs/jobs.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { RunEventsService } from '../../src/training-agents/runtime/run-events.service';
import type { TrainingRunsService } from '../../src/training-agents/runtime/training-runs.service';
import type { TrainingModelResolver } from '../../src/training-agents/models/training-model-resolver.service';
import { ADAPTATION_RUN_JOB_TYPE, ADAPTATION_TTL_MS } from '../../src/training-adaptation/adaptation.constants';
import { AdaptationService } from '../../src/training-adaptation/adaptation.service';
import type { AdaptationContextBuilder } from '../../src/training-adaptation/context/adaptation-context.builder';
import type { AdaptationRequest } from '../../src/training-adaptation/dto/adaptation-request.dto';
import { AdaptationRunHandler } from '../../src/training-adaptation/handlers/adaptation-run.handler';
import { AdaptationsPurgeHandler } from '../../src/training-adaptation/handlers/adaptations-purge.handler';
import {
  ACCEPT,
  DUMBBELL_30_ANSWER,
  adaptationContextFixture,
  onlyDumbbellsRequest,
} from '../../src/training-adaptation/testing/adaptation-fixtures';
import { SCRIPT_USAGE } from '../../src/training-agents/testing/agent-scripts';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('adaptation-runtime.db.spec');

const READY_ROLE = (role: 'planner' | 'critic') => ({
  role,
  state: 'ready' as const,
  model: { provider: 'openai', modelId: HARNESS_MODEL, displayName: 'Fake', keySource: 'user' as const },
  needs: [],
  requestedEffort: 'medium' as const,
  effectiveEffort: 'medium' as const,
  fix: null,
});

describeWithDb('quick workout adaptation (real Postgres)', () => {
  let client: PrismaClient;
  let prisma: PrismaService;
  let events: RunEventsService;
  const tag = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  beforeAll(() => {
    client = createDbClient();
    prisma = client as unknown as PrismaService;
    events = new RunEventsService(prisma);
  });

  afterAll(async () => {
    const runs = await client.trainingPlanRun.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const threads = runs.map((r) => r.id);
    await client.trainingRunCheckpointWrite.deleteMany({ where: { threadId: { in: threads } } });
    await client.trainingRunCheckpoint.deleteMany({ where: { threadId: { in: threads } } });
    await client.job.deleteMany({ where: { type: ADAPTATION_RUN_JOB_TYPE, subjectId: { in: (await client.workoutAdaptation.findMany({ where: { userId: { in: userIds } }, select: { id: true } })).map((a) => a.id) } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  async function user(): Promise<string> {
    const row = await client.user.create({ data: { email: `adapt-${randomUUID().slice(0, 8)}-${tag}@example.com` } });
    userIds.push(row.id);
    return row.id;
  }

  function service(request: AdaptationRequest) {
    const resolver = {
      resolveForRun: async () => ({
        roles: { planner: READY_ROLE('planner'), critic: READY_ROLE('critic') },
        settings: undefined,
        limits: () => ({}),
      }),
    } as unknown as TrainingModelResolver;
    // The fixture's gym is not a row here: the adaptation stores no gym.
    const context = adaptationContextFixture({ request });
    context.facts.gymId = null;
    const builder = { build: async () => context } as unknown as AdaptationContextBuilder;

    return new AdaptationService(
      prisma,
      new JobsService(prisma),
      resolver,
      events,
      { cancel: jest.fn() } as unknown as TrainingRunsService,
      builder,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  it('creates the adaptation, its adapt run and its job; a second one is 409 ADAPTATION_IN_PROGRESS', async () => {
    const userId = await user();
    const request = onlyDumbbellsRequest({ minutes: 30 });
    const now = new Date();

    const started = await service(request).create(userId, request, now);

    expect(started.status).toBe('queued');
    const row = await client.workoutAdaptation.findUniqueOrThrow({ where: { id: started.adaptationId } });
    expect(row.status).toBe('queued');
    expect(row.runId).toBe(started.runId);
    expect(row.jobId).toBe(started.jobId);
    expect(row.expiresAt.getTime()).toBe(now.getTime() + ADAPTATION_TTL_MS);
    const run = await client.trainingPlanRun.findUniqueOrThrow({ where: { id: started.runId! } });
    expect(run).toMatchObject({ kind: 'adapt', status: 'queued', jobId: started.jobId });
    const job = await client.job.findUniqueOrThrow({ where: { id: started.jobId! } });
    expect(job).toMatchObject({ type: ADAPTATION_RUN_JOB_TYPE, subjectType: 'training_adaptation', subjectId: started.adaptationId });

    const second = await service(request).create(userId, request).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(ConflictException);
    expect((second as ConflictException).getResponse()).toMatchObject({
      details: { reason: 'ADAPTATION_IN_PROGRESS', adaptationId: started.adaptationId },
    });
  });

  it('an adapt run does not collide with an active plan run of the same user', async () => {
    const userId = await user();
    await client.trainingPlanRun.create({
      data: { userId, kind: 'evaluate', status: 'awaiting_approval', input: {}, tokenCap: 100_000 },
    });

    const request = onlyDumbbellsRequest({ minutes: 30 });
    await expect(service(request).create(userId, request)).resolves.toMatchObject({ status: 'queued' });
  });

  it('the handler runs the graph on the fake provider and stores a ready proposal', async () => {
    const userId = await user();
    const request = onlyDumbbellsRequest({ minutes: 30, soreness: { muscles: ['chest'], level: 'mild' } });
    const started = await service(request).create(userId, request);

    const h = createAiRuntimeHarness({
      models: [{ modelId: HARNESS_MODEL, capabilities: FAKE_TEXT_MODEL_CAPABILITIES }],
      fake: {
        responses: (req) => ({
          outputText: JSON.stringify(req.metadata?.agent === 'critic' ? ACCEPT : DUMBBELL_30_ANSWER),
          usage: SCRIPT_USAGE,
        }),
      },
    });
    h.addUserKey(userId, 'sk-adapt-db-spec-key', [HARNESS_MODEL]);
    const context = adaptationContextFixture({ request });
    const handler = new AdaptationRunHandler(new JobHandlerRegistry(), prisma, h.ai, h.aiConfig, events, {} as never, {
      cancelPollMs: 50,
      contextPort: { build: async () => context },
    });

    await handler.process({
      id: started.jobId,
      type: ADAPTATION_RUN_JOB_TYPE,
      payload: { adaptationId: started.adaptationId },
      subjectType: 'training_adaptation',
      subjectId: started.adaptationId,
    } as unknown as Job);

    const row = await client.workoutAdaptation.findUniqueOrThrow({ where: { id: started.adaptationId } });
    expect(row.status).toBe('ready');
    expect((row.proposal as { estimatedMinutes: number }).estimatedMinutes).toBeLessThanOrEqual(30);
    expect(row.criticReport).toMatchObject({ verdict: 'accept', rounds: 1 });
    const run = await client.trainingPlanRun.findUniqueOrThrow({ where: { id: started.runId! } });
    expect(run.status).toBe('succeeded');
    expect(h.fake.calls.length).toBe(2);

    const types = (await events.list(started.runId!, 0, 500)).map((e) => e.type);
    expect(types[0]).toBe('run.queued');
    expect(types).toContain('workout_adaptation.ready');
    expect(types.at(-1)).toBe('run.completed');
    expect(types.filter((t) => t === 'stage.started')).toHaveLength(5);
  });

  it('training.adaptations.purge deletes only rows past expires_at', async () => {
    const userId = await user();
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 60_000);
    const expired = await client.workoutAdaptation.create({ data: { userId, status: 'discarded', request: {}, expiresAt: past } });
    const kept = await client.workoutAdaptation.create({ data: { userId, status: 'ready', request: {}, expiresAt: future } });

    const deleted = await new AdaptationsPurgeHandler(new JobHandlerRegistry(), prisma).purge(new Date());

    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await client.workoutAdaptation.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await client.workoutAdaptation.findUnique({ where: { id: kept.id } })).not.toBeNull();
  });
});

