import type { GoalProgressData } from '../../activity/goal-progress.service';
import { evaluatePeriod, type ProgressEntry } from '../../activity/goal-progress';
import type { CoachGoalHit, CoachGoalSignal } from './plan-coach-moments';

// =============================================================================
// Activity goals as the coach reads them (F9, #269; docs/specs/ai-coach.md)
// =============================================================================
//
// PURE. Maps `GoalProgressService.progressForUser` results to what the
// planner, the nudge context and the weekly review need:
//
//   toCoachGoalSignals   ids, enums and counts for `planCoachMoments`
//   goalsHitBy           which goals an event (a check-in, a finished
//                        workout) made `hit` for the FIRST time this period
//   coachGoalSummaries   the compact, title-bearing summary the model and
//                        the weekly review see (no ids, no entries, no notes)
//
// "First time" is decided by re-counting the period WITHOUT the event's
// entries (the activity rules' own `evaluatePeriod`, so precedence holds: a
// manual walk superseded by a workout walk crosses nothing). Hit now and not
// hit without them: this event crossed the target.
// =============================================================================

/** Clock skew allowed between the API (which reads `recordedSince`) and the database (which stamps rows). */
export const RECORDED_SINCE_SKEW_MS = 5_000;

export function toCoachGoalSignals(progress: readonly GoalProgressData[]): CoachGoalSignal[] {
  return progress.map((p) => ({
    goalId: p.goalId,
    metric: p.goal.metric,
    period: p.goal.period,
    periodStart: p.periodStart,
    done: p.done,
    target: p.target,
    remaining: p.remaining,
    daysLeft: p.daysLeft,
    elapsedFraction: p.elapsedFraction,
    hit: p.hit,
  }));
}

type EventEntry = GoalProgressData['entries'][number];

/** The goals `fromEvent` entries made `hit` for the first time in the current period. */
export function goalsHitBy(progress: readonly GoalProgressData[], fromEvent: (entry: EventEntry) => boolean): CoachGoalHit[] {
  const out: CoachGoalHit[] = [];
  for (const p of progress) {
    if (!p.hit) continue;
    const before = p.entries.filter((entry) => !fromEvent(entry));
    if (before.length === p.entries.length) continue;
    const goal = {
      id: p.goalId,
      activityKind: p.goal.activityKind,
      metric: p.goal.metric,
      target: p.target,
      period: p.goal.period,
      startsOn: p.goal.startsOn,
    };
    const { done } = evaluatePeriod(goal, before as ProgressEntry[], { start: p.periodStart, end: p.periodEnd });
    if (done < p.target) out.push({ goalId: p.goalId, periodStart: p.periodStart });
  }
  return out;
}

/**
 * Entries of a manual check-in, or of a Health Connect sync (`integration`,
 * epic #276, which emits the same `activity.entry.recorded`), written at or
 * after `recordedSince` (less the skew allowance).
 */
export function recordedSincePredicate(recordedSince: Date): (entry: EventEntry) => boolean {
  const from = recordedSince.getTime() - RECORDED_SINCE_SKEW_MS;
  return (entry) =>
    (entry.source === 'manual' || entry.source === 'integration') &&
    Math.max(Date.parse(entry.createdAt), Date.parse(entry.updatedAt)) >= from;
}

/** Entries derived from the finished workout. */
export function fromWorkoutPredicate(workoutId: string): (entry: EventEntry) => boolean {
  return (entry) => entry.source === 'workout' && entry.workoutId === workoutId;
}

/** One goal as the model and the weekly review see it: no id, no entries. */
export interface CoachGoalSummary {
  title: string;
  metric: 'sessions' | 'minutes' | 'steps' | 'distance_m';
  period: 'week' | 'day';
  done: number;
  target: number;
  remaining: number;
  daysLeft: number;
  hit: boolean;
  onTrack: boolean;
  streakPeriods: number;
}

/** At most this many goals reach a prompt (the API caps active goals at 10 anyway). */
export const COACH_GOAL_SUMMARY_LIMIT = 10;

export function coachGoalSummaries(progress: readonly GoalProgressData[]): CoachGoalSummary[] {
  return progress.slice(0, COACH_GOAL_SUMMARY_LIMIT).map((p) => ({
    title: p.goal.title,
    metric: p.goal.metric,
    period: p.goal.period,
    done: p.done,
    target: p.target,
    remaining: p.remaining,
    daysLeft: p.daysLeft,
    hit: p.hit,
    onTrack: p.onTrack,
    streakPeriods: p.streakPeriods,
  }));
}
