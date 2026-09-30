import {
  TRAINING_MAX_RUN_TOKENS,
  type TaskReasoningEffort,
  type TrainingAgentRole,
  type UserAiSettingsValue,
} from '../../common/schemas/settings.schema';

// =============================================================================
// Training run token estimate and per-run cap
// =============================================================================
//
// THESE ARE ESTIMATES, NOT QUOTES. The numbers below are rough per-call token
// budgets used to tell a user, before a run starts, roughly how many tokens it
// may spend and whether their cap would bind. Real usage depends on the model,
// the provider's own search context and what the agents write. Tokens only:
// no currency is ever computed (the platform has no price catalog).
//
// Per call, before the effort multiplier on output:
//
//   role                output low..high     input
//   researcher          6,000 .. 20,000      2,000 + 15,000 flat allowance for
//                                            provider-side search context
//   planner (per pass)  8,000 .. 20,000      contextChars / 4 + 3,000 brief
//   critic (per round)  3,000 .. 8,000       8,000 draft + contextChars / 4
//   evaluator           2,000 .. 6,000       4,000 .. 10,000
//
// Which calls a run makes:
//
//   create    researcher once; planner and critic
//   revise    planner and critic
//   evaluate  evaluator; the high bound adds one critic round (the critic runs
//             only when structural changes are possible, which the runtime
//             decides)
//
// `low` assumes one planner pass and one critic round; `high` assumes the full
// `criticRounds` critic rounds and a planner revision after each of them.
// =============================================================================

export const TRAINING_RUN_KINDS = ['create', 'revise', 'evaluate'] as const;

export type TrainingRunKind = (typeof TRAINING_RUN_KINDS)[number];

/** The per-run token cap when the user has not set `ai.training.maxRunTokens`. */
export const TRAINING_DEFAULT_RUN_TOKENS: Readonly<Record<TrainingRunKind, number>> = {
  create: 400_000,
  revise: 400_000,
  evaluate: 150_000,
};

/** The hard maximum a user may set (the settings schema enforces it). */
export const TRAINING_HARD_MAX_RUN_TOKENS = TRAINING_MAX_RUN_TOKENS;

/** Critic rounds when the user has not set `ai.training.maxCriticRounds`. */
export const TRAINING_DEFAULT_CRITIC_ROUNDS = 2;

/** Context size assumed for "a typical plan" when the caller does not say. */
export const TRAINING_TYPICAL_CONTEXT_CHARS = 12_000;

/** Output-token multiplier per reasoning effort; `null` (no reasoning) is 1.0. */
export const EFFORT_MULTIPLIER: Readonly<Record<TaskReasoningEffort, number>> = {
  minimal: 0.6,
  low: 0.8,
  medium: 1.0,
  high: 1.6,
};

export const RESEARCHER_OUTPUT = { low: 6_000, high: 20_000 } as const;
export const RESEARCHER_INPUT = 2_000;
export const RESEARCHER_SEARCH_ALLOWANCE = 15_000;
export const PLANNER_OUTPUT = { low: 8_000, high: 20_000 } as const;
export const PLANNER_BRIEF = 3_000;
export const CRITIC_OUTPUT = { low: 3_000, high: 8_000 } as const;
export const CRITIC_DRAFT = 8_000;
export const EVALUATOR_OUTPUT = { low: 2_000, high: 6_000 } as const;
export const EVALUATOR_INPUT = { low: 4_000, high: 10_000 } as const;

export interface TokenRange {
  low: number;
  high: number;
}

export interface RunTokenEstimateInput {
  kind: TrainingRunKind;
  /** Critic rounds the run may take (1 to 3). */
  criticRounds: number;
  /** Characters of user context sent to the planner and critic. */
  contextChars: number;
  /** The effort each role will send; absent or `null` counts as 1.0. */
  roles?: Partial<Record<TrainingAgentRole, TaskReasoningEffort | null>>;
}

export interface RunTokenEstimate extends TokenRange {
  /** Only the roles this kind of run calls. */
  byRole: Partial<Record<TrainingAgentRole, TokenRange>>;
}

function multiplier(effort: TaskReasoningEffort | null | undefined): number {
  return effort ? EFFORT_MULTIPLIER[effort] : 1.0;
}

function calls(
  output: TokenRange,
  input: TokenRange,
  mult: number,
  count: TokenRange,
): TokenRange {
  return {
    low: Math.round(count.low * (input.low + output.low * mult)),
    high: Math.round(count.high * (input.high + output.high * mult)),
  };
}

/** A pure estimate of a run's total tokens (input plus output), by role. */
export function estimateRunTokens(input: RunTokenEstimateInput): RunTokenEstimate {
  const rounds = Math.max(1, Math.floor(input.criticRounds));
  const contextTokens = Math.ceil(Math.max(0, input.contextChars) / 4);
  const efforts = input.roles ?? {};
  const byRole: RunTokenEstimate['byRole'] = {};

  const critic = (count: TokenRange) =>
    calls(CRITIC_OUTPUT, both(CRITIC_DRAFT + contextTokens), multiplier(efforts.critic), count);

  if (input.kind === 'evaluate') {
    byRole.evaluator = calls(EVALUATOR_OUTPUT, EVALUATOR_INPUT, multiplier(efforts.evaluator), { low: 1, high: 1 });
    byRole.critic = critic({ low: 0, high: 1 });
  } else {
    if (input.kind === 'create') {
      byRole.researcher = calls(
        RESEARCHER_OUTPUT,
        both(RESEARCHER_INPUT + RESEARCHER_SEARCH_ALLOWANCE),
        multiplier(efforts.researcher),
        { low: 1, high: 1 },
      );
    }
    byRole.planner = calls(PLANNER_OUTPUT, both(PLANNER_BRIEF + contextTokens), multiplier(efforts.planner), {
      low: 1,
      high: 1 + rounds,
    });
    byRole.critic = critic({ low: 1, high: rounds });
  }

  const ranges = Object.values(byRole);

  return {
    low: ranges.reduce((sum, r) => sum + r.low, 0),
    high: ranges.reduce((sum, r) => sum + r.high, 0),
    byRole,
  };
}

function both(value: number): TokenRange {
  return { low: value, high: value };
}

/** The per-run token cap for `kind`: the user's `maxRunTokens`, else the default. */
export function effectiveTokenCap(kind: TrainingRunKind, settings: UserAiSettingsValue | undefined): number {
  return settings?.training?.maxRunTokens ?? TRAINING_DEFAULT_RUN_TOKENS[kind];
}
