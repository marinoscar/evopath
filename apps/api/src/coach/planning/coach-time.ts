import { addDays } from '../../check-ins/local-date';
import { daysFrom, isoWeekday } from '../../programs/today/resolve-today';
import { localWallTime, weeklyAnchorDate } from '../../training-agents/evaluation/evaluation-due';

// =============================================================================
// The coach's local clock (E7.4; docs/specs/ai-coach.md §2.5)
// =============================================================================
//
// Pure helpers, no Nest and no Prisma. Wall-clock arithmetic reuses the
// continuous evaluation's `localWallTime` and `weeklyAnchorDate`
// (`training-agents/evaluation/evaluation-due.ts`), so the coach and the plan
// evaluator agree on what "the user's Sunday 18:00" is. The zone is the
// Health Profile `timeZone`; a null, empty or unknown zone is UTC, and
// `coachNow` reports the fallback (`zoneFallback`) so the caller can count it.
// =============================================================================

export const MINUTES_PER_DAY = 24 * 60;

/** The planner's clock: one instant, read once by the caller, and its local wall time. */
export interface CoachNow {
  /** The real instant (spacing and `pausedUntil` compare instants). */
  instant: Date;
  /** The user's local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** ISO weekday of `date`, 1 (Monday) .. 7 (Sunday). */
  weekday: number;
  /** Day of the month of `date`, 1 .. 31. */
  dayOfMonth: number;
  /** Minutes since local midnight, 0 .. 1439. */
  minuteOfDay: number;
  /** The zone actually used (`UTC` after a fallback). */
  timeZone: string;
  /** True when the requested zone was set but unknown, so UTC was used. */
  zoneFallback: boolean;
}

const validity = new Map<string, boolean>();

/** Whether `timeZone` is an IANA zone this runtime knows. */
export function isKnownTimeZone(timeZone: string): boolean {
  const cached = validity.get(timeZone);
  if (cached !== undefined) return cached;
  let known: boolean;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    known = true;
  } catch {
    known = false;
  }
  validity.set(timeZone, known);
  return known;
}

/** The coach clock for `instant` in `timeZone`. Never throws: an unknown zone is UTC. */
export function coachNow(instant: Date, timeZone: string | null | undefined): CoachNow {
  const requested = timeZone && timeZone.trim() ? timeZone : null;
  const known = requested !== null && isKnownTimeZone(requested);
  const zone = known ? requested : 'UTC';
  const wall = localWallTime(instant, zone);
  return {
    instant,
    date: wall.date,
    weekday: wall.weekday,
    dayOfMonth: Number(wall.date.slice(8, 10)),
    minuteOfDay: wall.hour * 60 + wall.minute,
    timeZone: zone,
    zoneFallback: requested !== null && !known,
  };
}

/** The local calendar day of `instant` in `timeZone` (UTC fallback). */
export function localDateOf(instant: Date, timeZone: string | null | undefined): string {
  return coachNow(instant, timeZone).date;
}

/** Minutes since local midnight of `instant` in `timeZone` (UTC fallback). */
export function localMinuteOf(instant: Date, timeZone: string | null | undefined): number {
  return coachNow(instant, timeZone).minuteOfDay;
}

/** `HH:mm` to minutes since midnight; null for null or a malformed value. */
export function parseTimeOfDay(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Whether `minuteOfDay` falls inside the quiet window `[start, end)`. The
 * window may wrap midnight (21:30 to 07:30): then it is `>= start` OR `< end`.
 * A window whose start equals its end is empty.
 */
export function isWithinQuietHours(minuteOfDay: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return minuteOfDay >= start && minuteOfDay < end;
  return minuteOfDay >= start || minuteOfDay < end;
}

/** The ISO week key of a local day, `YYYY-Www` (`2026-W40`). */
export function isoWeekKey(date: string): string {
  // The ISO year is the calendar year of the week's Thursday.
  const thursday = addDays(date, 4 - isoWeekday(date));
  const year = Number(thursday.slice(0, 4));
  const week = Math.floor(daysFrom(`${year}-01-01`, thursday) / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The Monday of `date`'s ISO week. */
export function isoWeekStart(date: string): string {
  return addDays(date, -(isoWeekday(date) - 1));
}

/**
 * The local date of the most recent Sunday 18:00 at or before `instant` in
 * `timeZone` (the weekly review anchor; the same anchor the plan evaluator uses).
 */
export function weeklyReviewAnchorDate(instant: Date, timeZone: string | null | undefined): string {
  return weeklyAnchorDate(instant, timeZone);
}
