/**
 * When a measurement was taken, in the words the Health tiles use (issue #53,
 * E2.3): `Today`, `Yesterday`, `N days ago` up to 30 days, then a local date.
 *
 * Counted in LOCAL CALENDAR DAYS, not 24-hour blocks: a weight logged at
 * 23:00 yesterday is "Yesterday" at 07:00 today. A timestamp slightly ahead of
 * the browser's clock (server clock skew) still reads "Today".
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const RELATIVE_LIMIT_DAYS = 30;

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function formatTakenAt(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;

  // `round`, not `floor`: a daylight-saving day is 23 or 25 hours long.
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(then)) / DAY_MS);

  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days <= RELATIVE_LIMIT_DAYS) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** `YYYY-MM-DDTHH:mm` in local time: the value a `datetime-local` input takes. */
export function toDateTimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * A `datetime-local` value → a `Date` in the browser's time zone, or `null`.
 * Parsed by hand: the value has no offset, and the whole point is that it is
 * local wall-clock time.
 */
export function parseDateTimeLocalValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  if (
    date.getFullYear() !== Number(y) ||
    date.getMonth() !== Number(mo) - 1 ||
    date.getDate() !== Number(d)
  ) {
    return null;
  }
  return date;
}

/**
 * `Sep 29`: the short date History uses in accessible names and the delete
 * confirmation (issue #60, E2.5). The reading's instant in the BROWSER's time
 * zone; the profile's zone only defines check-in days.
 */
export function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** `8:00 AM` (locale-dependent), the time part of a History row. */
export function formatShortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** `Sep 29, 2026, 8:00 AM`: a History row's date and time, and the chart tooltip's. */
export function formatDateTime(iso: string | Date): string {
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
