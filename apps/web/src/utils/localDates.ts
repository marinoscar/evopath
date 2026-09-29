/**
 * Formatting for date-only `YYYY-MM-DD` values (issue #56, E2.4): a check-in's
 * day is the user's LOCAL calendar day as the server computed it, not an
 * instant. It is formatted as a calendar date in UTC so no browser time zone
 * can move it to the day before or after.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function toUtcDate(value: string): Date | null {
  const match = DATE_ONLY.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Tuesday, September 29" (the year only when it is not `referenceYear`). */
export function formatLongDate(value: string, referenceYear?: number): string {
  const date = toUtcDate(value);
  if (!date) return value;
  const sameYear = referenceYear === undefined || date.getUTCFullYear() === referenceYear;
  return date.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * "Today", "Yesterday", or "Mon, Sep 28", relative to `today` (also a
 * `YYYY-MM-DD` from the server). Without `today`, always the short date.
 */
export function formatDayLabel(value: string, today?: string | null): string {
  const date = toUtcDate(value);
  if (!date) return value;
  const reference = today ? toUtcDate(today) : null;
  if (reference) {
    const diff = Math.round((reference.getTime() - date.getTime()) / DAY_MS);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
  }
  return date.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(reference && reference.getUTCFullYear() !== date.getUTCFullYear() ? { year: 'numeric' } : {}),
  });
}
