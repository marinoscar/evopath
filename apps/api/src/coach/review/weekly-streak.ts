import {
  advanceWeeklyStreak,
  type FinishedWeek,
  type WeeklyStreakState,
} from '../planning/coach-signals';

// =============================================================================
// Weekly streak and passes for the weekly review (E7.10; spec §2.11), pure
// =============================================================================
//
// The rule itself is `advanceWeeklyStreak` (`planning/coach-signals.ts`, the
// spec's owner of the arithmetic). This file names what happened, so the
// review job can count it and the card can say it:
//
//   advanced   the week's target was reached: +1 (a pass is earned every 4
//              weeks, at most 1 held)
//   pass_used  missed with a pass left: the streak holds, the pass is spent
//   reset      missed without a pass: back to 0
//   held       a protected week (safety stop, pain pattern, pause) or a week
//              with no target (rest week, no plan): nothing changes
// =============================================================================

export type { FinishedWeek, WeeklyStreakState };

export const WEEKLY_STREAK_CHANGES = ['advanced', 'pass_used', 'reset', 'held'] as const;
export type WeeklyStreakChange = (typeof WEEKLY_STREAK_CHANGES)[number];

export interface WeeklyStreakUpdate extends WeeklyStreakState {
  change: WeeklyStreakChange;
  /** A pass was earned by this week (the 4th, 8th, ... week of streak, while none was held). */
  passEarned: boolean;
}

/** The streak after one finished ISO week, and what changed. */
export function updateWeeklyStreak(before: WeeklyStreakState, week: FinishedWeek): WeeklyStreakUpdate {
  const after = advanceWeeklyStreak(before, week);
  let change: WeeklyStreakChange;
  if (week.protectedWeek || week.target <= 0) change = 'held';
  else if (week.completed >= week.target) change = 'advanced';
  else if (before.streakPassesLeft > 0) change = 'pass_used';
  else change = 'reset';
  return { ...after, change, passEarned: after.streakPassesLeft > before.streakPassesLeft };
}
