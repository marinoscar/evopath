import { DEFAULT_TIME_ZONE, addDays } from '../../check-ins/local-date';
import { daysFrom, isoWeekday } from '../../programs/today/resolve-today';
import { EVALUATION_DUE } from './evaluation.constants';

// =============================================================================
// When the sweep's evaluations are due, in the user's time zone (pure)
// =============================================================================
//
// WEEKLY. The anchor is the most recent local Sunday 18:00 at or before now
// (Health Profile `timeZone`, UTC when unset or unknown). A weekly review is
// due when the last one is null or both earlier than that anchor and at least
// 6 days old, and the plan had been active (since its `startDate`) at least 5
// local days on the anchor's Sunday. So it fires once per week from Sunday
// 18:00, and a week whose
// Sunday was missed (the sweep did not run, a gate failed) is caught up on a
// later day, until the next anchor. A traveller may get it a day early or late.
//
// MISSED SESSIONS. Checked at most once a day per plan: only in the sweep
// pass that runs in the user's local 06:00 hour, and only when the last
// evaluation is at least 3 days old (or none). The streak itself comes from
// the signals (`adherence.missedStreak >= 2`), read only for such candidates.
//
// BLOCK TRANSITION. A weekly review in the last week of a block carries
// `deep: true` (a hint in the evaluator's prompt).
// =============================================================================

export interface LocalWallTime {
  /** `YYYY-MM-DD`. */
  date: string;
  /** ISO weekday, 1 (Monday) .. 7 (Sunday). */
  weekday: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  if (formatters.has(timeZone)) return formatters.get(timeZone) ?? null;
  let formatter: Intl.DateTimeFormat | null;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    // Not an IANA zone this runtime knows.
    formatter = null;
  }
  formatters.set(timeZone, formatter);
  return formatter;
}

/** The wall clock of `instant` in `timeZone`; a null, empty or unknown zone is UTC. */
export function localWallTime(instant: Date, timeZone: string | null | undefined): LocalWallTime {
  const formatter = (timeZone && formatterFor(timeZone)) || formatterFor(DEFAULT_TIME_ZONE)!;
  const parts = formatter.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00';
  const date = `${part('year')}-${part('month')}-${part('day')}`;
  return { date, weekday: isoWeekday(date), hour: Number(part('hour')) % 24, minute: Number(part('minute')) };
}

/** A sortable local key, `YYYY-MM-DDTHH:mm`. */
function keyOf(wall: Pick<LocalWallTime, 'date' | 'hour' | 'minute'>): string {
  return `${wall.date}T${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`;
}

/** The local date of the most recent Sunday 18:00 at or before `now`. */
export function weeklyAnchorDate(now: Date, timeZone: string | null | undefined): string {
  const local = localWallTime(now, timeZone);
  const reached = local.weekday === EVALUATION_DUE.weeklyWeekday && local.hour >= EVALUATION_DUE.weeklyHour;
  const back = reached ? 0 : local.weekday === EVALUATION_DUE.weeklyWeekday ? 7 : local.weekday;
  return addDays(local.date, -back);
}

/** The most recent local Sunday 18:00 at or before `now`, as a local key (`YYYY-MM-DDTHH:mm`). */
export function weeklyAnchorKey(now: Date, timeZone: string | null | undefined): string {
  return keyOf({ date: weeklyAnchorDate(now, timeZone), hour: EVALUATION_DUE.weeklyHour, minute: 0 });
}

export interface WeeklyDueInput {
  now: Date;
  timeZone: string | null | undefined;
  /** The plan's `startDate` (`YYYY-MM-DD`); null for a plan never activated. */
  startDate: string | null;
  lastWeeklyEvaluationAt: Date | null;
}

export function isWeeklyDue(input: WeeklyDueInput): boolean {
  const { now, timeZone, startDate, lastWeeklyEvaluationAt: last } = input;
  if (!startDate) return false;

  // Active at least 5 days by the anchor (so the first review is the first
  // Sunday evening at least 5 days into the plan, never mid-week).
  if (daysFrom(startDate, weeklyAnchorDate(now, timeZone)) < EVALUATION_DUE.weeklyMinActiveDays) return false;

  if (last) {
    if (now.getTime() - last.getTime() < EVALUATION_DUE.weeklyMinGapMs) return false;
    if (keyOf(localWallTime(last, timeZone)) >= weeklyAnchorKey(now, timeZone)) return false;
  }
  return true;
}

export interface MissedSessionsCandidateInput {
  now: Date;
  timeZone: string | null | undefined;
  lastEvaluatedAt: Date | null;
}

/** Whether the sweep should read this plan's signals for the missed-sessions rule in this pass. */
export function isMissedSessionsCandidate(input: MissedSessionsCandidateInput): boolean {
  if (localWallTime(input.now, input.timeZone).hour !== EVALUATION_DUE.missedSessionsCheckLocalHour) return false;
  return !input.lastEvaluatedAt || input.now.getTime() - input.lastEvaluatedAt.getTime() >= EVALUATION_DUE.missedSessionsMinIdleMs;
}

/** The missed-sessions rule proper, once the signals are read. */
export function isMissedSessionsDue(missedStreak: number): boolean {
  return missedStreak >= EVALUATION_DUE.missedStreakMin;
}

/**
 * Whether `today` falls in the last week of its block: `weeks` are the live
 * plan weeks (`weekNumber` program-wide, grouped by `blockId`). False when the
 * plan has not started or `today` is past its last week.
 */
export function isLastWeekOfBlock(
  startDate: string | null,
  today: string,
  weeks: ReadonlyArray<{ weekNumber: number; blockId: string }>,
): boolean {
  if (!startDate) return false;
  const elapsed = daysFrom(startDate, today);
  if (elapsed < 0) return false;
  const current = Math.floor(elapsed / 7) + 1;
  const week = weeks.find((w) => w.weekNumber === current);
  if (!week) return false;
  const last = Math.max(...weeks.filter((w) => w.blockId === week.blockId).map((w) => w.weekNumber));
  return current === last;
}
