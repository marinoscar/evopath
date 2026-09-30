import type { VerdictInput } from '../dashboard/telemetry-dashboard.verdict';
import type { TelemetryQueryResult } from '../greptime/greptime.client';
import {
  HOST_TABLES,
  HTTPCHECK_STATUS_TABLE,
  type MetricFilterKey,
  type MetricTables,
} from './metric-catalog';
import {
  latestByKeySql,
  METRIC_PROBE_MAX_KEYS,
  uptimeStatusSql,
  type LatestPart,
} from './metric-sql';
import { instantMs, numOrNull, rowObjects, strOrNull } from './metric-values';

// =============================================================================
// Verdict probes: the infrastructure inputs of the summary verdict (issue #126)
// =============================================================================
//
// The summary's verdict (`computeVerdict`) gains infrastructure rules. Their
// inputs are gathered here with ONE SMALL STATEMENT PER RULE FAMILY, run
// inside the summary's existing `Promise.all` and result cache:
//
//   host      worst filesystem utilization (per mountpoint), worst memory
//   database  latest backends and max_connections per server
//   queue     oldest pending age per job type, last backup instant
//   nodes     node count per health, "no eligible node" per job type
//   uptime    per URL: latest check passed? every check failed?
//   tls       certificate seconds left per URL
//   pipeline  exporter points failed and sent over the window
//
// A statement whose tables are all absent is null (not run); a rule whose
// input is absent is skipped by the verdict. Gauges are read over the last
// `VERDICT_PROBE_LOOKBACK_MS` before `to` and only their FRESH keys count (a
// key whose newest reading is more than `VERDICT_FRESH_MS` older than the
// newest reading of its part has stopped reporting, e.g. a drained job type
// under delta temporality). The pipeline counters use the dashboard window.
// Request filters (service/instance) do not apply: infrastructure is shared.
// =============================================================================

/** How far before `to` the gauge probes look. */
export const VERDICT_PROBE_LOOKBACK_MS = 10 * 60_000;
/** A key older than its part's newest reading by more than this is not current. */
export const VERDICT_FRESH_MS = 150_000;

export const VERDICT_PROBES = [
  'host',
  'database',
  'queue',
  'nodes',
  'uptime',
  'tls',
  'pipeline',
] as const;
export type VerdictProbe = (typeof VERDICT_PROBES)[number];

const NO_FILTERS: readonly MetricFilterKey[] = [];

function part(
  tables: MetricTables,
  name: string,
  table: string,
  keyColumn: string | null,
  rest: Partial<LatestPart> & Pick<LatestPart, 'seriesAggregate' | 'over'>
): LatestPart {
  return { name, table, info: tables.get(table) ?? null, keyColumn, filters: NO_FILTERS, ...rest };
}

/** The probe statements for a window; null where no table of the probe exists. */
export function verdictProbeSql(
  tables: MetricTables,
  window: { from: Date; to: Date }
): Record<VerdictProbe, string | null> {
  const recentFrom = new Date(Math.max(window.to.getTime() - VERDICT_PROBE_LOOKBACK_MS, 0));
  const latest = (parts: LatestPart[], from = recentFrom) =>
    latestByKeySql(parts, from, window.to, {}, { maxKeys: METRIC_PROBE_MAX_KEYS, order: 'part' });

  return {
    host: latest([
      part(tables, 'disk', HOST_TABLES.filesystemUtilization, 'mountpoint', {
        seriesAggregate: 'max',
        over: 'last',
      }),
      part(tables, 'memory', HOST_TABLES.memoryUtilization, 'host_name', {
        where: [{ column: 'state', op: '=', value: 'used' }],
        seriesAggregate: 'max',
        over: 'last',
      }),
    ]),
    database: latest([
      part(tables, 'backends', 'postgresql_backends', 'instance', {
        seriesAggregate: 'sum',
        over: 'last',
      }),
      part(tables, 'max', 'postgresql_connection_max', 'instance', {
        seriesAggregate: 'max',
        over: 'last',
      }),
    ]),
    queue: latest([
      part(tables, 'oldest', 'app_jobs_oldest_pending_age_seconds', 'job_type', {
        seriesAggregate: 'max',
        over: 'last',
      }),
      part(tables, 'backup', 'app_backup_last_success_timestamp_seconds', null, {
        seriesAggregate: 'max',
        over: 'max',
      }),
    ]),
    nodes: latest([
      part(tables, 'health', 'app_nodes_count', 'health', { seriesAggregate: 'sum', over: 'last' }),
      part(tables, 'noEligible', 'app_nodes_types_no_eligible_node', 'job_type', {
        seriesAggregate: 'max',
        over: 'last',
      }),
    ]),
    uptime: uptimeStatusSql(
      tables.get(HTTPCHECK_STATUS_TABLE) ?? null,
      recentFrom,
      window.to,
      {},
      NO_FILTERS,
      METRIC_PROBE_MAX_KEYS
    ),
    tls: latest([
      part(tables, 'tls', 'httpcheck_tls_cert_remaining_seconds', 'http_url', {
        seriesAggregate: 'min',
        over: 'last',
      }),
    ]),
    pipeline: latest(
      [
        part(tables, 'failed', 'otelcol_exporter_send_failed_metric_points_total', 'exporter', {
          seriesAggregate: 'sum',
          over: 'increase',
        }),
        part(tables, 'sent', 'otelcol_exporter_sent_metric_points_total', 'exporter', {
          seriesAggregate: 'sum',
          over: 'increase',
        }),
      ],
      window.from
    ),
  };
}

interface Reading {
  k: string;
  v: number;
  at: number | null;
}

/** Rows of a latest-per-key probe by part, keeping only fresh keys of `last`-style parts. */
function readings(result: TelemetryQueryResult | null, fresh: boolean): Map<string, Reading[]> {
  const byPart = new Map<string, Reading[]>();
  for (const r of rowObjects(result)) {
    const v = numOrNull(r.v);
    if (v === null) continue;
    const m = String(r.m);
    if (!byPart.has(m)) byPart.set(m, []);
    byPart.get(m)!.push({ k: strOrNull(r.k) ?? '', v, at: instantMs(r.at) });
  }
  if (!fresh) return byPart;
  for (const [m, list] of byPart) {
    const newest = Math.max(-Infinity, ...list.map((x) => x.at ?? -Infinity));
    byPart.set(
      m,
      list.filter((x) => x.at === null || x.at >= newest - VERDICT_FRESH_MS)
    );
  }
  return byPart;
}

function worst(list: Reading[] | undefined, pick: 'max' | 'min' = 'max'): Reading | null {
  if (!list || list.length === 0) return null;
  return list.reduce((a, b) => (pick === 'max' ? (b.v > a.v ? b : a) : b.v < a.v ? b : a));
}

/**
 * The verdict's infrastructure inputs from the probe results. A probe that
 * did not run, or returned no fresh rows, leaves its input undefined.
 */
export function verdictInputsFrom(
  results: Partial<Record<VerdictProbe, TelemetryQueryResult | null>>,
  now: Date
): Partial<VerdictInput> {
  const input: Partial<VerdictInput> = {};

  if (results.host) {
    const host = readings(results.host, true);
    const disk = worst(host.get('disk'));
    if (disk) input.disk = { utilizationPct: disk.v * 100, mountpoint: disk.k || null };
    const memory = worst(host.get('memory'));
    if (memory) input.memory = { utilizationPct: memory.v * 100, host: memory.k || null };
  }

  if (results.database) {
    const db = readings(results.database, true);
    const max = new Map((db.get('max') ?? []).map((r) => [r.k, r.v]));
    const ratios = (db.get('backends') ?? [])
      .filter((r) => (max.get(r.k) ?? 0) > 0)
      .map((r) => ({ ...r, v: (r.v / max.get(r.k)!) * 100 }));
    const top = worst(ratios);
    if (top) input.dbConnections = { utilizationPct: top.v, instance: top.k || null };
  }

  if (results.queue) {
    const queue = readings(results.queue, true);
    const oldest = worst(queue.get('oldest'));
    if (oldest) input.oldestPendingJob = { ageSeconds: oldest.v, jobType: oldest.k || null };
    const backup = worst(queue.get('backup'));
    if (backup && backup.v > 0)
      input.backupAgeHours = Math.max(0, (now.getTime() / 1000 - backup.v) / 3600);
  }

  if (results.nodes) {
    const nodes = readings(results.nodes, true);
    const health = nodes.get('health');
    const noEligible = nodes.get('noEligible');
    if (health || noEligible) {
      input.nodes = {
        stale: (health ?? []).filter((r) => r.k === 'stale').reduce((a, r) => a + r.v, 0),
        noEligibleNodeTypes: (noEligible ?? []).filter((r) => r.v >= 1).map((r) => r.k),
      };
    }
  }

  if (results.uptime) {
    const rows = rowObjects(results.uptime);
    const newest = Math.max(-Infinity, ...rows.map((r) => instantMs(r.last_at) ?? -Infinity));
    const failures = rows
      .filter((r) => {
        const lastAt = instantMs(r.last_at);
        return lastAt !== null && lastAt >= newest - VERDICT_FRESH_MS && numOrNull(r.ok_now) !== 1;
      })
      .map((r) => ({
        url: strOrNull(r.k) ?? '',
        checks: numOrNull(r.checks) ?? 0,
        allFailed: (numOrNull(r.ok_checks) ?? 0) === 0,
      }));
    if (rows.length > 0) input.uptimeFailures = failures;
  }

  if (results.tls) {
    const soonest = worst(readings(results.tls, true).get('tls'), 'min');
    if (soonest) input.tls = { daysLeft: soonest.v / 86_400, url: soonest.k || null };
  }

  if (results.pipeline) {
    const pipeline = readings(results.pipeline, false);
    const failed = pipeline.get('failed') ?? [];
    const sent = pipeline.get('sent') ?? [];
    if (failed.length || sent.length) {
      const top = worst(failed);
      input.collector = {
        failed: failed.reduce((a, r) => a + r.v, 0),
        sent: sent.reduce((a, r) => a + r.v, 0),
        exporter: top && top.v > 0 ? top.k || null : null,
      };
    }
  }

  return input;
}
