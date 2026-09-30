import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { TRAINING_AGENT_ROLES } from '../../common/schemas/settings.schema';

// =============================================================================
// Training agent usage: query and report shapes (E6.3)
// =============================================================================
//
//   GET /api/ai/training/runs/:runId/usage   one of my runs, by node and role, with its cap
//   GET /api/ai/training/usage?month=YYYY-MM my agent runs in one UTC month
//
// Tokens, model and key source only: the platform has no price catalog, so
// no currency is computed anywhere.
//
// SOURCES. `ai_usage_events` (one row per provider round trip, joined to a
// run through its `job_id`) is the source of truth for requests, failures,
// cached input, latency and the key source. It carries no node or role, so
// attribution to a node (per run) or a role (per month) comes from the run
// itself: `training_plan_runs.usage` (the kit's tally, by node and role, kept
// with the run for 365 days) and `roleModels` (the model frozen per role),
// with the `agent.usage` run events (kept 30 days) adding the node -> role
// map and per-node latency while they exist. See `training-usage.attribution.ts`.
// =============================================================================

/** How many whole months back `month` may reach (the current month is 0). */
export const TRAINING_USAGE_MAX_MONTHS_BACK = 12;

/** Completed runs the typical-usage median looks at, newest first. */
export const TRAINING_USAGE_TYPICAL_WINDOW = 10;

/** Fewer completed runs than this: no typical number (the UI says nothing). */
export const TRAINING_USAGE_TYPICAL_MIN_RUNS = 3;

/** The role a usage row falls into when no single role can be named for it. */
export const UNATTRIBUTED_ROLE = 'unattributed';

/** Stable reason for an unusable `month` (in `details.reason`). */
export const TRAINING_USAGE_MONTH_INVALID = 'TRAINING_USAGE_MONTH_INVALID';

/** The run kinds a report splits by (the kit's `training_plan_runs.kind`). */
export const TRAINING_USAGE_RUN_KINDS = ['create', 'revise', 'evaluate', 'adapt'] as const;

export const trainingUsageMonthQuerySchema = z.object({
  /** The UTC month (`YYYY-MM`). Default: the current UTC month; at most 12 months back, never in the future. */
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM')
    .optional(),
});

export class TrainingUsageMonthQueryDto extends createZodDto(trainingUsageMonthQuerySchema) {}
export type TrainingUsageMonthQuery = z.output<typeof trainingUsageMonthQuerySchema>;

export const trainingUsageRunParamSchema = z.object({
  runId: z.string().uuid(),
});

export class TrainingUsageRunParamDto extends createZodDto(trainingUsageRunParamSchema) {}

/**
 * One bucket of agent usage. `requests` counts every recorded provider round
 * trip (succeeded, failed, cancelled); `failed` is the `failed` subset. Token
 * sums treat an unreported count as zero; providers count reasoning tokens
 * INSIDE `outputTokens` (`reasoningTokens` is a breakdown, never added on
 * top). `latencyMs` is the summed provider latency. `orgKey*`: the part the
 * organisation key paid for.
 */
export const trainingUsageBucketSchema = z.object({
  requests: z.number().int(),
  failed: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  reasoningTokens: z.number().int(),
  cachedInputTokens: z.number().int(),
  latencyMs: z.number().int(),
  orgKeyRequests: z.number().int(),
  orgKeyInputTokens: z.number().int(),
  orgKeyOutputTokens: z.number().int(),
});

export type TrainingUsageBucket = z.infer<typeof trainingUsageBucketSchema>;

const roleSchema = z.enum(TRAINING_AGENT_ROLES);

export const trainingRunUsageNodeSchema = trainingUsageBucketSchema.extend({
  /** The graph node (`plan`, `critique`, `adapt`, `critic`, ...); `null` on the unattributed row. */
  node: z.string().nullable(),
  /** The agent role the node runs as; `null` when unknown or unattributed. */
  role: roleSchema.nullable(),
  provider: z.string().nullable(),
  modelId: z.string().nullable(),
  /** Whose key paid: `user` (your key), `org` (the organisation's), `none` (a keyless server). */
  keySource: z.string().nullable(),
});

export const trainingRunUsageSchema = z.object({
  runId: z.string().uuid(),
  /** The run's current queue job (a resume creates a new one); `null` before one exists. */
  jobId: z.string().uuid().nullable(),
  kind: z.string(),
  status: z.string(),
  totals: trainingUsageBucketSchema,
  /**
   * One row per node (one provider and model each; a run with mixed providers
   * has one row per node, never summed across providers). A final row with
   * `node: null` holds what cannot be pinned to one node: typically failed
   * calls when two nodes share a model.
   */
  byNode: z.array(trainingRunUsageNodeSchema),
  cap: z.object({
    limitTokens: z.number().int(),
    /** Input + output + reasoning tokens: the count the run's budget enforces. */
    usedTokens: z.number().int(),
    reached: z.boolean(),
    reason: z.literal('token_cap').optional(),
  }),
  retention: z.object({
    /** The usage rows of this run were removed by `ai.usageRetentionDays`; numbers come from the run's own tally. */
    purged: z.boolean(),
    retentionDays: z.number().int(),
  }),
});

export class TrainingRunUsageDto extends createZodDto(trainingRunUsageSchema) {}
export type TrainingRunUsage = z.infer<typeof trainingRunUsageSchema>;
export type TrainingRunUsageNode = z.infer<typeof trainingRunUsageNodeSchema>;

const typicalSchema = z
  .object({
    /** Completed runs the median was taken over (at most 10). */
    runs: z.number().int(),
    /** Median input + output + reasoning tokens (the cap's count). */
    medianTokens: z.number().int(),
  })
  .nullable();

export const trainingMonthlyUsageSchema = z.object({
  month: z.string(),
  /** UTC days, both inclusive. */
  range: z.object({ from: z.iso.date(), to: z.iso.date() }),
  totals: trainingUsageBucketSchema,
  byRole: z.array(trainingUsageBucketSchema.extend({ role: z.union([roleSchema, z.literal(UNATTRIBUTED_ROLE)]) })),
  byModel: z.array(trainingUsageBucketSchema.extend({ provider: z.string(), modelId: z.string() })),
  byKeySource: z.array(trainingUsageBucketSchema.extend({ keySource: z.string() })),
  byKind: z.array(trainingUsageBucketSchema.extend({ kind: z.string(), runs: z.number().int() })),
  /**
   * From your own history, not from this month: the median tokens of your last
   * 10 completed runs of each kind; `null` with fewer than 3.
   */
  typical: z.object({
    create: typicalSchema,
    revise: typicalSchema,
    evaluate: typicalSchema,
    adapt: typicalSchema,
  }),
  retention: z.object({
    /** Some of this month is older than `ai.usageRetentionDays`: its usage rows may be gone. */
    partial: z.boolean(),
    retentionDays: z.number().int(),
  }),
});

export class TrainingMonthlyUsageDto extends createZodDto(trainingMonthlyUsageSchema) {}
export type TrainingMonthlyUsage = z.infer<typeof trainingMonthlyUsageSchema>;
