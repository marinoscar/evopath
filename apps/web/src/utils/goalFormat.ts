/**
 * Presentation helpers for activity goals (#268): labels, target summaries,
 * the progress line ("2 of 4 walks · 3 days left", "5,240 / 8,000 steps"),
 * the custom-goal form's client-side checks and the check-in day list.
 *
 * Nothing here decides progress; `done`, `daysLeft`, `onTrack` and `hit`
 * come from `GET /api/goals/progress` as sent.
 */
import {
  GOAL_CUSTOM_LABEL_MAX,
  GOAL_TARGET_MAX,
  GOAL_TARGET_MIN,
  GOAL_TITLE_MAX,
  type ActivityKind,
  type CreateActivityEntryInput,
  type CreateGoalInput,
  type Goal,
  type GoalActivityKind,
  type GoalHistoryPeriod,
  type GoalMetric,
  type GoalPeriod,
} from '../services/goals';

export type DistanceUnit = 'km' | 'mi';
export const METERS_PER_MILE = 1609.344;

const numberFormat = new Intl.NumberFormat('en-US');
const distanceFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

export function formatCount(n: number): string {
  return numberFormat.format(n);
}

export const ACTIVITY_KIND_LABELS: Record<GoalActivityKind, string> = {
  walk: 'Walk',
  run: 'Run',
  cardio_any: 'Any cardio',
  workout_any: 'Any workout',
  custom: 'Custom',
};

export const METRIC_LABELS: Record<GoalMetric, string> = {
  sessions: 'Sessions',
  minutes: 'Minutes',
  steps: 'Steps',
  distance_m: 'Distance',
};

export const PERIOD_LABELS: Record<GoalPeriod, string> = {
  week: 'Per week',
  day: 'Per day',
};

/** "Walk", "Any cardio", or a custom goal's own label. */
export function activityLabel(goal: Pick<Goal, 'activityKind' | 'customLabel'>): string {
  if (goal.activityKind === 'custom') return goal.customLabel?.trim() || ACTIVITY_KIND_LABELS.custom;
  return ACTIVITY_KIND_LABELS[goal.activityKind];
}

/** The noun a sessions goal counts: "walks", "runs", "cardio sessions", "workouts". */
export function sessionNoun(kind: GoalActivityKind, count: number): string {
  const one = count === 1;
  switch (kind) {
    case 'walk':
      return one ? 'walk' : 'walks';
    case 'run':
      return one ? 'run' : 'runs';
    case 'cardio_any':
      return one ? 'cardio session' : 'cardio sessions';
    case 'workout_any':
      return one ? 'workout' : 'workouts';
    default:
      return one ? 'session' : 'sessions';
  }
}

export function metersToDisplay(meters: number, unit: DistanceUnit): number {
  return unit === 'mi' ? meters / METERS_PER_MILE : meters / 1000;
}

export function displayToMeters(value: number, unit: DistanceUnit): number {
  return Math.round(unit === 'mi' ? value * METERS_PER_MILE : value * 1000);
}

function formatDistance(meters: number, unit: DistanceUnit): string {
  return distanceFormat.format(metersToDisplay(meters, unit));
}

/** "4 walks a week", "150 min a week", "8,000 steps a day", "10 km a week". */
export function formatGoalTarget(
  goal: Pick<Goal, 'activityKind' | 'metric' | 'target' | 'period'>,
  unit: DistanceUnit = 'km',
): string {
  const per = goal.period === 'week' ? 'a week' : 'a day';
  switch (goal.metric) {
    case 'sessions':
      return `${formatCount(goal.target)} ${sessionNoun(goal.activityKind, goal.target)} ${per}`;
    case 'minutes':
      return `${formatCount(goal.target)} min ${per}`;
    case 'steps':
      return `${formatCount(goal.target)} steps ${per}`;
    case 'distance_m':
      return `${formatDistance(goal.target, unit)} ${unit} ${per}`;
  }
}

/** "3 days left", "Last day", or "" for a daily goal (the period is today). */
export function formatDaysLeft(daysLeft: number, period: GoalPeriod): string {
  if (period === 'day') return '';
  if (daysLeft <= 1) return 'Last day';
  return `${daysLeft} days left`;
}

/** The amount part: "2 of 4 walks", "45 / 150 min", "5,240 / 8,000 steps", "3.2 / 10 km". */
export function formatGoalAmount(
  progress: { done: number; target: number; goal: Pick<Goal, 'activityKind' | 'metric'> },
  unit: DistanceUnit = 'km',
): string {
  const { done, target, goal } = progress;
  switch (goal.metric) {
    case 'sessions':
      return `${formatCount(done)} of ${formatCount(target)} ${sessionNoun(goal.activityKind, target)}`;
    case 'minutes':
      return `${formatCount(done)} / ${formatCount(target)} min`;
    case 'steps':
      return `${formatCount(done)} / ${formatCount(target)} steps`;
    case 'distance_m':
      return `${formatDistance(done, unit)} / ${formatDistance(target, unit)} ${unit}`;
  }
}

/** The full line: "2 of 4 walks · 3 days left", "5,240 / 8,000 steps". */
export function formatGoalProgress(
  progress: {
    done: number;
    target: number;
    daysLeft: number;
    goal: Pick<Goal, 'activityKind' | 'metric' | 'period'>;
  },
  unit: DistanceUnit = 'km',
): string {
  const amount = formatGoalAmount(progress, unit);
  const left = progress.done >= progress.target ? '' : formatDaysLeft(progress.daysLeft, progress.goal.period);
  return left ? `${amount} · ${left}` : amount;
}

/** 0..100 for a determinate ring. */
export function progressPercent(done: number, target: number): number {
  if (target <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / target) * 100)));
}

export type GoalStanding = 'hit' | 'onTrack' | 'behind';

export function goalStanding(progress: { hit: boolean; onTrack: boolean }): GoalStanding {
  if (progress.hit) return 'hit';
  return progress.onTrack ? 'onTrack' : 'behind';
}

export const STANDING_LABELS: Record<GoalStanding, string> = {
  hit: 'Goal hit',
  onTrack: 'On track',
  behind: 'Behind',
};

/** "3-week streak", "1-day streak"; "" for none. */
export function formatStreak(periods: number, period: GoalPeriod): string {
  if (periods <= 0) return '';
  return `${periods}-${period} streak`;
}

/**
 * Consecutive hit periods, newest first, from `GET /api/goals/:id/history`.
 * A period still running (`periodEnd >= today`) that is not hit yet is skipped
 * rather than breaking the streak.
 */
export function historyStreak(history: readonly GoalHistoryPeriod[], today: string): number {
  let streak = 0;
  for (let i = 0; i < history.length; i += 1) {
    const period = history[i];
    if (i === 0 && !period.hit && period.periodEnd >= today) continue;
    if (!period.hit) break;
    streak += 1;
  }
  return streak;
}

// -----------------------------------------------------------------------------
// Dates
// -----------------------------------------------------------------------------

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` plus `days` (negative goes back), calendar arithmetic in UTC. */
export function addDays(date: string, days: number): string {
  const match = DATE_ONLY.exec(date);
  if (!match) return date;
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return d.toISOString().slice(0, 10);
}

/** "Sep 22 – Sep 28" for a week, "Sep 28" for a day. */
export function formatPeriodRange(periodStart: string, periodEnd: string): string {
  const fmt = (value: string) => {
    const match = DATE_ONLY.exec(value);
    if (!match) return value;
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toLocaleDateString('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
    });
  };
  return periodStart === periodEnd ? fmt(periodStart) : `${fmt(periodStart)} – ${fmt(periodEnd)}`;
}

// -----------------------------------------------------------------------------
// The goal form
// -----------------------------------------------------------------------------

export interface GoalDraft {
  title: string;
  activityKind: GoalActivityKind;
  customLabel: string;
  metric: GoalMetric;
  /** As typed: a count, minutes, steps, or a distance in `unit`. */
  target: string;
  period: GoalPeriod;
}

export const EMPTY_GOAL_DRAFT: GoalDraft = {
  title: '',
  activityKind: 'walk',
  customLabel: '',
  metric: 'sessions',
  target: '',
  period: 'week',
};

export type GoalDraftErrors = Partial<Record<'title' | 'customLabel' | 'target' | 'period', string>>;

/** The form value for a stored target (meters shown in `unit`). */
export function targetToDraft(metric: GoalMetric, target: number, unit: DistanceUnit): string {
  if (metric !== 'distance_m') return String(target);
  return String(Math.round(metersToDisplay(target, unit) * 10) / 10);
}

export function draftFromGoal(goal: Goal, unit: DistanceUnit): GoalDraft {
  return {
    title: goal.title,
    activityKind: goal.activityKind,
    customLabel: goal.customLabel ?? '',
    metric: goal.metric,
    target: targetToDraft(goal.metric, goal.target, unit),
    period: goal.period,
  };
}

/**
 * Client-side checks mirroring the API's Zod rules (the API decides).
 * Returns the errors and, when there are none, the create body.
 */
export function validateGoalDraft(
  draft: GoalDraft,
  unit: DistanceUnit,
): { errors: GoalDraftErrors; input: CreateGoalInput | null } {
  const errors: GoalDraftErrors = {};
  const title = draft.title.trim();
  if (!title) errors.title = 'Give the goal a name.';
  else if (title.length > GOAL_TITLE_MAX) errors.title = `Keep it to ${GOAL_TITLE_MAX} characters.`;

  const customLabel = draft.customLabel.trim();
  if (draft.activityKind === 'custom') {
    if (!customLabel) errors.customLabel = 'Say what the activity is, e.g. Yoga.';
    else if (customLabel.length > GOAL_CUSTOM_LABEL_MAX) {
      errors.customLabel = `Keep it to ${GOAL_CUSTOM_LABEL_MAX} characters.`;
    }
  }

  if (draft.metric === 'sessions' && draft.period !== 'week') {
    errors.period = 'A sessions goal is counted per week.';
  }

  const raw = draft.target.trim();
  const value = Number(raw);
  let target: number | null = null;
  if (!raw || !Number.isFinite(value) || value <= 0) {
    errors.target = 'Enter a target above zero.';
  } else if (draft.metric === 'distance_m') {
    target = displayToMeters(value, unit);
  } else if (!Number.isInteger(value)) {
    errors.target = 'Enter a whole number.';
  } else {
    target = value;
  }
  if (target !== null && !errors.target) {
    if (target < GOAL_TARGET_MIN) errors.target = 'Enter a target above zero.';
    else if (target > GOAL_TARGET_MAX) errors.target = 'That target is too large.';
  }

  if (Object.keys(errors).length > 0 || target === null) return { errors, input: null };
  return {
    errors,
    input: {
      title,
      activityKind: draft.activityKind,
      ...(draft.activityKind === 'custom' ? { customLabel } : {}),
      metric: draft.metric,
      target,
      period: draft.period,
    },
  };
}

/** The unit the target field is typed in. */
export function targetUnitLabel(metric: GoalMetric, unit: DistanceUnit): string {
  switch (metric) {
    case 'sessions':
      return 'times';
    case 'minutes':
      return 'min';
    case 'steps':
      return 'steps';
    case 'distance_m':
      return unit;
  }
}

export type CheckInMode = 'done' | 'minutes' | 'steps';

/** The check-in sheet's starting mode: steps for a steps goal, minutes for a minutes goal. */
export function defaultCheckInMode(goal: Pick<Goal, 'metric'>): CheckInMode {
  if (goal.metric === 'steps') return 'steps';
  if (goal.metric === 'minutes') return 'minutes';
  return 'done';
}

/**
 * Whether a manual check-in can count toward the goal: an "any workout" goal
 * counts logged workouts only (unless it tracks steps).
 */
export function canCheckIn(goal: Pick<Goal, 'activityKind' | 'metric'>): boolean {
  return goal.activityKind !== 'workout_any' || goal.metric === 'steps';
}

/** The entry body for a check-in (the API matches it to goals). */
export function checkInEntry(
  goal: Pick<Goal, 'activityKind'>,
  mode: CheckInMode,
  amount: number,
  occurredOn?: string,
): CreateActivityEntryInput {
  const day = occurredOn ? { occurredOn } : {};
  if (mode === 'steps') return { activityKind: 'steps', steps: amount, ...day };
  // `workout_any` has no manual kind of its own; record it as generic cardio.
  const activityKind: ActivityKind = goal.activityKind === 'workout_any' ? 'cardio_any' : goal.activityKind;
  if (mode === 'minutes') return { activityKind, durationSeconds: amount * 60, ...day };
  return { activityKind, ...day };
}
