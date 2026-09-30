import {
  effectiveTokenCap,
  estimateRunTokens,
  type RunTokenEstimateInput,
  TRAINING_DEFAULT_RUN_TOKENS,
  TRAINING_RUN_KINDS,
} from './token-estimate';

// Table-driven: fixed inputs give the documented numbers.

describe('estimateRunTokens', () => {
  it.each<[string, RunTokenEstimateInput, { low: number; high: number; byRole: Record<string, { low: number; high: number }> }]>([
    [
      'create, 2 rounds, 12,000 chars, no effort',
      { kind: 'create', criticRounds: 2, contextChars: 12_000 },
      {
        low: 51_000,
        high: 153_000,
        byRole: {
          researcher: { low: 23_000, high: 37_000 },
          planner: { low: 14_000, high: 78_000 },
          critic: { low: 14_000, high: 38_000 },
        },
      },
    ],
    [
      'create, 2 rounds, 12,000 chars, high planner and critic, medium researcher',
      { kind: 'create', criticRounds: 2, contextChars: 12_000, roles: { researcher: 'medium', planner: 'high', critic: 'high' } },
      {
        low: 23_000 + 18_800 + 15_800,
        high: 37_000 + 114_000 + 47_600,
        byRole: {
          researcher: { low: 23_000, high: 37_000 },
          planner: { low: 18_800, high: 114_000 },
          critic: { low: 15_800, high: 47_600 },
        },
      },
    ],
    [
      'revise, 1 round, no context, minimal effort',
      { kind: 'revise', criticRounds: 1, contextChars: 0, roles: { planner: 'minimal', critic: 'minimal' } },
      {
        low: 17_600,
        high: 42_800,
        byRole: {
          planner: { low: 7_800, high: 30_000 },
          critic: { low: 9_800, high: 12_800 },
        },
      },
    ],
    [
      'evaluate, no context, no effort',
      { kind: 'evaluate', criticRounds: 2, contextChars: 0 },
      {
        low: 6_000,
        high: 32_000,
        byRole: {
          evaluator: { low: 6_000, high: 16_000 },
          critic: { low: 0, high: 16_000 },
        },
      },
    ],
    [
      'evaluate, low evaluator effort',
      { kind: 'evaluate', criticRounds: 1, contextChars: 0, roles: { evaluator: 'low' } },
      {
        low: 5_600,
        high: 30_800,
        byRole: {
          evaluator: { low: 5_600, high: 14_800 },
          critic: { low: 0, high: 16_000 },
        },
      },
    ],
  ])('%s', (_name, input, expected) => {
    expect(estimateRunTokens(input)).toEqual(expected);
  });

  it('low <= high for every kind, round count, context size and effort', () => {
    for (const kind of TRAINING_RUN_KINDS) {
      for (const criticRounds of [1, 2, 3]) {
        for (const contextChars of [0, 1, 12_000, 400_000]) {
          for (const effort of [null, 'minimal', 'low', 'medium', 'high'] as const) {
            const r = estimateRunTokens({
              kind,
              criticRounds,
              contextChars,
              roles: { researcher: effort, planner: effort, critic: effort, evaluator: effort },
            });

            expect(r.low).toBeLessThanOrEqual(r.high);
            expect(r.low).toBeGreaterThan(0);
            for (const range of Object.values(r.byRole)) {
              expect(range.low).toBeLessThanOrEqual(range.high);
            }
          }
        }
      }
    }
  });

  it('only the roles a kind calls appear in byRole', () => {
    expect(Object.keys(estimateRunTokens({ kind: 'create', criticRounds: 2, contextChars: 0 }).byRole).sort()).toEqual([
      'critic',
      'planner',
      'researcher',
    ]);
    expect(Object.keys(estimateRunTokens({ kind: 'revise', criticRounds: 2, contextChars: 0 }).byRole).sort()).toEqual([
      'critic',
      'planner',
    ]);
    expect(Object.keys(estimateRunTokens({ kind: 'evaluate', criticRounds: 2, contextChars: 0 }).byRole).sort()).toEqual([
      'critic',
      'evaluator',
    ]);
  });

  it('more critic rounds only raise the high bound', () => {
    const one = estimateRunTokens({ kind: 'create', criticRounds: 1, contextChars: 0 });
    const three = estimateRunTokens({ kind: 'create', criticRounds: 3, contextChars: 0 });

    expect(three.low).toBe(one.low);
    expect(three.high).toBeGreaterThan(one.high);
  });
});

describe('effectiveTokenCap', () => {
  it.each(TRAINING_RUN_KINDS)('%s: the default when unset', (kind) => {
    expect(effectiveTokenCap(kind, undefined)).toBe(TRAINING_DEFAULT_RUN_TOKENS[kind]);
    expect(effectiveTokenCap(kind, {})).toBe(TRAINING_DEFAULT_RUN_TOKENS[kind]);
    expect(effectiveTokenCap(kind, { training: { maxRunTokens: null } })).toBe(
      TRAINING_DEFAULT_RUN_TOKENS[kind],
    );
  });

  it('the user setting when set', () => {
    expect(effectiveTokenCap('evaluate', { training: { maxRunTokens: 50_000 } })).toBe(50_000);
  });

  it('defaults are 400k, 400k, 150k', () => {
    expect(TRAINING_DEFAULT_RUN_TOKENS).toEqual({ create: 400_000, revise: 400_000, evaluate: 150_000 });
  });
});
