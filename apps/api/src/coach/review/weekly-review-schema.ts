import { z } from 'zod';

// =============================================================================
// The `ai.coach.weekly_review` structured answer (E7.10; spec §2.10)
// =============================================================================
//
// The model writes ONLY the prose around the deterministic stats block:
// `{ headline, intro, wins[], focus, nextWeekPlanPrompt }`. Every number the
// user sees is in `stats`, rendered by the card and the email template; a
// figure in the prose must be one of them (the content guard's
// `invented_number` rule).
//
// No `maxItems` on `wins` (not every provider's strict mode accepts it); the
// job keeps the first `WEEKLY_REVIEW_MAX_WINS`.
// =============================================================================

export const COACH_WEEKLY_REVIEW_SCHEMA_NAME = 'coach_weekly_review';

/** Wins kept from an answer. */
export const WEEKLY_REVIEW_MAX_WINS = 3;

/** Per-field limits; each fits the content guard field it is checked as (`title` 60, `body` 320). */
export const WEEKLY_REVIEW_LIMITS = {
  headline: 60,
  intro: 320,
  win: 140,
  focus: 200,
  nextWeekPlanPrompt: 200,
} as const;

export const coachWeeklyReviewSchema = z.object({
  /** One line; the card title and the email subject. */
  headline: z.string().max(WEEKLY_REVIEW_LIMITS.headline),
  /** The persona's opening paragraph. */
  intro: z.string().max(WEEKLY_REVIEW_LIMITS.intro),
  /** Up to three short wins of the week. */
  wins: z.array(z.string().max(WEEKLY_REVIEW_LIMITS.win)),
  /** The one thing to focus on next week. */
  focus: z.string().max(WEEKLY_REVIEW_LIMITS.focus),
  /** A first-person message the user can send the coach to plan next week (prefills the composer). */
  nextWeekPlanPrompt: z.string().max(WEEKLY_REVIEW_LIMITS.nextWeekPlanPrompt),
});

export type CoachWeeklyReviewProse = z.infer<typeof coachWeeklyReviewSchema>;
