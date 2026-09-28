import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import {
  DASHBOARD_BUCKET_COUNTS,
  DASHBOARD_RANGE_MS,
  DEFAULT_DASHBOARD_RANGE,
  type TelemetryDashboardEvents,
  type TelemetryDashboardEventsQuery,
  type TelemetryDashboardFilters,
  type TelemetryDashboardQuery,
  type TelemetryDashboardSummary,
  type TelemetryDashboardTile,
  type TelemetryDashboardTimeseries,
  type TelemetryDashboardTimeseriesQuery,
  type TelemetryDashboardTop,
  type TelemetryDashboardTopQuery,
} from '../dto/telemetry-dashboard.dto';
import type { TelemetrySchema } from '../dto/telemetry-query.dto';
import { GreptimeClient, type TelemetryQueryResult } from '../greptime/greptime.client';
import { analyzeStatement } from '../query/sql-guard';
import { requireQueryablePolicy, toTelemetryHttpError } from '../query/telemetry-availability';
import { TELEMETRY_ERROR_REASONS, TelemetryHttpError } from '../query/telemetry-query.errors';
import { TelemetrySchemaService } from '../query/telemetry-schema.service';
import { TelemetrySettingsService } from '../telemetry-settings.service';
import {
  apiTimeseriesSql,
  apiTotalsSql,
  bucketSecondsFor,
  DISTINCT_VALUES_MAX,
  distinctInstancesSql,
  distinctServicesSql,
  EVENT_CURSOR_SPAN_PATTERN,
  EVENT_CURSOR_TS_PATTERN,
  EVENT_LOOP_P99_TABLE,
  EVENT_SEVERITIES,
  eventLoopDelayP99Sql,
  EVENTS_PAGE_SIZE,
  eventsSql,
  type DashboardSqlFilters,
  type DashboardSqlWindow,
  type EventSeverity,
  type EventsCursor,
  HEAP_USED_TABLE,
  heapUsedSql,
  isStreamingRoute,
  lastDataSql,
  LOGS_TABLE,
  logsTimeseriesSql,
  logsTotalsSql,
  REQUIRED_LOG_COLUMNS,
  REQUIRED_TRACE_COLUMNS,
  TOP_N,
  topErrorsSql,
  topRoutesSql,
  TRACE_COLUMNS,
  TRACES_TABLE,
} from './telemetry-dashboard.sql';
import { computeVerdict } from './telemetry-dashboard.verdict';

// =============================================================================
// TelemetryDashboardService — the fixed dashboard over the telemetry store
// (issue #577, epic #576)
// =============================================================================
//
// Unlike the explorer, NOTHING here is caller-supplied SQL: every statement is
// a template of `telemetry-dashboard.sql.ts`, filled with validated values.
// The flow of every route:
//
//   1. preconditions (`requireQueryablePolicy`): 503 not configured, 409
//      disabled — checked before the cache, so a disabled store never serves
//      a cached answer;
//   2. the window: `range` (relative to now) or `from`/`to`, bucket size =
//      span/buckets rounded UP to an allowed size; the previous window is the
//      same span ending at `from`;
//   3. the 15-second RESULT CACHE, keyed by route + normalized params (a
//      relative range keys by its name, not its instants), with concurrent
//      identical requests sharing one in-flight promise;
//   4. on a miss: which tables/columns exist (`TelemetrySchemaService`,
//      cached 30 s) so a fresh store degrades to empty panels rather than
//      failing; `service`/`instance` checked against the DISTINCT values seen
//      in the range (cached 60 s) → 400 TELEMETRY_DASHBOARD_BAD_FILTER; then
//      the statements, through the READ-ONLY reader pool with the policy's
//      client-side timeout (summary: all at once, `Promise.all`);
//   5. an audit row per store read (`telemetry:dashboard`), failures too. A
//      cache hit is not audited: nothing was read from the store.
//
// NOT A QUEUE JOB (CLAUDE.md): every statement is bounded by the policy
// timeout and a literal LIMIT, and none outlives the request. No @Cron, no
// @OnEvent, no detached promise; the caches expire lazily on read.
//
// ⚠ Never log `q` beyond 64 characters, and never log rows.
// =============================================================================

export const DASHBOARD_RESULT_CACHE_MS = 15_000;
export const DASHBOARD_DISTINCT_CACHE_MS = 60_000;
/** Entries each cache keeps at most (oldest evicted first). */
export const DASHBOARD_CACHE_MAX_ENTRIES = 500;
/** How far back "latest data" looks. */
export const LAST_DATA_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
/** Runtime metrics are exported every 60 s: a finer bucket would be half empty. */
export const RUNTIME_MIN_BUCKET_SECONDS = 60;
/** How much of `q` an audit row or log line keeps. */
export const DASHBOARD_LOG_Q_MAX = 64;

export const TELEMETRY_DASHBOARD_AUDIT_ACTION = 'telemetry:dashboard';

export type DashboardRoute = 'summary' | 'timeseries' | 'top' | 'events' | 'filters';

/** The window a request resolved to. */
export interface ResolvedWindow extends DashboardSqlWindow {
  previousFrom: Date;
  spanMs: number;
  /** Cache key of the window: the range name, or the absolute instants; plus the bucket count. */
  key: string;
  /** `key` without the bucket count (the distinct-values cache). */
  spanKey: string;
}

type CommonQuery = Pick<TelemetryDashboardQuery, 'range' | 'from' | 'to' | 'buckets'>;

/** The request's window at `now`. The DTO has already refused conflicting or oversized windows. */
export function resolveWindow(query: CommonQuery, now = Date.now()): ResolvedWindow {
  const buckets = Number(query.buckets ?? DASHBOARD_BUCKET_COUNTS[DASHBOARD_BUCKET_COUNTS.length - 1]);
  let from: Date;
  let to: Date;
  let key: string;

  if (query.from && query.to) {
    from = new Date(query.from);
    to = new Date(query.to);
    key = `from=${from.toISOString()}&to=${to.toISOString()}`;
  } else {
    const range = query.range ?? DEFAULT_DASHBOARD_RANGE;
    to = new Date(now);
    from = new Date(now - DASHBOARD_RANGE_MS[range]);
    key = `range=${range}`;
  }

  const spanMs = to.getTime() - from.getTime();

  return {
    from,
    to,
    spanMs,
    previousFrom: new Date(from.getTime() - spanMs),
    bucketSeconds: bucketSecondsFor(spanMs, buckets),
    key: `${key}&buckets=${buckets}`,
    spanKey: key,
  };
}

/** A TTL cache whose concurrent misses for one key share one promise. Failures are not cached. */
export class SharedTtlCache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = DASHBOARD_CACHE_MAX_ENTRIES,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return Promise.resolve(hit.value);
    if (hit) this.entries.delete(key);

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = load()
      .then((value) => {
        this.entries.set(key, { value, at: Date.now() });
        this.evict();
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.entries.clear();
  }

  private evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= this.ttlMs) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }
}

/** What exists in the store, decided from its schema. */
export interface DashboardCatalog {
  traces: boolean;
  tracesHaveInstance: boolean;
  logs: boolean;
  heap: boolean;
  eventLoop: boolean;
}

export function catalogOf(schema: TelemetrySchema): DashboardCatalog {
  const columns = (table: string): Set<string> | null => {
    const found = schema.tables.find((t) => t.name === table);
    return found ? new Set(found.columns.map((c) => c.name)) : null;
  };
  const traces = columns(TRACES_TABLE);
  const logs = columns(LOGS_TABLE);

  return {
    traces: !!traces && REQUIRED_TRACE_COLUMNS.every((c) => traces.has(c)),
    tracesHaveInstance: !!traces && traces.has(TRACE_COLUMNS.instance),
    logs: !!logs && REQUIRED_LOG_COLUMNS.every((c) => logs.has(c)),
    heap: columns(HEAP_USED_TABLE) !== null,
    eventLoop: columns(EVENT_LOOP_P99_TABLE) !== null,
  };
}

// ---- cursor ------------------------------------------------------------------

export function encodeCursor(cursor: EventsCursor): string {
  return Buffer.from(JSON.stringify({ ts: cursor.ts, spanId: cursor.spanId }), 'utf8').toString('base64url');
}

/** Strictly decodes a cursor, or throws 400 TELEMETRY_DASHBOARD_BAD_CURSOR. */
export function decodeCursor(raw: string): EventsCursor {
  const bad = () =>
    new TelemetryHttpError(TELEMETRY_ERROR_REASONS.DASHBOARD_BAD_CURSOR, 'The events cursor is not valid.');

  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw bad();

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad();
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== 'spanId' || keys[1] !== 'ts') throw bad();

  const { ts, spanId } = parsed as Record<string, unknown>;
  if (typeof ts !== 'string' || typeof spanId !== 'string') throw bad();
  if (!EVENT_CURSOR_TS_PATTERN.test(ts) || !EVENT_CURSOR_SPAN_PATTERN.test(spanId)) throw bad();
  if (!Number.isFinite(Date.parse(toIsoText(ts)))) throw bad();

  return { ts, spanId };
}

// ---- value conversion ----------------------------------------------------------

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** ns (number or UInt64 text) → ms rounded to 0.1, or null. */
export function nsToMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n / 1e5) / 10 : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The store's timestamp text (`2026-09-27 22:21:00.000000`, UTC) as ISO with `T` and `Z`, full precision. */
function toIsoText(text: string): string {
  const t = text.replace(' ', 'T');
  return t.endsWith('Z') ? t : `${t}Z`;
}

/** A store timestamp as a Date, or null. */
function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const ms = Date.parse(toIsoText(String(value)));
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function toIso(value: unknown): string | null {
  return toDate(value)?.toISOString() ?? null;
}

function str(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

/** Bucket starts covering `[from, to)`, aligned to the epoch like `date_bin`. */
export function bucketStarts(from: Date, to: Date, bucketSeconds: number): number[] {
  const size = bucketSeconds * 1000;
  const starts: number[] = [];
  for (let t = Math.floor(from.getTime() / size) * size; t < to.getTime(); t += size) starts.push(t);
  return starts;
}

/** Rows keyed by their bucket start (ms), from a column `t`. */
function byBucket(result: TelemetryQueryResult | null): Map<number, unknown[]> {
  const map = new Map<number, unknown[]>();
  if (!result) return map;
  const index = result.fields.findIndex((f) => f.name === 't');
  for (const row of result.rows) {
    const t = toDate(row[index]);
    if (t) map.set(t.getTime(), row);
  }
  return map;
}

function column(result: TelemetryQueryResult | null, name: string): number {
  return result ? result.fields.findIndex((f) => f.name === name) : -1;
}

/** Row objects keyed by field name. */
function objects(result: TelemetryQueryResult | null): Record<string, unknown>[] {
  if (!result) return [];
  return result.rows.map((row) => Object.fromEntries(result.fields.map((f, i) => [f.name, row[i]])));
}

interface PeriodTotals {
  current: Record<string, unknown>;
  previous: Record<string, unknown>;
}

function periods(result: TelemetryQueryResult | null): PeriodTotals {
  const rows = objects(result);
  return {
    current: rows.find((r) => r.period === 'current') ?? {},
    previous: rows.find((r) => r.period === 'previous') ?? {},
  };
}

function severityLabel(severityNumber: unknown, text: unknown): string {
  const label = str(text);
  if (label) return label.toLowerCase();
  const n = num(severityNumber);
  if (n >= 17) return 'error';
  if (n >= 13) return 'warn';
  if (n >= 9) return 'info';
  return 'other';
}

// ---- the service ---------------------------------------------------------------

interface DistinctValues {
  services: string[];
  instances: string[];
  truncated: boolean;
  sql: string[];
  generatedAt: string;
}

/** Collects the statements a request ran, in order, and runs them. */
class StatementRunner {
  readonly sql: string[] = [];

  constructor(
    private readonly greptime: GreptimeClient,
    private readonly timeoutMs: number,
  ) {}

  async run(sql: string): Promise<TelemetryQueryResult> {
    this.sql.push(sql);
    try {
      return await this.greptime.queryReader(sql, { timeoutMs: this.timeoutMs });
    } catch (error) {
      throw toTelemetryHttpError(error);
    }
  }

  /** `run`, or null without running when `sql` is null. */
  maybe(sql: string | null): Promise<TelemetryQueryResult | null> {
    return sql ? this.run(sql) : Promise.resolve(null);
  }
}

@Injectable()
export class TelemetryDashboardService {
  private readonly logger = new Logger(TelemetryDashboardService.name);
  private readonly results = new SharedTtlCache<unknown>(DASHBOARD_RESULT_CACHE_MS);
  private readonly distinct = new SharedTtlCache<DistinctValues>(DASHBOARD_DISTINCT_CACHE_MS);

  constructor(
    private readonly greptime: GreptimeClient,
    private readonly settings: TelemetrySettingsService,
    private readonly schema: TelemetrySchemaService,
    private readonly prisma: PrismaService,
  ) {}

  async summary(userId: string, query: TelemetryDashboardQuery): Promise<TelemetryDashboardSummary> {
    return this.cached(userId, 'summary', query, {}, (ctx) => this.computeSummary(ctx));
  }

  async timeseries(userId: string, query: TelemetryDashboardTimeseriesQuery): Promise<TelemetryDashboardTimeseries> {
    return this.cached(userId, 'timeseries', query, { panel: query.panel }, (ctx) =>
      this.computeTimeseries(ctx, query.panel),
    );
  }

  async top(userId: string, query: TelemetryDashboardTopQuery): Promise<TelemetryDashboardTop> {
    return this.cached(userId, 'top', query, { kind: query.kind }, (ctx) => this.computeTop(ctx, query.kind));
  }

  async events(userId: string, query: TelemetryDashboardEventsQuery): Promise<TelemetryDashboardEvents> {
    // Validated before the cache, so a malformed cursor is a 400 every time.
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const severities = parseSeverities(query.severity);

    return this.cached(
      userId,
      'events',
      query,
      { severity: severities.join(','), q: query.q ?? '', cursor: query.cursor ?? '' },
      (ctx) => this.computeEvents(ctx, severities, query.q ?? null, cursor),
    );
  }

  async filters(userId: string, query: TelemetryDashboardQuery): Promise<TelemetryDashboardFilters> {
    const policy = await requireQueryablePolicy(this.greptime, this.settings);
    const window = resolveWindow(query);
    const timeoutMs = policy.query.timeoutSeconds * 1000;
    const started = Date.now();

    const values = await this.distinct.get(window.spanKey, () =>
      this.audited(userId, 'filters', query, started, () => this.loadDistinct(window, timeoutMs)),
    );

    return {
      range: rangeOf(window),
      generatedAt: values.generatedAt,
      truncated: values.truncated,
      sql: values.sql,
      services: values.services,
      instances: values.instances,
    };
  }

  // ---------------------------------------------------------------------------

  /** Preconditions, window, result cache, audit. */
  private async cached<T extends { sql: string | string[]; truncated: boolean }>(
    userId: string,
    route: DashboardRoute,
    query: CommonQuery & { service?: string; instance?: string },
    extra: Record<string, string>,
    compute: (ctx: ComputeContext) => Promise<T>,
  ): Promise<T> {
    const policy = await requireQueryablePolicy(this.greptime, this.settings);
    const window = resolveWindow(query);
    const key = [
      route,
      window.key,
      `service=${query.service ?? ''}`,
      `instance=${query.instance ?? ''}`,
      ...Object.entries(extra)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`),
    ].join('\u0000');

    const value = await this.results.get(key, () => {
      const started = Date.now();
      return this.audited(userId, route, { ...query, ...extra }, started, async () => {
        const runner = new StatementRunner(this.greptime, policy.query.timeoutSeconds * 1000);
        const catalog = catalogOf(await this.schema.getSchema());
        const filters = await this.validateFilters(window, query, catalog, policy.query.timeoutSeconds * 1000);
        return compute({ window, filters, catalog, runner });
      });
    });

    return value as T;
  }

  /** Runs `work`, then writes the audit row (for a failure too) and logs the outcome. */
  private async audited<T extends { sql: string | string[]; truncated: boolean }>(
    userId: string,
    route: DashboardRoute,
    params: Record<string, unknown>,
    started: number,
    work: () => Promise<T>,
  ): Promise<T> {
    let result: T;
    try {
      result = await work();
    } catch (error) {
      const elapsedMs = Date.now() - started;
      await this.audit(userId, route, params, {
        elapsedMs,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof TelemetryHttpError ? { reason: error.reason } : {}),
      }).catch((auditError: unknown) => {
        this.logger.warn(
          `Could not audit a failed telemetry dashboard read: ${auditError instanceof Error ? auditError.message : String(auditError)}`,
        );
      });
      throw error;
    }

    const elapsedMs = Date.now() - started;
    const statements = Array.isArray(result.sql) ? result.sql.length : 1;
    this.logger.debug(`Telemetry dashboard ${route}: ${statements} statement(s) in ${elapsedMs} ms`);
    await this.audit(userId, route, params, { elapsedMs, statements, truncated: result.truncated });
    return result;
  }

  private async audit(
    userId: string,
    route: DashboardRoute,
    params: Record<string, unknown>,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: TELEMETRY_DASHBOARD_AUDIT_ACTION,
        targetType: 'telemetry_store',
        targetId: this.greptime.database,
        meta: { route, params: auditParams(params), ...meta } as Prisma.InputJsonValue,
      },
    });
  }

  /** `service`/`instance` as SQL filters, or 400 when one was not seen in the range. */
  private async validateFilters(
    window: ResolvedWindow,
    query: { service?: string; instance?: string },
    catalog: DashboardCatalog,
    timeoutMs: number,
  ): Promise<DashboardSqlFilters> {
    const filters: DashboardSqlFilters = { tracesHaveInstance: catalog.tracesHaveInstance };
    if (!query.service && !query.instance) return filters;

    const values = await this.distinct.get(window.spanKey, () =>
      this.loadDistinct(window, timeoutMs, catalog),
    );

    for (const field of ['service', 'instance'] as const) {
      const wanted = query[field];
      if (wanted === undefined) continue;
      const known = field === 'service' ? values.services : values.instances;
      if (!known.includes(wanted)) {
        throw new TelemetryHttpError(
          TELEMETRY_ERROR_REASONS.DASHBOARD_BAD_FILTER,
          `The ${field} is not among those seen in the selected range.`,
          { field },
        );
      }
      filters[field] = wanted;
    }
    return filters;
  }

  private async loadDistinct(
    window: ResolvedWindow,
    timeoutMs: number,
    known?: DashboardCatalog,
  ): Promise<DistinctValues & { truncated: boolean; sql: string[] }> {
    const catalog = known ?? catalogOf(await this.schema.getSchema());
    const runner = new StatementRunner(this.greptime, timeoutMs);
    const tables = { traces: catalog.traces, logs: catalog.logs };

    const [services, instances] = await Promise.all([
      runner.maybe(distinctServicesSql(window.from, window.to, tables)),
      runner.maybe(
        distinctInstancesSql(window.from, window.to, { traces: catalog.tracesHaveInstance, logs: catalog.logs }),
      ),
    ]);

    const list = (result: TelemetryQueryResult | null) =>
      (result?.rows ?? []).map((row) => str(row[0])).filter((v): v is string => v !== null);
    const s = list(services);
    const i = list(instances);

    return {
      services: s.slice(0, DISTINCT_VALUES_MAX),
      instances: i.slice(0, DISTINCT_VALUES_MAX),
      truncated: s.length > DISTINCT_VALUES_MAX || i.length > DISTINCT_VALUES_MAX,
      sql: runner.sql,
      generatedAt: new Date(Date.now()).toISOString(),
    };
  }

  // ---- summary ---------------------------------------------------------------

  private async computeSummary({ window, filters, catalog, runner }: ComputeContext): Promise<TelemetryDashboardSummary> {
    const now = new Date(Date.now());
    const runtimeBucket = Math.max(window.bucketSeconds, RUNTIME_MIN_BUCKET_SECONDS);
    const runtimeService = filters.service ?? null;
    const lastDataSince = new Date(now.getTime() - LAST_DATA_LOOKBACK_MS);

    const [apiTotals, apiSeries, logsTotals, logsSeries, last, routes, errors, heap, eventLoop] = await Promise.all([
      runner.maybe(catalog.traces ? apiTotalsSql(window.previousFrom, window, filters) : null),
      runner.maybe(catalog.traces ? apiTimeseriesSql(window, filters) : null),
      runner.maybe(catalog.logs ? logsTotalsSql(window.previousFrom, window, filters) : null),
      runner.maybe(catalog.logs ? logsTimeseriesSql(window, filters) : null),
      runner.maybe(
        catalog.traces || catalog.logs
          ? lastDataSql(lastDataSince, new Date(now.getTime() + 60_000), filters, {
              traces: catalog.traces,
              logs: catalog.logs,
            })
          : null,
      ),
      runner.maybe(catalog.traces ? topRoutesSql(window, filters) : null),
      runner.maybe(catalog.logs ? topErrorsSql(window, filters, 1) : null),
      runner.maybe(catalog.heap ? heapUsedSql(window.previousFrom, window.to, runtimeBucket, runtimeService) : null),
      runner.maybe(
        catalog.eventLoop ? eventLoopDelayP99Sql(window.previousFrom, window.to, runtimeBucket, runtimeService) : null,
      ),
    ]);

    const api = periods(apiTotals);
    const logs = periods(logsTotals);
    const requests = num(api.current.requests);
    const previousRequests = num(api.previous.requests);
    const errors5xx = num(api.current.errors);
    const previousErrors5xx = num(api.previous.errors);
    const p95Ms = nsToMs(api.current.p95_ns);
    const errorLogs = num(logs.current.error);
    const previousErrorLogs = num(logs.previous.error);

    const lastRow = objects(last)[0] ?? {};
    const lastDates = [toDate(lastRow.traces_last), toDate(lastRow.logs_last)].filter((d): d is Date => d !== null);
    const lastDataAt = lastDates.length ? new Date(Math.max(...lastDates.map((d) => d.getTime()))) : null;

    const routeRows = objects(routes);
    const topErrorRow = routeRows.find((r) => num(r.errors) > 0);
    // Streaming (SSE) routes are never the latency offender: their span is the
    // connection's lifetime (see STREAM_SPAN_PREDICATE).
    const slowest = routeRows.filter((r) => !isStreamingRoute(str(r.route))).reduce<Record<string, unknown> | null>(
      (worst, r) => ((nsToMs(r.p95_ns) ?? -1) > (worst ? nsToMs(worst.p95_ns) ?? -1 : -1) ? r : worst),
      null,
    );
    const routeLabel = (r: Record<string, unknown> | null | undefined) =>
      r ? [str(r.method), str(r.route)].filter(Boolean).join(' ') || null : null;

    const verdict = computeVerdict({
      now,
      lastDataAt,
      requests,
      errors5xx,
      p95Ms,
      errorLogs,
      previousErrorLogs,
      topErrorRoute: routeLabel(topErrorRow),
      slowestRoute: routeLabel(slowest),
      topErrorMessage: str(objects(errors)[0]?.message),
    });

    const starts = bucketStarts(window.from, window.to, window.bucketSeconds);
    const apiBuckets = byBucket(apiSeries);
    const logBuckets = byBucket(logsSeries);
    const at = (result: TelemetryQueryResult | null, name: string) => column(result, name);
    const spanMin = window.spanMs / 60_000;
    const bucketMin = window.bucketSeconds / 60;

    const apiSpark = (pick: (row: unknown[]) => number | null) =>
      starts.map((t) => {
        const row = apiBuckets.get(t);
        return row ? pick(row) : null;
      });
    const totalAt = at(apiSeries, 'total');
    const s5xxAt = at(apiSeries, 's5xx');
    const p95At = at(apiSeries, 'p95_ns');

    const tiles: TelemetryDashboardTile[] = [
      {
        key: 'requestsPerMin',
        label: 'Requests / min',
        value: round2(requests / spanMin),
        previous: round2(previousRequests / spanMin),
        unit: 'req/min',
        sparkline: starts.map((t) => round2(num(apiBuckets.get(t)?.[totalAt]) / bucketMin)),
      },
      {
        key: 'errorRatePct',
        label: '5xx rate',
        value: requests ? round2((errors5xx / requests) * 100) : null,
        previous: previousRequests ? round2((previousErrors5xx / previousRequests) * 100) : null,
        unit: '%',
        sparkline: apiSpark((row) => {
          const total = num(row[totalAt]);
          return total ? round2((num(row[s5xxAt]) / total) * 100) : null;
        }),
      },
      {
        key: 'p95Ms',
        label: 'p95 latency',
        value: p95Ms,
        previous: nsToMs(api.previous.p95_ns),
        unit: 'ms',
        sparkline: apiSpark((row) => nsToMs(row[p95At])),
      },
      {
        key: 'errorLogs',
        label: 'Error logs',
        value: errorLogs,
        previous: previousErrorLogs,
        unit: 'count',
        sparkline: starts.map((t) => num(logBuckets.get(t)?.[at(logsSeries, 'error')])),
      },
      {
        key: 'warnLogs',
        label: 'Warning logs',
        value: num(logs.current.warn),
        previous: num(logs.previous.warn),
        unit: 'count',
        sparkline: starts.map((t) => num(logBuckets.get(t)?.[at(logsSeries, 'warn')])),
      },
      {
        key: 'lastDataAt',
        label: 'Last data',
        value: lastDataAt?.toISOString() ?? null,
        previous: null,
        unit: 'timestamp',
        sparkline: [],
      },
    ];

    const runtime: TelemetryDashboardTile[] = [];
    if (catalog.heap) runtime.push(runtimeTile('heapUsedBytes', 'Heap used', 'bytes', heap, window, runtimeBucket, (v) => Math.round(v)));
    if (catalog.eventLoop) {
      runtime.push(
        runtimeTile('eventLoopDelayP99Ms', 'Event-loop delay p99', 'ms', eventLoop, window, runtimeBucket, (v) => Math.round(v * 10) / 10),
      );
    }

    return {
      range: rangeOf(window),
      generatedAt: now.toISOString(),
      truncated: false,
      sql: runner.sql,
      verdict,
      tiles,
      ...(runtime.length ? { runtime } : {}),
    };
  }

  // ---- timeseries --------------------------------------------------------------

  private async computeTimeseries(
    { window, filters, catalog, runner }: ComputeContext,
    panel: 'api' | 'logs',
  ): Promise<TelemetryDashboardTimeseries> {
    const starts = bucketStarts(window.from, window.to, window.bucketSeconds);
    const envelope = (sql: string[]) => ({
      range: rangeOf(window),
      generatedAt: new Date(Date.now()).toISOString(),
      truncated: false,
      sql: sql[0] ?? '',
    });

    if (panel === 'api') {
      const result = await runner.maybe(catalog.traces ? apiTimeseriesSql(window, filters) : null);
      const rows = byBucket(result);
      const i = (name: string) => column(result, name);
      return {
        ...envelope(runner.sql),
        panel,
        buckets: starts.map((t) => {
          const row = rows.get(t);
          return {
            t: new Date(t).toISOString(),
            s2xx: num(row?.[i('s2xx')]),
            s3xx: num(row?.[i('s3xx')]),
            s4xx: num(row?.[i('s4xx')]),
            s5xx: num(row?.[i('s5xx')]),
            p95Ms: row ? nsToMs(row[i('p95_ns')]) : null,
          };
        }),
      };
    }

    const result = await runner.maybe(catalog.logs ? logsTimeseriesSql(window, filters) : null);
    const rows = byBucket(result);
    const i = (name: string) => column(result, name);
    return {
      ...envelope(runner.sql),
      panel,
      buckets: starts.map((t) => {
        const row = rows.get(t);
        return {
          t: new Date(t).toISOString(),
          error: num(row?.[i('error')]),
          warn: num(row?.[i('warn')]),
          info: num(row?.[i('info')]),
          other: num(row?.[i('other')]),
        };
      }),
    };
  }

  // ---- top ---------------------------------------------------------------------

  private async computeTop(
    { window, filters, catalog, runner }: ComputeContext,
    kind: 'routes' | 'errors',
  ): Promise<TelemetryDashboardTop> {
    const base = () => ({ range: rangeOf(window), generatedAt: new Date(Date.now()).toISOString(), sql: runner.sql[0] ?? '' });

    if (kind === 'routes') {
      const rows = objects(await runner.maybe(catalog.traces ? topRoutesSql(window, filters) : null));
      return {
        ...base(),
        truncated: rows.length > TOP_N,
        kind,
        items: rows.slice(0, TOP_N).map((r) => {
          const count = num(r.requests);
          const errors = num(r.errors);
          return {
            method: str(r.method),
            route: str(r.route),
            count,
            errors,
            errorRatePct: count ? round2((errors / count) * 100) : 0,
            p95Ms: nsToMs(r.p95_ns),
          };
        }),
      };
    }

    const rows = objects(await runner.maybe(catalog.logs ? topErrorsSql(window, filters) : null));
    return {
      ...base(),
      truncated: rows.length > TOP_N,
      kind,
      items: rows.slice(0, TOP_N).map((r) => ({
        message: str(r.message),
        count: num(r.occurrences),
        firstSeen: toIso(r.first_seen),
        lastSeen: toIso(r.last_seen),
        sampleTraceId: str(r.sample_trace_id),
        service: str(r.service),
      })),
    };
  }

  // ---- events ------------------------------------------------------------------

  private async computeEvents(
    { window, filters, catalog, runner }: ComputeContext,
    severities: EventSeverity[],
    q: string | null,
    cursor: EventsCursor | null,
  ): Promise<TelemetryDashboardEvents> {
    const envelope = { range: rangeOf(window), generatedAt: new Date(Date.now()).toISOString(), truncated: false };

    if (!catalog.logs) {
      return { ...envelope, sql: '', items: [], nextCursor: null };
    }

    const sql = eventsSql(window, filters, { severities, q, cursor, limit: EVENTS_PAGE_SIZE + 1 });

    // Defence in depth: the statement is server-authored, but it carries user
    // text, so it must still be exactly one read-only statement.
    try {
      analyzeStatement(sql);
    } catch (error) {
      throw toTelemetryHttpError(error);
    }

    const rows = objects(await runner.run(sql));
    const keyOf = (r: Record<string, unknown>) => `${String(r.ts)}\u0000${String(r.span_id ?? '')}`;

    let page = rows.slice(0, EVENTS_PAGE_SIZE);
    const more = rows.length > EVENTS_PAGE_SIZE;
    if (more) {
      // Keyset pagination is strict on (timestamp, span_id): rows sharing the
      // boundary key with the first row of the NEXT page would be skipped, so
      // the page ends before them (unless the whole page shares one key).
      const boundary = keyOf(rows[EVENTS_PAGE_SIZE]);
      let end = EVENTS_PAGE_SIZE;
      while (end > 0 && keyOf(rows[end - 1]) === boundary) end--;
      if (end > 0) page = rows.slice(0, end);
    }

    const last = page[page.length - 1];
    return {
      ...envelope,
      sql,
      items: page.map((r) => ({
        timestamp: toIsoText(String(r.ts)),
        severity: severityLabel(r.severity_number, r.severity_text),
        service: str(r.service),
        body: r.body === null || r.body === undefined ? null : String(r.body),
        traceId: str(r.trace_id),
        spanId: str(r.span_id),
      })),
      nextCursor: more && last ? encodeCursor({ ts: String(last.ts), spanId: String(last.span_id ?? '') }) : null,
    };
  }
}

interface ComputeContext {
  window: ResolvedWindow;
  filters: DashboardSqlFilters;
  catalog: DashboardCatalog;
  runner: StatementRunner;
}

function rangeOf(window: ResolvedWindow) {
  return { from: window.from.toISOString(), to: window.to.toISOString(), bucketSeconds: window.bucketSeconds };
}

export function parseSeverities(raw: string | undefined): EventSeverity[] {
  if (!raw) return ['error', 'warn'];
  const wanted = new Set(raw.split(','));
  return EVENT_SEVERITIES.filter((s) => wanted.has(s));
}

/**
 * Request parameters as an audit row keeps them: control characters removed
 * (PostgreSQL's jsonb refuses `\u0000`), `q` cut to 64 characters, the cursor
 * only as present.
 */
export function auditParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    // eslint-disable-next-line no-control-regex
    const text = String(value).replace(/[\u0000-\u001f\u007f]/g, '');
    if (key === 'q') out.q = text.slice(0, DASHBOARD_LOG_Q_MAX);
    else if (key === 'cursor') out.cursor = true;
    else out[key] = text;
  }
  return out;
}

function runtimeTile(
  key: string,
  label: string,
  unit: string,
  result: TelemetryQueryResult | null,
  window: ResolvedWindow,
  bucketSeconds: number,
  round: (v: number) => number,
): TelemetryDashboardTile {
  const rows = byBucket(result);
  const vAt = column(result, 'v');
  const value = (row: unknown[] | undefined) => {
    if (!row) return null;
    const v = row[vAt];
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? round(n) : null;
  };

  const sparkline = bucketStarts(window.from, window.to, bucketSeconds).map((t) => value(rows.get(t)));
  const lastOf = (list: (number | null)[]) => [...list].reverse().find((v) => v !== null) ?? null;
  const fromMs = window.from.getTime();
  const previous = [...rows.entries()]
    .filter(([t]) => t < fromMs)
    .sort(([a], [b]) => a - b)
    .map(([, row]) => value(row));

  return { key, label, value: lastOf(sparkline), previous: lastOf(previous), unit, sparkline };
}
