import { RunBudget, RunBudgetExceededError, countedTokens, parseRunUsage, totalsOf } from './run-budget';

describe('RunBudget', () => {
  it('counts input, output and reasoning tokens, by role, by node and in total', () => {
    const budget = new RunBudget(1_000);

    budget.charge({ inputTokens: 100, outputTokens: 50, reasoningTokens: 25 }, { role: 'planner', node: 'plan' });
    budget.charge({ inputTokens: 10, outputTokens: 5 }, { role: 'critic', node: 'critique' });
    budget.charge({ inputTokens: 1, outputTokens: 1, reasoningTokens: 1 }, { role: 'planner', node: 'plan' });

    expect(budget.used).toBe(193);
    expect(budget.remaining()).toBe(807);
    expect(budget.snapshot()).toEqual({
      byRole: {
        planner: { calls: 2, inputTokens: 101, outputTokens: 51, reasoningTokens: 26 },
        critic: { calls: 1, inputTokens: 10, outputTokens: 5, reasoningTokens: 0 },
      },
      byNode: {
        plan: { calls: 2, inputTokens: 101, outputTokens: 51, reasoningTokens: 26 },
        critique: { calls: 1, inputTokens: 10, outputTokens: 5, reasoningTokens: 0 },
      },
      total: { calls: 3, inputTokens: 111, outputTokens: 56, reasoningTokens: 26 },
    });
  });

  it('treats a missing usage as zero tokens but still one call', () => {
    const budget = new RunBudget(10);

    expect(budget.charge(undefined, { role: 'critic', node: 'critique' })).toEqual({
      calls: 1,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    });
    expect(budget.used).toBe(0);
  });

  it('assertAvailable passes while tokens remain and throws RunBudgetExceededError once the cap is spent', () => {
    const budget = new RunBudget(100);

    budget.charge({ inputTokens: 99 }, { role: 'planner', node: 'plan' });
    expect(() => budget.assertAvailable('planner')).not.toThrow();

    // A single call may overshoot by its own size.
    budget.charge({ inputTokens: 50 }, { role: 'planner', node: 'plan' });
    expect(budget.remaining()).toBe(0);

    const error = (() => {
      try {
        budget.assertAvailable('critic');
      } catch (e) {
        return e;
      }
      return null;
    })();

    expect(error).toBeInstanceOf(RunBudgetExceededError);
    expect(error).toMatchObject({ code: 'TRAINING_RUN_BUDGET_EXCEEDED', cap: 100, used: 149, role: 'critic' });
  });

  it('continues from a stored usage (a resumed run keeps its spend)', () => {
    const stored = new RunBudget(500);
    stored.charge({ inputTokens: 200 }, { role: 'researcher', node: 'research' });

    const resumed = new RunBudget(500, parseRunUsage(JSON.parse(JSON.stringify(stored.snapshot()))));

    expect(resumed.used).toBe(200);
    expect(resumed.byRole.researcher?.calls).toBe(1);
  });

  it('refuses a non-positive or fractional cap', () => {
    expect(() => new RunBudget(0)).toThrow();
    expect(() => new RunBudget(1.5)).toThrow();
  });
});

describe('parseRunUsage', () => {
  it('reads the column default `{}` as an empty tally', () => {
    expect(parseRunUsage({})).toEqual({
      byRole: {},
      byNode: {},
      total: { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    });
  });

  it('ignores junk and negative counts', () => {
    const usage = parseRunUsage({ total: { calls: -1, inputTokens: 'x', outputTokens: 5.9 }, byRole: [] });

    expect(usage.total).toEqual({ calls: 0, inputTokens: 0, outputTokens: 5, reasoningTokens: 0 });
    expect(usage.byRole).toEqual({});
  });
});

describe('totalsOf / countedTokens', () => {
  it('sums the three counted fields', () => {
    expect(countedTokens(totalsOf({ inputTokens: 1, outputTokens: 2, reasoningTokens: 3, cachedInputTokens: 99 }))).toBe(6);
  });
});
