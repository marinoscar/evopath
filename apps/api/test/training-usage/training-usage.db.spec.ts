// =============================================================================
// Real-Postgres test: training agent usage per run and per month (E6.3)
// =============================================================================
//
// The usage SQL (the run -> jobs lateral join over `job_ids` plus `job_id`,
// the owner keying, the month window, the `::int`/`::float8` casts and the
// typical-run window function) only means anything against a real server.
// Every user here is created by this suite, and every statement is keyed by
// user, so the suite neither sees nor disturbs other data.
//
// THIS IS A `*.db.spec.ts` FILE: skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { NotFoundException, BadRequestException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { AiProviderRegistry } from '../../src/ai/core/provider-registry';
import { AiUsageService } from '../../src/ai/usage/ai-usage.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { TrainingUsageService } from '../../src/training-usage/training-usage.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('training-usage.db.spec');

const NOW = new Date('2026-09-30T12:00:00.000Z');
const IN_MONTH = new Date('2026-09-15T10:00:00.000Z');

const totals = (calls: number, inputTokens: number, outputTokens: number) => ({ calls, inputTokens, outputTokens, reasoningTokens: 0 });

describeWithDb('training agent usage (real Postgres)', () => {
  let client: PrismaClient;
  let service: TrainingUsageService;
  const tag = randomUUID().slice(0, 8);
  const providerA = `dbspec-a-${tag}`;
  const providerB = `dbspec-b-${tag}`;
  let alice: string;
  let bob: string;
  const jobA = randomUUID();
  const jobB1 = randomUUID();
  const jobB2 = randomUUID();
  const jobBob = randomUUID();
  let runA: string;
  let runB: string;
  let runPurged: string;
  let runBob: string;

  beforeAll(async () => {
    client = createDbClient();
    const settings = { getAiPolicy: async () => ({ usageRetentionDays: 180 }) } as unknown as SystemSettingsService;
    service = new TrainingUsageService(client as unknown as PrismaService, settings);

    alice = (await client.user.create({ data: { email: `alice-${tag}@example.com` }, select: { id: true } })).id;
    bob = (await client.user.create({ data: { email: `bob-${tag}@example.com` }, select: { id: true } })).id;

    const run = (data: Record<string, unknown>) =>
      client.trainingPlanRun.create({ data: { input: {}, tokenCap: 100_000, status: 'succeeded', ...data } as never, select: { id: true } });

    // Run A (adapt): planner and critic on DIFFERENT models: exact attribution.
    runA = (
      await run({
        userId: alice,
        kind: 'adapt',
        jobId: jobA,
        jobIds: [jobA],
        tokenCap: 10_000,
        completedAt: new Date('2026-09-15T10:05:00.000Z'),
        roleModels: {
          planner: { provider: providerA, modelId: 'model-p', effort: null, keySource: 'user' },
          critic: { provider: providerA, modelId: 'model-c', effort: null, keySource: 'user' },
        },
        usage: {
          byRole: { planner: totals(1, 1_200, 300), critic: totals(1, 800, 120) },
          byNode: { adapt: totals(1, 1_200, 300), critic: totals(1, 800, 120) },
          total: totals(2, 2_000, 420),
        },
      })
    ).id;

    // Run B (create, resumed once): planner and critic on the SAME org-key model.
    runB = (
      await run({
        userId: alice,
        kind: 'create',
        jobId: jobB2,
        jobIds: [jobB1],
        roleModels: {
          planner: { provider: providerB, modelId: 'model-s', effort: null, keySource: 'org' },
          critic: { provider: providerB, modelId: 'model-s', effort: null, keySource: 'org' },
        },
        usage: {
          byRole: { planner: totals(2, 1_000, 200), critic: totals(1, 500, 100) },
          byNode: { plan: totals(2, 1_000, 200), critique: totals(1, 500, 100) },
          total: totals(3, 1_500, 300),
        },
      })
    ).id;

    // A run whose usage rows retention removed.
    runPurged = (
      await run({
        userId: alice,
        kind: 'evaluate',
        jobId: randomUUID(),
        roleModels: { evaluator: { provider: providerA, modelId: 'model-e', effort: null, keySource: 'user' } },
        usage: { byRole: { evaluator: totals(1, 400, 100) }, byNode: { evaluate: totals(1, 400, 100) }, total: totals(1, 400, 100) },
      })
    ).id;

    // Two more completed adapt runs for the typical median (1,000 and 5,000 tokens; run A is 2,420).
    for (const [input, output] of [
      [800, 200],
      [4_000, 1_000],
    ]) {
      await run({ userId: alice, kind: 'adapt', usage: { byRole: {}, byNode: {}, total: totals(1, input, output) }, completedAt: new Date('2026-09-01T00:00:00.000Z') });
    }

    runBob = (
      await run({
        userId: bob,
        kind: 'adapt',
        jobId: jobBob,
        jobIds: [jobBob],
        roleModels: { planner: { provider: providerA, modelId: 'model-p', effort: null, keySource: 'user' } },
        usage: { byRole: { planner: totals(1, 9_000, 9_000) }, byNode: { adapt: totals(1, 9_000, 9_000) }, total: totals(1, 9_000, 9_000) },
      })
    ).id;

    const base = { operation: 'responses', createdAt: IN_MONTH };
    await client.aiUsageEvent.createMany({
      data: [
        // Run A
        { ...base, userId: alice, jobId: jobA, provider: providerA, modelId: 'model-p', keySource: 'user', status: 'succeeded', inputTokens: 1_200, outputTokens: 300, cachedInputTokens: 200, latencyMs: 100 },
        { ...base, userId: alice, jobId: jobA, provider: providerA, modelId: 'model-c', keySource: 'user', status: 'succeeded', inputTokens: 800, outputTokens: 120, latencyMs: 50 },
        { ...base, userId: alice, jobId: jobA, provider: providerA, modelId: 'model-c', keySource: 'user', status: 'failed', latencyMs: 5 },
        // Run B, over its two jobs
        { ...base, userId: alice, jobId: jobB1, provider: providerB, modelId: 'model-s', keySource: 'org', status: 'succeeded', inputTokens: 500, outputTokens: 100, latencyMs: 10 },
        { ...base, userId: alice, jobId: jobB1, provider: providerB, modelId: 'model-s', keySource: 'org', status: 'succeeded', inputTokens: 500, outputTokens: 100, latencyMs: 10 },
        { ...base, userId: alice, jobId: jobB2, provider: providerB, modelId: 'model-s', keySource: 'org', status: 'succeeded', inputTokens: 500, outputTokens: 100, latencyMs: 10 },
        { ...base, userId: alice, jobId: jobB2, provider: providerB, modelId: 'model-s', keySource: 'org', status: 'failed', latencyMs: 3 },
        // Alice, NOT an agent run: excluded
        { ...base, userId: alice, jobId: randomUUID(), provider: providerA, modelId: 'model-p', keySource: 'user', status: 'succeeded', inputTokens: 7_777, latencyMs: 1 },
        { ...base, userId: alice, jobId: null, provider: providerA, modelId: 'model-p', keySource: 'user', status: 'succeeded', inputTokens: 7_777, latencyMs: 1 },
        // Run A's job, but in AUGUST: outside September
        { ...base, userId: alice, jobId: jobA, provider: providerA, modelId: 'model-p', keySource: 'user', status: 'succeeded', inputTokens: 5, latencyMs: 1, createdAt: new Date('2026-08-31T23:59:59.999Z') },
        // Bob
        { ...base, userId: bob, jobId: jobBob, provider: providerA, modelId: 'model-p', keySource: 'user', status: 'succeeded', inputTokens: 9_000, outputTokens: 9_000, latencyMs: 1 },
      ],
    });

    await client.trainingRunEvent.createMany({
      data: [
        { runId: runA, seq: 1, type: 'agent.usage', stage: 'adapt', data: { role: 'planner', node: 'adapt', provider: providerA, model: 'model-p', inputTokens: 1_200, outputTokens: 300, reasoningTokens: 0, latencyMs: 100 } },
        { runId: runA, seq: 2, type: 'agent.usage', stage: 'critic', data: { role: 'critic', node: 'critic', provider: providerA, model: 'model-c', inputTokens: 800, outputTokens: 120, reasoningTokens: 0, latencyMs: 50 } },
      ],
    });
  });

  afterAll(async () => {
    await client.aiUsageEvent.deleteMany({ where: { provider: { in: [providerA, providerB] } } });
    await client.user.deleteMany({ where: { id: { in: [alice, bob] } } });
    await client.$disconnect();
  });

  describe('GET /api/ai/training/runs/:runId/usage', () => {
    it('attributes a run with one model per role exactly, per node, role, model and key source', async () => {
      const usage = await service.runUsage(alice, runA);

      expect(usage).toMatchObject({ runId: runA, jobId: jobA, kind: 'adapt', status: 'succeeded' });
      // Not month-bound: the August row of the run's job counts too.
      expect(usage.totals).toMatchObject({ requests: 4, failed: 1, inputTokens: 2_005, outputTokens: 420, cachedInputTokens: 200, latencyMs: 156 });
      expect(usage.byNode).toEqual([
        expect.objectContaining({ node: 'adapt', role: 'planner', provider: providerA, modelId: 'model-p', keySource: 'user', requests: 2, failed: 0, inputTokens: 1_205, outputTokens: 300, cachedInputTokens: 200 }),
        expect.objectContaining({ node: 'critic', role: 'critic', provider: providerA, modelId: 'model-c', keySource: 'user', requests: 2, failed: 1, inputTokens: 800, outputTokens: 120, latencyMs: 55 }),
      ]);
      expect(usage.cap).toEqual({ limitTokens: 10_000, usedTokens: 2_420, reached: false });
      expect(usage.retention).toEqual({ purged: false, retentionDays: 180 });
      // Every number is a plain JS number (the casts), never a bigint.
      expect(() => JSON.stringify(usage)).not.toThrow();
    });

    it('totals equal the platform usage report restricted to the run (the same rows)', async () => {
      const platform = new AiUsageService(client as unknown as PrismaService, new AiProviderRegistry());
      const report = await platform.report({ from: '2026-08-01', to: '2026-09-30', groupBy: 'model', userId: alice, provider: providerA }, NOW);
      const usage = await service.runUsage(alice, runA);

      // providerA also carries the rows that are not run A's; take them out.
      expect({
        requests: report.totals.requests - 2,
        failed: report.totals.failed,
        inputTokens: report.totals.inputTokens - 2 * 7_777,
        outputTokens: report.totals.outputTokens,
      }).toEqual({
        requests: usage.totals.requests,
        failed: usage.totals.failed,
        inputTokens: usage.totals.inputTokens,
        outputTokens: usage.totals.outputTokens,
      });
    });

    it('a shared model: each node its tally, the rest (the failed call) unattributed; jobs of a resumed run all count', async () => {
      const usage = await service.runUsage(alice, runB);

      expect(usage.totals).toMatchObject({ requests: 4, failed: 1, inputTokens: 1_500, outputTokens: 300, orgKeyRequests: 4 });
      expect(usage.byNode.map((n) => [n.node, n.role, n.requests, n.failed, n.inputTokens, n.keySource])).toEqual([
        ['plan', 'planner', 2, 0, 1_000, 'org'],
        ['critique', 'critic', 1, 0, 500, 'org'],
        [null, null, 1, 1, 0, 'org'],
      ]);
      const sum = usage.byNode.reduce((acc, n) => acc + n.requests, 0);
      expect(sum).toBe(usage.totals.requests);
    });

    it('usage rows removed by retention: purged, numbers from the run tally', async () => {
      const usage = await service.runUsage(alice, runPurged);

      expect(usage.retention.purged).toBe(true);
      expect(usage.byNode).toEqual([expect.objectContaining({ node: 'evaluate', role: 'evaluator', requests: 1, inputTokens: 400, outputTokens: 100 })]);
      expect(usage.totals).toMatchObject({ requests: 1, inputTokens: 400, outputTokens: 100 });
    });

    it("another user's run is a 404", async () => {
      await expect(service.runUsage(alice, runBob)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.runUsage(bob, runA)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('GET /api/ai/training/usage', () => {
    it('sums the month by role, model, key source and kind; excludes non-run rows, other months and other users', async () => {
      const usage = await service.monthlyUsage(alice, '2026-09', NOW);

      expect(usage.month).toBe('2026-09');
      expect(usage.range).toEqual({ from: '2026-09-01', to: '2026-09-30' });
      expect(usage.totals).toMatchObject({ requests: 7, failed: 2, inputTokens: 3_500, outputTokens: 720, orgKeyRequests: 4, orgKeyInputTokens: 1_500 });

      expect(usage.byRole.map((r) => [r.role, r.requests, r.failed, r.inputTokens, r.outputTokens])).toEqual([
        ['planner', 3, 0, 2_200, 500],
        ['critic', 3, 1, 1_300, 220],
        ['unattributed', 1, 1, 0, 0],
      ]);
      expect(usage.byKeySource.map((k) => [k.keySource, k.requests])).toEqual([
        ['org', 4],
        ['user', 3],
      ]);
      expect(usage.byKind.map((k) => [k.kind, k.runs, k.requests])).toEqual([
        ['create', 1, 4],
        ['adapt', 1, 3],
      ]);
      expect(usage.byModel.map((m) => [m.provider, m.modelId, m.requests])).toEqual([
        [providerB, 'model-s', 4],
        [providerA, 'model-c', 2],
        [providerA, 'model-p', 1],
      ]);
      expect(usage.retention).toEqual({ partial: false, retentionDays: 180 });
    });

    it('a month with no agent usage is empty, not an error', async () => {
      const usage = await service.monthlyUsage(alice, '2026-07', NOW);

      expect(usage.totals.requests).toBe(0);
      expect(usage.byRole).toEqual([]);
      expect(usage.byKind).toEqual([]);
    });

    it('typical: the median of the last completed runs per kind, null below three', async () => {
      const usage = await service.monthlyUsage(alice, undefined, NOW);

      expect(usage.typical.adapt).toEqual({ runs: 3, medianTokens: 2_420 });
      expect(usage.typical.create).toBeNull();
      expect(usage.typical.evaluate).toBeNull();
    });

    it('a month older than the usage retention is flagged partial; beyond 12 months is refused', async () => {
      expect((await service.monthlyUsage(alice, '2025-10', NOW)).retention.partial).toBe(true);
      await expect(service.monthlyUsage(alice, '2025-08', NOW)).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
