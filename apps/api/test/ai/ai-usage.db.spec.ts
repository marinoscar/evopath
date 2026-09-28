// =============================================================================
// Real-Postgres test: AI usage aggregates and the retention purge (issue #443)
// =============================================================================
//
// The aggregate SQL — GROUPING SETS, FILTERed org-key subtotals, `jsonb_each`
// over `units`, the UTC day key — only means anything against a real server:
// a mocked `$queryRaw` returns whatever a test tells it to. A seeded fixture is
// aggregated under every grouping and checked against hand-computed totals.
//
// Every row is recorded under a provider id unique to this run and every
// report filters on it, so the suite neither sees nor disturbs other data.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { Job, PrismaClient } from '@prisma/client';

import { AiProviderRegistry } from '../../src/ai/core/provider-registry';
import { AiUsagePurgeHandler } from '../../src/ai/usage/ai-usage-purge.handler';
import { AiUsageService } from '../../src/ai/usage/ai-usage.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('ai-usage.db.spec');

const NOW = new Date('2026-09-26T12:00:00.000Z');
const at = (iso: string) => new Date(iso);

describeWithDb('AI usage aggregates and purge (real Postgres)', () => {
  let client: PrismaClient;
  let service: AiUsageService;
  const provider = `dbspec-${randomUUID().slice(0, 8)}`;
  let alice: { id: string; email: string };
  let bob: { id: string; email: string };

  beforeAll(async () => {
    client = createDbClient();
    service = new AiUsageService(client as unknown as PrismaService, new AiProviderRegistry());

    alice = await client.user.create({
      data: { email: `alice-${provider}@example.com` },
      select: { id: true, email: true },
    });
    bob = await client.user.create({
      data: { email: `bob-${provider}@example.com` },
      select: { id: true, email: true },
    });

    const base = { provider, operation: 'responses', latencyMs: 10 };

    await client.aiUsageEvent.createMany({
      data: [
        // alice, model-a, own key, day 1 — two rows
        { ...base, userId: alice.id, modelId: 'model-a', keySource: 'user', status: 'succeeded', inputTokens: 100, outputTokens: 40, reasoningTokens: 5, cachedInputTokens: 20, createdAt: at('2026-09-01T00:00:00.000Z') },
        { ...base, userId: alice.id, modelId: 'model-a', keySource: 'user', status: 'failed', inputTokens: 10, createdAt: at('2026-09-01T23:59:59.999Z') },
        // bob, model-b, ORG key, day 2 — one row with units
        { ...base, userId: bob.id, modelId: 'model-b', keySource: 'org', status: 'succeeded', inputTokens: 50, outputTokens: 25, units: { images: 2, audioSeconds: 1.5 }, createdAt: at('2026-09-02T08:00:00.000Z') },
        // bob, model-a, ORG key, day 3, cancelled, no tokens reported, non-numeric unit ignored
        { ...base, userId: bob.id, modelId: 'model-a', keySource: 'org', status: 'cancelled', units: { images: 1, note: 'x' }, createdAt: at('2026-09-03T10:00:00.000Z') },
        // system catalog sync, no user
        { ...base, userId: null, modelId: 'model-a', operation: 'catalog', keySource: 'admin_discovery', status: 'succeeded', units: [1, 2], createdAt: at('2026-09-03T11:00:00.000Z') },
        // OUTSIDE the window on both sides
        { ...base, userId: alice.id, modelId: 'model-a', keySource: 'user', status: 'succeeded', inputTokens: 999, createdAt: at('2026-08-31T23:59:59.999Z') },
        { ...base, userId: alice.id, modelId: 'model-a', keySource: 'user', status: 'succeeded', inputTokens: 999, createdAt: at('2026-09-04T00:00:00.000Z') },
      ],
    });
  });

  afterAll(async () => {
    await client.aiUsageEvent.deleteMany({ where: { provider } });
    await client.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await client.$disconnect();
  });

  const window = { from: '2026-09-01', to: '2026-09-03', provider };

  const TOTALS = {
    requests: 5,
    failed: 1,
    inputTokens: 160,
    outputTokens: 65,
    reasoningTokens: 5,
    cachedInputTokens: 20,
    units: { images: 3, audioSeconds: 1.5 },
    orgKeyRequests: 2,
    orgKeyInputTokens: 50,
    orgKeyOutputTokens: 25,
  };

  it('totals are identical under every grouping and exclude rows outside the window', async () => {
    for (const groupBy of ['day', 'user', 'model', 'provider', 'keySource'] as const) {
      const report = await service.report({ ...window, groupBy }, NOW);
      expect(report.totals).toEqual(TOTALS);

      // The groups partition the totals.
      const sum = report.series.reduce((acc, s) => acc + s.requests, 0);
      expect(sum).toBe(TOTALS.requests);
    }
  });

  it('groups by UTC day, zero-filled', async () => {
    const report = await service.report({ ...window, groupBy: 'day' }, NOW);

    expect(report.series.map((s) => [s.key, s.requests, s.failed, s.inputTokens, s.units])).toEqual([
      ['2026-09-01', 2, 1, 110, {}],
      ['2026-09-02', 1, 0, 50, { images: 2, audioSeconds: 1.5 }],
      ['2026-09-03', 2, 0, 0, { images: 1 }],
    ]);
  });

  it('groups by user, labelled by email, with the org-key subtotal per user', async () => {
    const report = await service.report({ ...window, groupBy: 'user' }, NOW);

    // alice and bob tie on requests, so their relative order is by (random) id.
    const rows = report.series.map((s) => [s.key, s.label, s.requests, s.orgKeyRequests, s.orgKeyInputTokens]);
    expect(rows[2][0]).toBe('system');
    expect(rows.sort((a, b) => String(a[1]).localeCompare(String(b[1])))).toEqual([
      [alice.id, alice.email, 2, 0, 0],
      [bob.id, bob.email, 2, 2, 50],
      ['system', 'System (no user)', 1, 0, 0],
    ]);
  });

  it('groups by model and key source', async () => {
    const byModel = await service.report({ ...window, groupBy: 'model' }, NOW);
    expect(byModel.series.map((s) => [s.key, s.label, s.requests, s.units])).toEqual([
      [`${provider}:model-a`, 'model-a', 4, { images: 1 }],
      [`${provider}:model-b`, 'model-b', 1, { images: 2, audioSeconds: 1.5 }],
    ]);

    const bySource = await service.report({ ...window, groupBy: 'keySource' }, NOW);
    expect(bySource.series.map((s) => [s.key, s.requests])).toEqual([
      ['org', 2],
      ['user', 2],
      ['admin_discovery', 1],
    ]);
  });

  it('scopes to one user when asked (the per-user route always asks)', async () => {
    const report = await service.report({ ...window, groupBy: 'model', userId: alice.id }, NOW);

    expect(report.totals).toMatchObject({ requests: 2, failed: 1, inputTokens: 110, orgKeyRequests: 0 });
    expect(report.series.map((s) => s.key)).toEqual([`${provider}:model-a`]);
  });

  it('the purge deletes only rows older than the retention window', async () => {
    const old = await client.aiUsageEvent.create({
      data: { provider, modelId: 'model-a', operation: 'responses', keySource: 'user', status: 'succeeded', latencyMs: 1, createdAt: new Date(Date.now() - 400 * 86_400_000) },
    });
    const recent = await client.aiUsageEvent.create({
      data: { provider, modelId: 'model-a', operation: 'responses', keySource: 'user', status: 'succeeded', latencyMs: 1, createdAt: new Date(Date.now() - 10 * 86_400_000) },
    });

    const handler = new AiUsagePurgeHandler(
      { register: () => undefined } as never,
      client as unknown as PrismaService,
      { getAiPolicy: async () => ({ usageRetentionDays: 180 }) } as never,
    );

    await handler.process({ id: 'purge-db-spec' } as Job);

    expect(await client.aiUsageEvent.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await client.aiUsageEvent.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });
});
