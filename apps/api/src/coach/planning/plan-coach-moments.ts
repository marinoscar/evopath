import type { SystemCoachValue } from '../../common/schemas/settings.schema';
import type { ResolvedCoachUserSettings } from '../../common/schemas/user-settings-namespaces.schema';
import { daysFrom } from '../../programs/today/resolve-today';
import { type CoachNow, isWithinQuietHours, isoWeekKey, MINUTES_PER_DAY, parseTimeOfDay, weeklyReviewAnchorDate } from './coach-time';

// =============================================================================
// planCoachMoments: when the coach may speak (E7.4; docs/specs/ai-coach.md §2.5)
// =============================================================================
//
// THE DETERMINISTIC LAYER. This function decides whether any message is
// allowed; the model (`ai.coach.nudge`, E7.5) only decides whether it should
// and what to say, and can only narrow what this allows.
//
// PURE. No Nest, no Prisma, no clock: `now` is its clock, read once by the
// caller (`plan-coach-moments.spec.ts` pins the import list). Every gate is
// table-tested.
//
// Output: every moment whose trigger fired, each with `suppressedBy` (null for
// an eligible one, else the first gate that removed it, so a suppressed
// moment can be counted), eligible ones first, ranked by priority. At most ONE
// nudge-lane moment is sent per pass (`topNudge`); the weekly review is a
// separate lane (`weeklyReviewOf`), exempt from the daily cap and spacing.
//
// TWO BACK-OFF MOMENTS END IN SILENCE. `back_off` (after
// `autoSilenceAfterIgnored` ignored nudges in a row) and `win_back` (no
// activity for `inactiveStopDays`) are each the ONLY nudge-lane candidate while
// their condition holds and `silencedAt` is unset; the caller sets
// `silencedAt` when it enqueues one (`silencesCoach`), so exactly one is sent
// and every later pass answers `silenced` until the user re-engages.
// =============================================================================

export const COACH_MOMENTS = [
  'back_off',
  'missed_twice',
  'streak_at_risk',
  'comeback',
  'pr',
  'weekly_target_hit',
  'missed_session',
  'fresh_start',
  'photo_prompt',
  'win_back',
  'weekly_review',
  // Activity goals (F9, #269).
  'goal_at_risk',
  'goal_hit',
] as const;
export type CoachMoment = (typeof COACH_MOMENTS)[number];

/** Priority: 1 wins (spec §2.5). `back_off` outranks everything; `weekly_review` is its own lane. */
export const COACH_MOMENT_PRIORITY: Readonly<Record<CoachMoment, number>> = {
  back_off: 0,
  missed_twice: 1,
  streak_at_risk: 2,
  comeback: 3,
  pr: 4,
  weekly_target_hit: 4,
  missed_session: 5,
  fresh_start: 6,
  photo_prompt: 7,
  win_back: 8,
  weekly_review: 9,
  // Activity goals (F9, #269). `goal_at_risk` ranks with `streak_at_risk`
  // (below `missed_twice`): both are "today still decides it" loss framing,
  // and a planned session at risk wins a tie (it is planned first). `goal_hit`
  // ranks with `weekly_target_hit`: both celebrate consistency the user chose.
  goal_at_risk: 2,
  goal_hit: 4,
};

/** Moments the safety gate removes: streak, challenge or guilt framing (spec §2.14). */
export const PUSHY_MOMENTS: ReadonlySet<CoachMoment> = new Set<CoachMoment>([
  'missed_twice',
  'streak_at_risk',
  'missed_session',
  'win_back',
  'goal_at_risk',
]);

/** Moments raised only by a finished workout (event-driven), never by the hourly sweep. */
export const EVENT_MOMENTS: ReadonlySet<CoachMoment> = new Set<CoachMoment>(['comeback', 'pr', 'weekly_target_hit', 'goal_hit']);

/** Moments about one activity goal: deduplicated per goal and period by their `momentKey`, not per day. */
export const GOAL_MOMENTS: ReadonlySet<CoachMoment> = new Set<CoachMoment>(['goal_at_risk', 'goal_hit']);

/** Moments after which the caller sets `silencedAt`. */
export const SILENCING_MOMENTS: ReadonlySet<CoachMoment> = new Set<CoachMoment>(['back_off', 'win_back']);

/** The notification events of spec §3.5 (declared in the registry by E7.5). */
export const COACH_EVENT_KEYS = ['coach.nudge', 'coach.celebration', 'coach.photo_prompt', 'coach.weekly_review'] as const;
export type CoachEventKey = (typeof COACH_EVENT_KEYS)[number];

/** Which notification event a moment is delivered as; the user's preference for it is the `pref_off` gate. */
export const COACH_MOMENT_EVENT: Readonly<Record<CoachMoment, CoachEventKey>> = {
  back_off: 'coach.nudge',
  missed_twice: 'coach.nudge',
  streak_at_risk: 'coach.nudge',
  comeback: 'coach.nudge',
  pr: 'coach.celebration',
  weekly_target_hit: 'coach.celebration',
  missed_session: 'coach.nudge',
  fresh_start: 'coach.nudge',
  photo_prompt: 'coach.photo_prompt',
  win_back: 'coach.nudge',
  weekly_review: 'coach.weekly_review',
  goal_at_risk: 'coach.nudge',
  goal_hit: 'coach.celebration',
};

export const COACH_SUPPRESSION_REASONS = [
  'coach_off',
  'quiet_hours',
  'daily_cap',
  'spacing',
  'paused',
  'silenced',
  'safety_supportive_only',
  'pref_off',
  'already_sent',
] as const;
export type CoachSuppressionReason = (typeof COACH_SUPPRESSION_REASONS)[number];

export const COACH_PLANNING = {
  /** Minimum time between two nudges. */
  minSpacingMs: 3 * 60 * 60 * 1000,
  /** `streak_at_risk` lands this long before the usual workout time (the 23.5-hour rule). */
  streakAtRiskLeadMinutes: 30,
  /** `streak_at_risk` anchor without a usual time or `preferredTime`: 17:00. */
  streakAtRiskDefaultMinute: 17 * 60,
  /** Morning anchor (`missed_session`, `fresh_start`, `photo_prompt`) without `preferredTime`: 09:00. */
  morningDefaultMinute: 9 * 60,
  /** `photo_prompt` is a morning moment: due from the anchor until noon (or 3 hours, for a late anchor). */
  photoWindowEndMinute: 12 * 60,
  photoWindowMinMinutes: 3 * 60,
  /** `fresh_start` follows a lapse: no completed session in this many days. */
  freshStartLapseDays: 7,
  /**
   * `goal_at_risk`, volume metrics: behind when `done < paceShare * target * elapsed`
   * (week: `elapsedFraction`, the share of whole days before today; day: the share
   * of today's clock already gone).
   */
  goalPaceShare: 0.7,
  /** `goal_at_risk`, sessions: `remaining == daysLeft` counts only from this ISO weekday (Thursday). */
  goalTightFromWeekday: 4,
  /** Weekly review anchor: local Sunday 18:00 (the plan evaluator's anchor), caught up until Monday 18:00. */
  weeklyReviewMinute: 18 * 60,
  /** Days between progress photos, per `coach.photoCadence`. */
  photoCadenceDays: { weekly: 7, biweekly: 14, monthly: 28 } as const,
} as const;

// -----------------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------------

/**
 * One active activity goal's current period, as the planner reads it
 * (`GoalProgressService.progressForUser`, mapped by `coach-goals.ts`). Ids,
 * enums and counts only: the title never reaches the planner.
 */
export interface CoachGoalSignal {
  goalId: string;
  metric: 'sessions' | 'minutes' | 'steps' | 'distance_m';
  period: 'week' | 'day';
  /** `YYYY-MM-DD`, the period's first local day (part of the dedup key). */
  periodStart: string;
  done: number;
  target: number;
  remaining: number;
  /** Days left in the period, today included. */
  daysLeft: number;
  /** Share of the period's days fully before today, 0..1. */
  elapsedFraction: number;
  hit: boolean;
}

/** A goal an event (a check-in or a finished workout) made `hit` for the first time this period. */
export interface CoachGoalHit {
  goalId: string;
  periodStart: string;
}

/** `<moment>:<goalId>:<periodStart>`: one goal moment per goal per period (the nudge job's `momentKey`). */
export function goalMomentKey(moment: 'goal_at_risk' | 'goal_hit', goalId: string, periodStart: string): string {
  return `${moment}:${goalId}:${periodStart}`;
}

/** What the planner needs from the signals service and a few cheap reads (`coach-signals.ts`). */
export interface CoachPlanningSignals {
  /** `adherence.missedStreak`: planned sessions missed in a row. */
  missedStreak: number;
  /** A planned session falls on local today, and whether it is done. */
  sessionToday: 'none' | 'planned' | 'done';
  /** Any completed workout on local today (planned or not). */
  loggedToday: boolean;
  /** A planned session yesterday was missed. */
  missedYesterday: boolean;
  /** Local day of the most recent completed workout; null when none. */
  lastCompletedWorkoutDate: string | null;
  /** The latest user activity (workout, coach chat, opened message); null when unknown (never inactive). */
  lastActivityAt: Date | null;
  /** Local day of the most recent progress photo; null when none. */
  lastProgressPhotoDate: string | null;
  /** Spec §2.14: any of these allows only supportive moments. */
  safety: { safetyStop: boolean; painStreak: boolean; lowReadinessStreak: boolean };
  /**
   * Set when planning after a finished workout: only these event moments are
   * candidates then (the sweep plans the clock-driven ones). Null for the sweep.
   */
  event: { comeback: boolean; pr: boolean; weeklyTargetHit: boolean; goalHits?: readonly CoachGoalHit[] } | null;
  /** Active activity goals in their current period (sweep only; absent: none). */
  goals?: readonly CoachGoalSignal[];
}

/** `CoachState` as the planner reads it, plus the moments already sent today. */
export interface CoachPlanningState {
  lastNudgeAt: Date | null;
  nudgesToday: number;
  /** `YYYY-MM-DD`; `nudgesToday` counts only when this is local today. */
  nudgeDayLocal: string | null;
  consecutiveIgnored: number;
  pausedUntil: Date | null;
  silencedAt: Date | null;
  usualWorkoutMinuteLocal: number | null;
  lastWeeklyReviewWeek: string | null;
  /** Moments of coach messages created on local today (the `already_sent` gate). */
  momentsSentToday: readonly CoachMoment[];
  /** `momentKey`s of goal moments already sent (`goalMomentKey`); absent: none. Once per goal per period. */
  goalMomentKeysSent?: readonly string[];
}

export interface CoachPlanningSettings {
  aiEnabled: boolean;
  system: Pick<SystemCoachValue, 'enabled' | 'maxNudgesPerDayCeiling' | 'autoSilenceAfterIgnored' | 'inactiveStopDays'>;
  user: Pick<ResolvedCoachUserSettings, 'enabled' | 'quietHours' | 'maxNudgesPerDay' | 'photoCadence' | 'preferredTime'>;
  /** Whether each coach event can reach the user (preferences and admin policy). Absent: on. */
  eventEnabled: Partial<Record<CoachEventKey, boolean>>;
}

// -----------------------------------------------------------------------------
// Output
// -----------------------------------------------------------------------------

export type CoachLane = 'nudge' | 'weekly_review';

export interface PlannedMoment {
  moment: CoachMoment;
  lane: CoachLane;
  priority: number;
  /** Why the trigger fired (a short code, never user content). */
  reason: string;
  eventKey: CoachEventKey;
  /** Null when eligible; else the first gate that removed it. */
  suppressedBy: CoachSuppressionReason | null;
  /** The ISO week a weekly review covers (`2026-W40`); weekly review only. */
  isoWeek?: string;
  /** Goal moments only: the goal, and the per-goal-per-period `momentKey` the nudge job dedupes on. */
  goalId?: string;
  momentKey?: string;
}

/** The eligible nudge-lane moment to enqueue this pass (the highest priority), or null. */
export function topNudge(plan: readonly PlannedMoment[]): PlannedMoment | null {
  return plan.find((m) => m.lane === 'nudge' && m.suppressedBy === null) ?? null;
}

/** The eligible weekly review, or null. */
export function weeklyReviewOf(plan: readonly PlannedMoment[]): PlannedMoment | null {
  return plan.find((m) => m.lane === 'weekly_review' && m.suppressedBy === null) ?? null;
}

/** The moments some gate removed. */
export function suppressedOf(plan: readonly PlannedMoment[]): PlannedMoment[] {
  return plan.filter((m) => m.suppressedBy !== null);
}

/** Whether enqueuing `moment` ends in `silencedAt` (`back_off`, `win_back`). */
export function silencesCoach(moment: CoachMoment): boolean {
  return SILENCING_MOMENTS.has(moment);
}

/** The effective daily cap: `min(user, system ceiling)`. */
export function effectiveDailyCap(settings: CoachPlanningSettings): number {
  return Math.min(settings.user.maxNudgesPerDay, settings.system.maxNudgesPerDayCeiling);
}

/** `streak_at_risk`'s threshold: usual time minus 30 minutes, else `preferredTime`, else 17:00. */
export function streakAtRiskMinute(state: Pick<CoachPlanningState, 'usualWorkoutMinuteLocal'>, preferredTime: string | null): number {
  if (state.usualWorkoutMinuteLocal !== null) {
    return Math.max(0, state.usualWorkoutMinuteLocal - COACH_PLANNING.streakAtRiskLeadMinutes);
  }
  return parseTimeOfDay(preferredTime) ?? COACH_PLANNING.streakAtRiskDefaultMinute;
}

/** The morning anchor: `preferredTime`, else 09:00. */
export function morningMinute(preferredTime: string | null): number {
  return parseTimeOfDay(preferredTime) ?? COACH_PLANNING.morningDefaultMinute;
}

// -----------------------------------------------------------------------------
// The function
// -----------------------------------------------------------------------------

interface Candidate {
  moment: CoachMoment;
  reason: string;
  isoWeek?: string;
  goalId?: string;
  momentKey?: string;
}

export function planCoachMoments(
  signals: CoachPlanningSignals,
  state: CoachPlanningState,
  settings: CoachPlanningSettings,
  now: CoachNow,
): PlannedMoment[] {
  const candidates = [...nudgeCandidates(signals, state, settings, now)];
  const review = signals.event === null ? weeklyReviewCandidate(now) : null;
  if (review) candidates.push(review);

  const planned = candidates.map((candidate) => {
    const lane: CoachLane = candidate.moment === 'weekly_review' ? 'weekly_review' : 'nudge';
    const moment: PlannedMoment = {
      moment: candidate.moment,
      lane,
      priority: COACH_MOMENT_PRIORITY[candidate.moment],
      reason: candidate.reason,
      eventKey: COACH_MOMENT_EVENT[candidate.moment],
      suppressedBy: gate(candidate, lane, signals, state, settings, now),
    };
    if (candidate.isoWeek) moment.isoWeek = candidate.isoWeek;
    if (candidate.goalId) moment.goalId = candidate.goalId;
    if (candidate.momentKey) moment.momentKey = candidate.momentKey;
    return moment;
  });

  return planned.sort((a, b) => {
    const aEligible = a.suppressedBy === null ? 0 : 1;
    const bEligible = b.suppressedBy === null ? 0 : 1;
    if (aEligible !== bEligible) return aEligible - bEligible;
    return a.priority - b.priority;
  });
}

/** The nudge-lane moments whose trigger fired, before any gate. */
function nudgeCandidates(
  signals: CoachPlanningSignals,
  state: CoachPlanningState,
  settings: CoachPlanningSettings,
  now: CoachNow,
): Candidate[] {
  if (signals.event) {
    const out: Candidate[] = [];
    if (signals.event.comeback) out.push({ moment: 'comeback', reason: 'workout_after_miss' });
    if (signals.event.pr) out.push({ moment: 'pr', reason: 'personal_record' });
    if (signals.event.weeklyTargetHit) out.push({ moment: 'weekly_target_hit', reason: 'weekly_target_reached' });
    const hit = pickGoal(
      (signals.event.goalHits ?? []).map((g) => ({ goalId: g.goalId, periodStart: g.periodStart, reason: 'goal_reached' })),
      'goal_hit',
      state,
    );
    if (hit) out.push(hit);
    return out;
  }

  // Auto-silence: exactly one back-off message, then silence (the caller sets `silencedAt`).
  if (state.silencedAt === null && state.consecutiveIgnored >= settings.system.autoSilenceAfterIgnored) {
    return [{ moment: 'back_off', reason: 'ignored_in_a_row' }];
  }

  // Win-back: one final message after `inactiveStopDays` of no activity, then silence.
  if (state.silencedAt === null && isInactive(signals.lastActivityAt, settings.system.inactiveStopDays, now)) {
    return [{ moment: 'win_back', reason: 'inactive' }];
  }

  const out: Candidate[] = [];
  const preferred = settings.user.preferredTime;
  const morning = morningMinute(preferred);

  if (signals.missedStreak >= 2) out.push({ moment: 'missed_twice', reason: 'missed_streak' });

  if (signals.sessionToday === 'planned' && !signals.loggedToday && now.minuteOfDay >= streakAtRiskMinute(state, preferred)) {
    out.push({ moment: 'streak_at_risk', reason: state.usualWorkoutMinuteLocal !== null ? 'usual_time' : 'default_time' });
  }

  const atRisk = pickGoal(
    (signals.goals ?? []).flatMap((goal) => {
      const reason = goalAtRiskReason(goal, state, preferred, now);
      return reason ? [{ goalId: goal.goalId, periodStart: goal.periodStart, reason }] : [];
    }),
    'goal_at_risk',
    state,
  );
  if (atRisk) out.push(atRisk);

  if (signals.missedYesterday && now.minuteOfDay >= morning) {
    out.push({ moment: 'missed_session', reason: 'missed_yesterday' });
  }

  if ((now.weekday === 1 || now.dayOfMonth === 1) && isLapsed(signals.lastCompletedWorkoutDate, now) && now.minuteOfDay >= morning) {
    out.push({ moment: 'fresh_start', reason: now.weekday === 1 ? 'monday_after_lapse' : 'month_start_after_lapse' });
  }

  if (isPhotoDue(signals, settings, now, morning)) out.push({ moment: 'photo_prompt', reason: 'cadence_due' });

  return out;
}

// -----------------------------------------------------------------------------
// Activity goals (F9, #269)
// -----------------------------------------------------------------------------
//
// `goal_at_risk` (sweep):
//   WEEK goals, from the morning anchor (`preferredTime`, else 09:00), so the
//   user still has the day to act:
//     sessions  remaining > daysLeft, or remaining == daysLeft (> 0) from
//               Thursday on (Monday-to-Wednesday "exactly one a day" is
//               still comfortable; later it is the last chance)
//     volume    done < 0.7 * target * elapsedFraction, at least one day left
//   DAY goals, only from the `streak_at_risk` anchor (usual workout time - 30
//   min, else `preferredTime`, else 17:00), the same-day evening window: a
//   day goal's own `elapsedFraction` is 0 all day, so the pace share is the
//   share of today's clock already gone: done < 0.7 * target * minute/1440.
//   A hit goal is never at risk.
// `goal_hit` (event): a check-in or a finished workout made `hit` true for
//   the first time in the period (the caller decides; `coach-goals.ts`).
//
// ONE PER GOAL PER PERIOD: the candidate's `momentKey` is
// `<moment>:<goalId>:<periodStart>`, and a key in `goalMomentKeysSent` is
// skipped (the nudge job also dedupes on it). The usual per-day
// `already_sent` gate also holds, so at most one goal moment of each kind per
// local day; with several at-risk goals the first unsent one (goal order) is
// the candidate and the next waits for tomorrow's sweep.
// -----------------------------------------------------------------------------

/** Why `goal` is at risk now (a reason code), or null when it is not. */
export function goalAtRiskReason(
  goal: CoachGoalSignal,
  state: Pick<CoachPlanningState, 'usualWorkoutMinuteLocal'>,
  preferredTime: string | null,
  now: CoachNow,
): string | null {
  if (goal.hit || goal.remaining <= 0) return null;

  if (goal.period === 'day') {
    if (now.minuteOfDay < streakAtRiskMinute(state, preferredTime)) return null;
    if (goal.metric === 'sessions') return 'day_sessions_open';
    const dayShare = now.minuteOfDay / MINUTES_PER_DAY;
    return goal.done < COACH_PLANNING.goalPaceShare * goal.target * dayShare ? 'day_behind_pace' : null;
  }

  if (now.minuteOfDay < morningMinute(preferredTime)) return null;
  if (goal.metric === 'sessions') {
    if (goal.remaining > goal.daysLeft) return 'sessions_out_of_reach';
    if (goal.remaining === goal.daysLeft && now.weekday >= COACH_PLANNING.goalTightFromWeekday) return 'sessions_last_chance';
    return null;
  }
  if (goal.daysLeft < 1) return null;
  return goal.done < COACH_PLANNING.goalPaceShare * goal.target * goal.elapsedFraction ? 'behind_pace' : null;
}

/**
 * The goal moment's candidate: the first goal whose key was not sent yet;
 * when every one was, the first (so the gate records `already_sent`).
 */
function pickGoal(
  goals: ReadonlyArray<{ goalId: string; periodStart: string; reason: string }>,
  moment: 'goal_at_risk' | 'goal_hit',
  state: CoachPlanningState,
): Candidate | null {
  if (goals.length === 0) return null;
  const sent = new Set(state.goalMomentKeysSent ?? []);
  const keyed = goals.map((g) => ({ ...g, momentKey: goalMomentKey(moment, g.goalId, g.periodStart) }));
  const chosen = keyed.find((g) => !sent.has(g.momentKey)) ?? keyed[0];
  return { moment, reason: chosen.reason, goalId: chosen.goalId, momentKey: chosen.momentKey };
}

/** The weekly review lane: local Sunday from 18:00, caught up until Monday 18:00. */
function weeklyReviewCandidate(now: CoachNow): Candidate | null {
  const anchor = weeklyReviewAnchorDate(now.instant, now.timeZone);
  const daysSince = daysFrom(anchor, now.date);
  const due = daysSince === 0 ? now.minuteOfDay >= COACH_PLANNING.weeklyReviewMinute : daysSince === 1 && now.minuteOfDay < COACH_PLANNING.weeklyReviewMinute;
  if (!due) return null;
  return { moment: 'weekly_review', reason: 'sunday_evening', isoWeek: isoWeekKey(anchor) };
}

function isInactive(lastActivityAt: Date | null, inactiveStopDays: number, now: CoachNow): boolean {
  if (lastActivityAt === null) return false;
  return now.instant.getTime() - lastActivityAt.getTime() >= inactiveStopDays * MINUTES_PER_DAY * 60_000;
}

function isLapsed(lastCompletedWorkoutDate: string | null, now: CoachNow): boolean {
  if (lastCompletedWorkoutDate === null) return true;
  return daysFrom(lastCompletedWorkoutDate, now.date) >= COACH_PLANNING.freshStartLapseDays;
}

function isPhotoDue(signals: CoachPlanningSignals, settings: CoachPlanningSettings, now: CoachNow, morning: number): boolean {
  const cadence = settings.user.photoCadence;
  if (cadence === 'off') return false;
  if (signals.sessionToday === 'none') return false;
  const windowEnd = Math.max(COACH_PLANNING.photoWindowEndMinute, morning + COACH_PLANNING.photoWindowMinMinutes);
  if (now.minuteOfDay < morning || now.minuteOfDay >= windowEnd) return false;
  if (signals.lastProgressPhotoDate === null) return true;
  return daysFrom(signals.lastProgressPhotoDate, now.date) >= COACH_PLANNING.photoCadenceDays[cadence];
}

/** The first gate that removes `candidate`, or null. The order fixes which reason is recorded. */
function gate(
  candidate: Candidate,
  lane: CoachLane,
  signals: CoachPlanningSignals,
  state: CoachPlanningState,
  settings: CoachPlanningSettings,
  now: CoachNow,
): CoachSuppressionReason | null {
  const { moment } = candidate;

  if (!settings.aiEnabled || !settings.system.enabled || !settings.user.enabled) return 'coach_off';
  if (state.pausedUntil !== null && state.pausedUntil.getTime() > now.instant.getTime()) return 'paused';
  if (state.silencedAt !== null) return 'silenced';

  const quietStart = parseTimeOfDay(settings.user.quietHours.start);
  const quietEnd = parseTimeOfDay(settings.user.quietHours.end);
  if (quietStart !== null && quietEnd !== null && isWithinQuietHours(now.minuteOfDay, quietStart, quietEnd)) {
    return 'quiet_hours';
  }

  const spaced = state.lastNudgeAt === null || now.instant.getTime() - state.lastNudgeAt.getTime() >= COACH_PLANNING.minSpacingMs;

  // The back-off message obeys the switches, pauses, quiet hours and spacing only:
  // it exists to stop the coach, so preferences and the cap never hold it back.
  if (moment === 'back_off') return spaced ? null : 'spacing';

  const { safetyStop, painStreak, lowReadinessStreak } = signals.safety;
  if ((safetyStop || painStreak || lowReadinessStreak) && PUSHY_MOMENTS.has(moment)) return 'safety_supportive_only';

  // The weekly review is not held back by notification preferences (E7.10 AC 5):
  // it is an in-app card that also advances the weekly streak, and the
  // dispatcher sends it only on the channels the user left on (none at all
  // still leaves the card in `/coach`).
  if (lane === 'weekly_review') {
    return candidate.isoWeek !== undefined && state.lastWeeklyReviewWeek === candidate.isoWeek ? 'already_sent' : null;
  }

  if (settings.eventEnabled[COACH_MOMENT_EVENT[moment]] === false) return 'pref_off';

  if (candidate.momentKey !== undefined && (state.goalMomentKeysSent ?? []).includes(candidate.momentKey)) return 'already_sent';
  if (state.momentsSentToday.includes(moment)) return 'already_sent';

  const sentToday = state.nudgeDayLocal === now.date ? state.nudgesToday : 0;
  if (sentToday >= effectiveDailyCap(settings)) return 'daily_cap';

  if (!spaced) return 'spacing';

  return null;
}

// -----------------------------------------------------------------------------
// The kickoff gate (E7.12)
// -----------------------------------------------------------------------------
//
// `kickoff` is EVENT-DRIVEN (program activation), not planned by the sweep,
// and it bypasses the usual-time anchor. It still passes the gates, but a
// gate that only means "not now" DEFERS it to the next allowed instant rather
// than dropping it: a program is activated once, so a dropped kickoff would
// never come back.
//
//   coach off (AI, system, user)  -> suppress
//   paused                        -> defer to `pausedUntil`
//   quiet hours                   -> defer to the end of the quiet window
//   daily cap reached             -> defer to the next local morning anchor
//   spacing (3 hours)             -> defer to `lastNudgeAt` + spacing
//
// `silencedAt` does not hold it back: activating a plan is the user
// re-engaging. One kickoff per program is the caller's `momentKey` check.
// -----------------------------------------------------------------------------

export type KickoffGateDecision =
  | { action: 'send' }
  | { action: 'suppress'; reason: 'coach_off' }
  | { action: 'defer'; reason: 'paused' | 'quiet_hours' | 'daily_cap' | 'spacing'; until: Date };

export interface KickoffGateInput {
  aiEnabled: boolean;
  system: Pick<SystemCoachValue, 'enabled' | 'maxNudgesPerDayCeiling'>;
  user: Pick<ResolvedCoachUserSettings, 'enabled' | 'quietHours' | 'maxNudgesPerDay' | 'preferredTime'>;
  state: Pick<CoachPlanningState, 'lastNudgeAt' | 'nudgesToday' | 'nudgeDayLocal' | 'pausedUntil'>;
}

export function kickoffGate(input: KickoffGateInput, now: CoachNow): KickoffGateDecision {
  const { user, system, state } = input;
  if (!input.aiEnabled || !system.enabled || !user.enabled) return { action: 'suppress', reason: 'coach_off' };

  if (state.pausedUntil !== null && state.pausedUntil.getTime() > now.instant.getTime()) {
    return { action: 'defer', reason: 'paused', until: state.pausedUntil };
  }

  const quietStart = parseTimeOfDay(user.quietHours.start);
  const quietEnd = parseTimeOfDay(user.quietHours.end);
  if (quietStart !== null && quietEnd !== null && isWithinQuietHours(now.minuteOfDay, quietStart, quietEnd)) {
    const minutes = (quietEnd - now.minuteOfDay + MINUTES_PER_DAY) % MINUTES_PER_DAY || MINUTES_PER_DAY;
    return { action: 'defer', reason: 'quiet_hours', until: addMinutes(now.instant, minutes) };
  }

  const sentToday = state.nudgeDayLocal === now.date ? state.nudgesToday : 0;
  const cap = Math.min(user.maxNudgesPerDay, system.maxNudgesPerDayCeiling);
  if (sentToday >= cap) {
    // The next local day's morning anchor; the re-run checks every gate again.
    const minutes = MINUTES_PER_DAY - now.minuteOfDay + morningMinute(user.preferredTime);
    return { action: 'defer', reason: 'daily_cap', until: addMinutes(now.instant, minutes) };
  }

  if (state.lastNudgeAt !== null) {
    const next = state.lastNudgeAt.getTime() + COACH_PLANNING.minSpacingMs;
    if (next > now.instant.getTime()) return { action: 'defer', reason: 'spacing', until: new Date(next) };
  }

  return { action: 'send' };
}

function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}
