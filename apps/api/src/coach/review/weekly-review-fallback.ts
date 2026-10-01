import { FALLBACK_TITLES, SUPPORTIVE_FALLBACK_LINE } from '../nudges/static-fallback';
import type { RenderedPersonaStyle } from '../personas/resolve-register';
import type { CoachWeeklyReviewProse } from './weekly-review-schema';
import { WEEKLY_REVIEW_LIMITS } from './weekly-review-schema';
import type { WeeklyReviewStats } from './weekly-review-stats';

// =============================================================================
// The deterministic weekly review (E7.10; spec §2.10 "On failure"), pure
// =============================================================================
//
// Used when the model is not runnable, fails after its retries, or writes
// prose the content guard rejects. The weekly cadence never silently skips:
// the user still gets the stats block, the persona's registry `weekly_review`
// line (rendered intensity, `{n}` = sessions completed) and code-written wins
// and focus. Every figure comes from `stats`. Persisted with
// `provider = 'static'`.
//
// Under the supportive register the persona line is replaced by the calm
// `SUPPORTIVE_FALLBACK_LINE`; a first week gets a welcome instead.
// =============================================================================

export const FIRST_WEEK_INTRO =
  "Welcome to your first weekly review. There's nothing to judge yet, only a fresh week ahead. Let's plan one easy session to start.";

export const DEFAULT_PLAN_PROMPT = 'Help me plan my training for next week.';

export function staticWeeklyReview(
  style: RenderedPersonaStyle,
  stats: WeeklyReviewStats,
  supportive: boolean,
): CoachWeeklyReviewProse {
  const line = style.persona.sampleLines.weekly_review[style.intensity].replace(/\{n\}/g, String(stats.completed));
  const intro = stats.firstWeek ? FIRST_WEEK_INTRO : supportive ? SUPPORTIVE_FALLBACK_LINE : line;

  const wins: string[] = [];
  if (stats.completed > 0) {
    wins.push(
      stats.planned > 0
        ? `You completed ${stats.completed} of ${stats.planned} planned sessions.`
        : `You completed ${stats.completed} sessions.`,
    );
  }
  if (stats.prs.length > 0) wins.push(`New personal best on ${stats.prs[0].exercise}.`);
  // No streak framing under the supportive register (spec §2.14).
  if (!supportive && stats.streakChange === 'advanced' && stats.weeklyStreak > 1) wins.push(`Your weekly streak is now ${stats.weeklyStreak} weeks.`);
  else if (stats.checkIns > 0) wins.push(`You checked in on ${stats.checkIns} days.`);

  let focus: string;
  if (supportive) focus = 'Take it easy and listen to your body. A lighter week is still progress.';
  else if (stats.noPlan || stats.firstWeek) focus = 'Set up next week: pick the days you can train and start with one session.';
  else if (stats.nextWeekSessions > 0) focus = 'Show up for the first session of next week and build from there.';
  else focus = 'Plan next week so every session has a day.';

  return {
    headline: FALLBACK_TITLES.weekly_review,
    intro: truncate(intro, WEEKLY_REVIEW_LIMITS.intro),
    wins: wins.slice(0, 3).map((w) => truncate(w, WEEKLY_REVIEW_LIMITS.win)),
    focus,
    nextWeekPlanPrompt: DEFAULT_PLAN_PROMPT,
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
