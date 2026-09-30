import type { UsageTotals } from '../training-agents/runtime/run-budget';
import { runCapState } from '../training-agents/runtime/run-budget';
import {
  type AttributionUnit,
  type UsageRowGroup,
  attributeRun,
  bucketOfGroup,
  emptyBucket,
  median,
} from './training-usage.attribution';
import { nodeFactsFromEvents, resolveUsageMonth } from './training-usage.service';

const tally = (calls: number, inputTokens: number, outputTokens: number, reasoningTokens = 0): UsageTotals => ({
  calls,
  inputTokens,
  outputTokens,
  reasoningTokens,
});

const unit = (key: string, modelId: string | null, t: UsageTotals, extra: Partial<AttributionUnit> = {}): AttributionUnit => ({
  key,
  role: key === 'plan' || key === 'adapt' ? 'planner' : 'critic',
  provider: modelId ? 'fake' : null,
  modelId,
  keySource: 'user',
  tally: t,
  latencyMs: 0,
  ...extra,
});

const group = (modelId: string, over: Partial<UsageRowGroup> = {}): UsageRowGroup => ({
  runId: 'r',
  provider: 'fake',
  modelId,
  keySource: 'user',
  requests: 1,
  failed: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  latencyMs: 0,
  ...over,
});

describe('attributeRun', () => {
  it('one node per model: every row of that model goes to it (planner 1,200/300, critic 800/120)', () => {
    const { units, unattributed } = attributeRun(
      [unit('adapt', 'model-p', tally(1, 1_200, 300)), unit('critic', 'model-c', tally(1, 800, 120))],
      [
        group('model-p', { inputTokens: 1_200, outputTokens: 300, cachedInputTokens: 100, latencyMs: 40 }),
        group('model-c', { inputTokens: 800, outputTokens: 120, latencyMs: 20 }),
        group('model-c', { requests: 1, failed: 1, latencyMs: 3 }),
      ],
    );

    expect(unattributed).toEqual([]);
    expect(units.map((u) => [u.key, u.bucket.requests, u.bucket.failed, u.bucket.inputTokens, u.bucket.outputTokens, u.bucket.cachedInputTokens, u.bucket.latencyMs])).toEqual([
      ['adapt', 1, 0, 1_200, 300, 100, 40],
      ['critic', 2, 1, 800, 120, 0, 23],
    ]);
  });

  it('a shared model: each node its tally, the rest unattributed; the parts add up to the rows', () => {
    const groups = [
      group('model-s', { requests: 3, inputTokens: 1_500, outputTokens: 300, cachedInputTokens: 50, latencyMs: 30, keySource: 'org' }),
      group('model-s', { requests: 1, failed: 1, latencyMs: 2, keySource: 'org' }),
    ];
    const { units, unattributed } = attributeRun(
      [
        unit('plan', 'model-s', tally(2, 1_000, 200), { keySource: 'org', latencyMs: 20 }),
        unit('critique', 'model-s', tally(1, 500, 100), { keySource: 'org', latencyMs: 10 }),
      ],
      groups,
    );

    expect(units.map((u) => [u.key, u.bucket.requests, u.bucket.inputTokens, u.bucket.orgKeyRequests, u.bucket.latencyMs])).toEqual([
      ['plan', 2, 1_000, 2, 20],
      ['critique', 1, 500, 1, 10],
    ]);
    expect(unattributed).toHaveLength(1);
    expect(unattributed[0]).toMatchObject({ provider: 'fake', modelId: 'model-s', keySource: 'org' });
    expect(unattributed[0].bucket).toMatchObject({ requests: 1, failed: 1, inputTokens: 0, cachedInputTokens: 50, latencyMs: 2 });

    const rows = groups.reduce((sum, g) => sum + bucketOfGroup(g).requests, 0);
    expect(units.reduce((sum, u) => sum + u.bucket.requests, 0) + unattributed[0].bucket.requests).toBe(rows);
  });

  it('mixed providers: one row per node, never summed across providers', () => {
    const { units } = attributeRun(
      [unit('plan', 'gpt', tally(1, 10, 5), { provider: 'openai' }), unit('critique', 'claude', tally(1, 20, 5), { provider: 'anthropic' })],
      [group('gpt', { provider: 'openai', inputTokens: 10, outputTokens: 5 }), group('claude', { provider: 'anthropic', inputTokens: 20, outputTokens: 5 })],
    );

    expect(units.map((u) => [u.key, u.provider, u.bucket.inputTokens])).toEqual([
      ['plan', 'openai', 10],
      ['critique', 'anthropic', 20],
    ]);
  });

  it('rows of a model no node was frozen to are unattributed', () => {
    const { units, unattributed } = attributeRun([unit('plan', 'model-p', tally(0, 0, 0))], [group('other', { inputTokens: 7 })]);

    expect(units[0].bucket).toEqual(emptyBucket());
    expect(unattributed.map((u) => [u.modelId, u.bucket.inputTokens])).toEqual([['other', 7]]);
  });

  it('no rows (retention removed them): every node reports its tally, no failures, no cached input', () => {
    const { units, unattributed } = attributeRun([unit('plan', 'model-p', tally(2, 100, 50, 10), { latencyMs: 9 })], []);

    expect(unattributed).toEqual([]);
    expect(units[0].bucket).toEqual({ ...emptyBucket(), requests: 2, inputTokens: 100, outputTokens: 50, reasoningTokens: 10, latencyMs: 9 });
  });

  it('a node with an unknown model still shows its tally', () => {
    const { units } = attributeRun([unit('mystery', null, tally(1, 30, 3), { role: null })], [group('model-p', { inputTokens: 5 })]);

    expect(units[0].bucket.inputTokens).toBe(30);
  });
});

describe('median', () => {
  it('is the middle value, or the rounded mean of the two middle ones', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 2, 3])).toBe(3); // (2 + 3) / 2 = 2.5 -> 3
    expect(median([])).toBe(0);
  });
});

describe('nodeFactsFromEvents', () => {
  it('sums agent.usage events per node, keeping the role and model', () => {
    const facts = nodeFactsFromEvents([
      { role: 'planner', node: 'adapt', provider: 'fake', model: 'm', inputTokens: 10, outputTokens: 2, reasoningTokens: 1, latencyMs: 5 },
      { role: 'planner', node: 'adapt', provider: 'fake', model: 'm', inputTokens: 20, outputTokens: 3, reasoningTokens: 0, latencyMs: 7 },
      { node: 'critic', role: 'not-a-role' },
      { garbage: true },
    ]);

    expect(facts.get('adapt')).toEqual({
      role: 'planner',
      provider: 'fake',
      modelId: 'm',
      latencyMs: 12,
      tally: { calls: 2, inputTokens: 30, outputTokens: 5, reasoningTokens: 1 },
    });
    expect(facts.get('critic')?.role).toBeNull();
    expect(facts.size).toBe(2);
  });
});

describe('resolveUsageMonth', () => {
  const now = new Date('2026-09-30T23:59:00.000Z');

  it('defaults to the current UTC month, days inclusive', () => {
    expect(resolveUsageMonth(undefined, now)).toMatchObject({ month: '2026-09', from: '2026-09-01', to: '2026-09-30' });
    const feb = resolveUsageMonth('2026-02', now);
    expect(feb).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
    expect(feb.end.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('allows exactly 12 months back and refuses 13 or a future month', () => {
    expect(resolveUsageMonth('2025-09', now).month).toBe('2025-09');
    for (const month of ['2025-08', '2026-10', '2026-13']) {
      expect(() => resolveUsageMonth(month, now)).toThrow();
    }
    try {
      resolveUsageMonth('2027-01', now);
    } catch (err) {
      expect((err as { getResponse(): { details: { reason: string } } }).getResponse().details.reason).toBe('TRAINING_USAGE_MONTH_INVALID');
    }
  });
});

describe('runCapState', () => {
  const usage = (input: number, output: number, reasoning = 0) => ({ total: { calls: 1, inputTokens: input, outputTokens: output, reasoningTokens: reasoning } });

  it('counts what the budget enforces (input + output + reasoning)', () => {
    expect(runCapState(20_000, usage(1_000, 500, 100), null)).toEqual({ limitTokens: 20_000, usedTokens: 1_600, reached: false });
  });

  it('is reached at or over the limit, or when the run failed with the budget code', () => {
    expect(runCapState(1_500, usage(1_200, 300), null)).toEqual({ limitTokens: 1_500, usedTokens: 1_500, reached: true, reason: 'token_cap' });
    expect(runCapState(20_000, usage(10, 10), 'TRAINING_RUN_BUDGET_EXCEEDED')).toMatchObject({ reached: true, reason: 'token_cap' });
    expect(runCapState(20_000, {}, null)).toEqual({ limitTokens: 20_000, usedTokens: 0, reached: false });
  });
});
