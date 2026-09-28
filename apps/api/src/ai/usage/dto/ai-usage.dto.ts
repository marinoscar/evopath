import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// AI usage aggregates — query and report shapes (issue #443, epic #420)
// =============================================================================
//
//   GET /api/admin/ai/usage   ai_config:read            every user, filterable
//   GET /api/ai/usage/me      ai:use + AiEnabledGuard   the caller only
//
// Both answer the SAME report shape (`AiUsageReport`), so one UI component
// renders either. Aggregated in SQL over `ai_usage_events` (the `created_at`
// and `(user_id, created_at)` indexes); see `ai-usage.service.ts`.
//
// DATES ARE UTC CALENDAR DAYS, BOTH ENDS INCLUSIVE. `from=2026-09-01&to=
// 2026-09-30` is thirty whole UTC days. Default: the last 30 days ending today;
// the span is at most `MAX_AI_USAGE_RANGE_DAYS` (the job-insights bound).
// =============================================================================

/** Largest window a report may cover, in days (inclusive). Same bound as job insights. */
export const MAX_AI_USAGE_RANGE_DAYS = 90;

/** Window used when neither end is given, in days (inclusive, ending today). */
export const DEFAULT_AI_USAGE_RANGE_DAYS = 30;

/** Every grouping the admin report accepts. */
export const AI_USAGE_ADMIN_GROUP_BY = ['day', 'user', 'model', 'provider', 'keySource'] as const;

/** The groupings a user's own report accepts — no per-user split of one user. */
export const AI_USAGE_ME_GROUP_BY = ['day', 'model'] as const;

export type AiUsageGroupBy = (typeof AI_USAGE_ADMIN_GROUP_BY)[number];

const isoDay = z.iso.date();

export const aiUsageMeQuerySchema = z.object({
  /** First UTC day included (`YYYY-MM-DD`). Default: 29 days before `to`. */
  from: isoDay.optional(),
  /** Last UTC day included (`YYYY-MM-DD`). Default: today (UTC). */
  to: isoDay.optional(),
  groupBy: z.enum(AI_USAGE_ME_GROUP_BY).default('day'),
});

export const aiUsageAdminQuerySchema = z.object({
  from: isoDay.optional(),
  to: isoDay.optional(),
  groupBy: z.enum(AI_USAGE_ADMIN_GROUP_BY).default('day'),
  /** Only this user's events. */
  userId: z.uuid().optional(),
  /** Only this provider's events (`openai`). */
  provider: z.string().min(1).max(64).optional(),
  /** Only this provider model id's events (`gpt-4o-mini`). */
  model: z.string().min(1).max(200).optional(),
});

export class AiUsageMeQueryDto extends createZodDto(aiUsageMeQuerySchema) {}
export class AiUsageAdminQueryDto extends createZodDto(aiUsageAdminQuerySchema) {}

export type AiUsageMeQuery = z.output<typeof aiUsageMeQuerySchema>;
export type AiUsageAdminQuery = z.output<typeof aiUsageAdminQuerySchema>;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Summed non-token units, by unit name (`{ images: 2, audioSeconds: 31.4 }`).
 * Empty when no event in the bucket reported any.
 */
const unitsSchema = z.record(z.string(), z.number());

/**
 * One bucket of usage. `totals` is one of these; every `series` entry is one
 * plus its `key`/`label`.
 *
 * `requests` counts every recorded provider round trip (succeeded, failed and
 * cancelled); `failed` is the subset whose status is `failed`. Token sums
 * treat an unreported count as zero. The `orgKey*` fields are the subtotal
 * paid for by the ORGANIZATION key (`keySource: 'org'`), so a UI can highlight
 * who the org key is paying for.
 */
export const aiUsageBucketSchema = z.object({
  requests: z.number().int(),
  failed: z.number().int(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cachedInputTokens: z.number(),
  units: unitsSchema,
  /** Requests paid for by the organization key (`keySource: 'org'`). */
  orgKeyRequests: z.number().int(),
  /** Input tokens paid for by the organization key. */
  orgKeyInputTokens: z.number(),
  /** Output tokens paid for by the organization key. */
  orgKeyOutputTokens: z.number(),
});

export const aiUsageSeriesItemSchema = aiUsageBucketSchema.extend({
  /**
   * The group's stable key: `YYYY-MM-DD` (day), a user id or `system` for
   * events with no user (user), `<provider>:<modelId>` (model), a provider id
   * (provider), or `user` / `org` / `none` / `admin_discovery` (keySource).
   */
  key: z.string(),
  /**
   * Human label: the day, the user's EMAIL, the model id, the provider's
   * display name, or a key-source description.
   */
  label: z.string(),
});

export const aiUsageReportSchema = z.object({
  /** The window actually reported, UTC days, both inclusive. */
  range: z.object({ from: isoDay, to: isoDay }),
  groupBy: z.enum(AI_USAGE_ADMIN_GROUP_BY),
  totals: aiUsageBucketSchema,
  /**
   * One entry per group. `day` is chronological and ZERO-FILLED (every day in
   * the range appears); every other grouping lists only groups with usage,
   * most requests first.
   */
  series: z.array(aiUsageSeriesItemSchema),
});

export class AiUsageReportDto extends createZodDto(aiUsageReportSchema) {}
export type AiUsageBucket = z.infer<typeof aiUsageBucketSchema>;
export type AiUsageSeriesItem = z.infer<typeof aiUsageSeriesItemSchema>;
export type AiUsageReport = z.infer<typeof aiUsageReportSchema>;
