/**
 * The Telemetry Dashboard's URL state — issue #578, epic #576.
 *
 * Everything a reader might want to share or come back to lives in the query
 * string, so a link reproduces the view:
 *
 *   ?range=15m|1h|6h|24h|7d   relative window (default 1h)
 *   &from=…&to=…              absolute window (a zoom); wins over `range`
 *   &service=…&instance=…     filters (values from `/filters`)
 *   &sev=error,warn,info      severities for the log panels (default error,warn)
 *   &q=…                      events search (≤ 200 characters)
 *   &refresh=30|off           auto-refresh (default 30 s)
 *
 * Anything invalid falls back to its default rather than erroring: a mangled
 * link still opens a working dashboard. Defaults are left OUT of the URL, so
 * the plain route is the default view. `range` is kept alongside a zoom so
 * "Reset zoom" returns to the preset the reader zoomed from.
 */
import {
  DASHBOARD_RANGES,
  DASHBOARD_RANGE_MS,
  DASHBOARD_SEARCH_MAX_LENGTH,
  DASHBOARD_SEVERITIES,
  DEFAULT_DASHBOARD_RANGE,
  DEFAULT_DASHBOARD_SEVERITIES,
  type DashboardQuery,
  type DashboardRange,
  type DashboardSeverity,
} from '../../../services/telemetryDashboard';

/** `DASHBOARD_MAX_SPAN_MS` in the API. */
const MAX_SPAN_MS = 30 * 24 * 60 * 60_000;
const FILTER_VALUE_MAX = 200;

export const DASHBOARD_REFRESH_MS = 30_000;

export interface DashboardState {
  range: DashboardRange;
  /** A zoomed window. Both set or both null. */
  from: string | null;
  to: string | null;
  service: string | null;
  instance: string | null;
  sev: DashboardSeverity[];
  q: string;
  refresh: boolean;
}

export const DEFAULT_DASHBOARD_STATE: DashboardState = {
  range: DEFAULT_DASHBOARD_RANGE,
  from: null,
  to: null,
  service: null,
  instance: null,
  sev: [...DEFAULT_DASHBOARD_SEVERITIES],
  q: '',
  refresh: true,
};

function isRange(value: string | null): value is DashboardRange {
  return value !== null && (DASHBOARD_RANGES as readonly string[]).includes(value);
}

function filterValue(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= FILTER_VALUE_MAX ? trimmed : null;
}

/** Severities in canonical order, deduplicated; `null` when none is valid. */
export function parseSeverities(value: string | null): DashboardSeverity[] | null {
  if (!value) return null;
  const wanted = new Set(value.split(',').map((part) => part.trim().toLowerCase()));
  const picked = DASHBOARD_SEVERITIES.filter((severity) => wanted.has(severity));
  return picked.length > 0 ? picked : null;
}

function parseWindow(from: string | null, to: string | null): { from: string; to: string } | null {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (!(start < end) || end - start > MAX_SPAN_MS) return null;
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}

export function parseDashboardState(params: URLSearchParams): DashboardState {
  const range = params.get('range');
  const window = parseWindow(params.get('from'), params.get('to'));
  const q = params.get('q') ?? '';
  return {
    range: isRange(range) ? range : DEFAULT_DASHBOARD_STATE.range,
    from: window?.from ?? null,
    to: window?.to ?? null,
    service: filterValue(params.get('service')),
    instance: filterValue(params.get('instance')),
    sev: parseSeverities(params.get('sev')) ?? [...DEFAULT_DASHBOARD_SEVERITIES],
    q: q.slice(0, DASHBOARD_SEARCH_MAX_LENGTH),
    refresh: params.get('refresh') !== 'off',
  };
}

function sameSeverities(a: DashboardSeverity[], b: DashboardSeverity[]): boolean {
  return a.length === b.length && a.every((severity, index) => severity === b[index]);
}

/** The query string for `state`, defaults omitted. */
export function dashboardStateToParams(state: DashboardState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.range !== DEFAULT_DASHBOARD_STATE.range) params.set('range', state.range);
  if (state.from && state.to) {
    params.set('from', state.from);
    params.set('to', state.to);
  }
  if (state.service) params.set('service', state.service);
  if (state.instance) params.set('instance', state.instance);
  const sev = DASHBOARD_SEVERITIES.filter((severity) => state.sev.includes(severity));
  if (sev.length > 0 && !sameSeverities(sev, DEFAULT_DASHBOARD_SEVERITIES)) {
    params.set('sev', sev.join(','));
  }
  if (state.q) params.set('q', state.q.slice(0, DASHBOARD_SEARCH_MAX_LENGTH));
  if (!state.refresh) params.set('refresh', 'off');
  return params;
}

export function isZoomed(state: DashboardState): boolean {
  return state.from !== null && state.to !== null;
}

/** The window + filter half of the API query, shared by every panel. */
export function dashboardQuery(state: DashboardState): DashboardQuery {
  const query: DashboardQuery = isZoomed(state)
    ? { from: state.from as string, to: state.to as string }
    : { range: state.range };
  if (state.service) query.service = state.service;
  if (state.instance) query.instance = state.instance;
  return query;
}

/**
 * The absolute window covering buckets `startIndex..endIndex` (inclusive, any
 * order) of a series whose buckets start at `starts` and last `bucketSeconds`.
 * `to` is clamped to `now`, since the API refuses a window ending more than a
 * minute ahead. `null` when the selection is empty.
 */
export function bucketWindow(
  starts: string[],
  bucketSeconds: number,
  startIndex: number,
  endIndex: number,
  now: number = Date.now(),
): { from: string; to: string } | null {
  if (starts.length === 0) return null;
  const clamp = (index: number) => Math.min(Math.max(index, 0), starts.length - 1);
  const first = clamp(Math.min(startIndex, endIndex));
  const last = clamp(Math.max(startIndex, endIndex));
  const from = Date.parse(starts[first]);
  const bucketEnd = Date.parse(starts[last]) + bucketSeconds * 1000;
  if (!Number.isFinite(from) || !Number.isFinite(bucketEnd)) return null;
  const to = Math.min(bucketEnd, now);
  if (!(from < to)) return null;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** The window's span in ms — for labels and tick formatting. */
export function windowSpanMs(state: DashboardState): number {
  if (state.from && state.to) return Date.parse(state.to) - Date.parse(state.from);
  return DASHBOARD_RANGE_MS[state.range];
}
