import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/admin/coach/stats (E7.11, #251; docs/specs/ai-coach.md §2.8, §2.13)
// =============================================================================
//
// Engagement aggregates for the admin Coach page. COUNTS AND RATES ONLY: no
// user id, no message text, no persona line ever appears in the answer.
//
// DATES ARE UTC CALENDAR DAYS, BOTH ENDS INCLUSIVE (the AI usage report's
// convention). Default: the last 30 days ending today; `days` is a shorthand
// for "the last N days ending `to`". At most 365 days; a reversed or longer
// range is refused with 400 `COACH_STATS_RANGE_INVALID`, never clamped.
// =============================================================================

export const DEFAULT_COACH_STATS_RANGE_DAYS = 30;
export const MAX_COACH_STATS_RANGE_DAYS = 365;
export const COACH_STATS_RANGE_INVALID = 'COACH_STATS_RANGE_INVALID';

const isoDay = z.iso.date();

export const coachStatsQuerySchema = z.object({
  /** First UTC day included (`YYYY-MM-DD`). Default: `days - 1` days before `to`. */
  from: isoDay.optional(),
  /** Last UTC day included (`YYYY-MM-DD`). Default: today (UTC). */
  to: isoDay.optional(),
  /** The window length when `from` is omitted. Default 30. */
  days: z.coerce.number().int().min(1).max(MAX_COACH_STATS_RANGE_DAYS).optional(),
});
export class CoachStatsQueryDto extends createZodDto(coachStatsQuerySchema) {}
export type CoachStatsQuery = z.output<typeof coachStatsQuerySchema>;

const rate = z.number().min(0).max(1).nullable();

/** One funnel bucket. Rates are `null` when their denominator is 0. */
export const coachFunnelSchema = z.object({
  /** Delivered coach messages (every kind but chat replies). */
  sent: z.number().int(),
  /** ...of which opened. */
  opened: z.number().int(),
  /** ...with a conversion target (spec §2.8): the workout moments, `photo_prompt`, and any converted message. */
  convertible: z.number().int(),
  /** ...of which converted within their window. */
  converted: z.number().int(),
  /** Thumbs up / down. */
  up: z.number().int(),
  down: z.number().int(),
  /** `opened / sent`. */
  openRate: rate,
  /** `converted / convertible`. */
  convertRate: rate,
});

export const coachFunnelRowSchema = coachFunnelSchema.extend({
  /** The angle, persona id or moment; `none` for messages without one. */
  key: z.string(),
});

export const coachStatsSchema = z.object({
  range: z.object({ from: z.string(), to: z.string(), days: z.number().int() }),
  totals: coachFunnelSchema,
  byAngle: z.array(coachFunnelRowSchema),
  byPersona: z.array(coachFunnelRowSchema),
  byMoment: z.array(coachFunnelRowSchema),
  /**
   * Epic success criterion 8. A KPI that cannot be computed from aggregates
   * alone is `null` (`weeklyAdherencePct`: adherence is computed per user by
   * the signals service, never summed across users here).
   */
  kpis: z.object({
    /** `totals.openRate`. */
    nudgeOpenRate: rate,
    /** `totals.convertRate` (24 h for workouts and check-ins, 48 h for photo prompts). */
    conversionRate: rate,
    /** Distinct users who completed a workout or chatted with the coach in the last 7 days of the range. */
    weeklyActiveUsers: z.number().int(),
    /** Chat sessions (a user's chat day) in those 7 days, per weekly active user. */
    chatSessionsPerWau: z.number().nullable(),
    /** Coach-enabled users with a photo cadence who posted a progress photo within it, as of `to`. 0..100. */
    photoCadenceAdherencePct: z.number().nullable(),
    /** Not computed from aggregates; always `null` here. */
    weeklyAdherencePct: z.number().nullable(),
    /** Users who turned the coach OFF after configuring it, as of now. */
    optedOut: z.number().int(),
    /** Users with the coach on, as of now. */
    enabled: z.number().int(),
    /** `optedOut / (optedOut + enabled)`. */
    optOutRate: rate,
  }),
});
export class CoachStatsView extends createZodDto(coachStatsSchema) {}
export type CoachStats = z.infer<typeof coachStatsSchema>;
export type CoachFunnel = z.infer<typeof coachFunnelSchema>;
export type CoachFunnelRow = z.infer<typeof coachFunnelRowSchema>;
