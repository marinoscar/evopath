/**
 * Telemetry Dashboard API client — issue #578, epic #576.
 *
 * The wire shapes mirror `apps/api/src/telemetry/dto/telemetry-dashboard.dto.ts`
 * (#577), which is the source of truth:
 *
 *   - `GET /admin/telemetry/dashboard/summary`     (`telemetry:query`)
 *   - `GET /admin/telemetry/dashboard/timeseries`  (`telemetry:query`, `panel=api|logs`)
 *   - `GET /admin/telemetry/dashboard/top`         (`telemetry:query`, `kind=routes|errors`)
 *   - `GET /admin/telemetry/dashboard/events`      (`telemetry:query`)
 *   - `GET /admin/telemetry/dashboard/filters`     (`telemetry:query`)
 *
 * The browser only presents. The verdict, its reasons, the tiles, what a
 * "route" is and how severities are banded are all decided by the API; the SQL
 * it ran comes back in `sql` so a panel can offer "open in explorer" (#579).
 */
import { api } from './api';

// =============================================================================
// Request
// =============================================================================

export const DASHBOARD_RANGES = ['15m', '1h', '6h', '24h', '7d'] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];
export const DEFAULT_DASHBOARD_RANGE: DashboardRange = '1h';

export const DASHBOARD_RANGE_LABELS: Record<DashboardRange, string> = {
  '15m': 'Last 15 minutes',
  '1h': 'Last hour',
  '6h': 'Last 6 hours',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
};

export const DASHBOARD_RANGE_MS: Record<DashboardRange, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

/** The severities `events` filters on (`EVENT_SEVERITIES` in the API). */
export const DASHBOARD_SEVERITIES = ['error', 'warn', 'info'] as const;
export type DashboardSeverity = (typeof DASHBOARD_SEVERITIES)[number];
export const DEFAULT_DASHBOARD_SEVERITIES: DashboardSeverity[] = ['error', 'warn'];

/** `SEARCH_MAX_LENGTH` in the API. */
export const DASHBOARD_SEARCH_MAX_LENGTH = 200;

export type DashboardBuckets = '30' | '60';

/** The query every endpoint shares. `range` XOR `from` + `to`. */
export interface DashboardQuery {
  range?: DashboardRange;
  from?: string;
  to?: string;
  service?: string;
  instance?: string;
  buckets?: DashboardBuckets;
}

export interface DashboardEventsQuery extends DashboardQuery {
  severity?: DashboardSeverity[];
  q?: string;
  cursor?: string;
}

interface RequestOptions {
  signal?: AbortSignal;
}

// =============================================================================
// Responses
// =============================================================================

export interface DashboardEnvelope {
  range: { from: string; to: string; bucketSeconds: number };
  generatedAt: string;
  truncated: boolean;
  /** The exact statement(s) run, primary first. */
  sql: string | string[];
}

export type DashboardVerdictLevel = 'healthy' | 'degraded' | 'critical' | 'no_data';

/** `unit` is `req/min`, `%`, `ms`, `count`, `bytes` or `timestamp`. */
export interface DashboardTile {
  key: string;
  label: string;
  /** `int8`/`numeric` may arrive as strings; a timestamp tile carries ISO text. */
  value: number | string | null;
  previous: number | string | null;
  unit: string;
  /** One value per bucket; `null` is a gap (nothing measurable). */
  sparkline: (number | null)[];
}

export interface DashboardSummary extends DashboardEnvelope {
  verdict: { level: DashboardVerdictLevel; reasons: string[] };
  tiles: DashboardTile[];
  /** Present only when the runtime metric tables exist. */
  runtime?: DashboardTile[];
}

export interface DashboardApiBucket {
  t: string;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  p95Ms: number | null;
}

export interface DashboardLogsBucket {
  t: string;
  error: number;
  warn: number;
  info: number;
  other: number;
}

export interface DashboardApiTimeseries extends DashboardEnvelope {
  panel: 'api';
  buckets: DashboardApiBucket[];
}

export interface DashboardLogsTimeseries extends DashboardEnvelope {
  panel: 'logs';
  buckets: DashboardLogsBucket[];
}

export type DashboardTimeseriesPanel = 'api' | 'logs';
export type DashboardTimeseries<P extends DashboardTimeseriesPanel> = P extends 'api'
  ? DashboardApiTimeseries
  : DashboardLogsTimeseries;

export interface DashboardTopRoute {
  method: string | null;
  /** The request path with id-like segments normalized to `:id`. */
  route: string | null;
  count: number;
  /** 5xx responses. */
  errors: number;
  errorRatePct: number;
  p95Ms: number | null;
}

export interface DashboardTopError {
  message: string | null;
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
  sampleTraceId: string | null;
  service: string | null;
}

export type DashboardTopKind = 'routes' | 'errors';

export interface DashboardTopRoutes extends DashboardEnvelope {
  kind: 'routes';
  items: DashboardTopRoute[];
}

export interface DashboardTopErrors extends DashboardEnvelope {
  kind: 'errors';
  items: DashboardTopError[];
}

export type DashboardTop<K extends DashboardTopKind> = K extends 'routes'
  ? DashboardTopRoutes
  : DashboardTopErrors;

export interface DashboardEvent {
  /** Full precision (up to nanoseconds), UTC. */
  timestamp: string;
  /** Lower-case severity text (`error`, `warn`, `info`, `debug`, …). */
  severity: string;
  service: string | null;
  body: string | null;
  traceId: string | null;
  spanId: string | null;
}

export interface DashboardEvents extends DashboardEnvelope {
  items: DashboardEvent[];
  nextCursor: string | null;
}

export interface DashboardFilters extends DashboardEnvelope {
  services: string[];
  instances: string[];
}

// =============================================================================
// Calls
// =============================================================================

/** Serialise a dashboard query. Absent values are left out, never sent empty. */
export function dashboardSearchParams(
  query: DashboardQuery & Partial<Pick<DashboardEventsQuery, 'severity' | 'q' | 'cursor'>>,
  extra: Record<string, string> = {},
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  if (query.from && query.to) {
    params.set('from', query.from);
    params.set('to', query.to);
  } else if (query.range) {
    params.set('range', query.range);
  }
  if (query.service) params.set('service', query.service);
  if (query.instance) params.set('instance', query.instance);
  if (query.buckets) params.set('buckets', query.buckets);
  if (query.severity && query.severity.length > 0) params.set('severity', query.severity.join(','));
  if (query.q) params.set('q', query.q);
  if (query.cursor) params.set('cursor', query.cursor);
  return params;
}

const BASE = '/admin/telemetry/dashboard';

export async function getDashboardSummary(
  query: DashboardQuery,
  options: RequestOptions = {},
): Promise<DashboardSummary> {
  return api.get<DashboardSummary>(`${BASE}/summary?${dashboardSearchParams(query)}`, {
    signal: options.signal,
  });
}

export async function getDashboardTimeseries<P extends DashboardTimeseriesPanel>(
  panel: P,
  query: DashboardQuery,
  options: RequestOptions = {},
): Promise<DashboardTimeseries<P>> {
  return api.get<DashboardTimeseries<P>>(
    `${BASE}/timeseries?${dashboardSearchParams(query, { panel })}`,
    { signal: options.signal },
  );
}

export async function getDashboardTop<K extends DashboardTopKind>(
  kind: K,
  query: DashboardQuery,
  options: RequestOptions = {},
): Promise<DashboardTop<K>> {
  return api.get<DashboardTop<K>>(`${BASE}/top?${dashboardSearchParams(query, { kind })}`, {
    signal: options.signal,
  });
}

export async function getDashboardEvents(
  query: DashboardEventsQuery,
  options: RequestOptions = {},
): Promise<DashboardEvents> {
  return api.get<DashboardEvents>(`${BASE}/events?${dashboardSearchParams(query)}`, {
    signal: options.signal,
  });
}

export async function getDashboardFilters(
  query: DashboardQuery,
  options: RequestOptions = {},
): Promise<DashboardFilters> {
  return api.get<DashboardFilters>(`${BASE}/filters?${dashboardSearchParams(query)}`, {
    signal: options.signal,
  });
}

/** `sql` as a list, primary first — what a panel's actions (#579) receive. */
export function sqlList(sql: string | string[] | undefined | null): string[] {
  if (!sql) return [];
  return (Array.isArray(sql) ? sql : [sql]).filter((statement) => statement.trim() !== '');
}
