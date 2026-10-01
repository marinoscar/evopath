import { z } from 'zod';

import {
  guardCoachText,
  COACH_GUARD_REASONS,
  type CoachGuardContext,
  type CoachGuardResult,
  type CoachGuardViolation,
  type CoachTextField,
} from '../guard/coach-content-guard';
import { WEEKLY_STREAK_CHANGES } from './weekly-streak';
import type { CoachWeeklyReviewProse } from './weekly-review-schema';
import type { WeeklyReviewStats } from './weekly-review-stats';

// =============================================================================
// `CoachMessage.data` of a `weekly_review` message, and the prose guard (E7.10)
// =============================================================================
//
// THE CONTRACT the `/coach` card (E7.8), the chat tool `get_last_weekly_review`
// (E7.7) and the email read. Version 1:
//
//   {
//     version: 1,
//     isoWeek: '2026-W40',              // the dedup key, also in stats
//     stats: WeeklyReviewStats,         // deterministic, from signals
//     prose: { headline, intro, wins[], focus, nextWeekPlanPrompt },
//                                       // in-app text (may be the unlocked
//                                       // profane register for Sarge L3)
//     emailProse: { ...same shape },    // ALWAYS the clean register; the
//                                       // email renders this one
//     register: 'clean' | 'profane' | 'supportive',
//     fallback: { app: boolean, email: boolean },  // static prose used
//   }
//
// `title` = `prose.headline`, `body` = `prose.intro`, `pushTitle`/`pushBody` a
// lock-screen-safe teaser (never stats when `lockScreenSafe`).
// =============================================================================

export const WEEKLY_REVIEW_DATA_VERSION = 1;

export interface WeeklyReviewMessageData {
  version: typeof WEEKLY_REVIEW_DATA_VERSION;
  isoWeek: string;
  stats: WeeklyReviewStats;
  prose: CoachWeeklyReviewProse;
  emailProse: CoachWeeklyReviewProse;
  register: 'clean' | 'profane' | 'supportive';
  fallback: { app: boolean; email: boolean };
}

const proseSchema = z.object({
  headline: z.string(),
  intro: z.string(),
  wins: z.array(z.string()),
  focus: z.string(),
  nextWeekPlanPrompt: z.string(),
});

/** Read-back validation (the deliver job and anything rendering a stored review). Lenient on extra keys. */
export const weeklyReviewMessageDataSchema = z
  .object({
    version: z.literal(WEEKLY_REVIEW_DATA_VERSION),
    isoWeek: z.string(),
    stats: z
      .object({
        isoWeek: z.string(),
        weekStart: z.string(),
        weekEnd: z.string(),
        planned: z.number(),
        completed: z.number(),
        missed: z.number(),
        adherencePct: z.number().nullable(),
        weeklyStreak: z.number(),
        streakPassesLeft: z.number(),
        streakChange: z.enum(WEEKLY_STREAK_CHANGES),
        prs: z.array(
          z.object({ exercise: z.string(), value: z.number(), unit: z.enum(['kg', 'reps']), reps: z.number().nullable() }),
        ),
        checkIns: z.number(),
        photosAdded: z.number(),
        nextWeekSessions: z.number(),
        nextWeek: z.array(z.object({ date: z.string(), weekday: z.string(), name: z.string() }).passthrough()),
        noPlan: z.boolean(),
        firstWeek: z.boolean(),
      })
      .passthrough(),
    prose: proseSchema.passthrough(),
    emailProse: proseSchema.passthrough(),
  })
  .passthrough();

/**
 * The content guard over the review's prose. Each field is checked as the
 * guard field whose limits and rules fit it: `headline` as `title`, every
 * other string as `body` (so the `invented_number` rule applies to all of
 * them). `headline` and `intro` must not be empty.
 */
export function guardWeeklyReviewProse(prose: CoachWeeklyReviewProse, ctx: CoachGuardContext): CoachGuardResult {
  const violations: CoachGuardViolation[] = [];
  const check = (field: CoachTextField, text: string, required: boolean) => {
    if (text.trim().length === 0) {
      if (required) violations.push({ reason: 'length', field });
      return;
    }
    violations.push(...guardCoachText(field, text, ctx));
  };

  check('title', prose.headline, true);
  check('body', prose.intro, true);
  for (const win of prose.wins) check('body', win, false);
  check('body', prose.focus, false);
  check('body', prose.nextWeekPlanPrompt, false);

  const reasons = COACH_GUARD_REASONS.filter((r) => violations.some((v) => v.reason === r));
  return { ok: violations.length === 0, violations, reasons };
}
