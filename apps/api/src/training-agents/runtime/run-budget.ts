import type { AiUsage } from '../../ai/core/types/responses.types';
import type { TrainingAgentRole } from '../../common/schemas/settings.schema';

// =============================================================================
// RunBudget: the per-run token cap and the usage tally
// =============================================================================
//
// One budget per run, frozen at start (`training_plan_runs.token_cap`) and
// carried across resumes (it is rebuilt from `training_plan_runs.usage`, so a
// resumed run keeps spending against the same cap).
//
// Tokens counted: `inputTokens + outputTokens + reasoningTokens`, each where
// the provider reported it. `assertAvailable` is checked before every call
// and `charge` after it. A single call can overshoot the cap by its own size;
// `AgentCaller` bounds that by clamping `maxOutputTokens` to `remaining()`.
//
// The tally (`byRole`, `byNode`, `total`) is what `training_plan_runs.usage`
// stores, so per-agent cost views need no schema change.
// =============================================================================

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface RunUsage {
  byRole: Partial<Record<TrainingAgentRole, UsageTotals>>;
  byNode: Record<string, UsageTotals>;
  total: UsageTotals;
}

export const EMPTY_TOTALS: Readonly<UsageTotals> = Object.freeze({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

/** Tokens a totals row counts against the cap. */
export function countedTokens(totals: UsageTotals): number {
  return totals.inputTokens + totals.outputTokens + totals.reasoningTokens;
}

/** Thrown when a call would start with the cap already spent. */
export class RunBudgetExceededError extends Error {
  readonly code = 'TRAINING_RUN_BUDGET_EXCEEDED';

  constructor(
    readonly cap: number,
    readonly used: number,
    readonly role?: TrainingAgentRole,
  ) {
    super(`The run's token budget is spent (${used} of ${cap} tokens).`);
    this.name = 'RunBudgetExceededError';
  }
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function readTotals(value: unknown): UsageTotals {
  const v = (value ?? {}) as Record<string, unknown>;

  return {
    calls: nonNegativeInt(v.calls),
    inputTokens: nonNegativeInt(v.inputTokens),
    outputTokens: nonNegativeInt(v.outputTokens),
    reasoningTokens: nonNegativeInt(v.reasoningTokens),
  };
}

function readMap(value: unknown): Record<string, UsageTotals> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  return Object.fromEntries(Object.entries(value).map(([key, totals]) => [key, readTotals(totals)]));
}

/** Parses a stored `training_plan_runs.usage` value, tolerating `{}` and junk. */
export function parseRunUsage(value: unknown): RunUsage {
  const v = (value ?? {}) as Record<string, unknown>;

  return {
    byRole: readMap(v.byRole) as RunUsage['byRole'],
    byNode: readMap(v.byNode),
    total: readTotals(v.total),
  };
}

function add(into: UsageTotals, usage: UsageTotals): UsageTotals {
  return {
    calls: into.calls + usage.calls,
    inputTokens: into.inputTokens + usage.inputTokens,
    outputTokens: into.outputTokens + usage.outputTokens,
    reasoningTokens: into.reasoningTokens + usage.reasoningTokens,
  };
}

/** One call's usage as totals (`calls: 1`). Missing counts are zero. */
export function totalsOf(usage: AiUsage | undefined): UsageTotals {
  return {
    calls: 1,
    inputTokens: nonNegativeInt(usage?.inputTokens),
    outputTokens: nonNegativeInt(usage?.outputTokens),
    reasoningTokens: nonNegativeInt(usage?.reasoningTokens),
  };
}

export class RunBudget {
  private tally: RunUsage;

  constructor(
    readonly cap: number,
    initial?: RunUsage,
  ) {
    if (!Number.isInteger(cap) || cap <= 0) {
      throw new Error(`A run budget needs a positive integer cap, got ${cap}`);
    }

    this.tally = initial
      ? { byRole: { ...initial.byRole }, byNode: { ...initial.byNode }, total: { ...initial.total } }
      : { byRole: {}, byNode: {}, total: { ...EMPTY_TOTALS } };
  }

  /** Tokens counted so far. */
  get used(): number {
    return countedTokens(this.tally.total);
  }

  /** Tokens counted so far, by role. */
  get byRole(): Readonly<Partial<Record<TrainingAgentRole, UsageTotals>>> {
    return this.tally.byRole;
  }

  /** Tokens left before the cap (never negative). */
  remaining(): number {
    return Math.max(0, this.cap - this.used);
  }

  /** Throws `RunBudgetExceededError` when nothing is left. */
  assertAvailable(role?: TrainingAgentRole): void {
    if (this.remaining() <= 0) {
      throw new RunBudgetExceededError(this.cap, this.used, role);
    }
  }

  /** Adds one call's usage to the total, its role and its node. Returns the call's totals. */
  charge(usage: AiUsage | undefined, at: { role: TrainingAgentRole; node: string }): UsageTotals {
    const call = totalsOf(usage);

    this.tally = {
      byRole: { ...this.tally.byRole, [at.role]: add(this.tally.byRole[at.role] ?? { ...EMPTY_TOTALS }, call) },
      byNode: { ...this.tally.byNode, [at.node]: add(this.tally.byNode[at.node] ?? { ...EMPTY_TOTALS }, call) },
      total: add(this.tally.total, call),
    };

    return call;
  }

  /** A copy of the tally, as `training_plan_runs.usage` stores it. */
  snapshot(): RunUsage {
    return {
      byRole: Object.fromEntries(Object.entries(this.tally.byRole).map(([k, v]) => [k, { ...v }])),
      byNode: Object.fromEntries(Object.entries(this.tally.byNode).map(([k, v]) => [k, { ...v }])),
      total: { ...this.tally.total },
    };
  }
}
