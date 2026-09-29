// =============================================================================
// Pure helpers for the health profile (E2.1, #47)
// =============================================================================
//
// Date-only values. `dateOfBirth` is a calendar date, not an instant: it is
// stored in a Postgres `date` column, which Prisma hands back as a `Date` at
// UTC midnight. Every conversion here therefore goes through UTC and never
// through local time — building it with `new Date(y, m, d)` or reading it with
// `getDate()` shifts a birthday by a day on any server not running in UTC.
// =============================================================================

/** Oldest accepted date of birth, in whole years before today. */
export const HEALTH_PROFILE_MAX_AGE_YEARS = 120;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses `YYYY-MM-DD` into a UTC-midnight `Date`, or returns null when the
 * string is not that shape or not a real calendar date (`2026-02-30`,
 * `2025-02-29`, `2024-13-01`).
 */
export function parseDateOnly(value: string): Date | null {
  const match = DATE_ONLY.exec(value);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  // `Date.UTC` rolls an impossible day over into the next month; a real date
  // round-trips to the same three numbers.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

/** Formats a UTC-midnight `Date` (as read from a `date` column) as `YYYY-MM-DD`. */
export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The latest calendar date that is "today" anywhere on Earth right now
 * (UTC+14, Kiribati). A person born today in Auckland has a birth date that is
 * still tomorrow in UTC, so "not in the future" measured against the UTC date
 * alone would refuse a true answer. Anything after this date is in the future
 * for everyone.
 */
export function latestTodayOnEarth(now: Date = new Date()): string {
  return formatDateOnly(new Date(now.getTime() + 14 * 60 * 60 * 1000));
}

/**
 * The earliest accepted date of birth: the UTC date `HEALTH_PROFILE_MAX_AGE_YEARS`
 * years before today. A 29 February anchor falls back to 28 February in a
 * non-leap target year (via `Date.UTC` roll-over, corrected below).
 */
export function earliestDateOfBirth(now: Date = new Date()): string {
  const year = now.getUTCFullYear() - HEALTH_PROFILE_MAX_AGE_YEARS;
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  const candidate = new Date(Date.UTC(year, month, day));

  // 29 Feb -> 1 Mar in a non-leap year: step back to 28 Feb.
  if (candidate.getUTCMonth() !== month) {
    return formatDateOnly(new Date(Date.UTC(year, month, day - 1)));
  }

  return formatDateOnly(candidate);
}

/** The reason a date of birth is refused, or null when it is acceptable. */
export type DateOfBirthProblem = 'invalid' | 'future' | 'too_old';

export function checkDateOfBirth(
  value: string,
  now: Date = new Date(),
): DateOfBirthProblem | null {
  if (!parseDateOnly(value)) {
    return 'invalid';
  }

  // `YYYY-MM-DD` strings compare correctly as strings.
  if (value > latestTodayOnEarth(now)) {
    return 'future';
  }

  if (value < earliestDateOfBirth(now)) {
    return 'too_old';
  }

  return null;
}

/**
 * Whether `value` is an IANA time zone name this runtime knows, as
 * `Intl.DateTimeFormat` accepts it. Accepts `UTC`; refuses an empty string
 * (which `Intl` would read as "the default zone").
 */
export function isValidTimeZone(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
