/** Agent usage (E6.3) fixtures: one run's usage by step, and one month. Tokens only. */
import type {
  TrainingMonthlyUsage,
  TrainingRunUsage,
  TrainingRunUsageNode,
  TrainingUsageBucket,
} from '../../../services/trainingUsage';

export const USAGE_RUN_ID = '00000000-0000-4000-8000-e00000000002';

export function usageBucket(overrides: Partial<TrainingUsageBucket> = {}): TrainingUsageBucket {
  return {
    requests: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    latencyMs: 0,
    orgKeyRequests: 0,
    orgKeyInputTokens: 0,
    orgKeyOutputTokens: 0,
    ...overrides,
  };
}

export function usageNode(overrides: Partial<TrainingRunUsageNode> = {}): TrainingRunUsageNode {
  return {
    ...usageBucket(),
    node: 'adapt',
    role: 'planner',
    provider: 'openai',
    modelId: 'frontier-1',
    keySource: 'user',
    ...overrides,
  };
}

/** The issue's scripted run: planner 1,200 in / 300 out, critic 800 in / 120 out. */
export function mockRunUsage(overrides: Partial<TrainingRunUsage> = {}): TrainingRunUsage {
  return {
    runId: USAGE_RUN_ID,
    jobId: '00000000-0000-4000-8000-e00000000099',
    kind: 'adapt',
    status: 'succeeded',
    totals: usageBucket({
      requests: 2,
      inputTokens: 2000,
      outputTokens: 420,
      latencyMs: 5300,
      orgKeyRequests: 1,
      orgKeyInputTokens: 800,
      orgKeyOutputTokens: 120,
    }),
    byNode: [
      usageNode({ node: 'adapt', role: 'planner', requests: 1, inputTokens: 1200, outputTokens: 300, latencyMs: 4200 }),
      usageNode({
        node: 'critic',
        role: 'critic',
        provider: 'anthropic',
        modelId: 'fast-1',
        keySource: 'org',
        requests: 1,
        inputTokens: 800,
        outputTokens: 120,
        latencyMs: 1100,
        orgKeyRequests: 1,
        orgKeyInputTokens: 800,
        orgKeyOutputTokens: 120,
      }),
    ],
    cap: { limitTokens: 120000, usedTokens: 2420, reached: false },
    retention: { purged: false, retentionDays: 180 },
    ...overrides,
  };
}

export function mockMonthlyUsage(overrides: Partial<TrainingMonthlyUsage> = {}): TrainingMonthlyUsage {
  return {
    month: '2026-09',
    range: { from: '2026-09-01', to: '2026-09-30' },
    totals: usageBucket({ requests: 12, failed: 1, inputTokens: 30000, outputTokens: 6000, reasoningTokens: 1000, orgKeyRequests: 4 }),
    byRole: [
      { role: 'planner', ...usageBucket({ requests: 6, inputTokens: 18000, outputTokens: 4000 }) },
      { role: 'critic', ...usageBucket({ requests: 5, failed: 1, inputTokens: 10000, outputTokens: 1500 }) },
      { role: 'unattributed', ...usageBucket({ requests: 1, inputTokens: 2000, outputTokens: 500 }) },
    ],
    byModel: [{ provider: 'openai', modelId: 'frontier-1', ...usageBucket({ requests: 12, inputTokens: 30000, outputTokens: 6000 }) }],
    byKeySource: [
      { keySource: 'user', ...usageBucket({ requests: 8, inputTokens: 20000, outputTokens: 4000 }) },
      { keySource: 'org', ...usageBucket({ requests: 3, inputTokens: 8000, outputTokens: 1500 }) },
      { keySource: 'none', ...usageBucket({ requests: 1, inputTokens: 2000, outputTokens: 500 }) },
    ],
    byKind: [
      { kind: 'adapt', runs: 3, ...usageBucket({ requests: 7, inputTokens: 12000, outputTokens: 2000 }) },
      { kind: 'create', runs: 1, ...usageBucket({ requests: 5, inputTokens: 18000, outputTokens: 4000 }) },
    ],
    typical: { create: null, revise: null, evaluate: null, adapt: null },
    retention: { partial: false, retentionDays: 180 },
    ...overrides,
  };
}

export function mockMonthlyUsageEmpty(month = '2026-09'): TrainingMonthlyUsage {
  return mockMonthlyUsage({
    month,
    totals: usageBucket(),
    byRole: [],
    byModel: [],
    byKeySource: [],
    byKind: [],
  });
}
