import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AiProviderRegistry } from '../core/provider-registry';
import { FakeAiProvider } from '../testing/fake-ai-provider';
import { AI_USAGE_NO_USER_KEY, AiUsageService, emptyBucket, resolveAiUsageRange } from './ai-usage.service';

// Unit tests over fixture rows shaped exactly as the two `$queryRaw`
// statements return them. The SQL itself is exercised against a real
// Postgres by `test/ai/ai-usage.db.spec.ts`.

const NOW = new Date('2026-09-26T15:30:00.000Z');

function aggRow(key: string | null, over: Record<string, number> = {}, isTotal = 0) {
  return {
    is_total: isTotal,
    key,
    requests: 0,
    failed: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_input_tokens: 0,
    org_requests: 0,
    org_input_tokens: 0,
    org_output_tokens: 0,
    ...over,
  };
}

describe('resolveAiUsageRange', () => {
  it('defaults to the last 30 UTC days ending today', () => {
    const range = resolveAiUsageRange(undefined, undefined, NOW);

    expect(range.from).toBe('2026-08-28');
    expect(range.to).toBe('2026-09-26');
    expect(range.start.toISOString()).toBe('2026-08-28T00:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-09-27T00:00:00.000Z');
  });

  it('defaults `from` relative to an explicit `to`', () => {
    expect(resolveAiUsageRange(undefined, '2026-03-31', NOW).from).toBe('2026-03-02');
  });

  it('accepts a single day and exactly 90 days', () => {
    expect(resolveAiUsageRange('2026-09-01', '2026-09-01', NOW).end.toISOString()).toBe(
      '2026-09-02T00:00:00.000Z',
    );
    expect(() => resolveAiUsageRange('2026-06-29', '2026-09-26', NOW)).not.toThrow();
  });

  it.each([
    ['a reversed range', '2026-09-10', '2026-09-01'],
    ['91 days', '2026-06-28', '2026-09-26'],
    ['an impossible date', '2026-02-30', '2026-03-01'],
    ['a default `to` with a `from` too far back', '2026-01-01', undefined],
  ])('refuses %s with 400 AI_USAGE_RANGE_INVALID', (_label, from, to) => {
    let error: unknown;
    try {
      resolveAiUsageRange(from, to, NOW);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      details: { reason: 'AI_USAGE_RANGE_INVALID' },
    });
  });
});

describe('AiUsageService.report', () => {
  let queryRaw: jest.Mock;
  let findUsers: jest.Mock;
  let service: AiUsageService;

  /** Script the two statements: aggregates first, units second (the order `report` issues them). */
  function script(aggregates: unknown[], units: unknown[] = []) {
    queryRaw.mockResolvedValueOnce(aggregates).mockResolvedValueOnce(units);
  }

  function sqlOf(call: number): Prisma.Sql {
    return queryRaw.mock.calls[call][0] as Prisma.Sql;
  }

  beforeEach(() => {
    queryRaw = jest.fn();
    findUsers = jest.fn().mockResolvedValue([]);
    const registry = new AiProviderRegistry();
    registry.register(new FakeAiProvider({ id: 'openai' }));
    service = new AiUsageService({ $queryRaw: queryRaw, user: { findMany: findUsers } } as never, registry);
  });

  it('splits the GROUPING SETS rows into totals and groups, attaching units to each', async () => {
    script(
      [
        aggRow(null, { requests: 5, failed: 1, input_tokens: 300, output_tokens: 90, reasoning_tokens: 7, cached_input_tokens: 40, org_requests: 2, org_input_tokens: 100, org_output_tokens: 30 }, 1),
        aggRow('openai:gpt-a', { requests: 3, failed: 1, input_tokens: 200, output_tokens: 60, org_requests: 2, org_input_tokens: 100, org_output_tokens: 30 }),
        aggRow('openai:gpt-b', { requests: 2, input_tokens: 100, output_tokens: 30, reasoning_tokens: 7, cached_input_tokens: 40 }),
      ],
      [
        { is_total: 1, key: null, unit: 'images', amount: 3 },
        { is_total: 0, key: 'openai:gpt-b', unit: 'images', amount: 3 },
      ],
    );

    const report = await service.report({ groupBy: 'model', from: '2026-09-01', to: '2026-09-26' }, NOW);

    expect(report.range).toEqual({ from: '2026-09-01', to: '2026-09-26' });
    expect(report.groupBy).toBe('model');
    expect(report.totals).toEqual({
      requests: 5,
      failed: 1,
      inputTokens: 300,
      outputTokens: 90,
      reasoningTokens: 7,
      cachedInputTokens: 40,
      units: { images: 3 },
      orgKeyRequests: 2,
      orgKeyInputTokens: 100,
      orgKeyOutputTokens: 30,
    });
    expect(report.series).toEqual([
      expect.objectContaining({ key: 'openai:gpt-a', label: 'gpt-a', requests: 3, units: {}, orgKeyRequests: 2 }),
      expect.objectContaining({ key: 'openai:gpt-b', label: 'gpt-b', requests: 2, units: { images: 3 } }),
    ]);
  });

  it('returns an empty report (zero totals) when nothing was recorded', async () => {
    script([]);

    const report = await service.report({ groupBy: 'provider' }, NOW);

    expect(report.totals).toEqual(emptyBucket());
    expect(report.series).toEqual([]);
  });

  it('zero-fills a day series across the whole range, in order', async () => {
    script(
      [aggRow(null, { requests: 4 }, 1), aggRow('2026-09-02', { requests: 4, input_tokens: 10 })],
    );

    const report = await service.report({ groupBy: 'day', from: '2026-09-01', to: '2026-09-03' }, NOW);

    expect(report.series.map((s) => [s.key, s.label, s.requests, s.inputTokens])).toEqual([
      ['2026-09-01', '2026-09-01', 0, 0],
      ['2026-09-02', '2026-09-02', 4, 10],
      ['2026-09-03', '2026-09-03', 0, 0],
    ]);
  });

  it('labels user groups with their email, keys the null user `system`, and sorts by requests', async () => {
    script([
      aggRow(null, { requests: 6 }, 1),
      aggRow('u-1', { requests: 1 }),
      aggRow('u-2', { requests: 3 }),
      aggRow(null, { requests: 2 }),
    ]);
    findUsers.mockResolvedValue([
      { id: 'u-1', email: 'one@example.com' },
      { id: 'u-2', email: 'two@example.com' },
    ]);

    const report = await service.report({ groupBy: 'user' }, NOW);

    expect(findUsers).toHaveBeenCalledWith({
      where: { id: { in: ['u-1', 'u-2'] } },
      select: { id: true, email: true },
    });
    expect(report.series.map((s) => [s.key, s.label, s.requests])).toEqual([
      ['u-2', 'two@example.com', 3],
      [AI_USAGE_NO_USER_KEY, 'System (no user)', 2],
      ['u-1', 'one@example.com', 1],
    ]);
  });

  it('labels providers by adapter display name and key sources by description', async () => {
    script([aggRow(null, { requests: 1 }, 1), aggRow('openai', { requests: 1 }), aggRow('mystery', { requests: 1 })]);
    const byProvider = await service.report({ groupBy: 'provider' }, NOW);
    expect(byProvider.series.map((s) => s.label)).toEqual(['mystery', 'Fake AI']);

    script([aggRow(null, { requests: 3 }, 1), aggRow('org', { requests: 2 }), aggRow('user', { requests: 1 })]);
    const bySource = await service.report({ groupBy: 'keySource' }, NOW);
    expect(bySource.series.map((s) => [s.key, s.label])).toEqual([
      ['org', 'Organization key'],
      ['user', "User's own key"],
    ]);
  });

  it('binds the window and every filter as parameters, never as SQL text', async () => {
    script([]);

    await service.report(
      {
        groupBy: 'day',
        from: '2026-09-01',
        to: '2026-09-02',
        userId: '11111111-1111-4111-8111-111111111111',
        provider: "openai'; DROP TABLE users; --",
        model: 'gpt-a',
      },
      NOW,
    );

    for (const call of [0, 1]) {
      const sql = sqlOf(call);
      expect(sql.sql).toContain('user_id = ');
      expect(sql.sql).toContain('provider = ');
      expect(sql.sql).toContain('model_id = ');
      expect(sql.sql).not.toContain('DROP TABLE');
      expect(sql.values).toEqual(
        expect.arrayContaining([
          new Date('2026-09-01T00:00:00.000Z'),
          new Date('2026-09-03T00:00:00.000Z'),
          '11111111-1111-4111-8111-111111111111',
          "openai'; DROP TABLE users; --",
          'gpt-a',
        ]),
      );
    }
  });

  it('adds no user filter when none is asked for', async () => {
    script([]);

    await service.report({ groupBy: 'keySource' }, NOW);

    expect(sqlOf(0).sql).not.toContain('user_id =');
    expect(sqlOf(0).sql).toContain('GROUP BY GROUPING SETS ((key_source), ())');
  });
});
