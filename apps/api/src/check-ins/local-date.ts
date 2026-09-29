// =============================================================================
// Calendar days in the user's time zone (E2.4, #56)
// =============================================================================
//
// A check-in belongs to a LOCAL calendar day, decided by the server from the
// time zone stored on the health profile (UTC when unset). Days are handled as
// `YYYY-MM-DD` strings throughout; the only `Date` values here are either a
// real instant (`localDateInZone`'s input) or the UTC-midnight value Prisma
// uses for a `@db.Date` column (`toDbDate` / `fromDbDate`).
//
// Pure functions, no Nest or Prisma imports.
// =============================================================================

export const DEFAULT_TIME_ZONE = 'UTC';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(timeZone);
  if (cached) return cached;

  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, formatter);
    return formatter;
  } catch {
    // RangeError: not an IANA zone this runtime knows.
    return null;
  }
}

/**
 * The calendar day `instant` falls on in `timeZone`, as `YYYY-MM-DD`. A null,
 * empty or unknown zone falls back to UTC.
 */
export function localDateInZone(instant: Date, timeZone: string | null | undefined): string {
  const formatter = (timeZone && formatterFor(timeZone)) || formatterFor(DEFAULT_TIME_ZONE)!;
  const parts = formatter.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';

  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** True for a `YYYY-MM-DD` string naming a real calendar day (no 2026-02-30). */
export function isRealDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;

  const [, year, month, day] = match.map(Number);
  // Date.UTC maps years 0-99 onto 1900-1999; no check-in predates 1000 anyway.
  if (year < 1000) return false;
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function assertRealDate(value: string): void {
  if (!isRealDate(value)) {
    throw new RangeError('Expected a real calendar date in YYYY-MM-DD format');
  }
}

/** `dateStr` shifted by `n` calendar days (negative goes back). */
export function addDays(dateStr: string, n: number): string {
  assertRealDate(dateStr);
  return new Date(toDbDate(dateStr).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * True when `dateStr` is `todayStr` or at most `maxBackDays` calendar days
 * before it. Never true for a day after `todayStr`.
 */
export function isWithinWindow(dateStr: string, todayStr: string, maxBackDays = 7): boolean {
  if (!isRealDate(dateStr) || !isRealDate(todayStr)) return false;
  // `YYYY-MM-DD` strings compare correctly as strings.
  return dateStr <= todayStr && dateStr >= addDays(todayStr, -maxBackDays);
}

/** The value Prisma reads and writes for a `@db.Date` column: UTC midnight. */
export function toDbDate(dateStr: string): Date {
  assertRealDate(dateStr);
  return new Date(`${dateStr}T00:00:00.000Z`);
}

/** Inverse of {@link toDbDate}. */
export function fromDbDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
