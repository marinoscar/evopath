import { addDays } from '../../check-ins/local-date';
import type { PlanSignals } from '../../programs/signals/plan-signals.contract';
import { isoWeekday } from '../../programs/today/resolve-today';
import { isoWeekKey } from '../planning/coach-time';
import type { WeeklyStreakChange } from './weekly-streak';

// =============================================================================
// The weekly review's deterministic stats block (E7.10; spec §2.10), pure
// =============================================================================
//
// Every number here comes from code, never from the model:
//
//   planned, completed,  `TrainingSignalsService.forUser` over exactly the
//   missed, adherencePct reviewed ISO week (`from` = its Monday, `to` = its
//                        Sunday): the adherence TOTALS, which are what
//                        `GET /api/training/signals?from=<Mon>&to=<Sun>`
//                        answers for the same user at the same time.
//   prs                  that response's lifts with `prInRange`.
//   nextWeek             a second signals read over the following ISO week:
//                        its planned sessions (date, weekday, name).
//   checkIns             days with a check-in inside the week.
//   photosAdded          progress photos dated inside the week (a count from
//                        `ProgressPhotoSummaryService`; never an id or a URL).
//   weeklyStreak,        `CoachState` after `updateWeeklyStreak` for this week.
//   streakPassesLeft
//   goals                every ACTIVE activity goal (F9, #269), from
//                        `GoalProgressService` as of the week's Sunday:
//                        a week goal's `done`/`target` in its unit and
//                        `hit`; a DAY goal's `done` = days hit in the week,
//                        `target` = 7 (`unit: 'days'`). `streakPeriods`
//                        counts the reviewed period when it is hit (a week
//                        goal missed this week shows 0; a day goal's Sunday
//                        not yet hit leaves the run before it).
//
// `adherencePct` is null when nothing was planned ("no plan", never 0 %).
// `firstWeek` is true when the user has never completed a workout up to the
// week's end: the review then becomes a gentle start-here variant.
// =============================================================================

const ISO_WEEK = /^(\d{4})-W(\d{2})$/;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
/** At most this many PRs are listed. */
export const WEEKLY_REVIEW_MAX_PRS = 5;
/** At most this many next-week sessions are listed (the count is exact). */
export const WEEKLY_REVIEW_MAX_NEXT_WEEK = 7;

/** The Monday of an ISO week key (`2026-W40` -> `2026-09-28`), or null when the key is malformed. */
export function isoWeekMonday(isoWeek: string): string | null {
  const match = ISO_WEEK.exec(isoWeek);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) return null;
  // 4 January is always in ISO week 1.
  const jan4 = `${year}-01-04`;
  const monday = addDays(addDays(jan4, -(isoWeekday(jan4) - 1)), (week - 1) * 7);
  return isoWeekKey(monday) === isoWeek ? monday : null;
}

export interface WeeklyReviewPr {
  /** The exercise's display name. */
  exercise: string;
  /** Best working weight in the week (kg), or the best reps of an unweighted set. */
  value: number;
  unit: 'kg' | 'reps';
  /** Reps of that best set, when weighted (null for an unweighted set: `value` is the reps). */
  reps: number | null;
}

export interface WeeklyReviewNextSession {
  /** Local date `YYYY-MM-DD`. */
  date: string;
  weekday: (typeof WEEKDAYS)[number];
  name: string;
}

/** One activity goal in the weekly review (F9). The title is the user's own label. */
export interface WeeklyReviewGoal {
  title: string;
  metric: 'sessions' | 'minutes' | 'steps' | 'distance_m';
  period: 'week' | 'day';
  /** What `done` and `target` count: the metric's unit, or days hit for a day goal. */
  unit: 'sessions' | 'minutes' | 'steps' | 'meters' | 'days';
  done: number;
  target: number;
  hit: boolean;
  streakPeriods: number;
}

/** At most this many goals are listed (the API caps active goals at 10). */
export const WEEKLY_REVIEW_MAX_GOALS = 10;

/** What `buildWeeklyReviewGoals` reads per goal (a subset of `GoalProgressData`). */
export interface WeeklyReviewGoalInput {
  goalId: string;
  goal: { title: string; metric: WeeklyReviewGoal['metric']; period: WeeklyReviewGoal['period'] };
  done: number;
  target: number;
  hit: boolean;
  streakPeriods: number;
}

const GOAL_UNITS: Readonly<Record<WeeklyReviewGoal['metric'], WeeklyReviewGoal['unit']>> = {
  sessions: 'sessions',
  minutes: 'minutes',
  steps: 'steps',
  distance_m: 'meters',
};

/**
 * The review's goals: `progress` as of the week's Sunday, and for each day
 * goal the number of days of the reviewed week it was hit (`dayGoalHits`,
 * by goal id).
 */
export function buildWeeklyReviewGoals(
  progress: readonly WeeklyReviewGoalInput[],
  dayGoalHits: ReadonlyMap<string, number>,
): WeeklyReviewGoal[] {
  return progress.slice(0, WEEKLY_REVIEW_MAX_GOALS).map((p) => {
    const base = { title: p.goal.title, metric: p.goal.metric, period: p.goal.period };
    if (p.goal.period === 'day') {
      const days = dayGoalHits.get(p.goalId) ?? (p.hit ? 1 : 0);
      return { ...base, unit: 'days' as const, done: days, target: 7, hit: days >= 7, streakPeriods: p.streakPeriods + (p.hit ? 1 : 0) };
    }
    return {
      ...base,
      unit: GOAL_UNITS[p.goal.metric],
      done: p.done,
      target: p.target,
      hit: p.hit,
      streakPeriods: p.hit ? p.streakPeriods + 1 : 0,
    };
  });
}

/** `CoachMessage.data.stats` of a `weekly_review` message (version 1). */
export interface WeeklyReviewStats {
  isoWeek: string;
  /** Monday and Sunday of the reviewed week (local dates). */
  weekStart: string;
  weekEnd: string;
  planned: number;
  completed: number;
  missed: number;
  /** `completed / planned` in percent (one decimal); null when nothing was planned. */
  adherencePct: number | null;
  weeklyStreak: number;
  streakPassesLeft: number;
  streakChange: WeeklyStreakChange;
  prs: WeeklyReviewPr[];
  checkIns: number;
  photosAdded: number;
  /** Planned sessions in the following ISO week. */
  nextWeekSessions: number;
  nextWeek: WeeklyReviewNextSession[];
  /** Nothing was planned this week (rest week or no program). */
  noPlan: boolean;
  /** The user has never completed a workout (nor made progress on a goal) up to this week's end. */
  firstWeek: boolean;
  /** Active activity goals (F9); absent on reviews written before goals existed. */
  goals: WeeklyReviewGoal[];
}

export interface WeeklyReviewStatsInput {
  isoWeek: string;
  weekStart: string;
  /** Signals over exactly the reviewed week. */
  week: PlanSignals;
  /** Signals over the following ISO week (sessions only are read). */
  nextWeek: PlanSignals;
  /** Local dates with a check-in (any range; only the reviewed week counts). */
  checkInDates: readonly string[];
  photosAdded: number;
  streak: { weeklyStreak: number; streakPassesLeft: number; change: WeeklyStreakChange };
  hasCompletedWorkout: boolean;
  /** The review's activity goals (`buildWeeklyReviewGoals`); absent: none. */
  goals?: WeeklyReviewGoal[];
}

export function buildWeeklyReviewStats(input: WeeklyReviewStatsInput): WeeklyReviewStats {
  const { week, weekStart } = input;
  const weekEnd = addDays(weekStart, 6);
  const totals = week.adherence.totals;
  const nextStart = addDays(weekStart, 7);
  const nextEnd = addDays(weekStart, 13);

  const prs: WeeklyReviewPr[] = week.performance
    .filter((lift) => lift.prInRange)
    .map((lift): WeeklyReviewPr | null => {
      if (lift.best.weightKg !== null) {
        return { exercise: lift.name, value: lift.best.weightKg, unit: 'kg', reps: lift.best.reps };
      }
      return lift.best.reps !== null ? { exercise: lift.name, value: lift.best.reps, unit: 'reps', reps: null } : null;
    })
    .filter((pr): pr is WeeklyReviewPr => pr !== null)
    .slice(0, WEEKLY_REVIEW_MAX_PRS);

  const upcoming = input.nextWeek.sessions
    .filter((s) => s.plannedFor >= nextStart && s.plannedFor <= nextEnd)
    .sort((a, b) => (a.plannedFor < b.plannedFor ? -1 : a.plannedFor > b.plannedFor ? 1 : a.name.localeCompare(b.name)));

  const checkIns = new Set(input.checkInDates.filter((d) => d >= weekStart && d <= weekEnd)).size;
  const goals = input.goals ?? [];
  // A user who only tracks activity goals is not on a "first week" once a goal has moved.
  const goalActivity = goals.some((g) => g.done > 0 || g.streakPeriods > 0);

  return {
    isoWeek: input.isoWeek,
    weekStart,
    weekEnd,
    planned: totals.planned,
    completed: totals.completed,
    missed: totals.missed,
    adherencePct: totals.planned > 0 ? totals.adherencePct : null,
    weeklyStreak: input.streak.weeklyStreak,
    streakPassesLeft: input.streak.streakPassesLeft,
    streakChange: input.streak.change,
    prs,
    checkIns,
    photosAdded: input.photosAdded,
    nextWeekSessions: upcoming.length,
    nextWeek: upcoming.slice(0, WEEKLY_REVIEW_MAX_NEXT_WEEK).map((s) => ({
      date: s.plannedFor,
      weekday: WEEKDAYS[isoWeekday(s.plannedFor) - 1],
      name: s.name,
    })),
    noPlan: totals.planned === 0,
    firstWeek: !input.hasCompletedWorkout && !goalActivity,
    goals,
  };
}

/** Every figure the stats block holds: the only numbers the review's prose may state. */
export function weeklyReviewAllowedNumbers(stats: WeeklyReviewStats): number[] {
  const numbers = [
    stats.planned,
    stats.completed,
    stats.missed,
    stats.weeklyStreak,
    stats.streakPassesLeft,
    stats.checkIns,
    stats.photosAdded,
    stats.nextWeekSessions,
  ];
  if (stats.adherencePct !== null) numbers.push(stats.adherencePct);
  for (const pr of stats.prs) {
    numbers.push(pr.value);
    if (pr.reps !== null) numbers.push(pr.reps);
  }
  const goals = stats.goals ?? [];
  if (goals.length > 0) numbers.push(goals.length, goals.filter((g) => g.hit).length);
  for (const goal of goals) numbers.push(goal.done, goal.target, goal.streakPeriods);
  return numbers;
}
