import { addDays } from '../../check-ins/local-date';
import type { PlanSignals } from '../../programs/signals/plan-signals.contract';
import type { CoachPlanningSignals } from './plan-coach-moments';
import { isoWeekStart } from './coach-time';

// =============================================================================
// From the signals service to the planner's view (E7.4), pure
// =============================================================================
//
// Every number the coach states comes from `TrainingSignalsService` (spec
// §2.1); this file only reshapes it. The caller reads the signals with the
// range extended 7 days past today, so the current ISO week's upcoming
// sessions (the weekly target) and the next session are in `sessions`.
// =============================================================================

/** A pain flag on this many sessions in a row is a pain streak (supportive only). */
export const PAIN_STREAK_MIN_SESSIONS = 2;
/** This many low-readiness days in a row is a low-readiness streak (supportive only). */
export const LOW_READINESS_STREAK_MIN_DAYS = 2;
/** A completed workout after a missed planned session within this many days is a comeback. */
export const COMEBACK_LOOKBACK_DAYS = 7;
/** A message delivered this long ago and still unopened counts as ignored. */
export const IGNORED_AFTER_MS = 24 * 60 * 60 * 1000;

const DONE: ReadonlySet<string> = new Set(['done', 'partial']);

export interface CoachSignalsExtras {
  /** Local today. */
  today: string;
  lastCompletedWorkoutDate: string | null;
  lastActivityAt: Date | null;
  lastProgressPhotoDate: string | null;
  safetyStop: boolean;
}

/** The planner's view of `signals` for the hourly sweep (`event: null`). */
export function toCoachPlanningSignals(signals: PlanSignals, extras: CoachSignalsExtras): CoachPlanningSignals {
  const { today } = extras;
  const yesterday = addDays(today, -1);
  const todays = signals.sessions.filter((s) => s.plannedFor === today);
  const sessionToday: CoachPlanningSignals['sessionToday'] =
    todays.length === 0 ? 'none' : todays.every((s) => DONE.has(s.status)) ? 'done' : 'planned';

  return {
    missedStreak: signals.adherence.missedStreak,
    sessionToday,
    loggedToday: extras.lastCompletedWorkoutDate === today,
    missedYesterday: signals.sessions.some((s) => s.plannedFor === yesterday && s.status === 'missed'),
    lastCompletedWorkoutDate: extras.lastCompletedWorkoutDate,
    lastActivityAt: extras.lastActivityAt,
    lastProgressPhotoDate: extras.lastProgressPhotoDate,
    safety: {
      safetyStop: extras.safetyStop,
      painStreak: signals.pain.some((p) => p.consecutiveFlaggedSessions >= PAIN_STREAK_MIN_SESSIONS),
      lowReadinessStreak: signals.readiness.lowStreak >= LOW_READINESS_STREAK_MIN_DAYS,
    },
    event: null,
  };
}

/**
 * The event moments a finished workout on `workoutDate` raises:
 *
 * - `comeback`: a planned session in the 7 days before it was missed.
 * - `pr`: a lift whose latest top set is on that day carries a PR in range.
 * - `weeklyTargetHit`: that workout brought the week's done sessions to the
 *   planned count (it was not reached before it).
 */
export function workoutEventOf(
  signals: PlanSignals,
  workoutDate: string,
): NonNullable<CoachPlanningSignals['event']> {
  const from = addDays(workoutDate, -COMEBACK_LOOKBACK_DAYS);
  const comeback = signals.sessions.some(
    (s) => s.status === 'missed' && s.plannedFor >= from && s.plannedFor < workoutDate,
  );
  const pr = signals.performance.some((lift) => lift.prInRange && lift.lastTopSets[0]?.date === workoutDate);

  const target = weeklyTargetOf(signals, workoutDate);
  const doneToday = signals.sessions.filter((s) => s.plannedFor === workoutDate && DONE.has(s.status)).length;
  const weeklyTargetHit = target.planned > 0 && target.done >= target.planned && target.done - doneToday < target.planned;

  return { comeback, pr, weeklyTargetHit };
}

/** The current ISO week's planned sessions and how many are done (the header ring). */
export function weeklyTargetOf(signals: PlanSignals, today: string): { planned: number; done: number } {
  const monday = isoWeekStart(today);
  const sunday = addDays(monday, 6);
  const week = signals.sessions.filter((s) => s.plannedFor >= monday && s.plannedFor <= sunday);
  return { planned: week.length, done: week.filter((s) => DONE.has(s.status)).length };
}

export interface NextSession {
  date: string;
  name: string;
  programWorkoutId: string;
}

/** The first planned session from today on that is not done yet; null when none in range. */
export function nextSessionOf(signals: PlanSignals, today: string): NextSession | null {
  const next = signals.sessions
    .filter((s) => s.plannedFor >= today && (s.status === 'upcoming' || s.status === 'in_progress'))
    .sort((a, b) => (a.plannedFor < b.plannedFor ? -1 : a.plannedFor > b.plannedFor ? 1 : 0))[0];
  return next ? { date: next.plannedFor, name: next.name, programWorkoutId: next.programWorkoutId } : null;
}

export interface DeliveredCoachMessage {
  deliveredAt: Date | null;
  openedAt: Date | null;
}

/**
 * Nudges delivered and not opened within 24 hours, in a row, newest first,
 * counted only after the user's last engagement (an open, a chat message or a
 * logged workout resets the run). `messages` are the user's coach-authored
 * messages, newest first.
 */
export function consecutiveIgnoredOf(
  messages: readonly DeliveredCoachMessage[],
  lastEngagementAt: Date | null,
  now: Date,
): number {
  let count = 0;
  for (const message of messages) {
    if (!message.deliveredAt) continue;
    if (lastEngagementAt && message.deliveredAt.getTime() <= lastEngagementAt.getTime()) break;
    if (message.openedAt) break;
    // Too fresh to call ignored: neither counts nor breaks the run.
    if (now.getTime() - message.deliveredAt.getTime() < IGNORED_AFTER_MS) continue;
    count += 1;
  }
  return count;
}

/** The latest of several optional instants; null when all are null. */
export function latestOf(...instants: ReadonlyArray<Date | null | undefined>): Date | null {
  let latest: Date | null = null;
  for (const instant of instants) {
    if (instant && (!latest || instant.getTime() > latest.getTime())) latest = instant;
  }
  return latest;
}

// -----------------------------------------------------------------------------
// Weekly streak and passes (spec §2.11), for the weekly review (E7.10)
// -----------------------------------------------------------------------------

/** Weeks of streak that earn one pass. */
export const STREAK_WEEKS_PER_PASS = 4;
/** Passes held at most. */
export const STREAK_MAX_PASSES = 1;

export interface WeeklyStreakState {
  weeklyStreak: number;
  streakPassesLeft: number;
}

export interface FinishedWeek {
  /** Sessions completed in the finished ISO week. */
  completed: number;
  /** Its session target (planned sessions); 0 means no target, which never breaks the streak. */
  target: number;
  /** A safety stop, pain pattern or pause covered the week: it never resets the streak. */
  protectedWeek: boolean;
}

/**
 * The streak after one finished ISO week: +1 when `completed >= target`
 * (earning a pass every 4 weeks, at most 1); otherwise a pass is used and the
 * streak kept, or it resets to 0. A protected or target-less week changes
 * nothing. The current week is never passed here until it ends.
 */
export function advanceWeeklyStreak(state: WeeklyStreakState, week: FinishedWeek): WeeklyStreakState {
  if (week.protectedWeek || week.target <= 0) return { ...state };
  if (week.completed >= week.target) {
    const weeklyStreak = state.weeklyStreak + 1;
    const earned = weeklyStreak % STREAK_WEEKS_PER_PASS === 0 ? 1 : 0;
    return { weeklyStreak, streakPassesLeft: Math.min(STREAK_MAX_PASSES, state.streakPassesLeft + earned) };
  }
  if (state.streakPassesLeft > 0) return { weeklyStreak: state.weeklyStreak, streakPassesLeft: state.streakPassesLeft - 1 };
  return { weeklyStreak: 0, streakPassesLeft: 0 };
}
