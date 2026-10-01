import { addDays } from '../../check-ins/local-date';
import type { ResolvedCoachUserSettings } from '../../common/schemas/user-settings-namespaces.schema';
import type { PlanSignals } from '../../programs/signals/plan-signals.contract';
import { LOW_READINESS_STREAK_MIN_DAYS, PAIN_STREAK_MIN_SESSIONS, nextSessionOf, weeklyTargetOf } from '../planning/coach-signals';
import type { CoachMoment } from '../personas';
import type { CoachGoalSummary } from '../planning/coach-goals';

// =============================================================================
// The nudge context builder (E7.5, #245; spec §2.6 step 2)
// =============================================================================
//
// PURE. Turns what the nudge job read into:
//
//   promptData      the JSON the model sees: the moment and why it fired,
//                   adherence and this week's target from the SIGNALS SERVICE,
//                   the streak from `CoachState`, the next session, any PR
//                   lifts, the safety register, and the last 10 coach lines
//                   (title and moment only) so the model does not repeat
//                   itself. No ids, no dates (weekday names instead), no body
//                   measurements, no free text except the user's `why`, which
//                   travels separately and delimited (`nudge-prompt.ts`), and
//                   the titles of the user's own activity goals (F9): a
//                   compact `goals` summary (title, metric, period, counts),
//                   plus `goal`, the one a goal moment is about. The prompt
//                   marks goal titles as data.
//   allowedNumbers  every figure in `promptData`, for the content guard's
//                   `invented_number` rule: a number the model writes that is
//                   not here fails the guard.
//   supportive      the safety register (spec §2.14): a safety stop, a pain
//                   streak or a low-readiness streak.
//   fill            values for the static fallback's placeholders.
//
// The never-send list (`coach/context/coach-never-send.ts`) is honoured by
// construction: nothing on it is an input here.
// =============================================================================

/** How many earlier coach messages the model sees (titles and moments only). */
export const NUDGE_HISTORY_LIMIT = 10;
/** At most this many PR lifts are named. */
const MAX_PR_LIFTS = 3;
/** The `streak_at_risk` default anchor when there is no usual time or preferred time. */
const DEFAULT_TIME = '17:00';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export interface NudgeStateInput {
  weeklyStreak: number;
  streakPassesLeft: number;
  usualWorkoutMinuteLocal: number | null;
}

export interface NudgeHistoryInput {
  kind: string;
  moment: string | null;
  title: string;
  createdAt: Date;
}

export interface NudgeContextInput {
  moment: CoachMoment;
  /** The planner's reason code for the moment (`missed_streak`, ...). */
  reason: string;
  trigger: string;
  /** Local today (`YYYY-MM-DD`). */
  today: string;
  now: Date;
  signals: PlanSignals;
  state: NudgeStateInput | null;
  /** The user's coach-authored messages, newest first (any number; the last 10 are used). */
  history: readonly NudgeHistoryInput[];
  settings: Pick<ResolvedCoachUserSettings, 'preferredTime' | 'lockScreenSafe'>;
  /** An active training safety stop (planner's `isSafetyStop`). */
  safetyStop: boolean;
  /** Active activity goals, compact (F9); absent: none. */
  goals?: readonly CoachGoalSummary[];
  /** Goal moments: the goal the message is about (absent or null otherwise). */
  goal?: CoachGoalSummary | null;
}

export interface NudgePromptData {
  moment: CoachMoment;
  momentReason: string;
  trigger: string;
  today: string;
  adherence: {
    plannedSessions: number;
    completedSessions: number;
    missedSessions: number;
    adherencePct: number | null;
    missedInARow: number;
    completedInARow: number;
  };
  thisWeek: { plannedSessions: number; doneSessions: number; remainingSessions: number };
  weeklyStreak: number;
  streakPassesLeft: number;
  nextSession: { name: string; when: string } | null;
  usualWorkoutTime: string | null;
  preferredTime: string | null;
  personalRecords: Array<{ lift: string; bestKg: number | null; reps: number | null }>;
  safety: { supportive: boolean; reasons: string[]; avoidLifts: string[] };
  recentCoachMessages: Array<{ moment: string | null; kind: string; title: string; daysAgo: number }>;
  /** The user's active activity goals in their current period (F9). */
  goals: CoachGoalSummary[];
  /** Goal moments: the goal this message is about; null otherwise. */
  goal: CoachGoalSummary | null;
}

export interface NudgeFill {
  n: number;
  streak: number;
  lift: string;
  time: string;
}

export interface NudgeContext {
  promptData: NudgePromptData;
  allowedNumbers: Array<number | string>;
  supportive: boolean;
  /** Supportive because of low readiness: a check-in converts this message (spec §2.8). */
  lowReadiness: boolean;
  fill: NudgeFill;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildNudgeContext(input: NudgeContextInput): NudgeContext {
  const { signals, today } = input;
  const totals = signals.adherence.totals;
  const week = weeklyTargetOf(signals, today);
  const next = nextSessionOf(signals, today);

  const painLifts = signals.pain.filter((p) => p.consecutiveFlaggedSessions >= PAIN_STREAK_MIN_SESSIONS).map((p) => p.name);
  const lowReadiness = signals.readiness.lowStreak >= LOW_READINESS_STREAK_MIN_DAYS;
  const reasons: string[] = [];
  if (input.safetyStop) reasons.push('safety_stop');
  if (painLifts.length > 0) reasons.push('pain_pattern');
  if (lowReadiness) reasons.push('low_readiness');
  const supportive = reasons.length > 0;

  const prs = signals.performance
    .filter((lift) => lift.prInRange)
    .sort((a, b) => (b.lastTopSets[0]?.date ?? '').localeCompare(a.lastTopSets[0]?.date ?? ''))
    .slice(0, MAX_PR_LIFTS)
    .map((lift) => ({
      lift: lift.name,
      bestKg: roundKg(lift.best.e1rmKg ?? lift.best.weightKg),
      reps: lift.best.reps,
    }));

  const usual = minuteToTime(input.state?.usualWorkoutMinuteLocal ?? null);
  const weeklyStreak = input.state?.weeklyStreak ?? 0;

  const promptData: NudgePromptData = {
    moment: input.moment,
    momentReason: input.reason,
    trigger: input.trigger,
    today: weekdayOf(today),
    adherence: {
      plannedSessions: totals.planned,
      completedSessions: totals.completed,
      missedSessions: totals.missed,
      adherencePct: totals.adherencePct,
      missedInARow: signals.adherence.missedStreak,
      completedInARow: signals.adherence.completedStreak,
    },
    thisWeek: { plannedSessions: week.planned, doneSessions: week.done, remainingSessions: Math.max(0, week.planned - week.done) },
    weeklyStreak,
    streakPassesLeft: input.state?.streakPassesLeft ?? 0,
    nextSession: next ? { name: next.name, when: relativeDay(next.date, today) } : null,
    usualWorkoutTime: usual,
    preferredTime: input.settings.preferredTime,
    personalRecords: prs,
    safety: { supportive, reasons, avoidLifts: painLifts },
    recentCoachMessages: input.history.slice(0, NUDGE_HISTORY_LIMIT).map((m) => ({
      moment: m.moment,
      kind: m.kind,
      title: m.title,
      daysAgo: Math.max(0, Math.floor((input.now.getTime() - m.createdAt.getTime()) / DAY_MS)),
    })),
    goals: [...(input.goals ?? [])],
    goal: input.goal ?? null,
  };

  const time = usual ?? input.settings.preferredTime ?? DEFAULT_TIME;
  const fill: NudgeFill = {
    n: goalFillNumber(input.moment, input.goal ?? null) ?? (week.done > 0 ? week.done : totals.completed),
    // "one session from a {streak}-week streak": the streak this week would make.
    streak: weeklyStreak + 1,
    lift: prs[0]?.lift ?? 'your top lift',
    time,
  };

  const allowedNumbers = collectNumbers(promptData);
  allowedNumbers.push(fill.n, fill.streak, time);

  return { promptData, allowedNumbers, supportive, lowReadiness: supportive && lowReadiness, fill };
}

/** Every number, and every `HH:mm` string, anywhere in `value` (titles and names excluded). */
export function collectNumbers(value: unknown, out: Array<number | string> = []): Array<number | string> {
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.push(value);
  } else if (typeof value === 'string') {
    if (/^\d{2}:\d{2}$/.test(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'title' || key === 'name' || key === 'lift') continue;
      collectNumbers(item, out);
    }
  }
  return out;
}

/** `{n}` of a goal moment: what is still to do (`goal_at_risk`) or what was done (`goal_hit`). */
function goalFillNumber(moment: CoachMoment, goal: CoachGoalSummary | null): number | null {
  if (!goal) return null;
  if (moment === 'goal_at_risk') return goal.remaining;
  if (moment === 'goal_hit') return goal.done;
  return null;
}

function roundKg(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

function minuteToTime(minute: number | null): string | null {
  if (minute === null || !Number.isFinite(minute)) return null;
  const h = Math.floor(minute / 60) % 24;
  const m = Math.floor(minute % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function weekdayOf(date: string): string {
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
}

function relativeDay(date: string, today: string): string {
  if (date === today) return 'today';
  if (date === addDays(today, 1)) return 'tomorrow';
  return weekdayOf(date);
}
