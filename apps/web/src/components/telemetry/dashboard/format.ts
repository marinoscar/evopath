/**
 * Number, time and change formatting for the Telemetry Dashboard (#578).
 * Pure functions, so the tiles and tables stay presentation-only.
 */

/** A tile value as a number, or `null` (`int8` may arrive as a string). */
export function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

const compact = (n: number, digits = 1) =>
  n.toLocaleString(undefined, { maximumFractionDigits: digits });

export function formatDuration(ms: number): string {
  if (ms >= 1000) return `${compact(ms / 1000, 2)} s`;
  return `${compact(ms, ms < 10 ? 1 : 0)} ms`;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${compact(value, unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** `value` and its unit, split so a tile can style them apart. */
export function formatTileValue(
  value: number | string | null,
  unit: string,
  now: number = Date.now(),
): { value: string; unit: string } {
  if (unit === 'timestamp') {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return { value: '—', unit: '' };
    return { value: formatRelative(value, now), unit: '' };
  }
  const n = toNumber(value);
  if (n === null) return { value: '—', unit: '' };
  switch (unit) {
    case '%':
      return { value: compact(n, 2), unit: '%' };
    case 'ms': {
      const [amount, suffix] = formatDuration(n).split(' ');
      return { value: amount, unit: suffix };
    }
    case 'bytes': {
      const [amount, suffix] = formatBytes(n).split(' ');
      return { value: amount, unit: suffix };
    }
    case 'count':
      return { value: Math.round(n).toLocaleString(), unit: '' };
    default:
      return { value: compact(n, 2), unit };
  }
}

/** "5s ago", "3m ago", "2h ago", "4d ago"; "just now" under a second. */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 1) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** A readable absolute timestamp (local time, to the second). */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  return new Date(then).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** A bucket's x-axis label: time of day, plus the date for multi-day spans. */
export function formatBucketLabel(iso: string, spanMs: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const date = new Date(then);
  if (spanMs > 24 * 60 * 60_000) {
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Which direction is bad for a tile: up for errors and latency, none for
 * traffic (more requests is neither good nor bad on its own).
 */
export type ChangeDirection = 'up-is-bad' | 'down-is-bad' | 'neutral';

const TILE_DIRECTIONS: Record<string, ChangeDirection> = {
  requestsPerMin: 'neutral',
  errorRatePct: 'up-is-bad',
  p95Ms: 'up-is-bad',
  errorLogs: 'up-is-bad',
  warnLogs: 'up-is-bad',
  heapUsedBytes: 'up-is-bad',
  eventLoopDelayP99Ms: 'up-is-bad',
};

export function tileDirection(key: string): ChangeDirection {
  return TILE_DIRECTIONS[key] ?? 'neutral';
}

export interface TileChange {
  /** Percent change, rounded; `null` when there is no comparable previous value. */
  pct: number | null;
  trend: 'up' | 'down' | 'flat';
  /** How to colour it. */
  tone: 'good' | 'bad' | 'neutral';
}

export function tileChange(
  value: number | string | null,
  previous: number | string | null,
  direction: ChangeDirection,
): TileChange {
  const current = toNumber(value);
  const before = toNumber(previous);
  if (current === null || before === null) return { pct: null, trend: 'flat', tone: 'neutral' };
  if (before === 0) {
    if (current === 0) return { pct: 0, trend: 'flat', tone: 'neutral' };
    return { pct: null, trend: 'up', tone: direction === 'up-is-bad' ? 'bad' : direction === 'down-is-bad' ? 'good' : 'neutral' };
  }
  const pct = Math.round(((current - before) / Math.abs(before)) * 1000) / 10;
  if (pct === 0) return { pct: 0, trend: 'flat', tone: 'neutral' };
  const trend = pct > 0 ? 'up' : 'down';
  let tone: TileChange['tone'] = 'neutral';
  if (direction === 'up-is-bad') tone = trend === 'up' ? 'bad' : 'good';
  if (direction === 'down-is-bad') tone = trend === 'down' ? 'bad' : 'good';
  return { pct, trend, tone };
}
