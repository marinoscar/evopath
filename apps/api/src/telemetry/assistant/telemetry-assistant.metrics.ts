import { resolveWindow } from '../dashboard/telemetry-dashboard.service';
import { DASHBOARD_VERDICT_THRESHOLDS, type VerdictInput } from '../dashboard/telemetry-dashboard.verdict';
import type { TelemetryQueryResult } from '../greptime/greptime.client';
import {
  familiesOf,
  METRIC_GROUPS,
  METRIC_TABLES,
  tablesOf,
  tableWith,
  type MetricFamily,
  type MetricGroup,
  type MetricTables,
  type MetricTableSpec,
} from '../metrics/metric-catalog';
import { tableParts, type MetricGroupResult, type MetricGroupWindow, type MetricTable } from '../metrics/metric-group';
import { presentParts } from '../metrics/metric-sql';
import { instantMs, numOrNull, roundForDisplay, rowObjects, strOrNull } from '../metrics/metric-values';
import { VERDICT_FRESH_MS, VERDICT_PROBES, type VerdictProbe } from '../metrics/metric-verdict';
import type { HealthWindow } from './telemetry-assistant.sql';

// =============================================================================
// The telemetry assistant's METRIC tools (issue #128, epic #576)
// =============================================================================
//
// `metrics_overview(group, window)`, `compare_nodes(window)`, the saturation
// section of `health_overview` and `get_app_context.metricFamilies` read the
// metric tables through the DASHBOARD'S OWN catalog and builders
// (`../metrics/*`, docs/specs/telemetry.md §11.14) — no SQL is written here.
// The service runs those statements through `TelemetryQueryService.run`
// (`source: 'assistant'`: guard, row cap, timeout, audit), exactly like the
// other server-built tools; this file only SHAPES what they computed for the
// model. Pure functions.
//
// WHAT THE MODEL SEES. Never raw metric rows: the computed tiles (current and
// previous value, the window's maximum and when it happened), the first rows
// of the group's tables, and which catalog entries were skipped.
//
// SHARING (`telemetry.assistant.shareResults` off). Tile keys, labels and
// units, skipped keys and flags are catalog constants; tile values and table
// cells with a numeric, boolean or timestamp unit are numbers this code
// computed — all shared. A LABEL VALUE THE MONITORED SYSTEM WROTE is not:
// mountpoints, host names, database server and table names, job types, node
// names, URLs, scrape jobs, exporters and error text. A table's key becomes a
// stable ordinal ("Node #1", in the table's own order) so the model can still
// reason about rows; every other text cell is null. Job types are withheld
// too: the application declares them in code, but they are label values like
// any other, and a fork may name them after customers or tenants.
// =============================================================================

/** Rows of one metric table the model sees at most (before the model's own row cap). */
export const METRICS_TABLE_ROWS_TO_MODEL = 20;

/** Items of a list (job types, URLs) the model sees at most. */
export const METRICS_LIST_MAX = 10;

/** A node whose reading is above this multiple of the fleet median is flagged. */
export const NODE_OUTLIER_FACTOR = 2;

/** A node whose state directory has less free space than this (%) is flagged. */
export const NODE_DISK_FREE_MIN_PCT = 10;

/** A node whose heap is above this share of its limit (%) is flagged. */
export const NODE_HEAP_HIGH_PCT = 90;

/** The buckets per window the assistant's metric reads use (the dashboard's coarser setting). */
export const ASSISTANT_METRIC_BUCKETS = '30';

export const METRICS_HIDDEN_NOTE =
  'label values (mountpoints, hosts, table names, job types, node names, URLs, scrape jobs, exporters, error text) ' +
  'are hidden from the assistant by policy: rows are identified by ordinal (e.g. "Node #1") and only computed ' +
  'numbers, booleans and timestamps are shared (other cells are null)';

export interface ShareOptions {
  shareResults: boolean;
  rowsToModel: number;
}

/** One metric table as the model sees it: `fitSections` can drop its rows from the end. */
export interface MetricTableOutput {
  key: string;
  label: string;
  columns: string[];
  rowCount: number;
  truncated: boolean;
  rows: unknown[][];
  note?: string;
}

// ---- windows -------------------------------------------------------------------------

/** The dashboard's window for a health window (they share the ranges), with its previous window. */
export function assistantMetricWindow(window: HealthWindow, now = Date.now()): MetricGroupWindow {
  const resolved = resolveWindow({ range: window, buckets: ASSISTANT_METRIC_BUCKETS }, now);

  return {
    from: resolved.from,
    to: resolved.to,
    previousFrom: resolved.previousFrom,
    bucketSeconds: resolved.bucketSeconds,
  };
}

// ---- get_app_context: which families exist -----------------------------------------------

/** A family's table exists with every column its statement reads. */
export function familyPresent(family: MetricFamily, tables: MetricTables): boolean {
  const columns = [
    ...family.requiredColumns,
    ...(family.groupBy ? [family.groupBy] : []),
    ...(family.where ?? []).map((p) => p.column),
    ...(family.kind === 'histogram' ? ['le'] : []),
  ];

  return tableWith(tables, family.table, columns) !== null;
}

export interface MetricGroupPresence {
  /** Something of the group exists. */
  available: boolean;
  familiesPresent: number;
  familiesTotal: number;
  tablesPresent: number;
  tablesTotal: number;
  /** Catalog keys of the families present (constants, never label values). */
  present: string[];
}

/** Per catalog group: what exists in the store. Counts, booleans and catalog keys only. */
export function metricFamilyPresence(tables: MetricTables): Record<MetricGroup, MetricGroupPresence> {
  return Object.fromEntries(
    METRIC_GROUPS.map((group) => {
      const families = familiesOf(group);
      const present = families.filter((family) => familyPresent(family, tables)).map((family) => family.key);
      const specs = tablesOf(group);
      const tablesPresent = specs.filter((spec) => presentParts(tableParts(spec, tables)).length > 0).length;

      return [
        group,
        {
          available: present.length > 0 || tablesPresent > 0,
          familiesPresent: present.length,
          familiesTotal: families.length,
          tablesPresent,
          tablesTotal: specs.length,
          present,
        },
      ];
    }),
  ) as Record<MetricGroup, MetricGroupPresence>;
}

// ---- tables ------------------------------------------------------------------------------

/** A column the model may see with sharing off: anything but free text (`statusCode` is a number). */
function shareableColumn(table: MetricTable, key: string): boolean {
  if (key === 'key') return false;
  if (key === 'statusCode') return true;
  const column = table.columns.find((c) => c.key === key);

  return !!column && column.unit !== 'text';
}

function isComputedCell(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && /^[-+0-9.eE:TZ ]{1,40}$/.test(value))
  );
}

function boundText(value: unknown, max: number): unknown {
  return typeof value === 'string' && value.length > max ? `${value.slice(0, max)}…` : value;
}

/** The key cell of row `index`: the label value, or an ordinal when label values are hidden. */
function keyCell(table: MetricTable, row: Record<string, unknown>, index: number, share: boolean): string {
  if (share) return String(row.key ?? '');
  const label = table.columns.find((c) => c.key === 'key')?.label ?? 'Row';

  return `${label} #${index + 1}`;
}

/**
 * One computed table (`buildTable`'s rows, in its own order) as the model
 * sees it: at most `METRICS_TABLE_ROWS_TO_MODEL` (and the model's row cap)
 * rows; with sharing off the key is an ordinal and text cells are null.
 */
export function shapeMetricTable(table: MetricTable, opts: ShareOptions, cellMax = 500): MetricTableOutput {
  const cap = Math.max(0, Math.min(METRICS_TABLE_ROWS_TO_MODEL, opts.rowsToModel));
  const columns = table.columns.map((c) => c.key);
  const keep = columns.map((key) => opts.shareResults || shareableColumn(table, key));

  const rows = table.rows.slice(0, cap).map((row, index) =>
    columns.map((key, i) => {
      if (key === 'key') return keyCell(table, row, index, opts.shareResults);
      const cell = row[key] ?? null;
      if (opts.shareResults) return boundText(cell, cellMax);
      return keep[i] && isComputedCell(cell) ? cell : null;
    }),
  );

  const output: MetricTableOutput = {
    key: table.key,
    label: table.label,
    columns,
    rowCount: table.rows.length,
    truncated: table.rows.length > cap,
    rows,
  };

  if (!opts.shareResults) output.note = METRICS_HIDDEN_NOTE;

  return output;
}

// ---- metrics_overview --------------------------------------------------------------------

export interface MetricTileOutput {
  key: string;
  label: string;
  unit: string;
  value: number | string | null;
  previous: number | string | null;
  /** The highest bucket of the current window, and when that bucket started. */
  max: number | null;
  maxAt: string | null;
}

/** A tile without its sparkline, but with the window's peak and when it happened. */
export function shapeTile(
  tile: MetricGroupResult['tiles'][number],
  window: { from: Date; bucketSeconds: number },
): MetricTileOutput {
  const bucketMs = window.bucketSeconds * 1000;
  const start = Math.floor(window.from.getTime() / bucketMs) * bucketMs;
  let max: number | null = null;
  let maxAt: string | null = null;

  tile.sparkline.forEach((value, i) => {
    if (value !== null && (max === null || value > max)) {
      max = value;
      maxAt = new Date(start + i * bucketMs).toISOString();
    }
  });

  return { key: tile.key, label: tile.label, unit: tile.unit, value: tile.value, previous: tile.previous, max, maxAt };
}

/** A computed metric group as the model sees it. */
export function shapeMetricsOverview(
  group: MetricGroup,
  result: MetricGroupResult,
  window: MetricGroupWindow,
  opts: ShareOptions,
): {
  group: MetricGroup;
  available: boolean;
  truncated: boolean;
  bucketSeconds: number;
  tiles: MetricTileOutput[];
  tables: MetricTableOutput[];
  skipped: string[];
} {
  const bucketed = { from: window.from, bucketSeconds: result.bucketSeconds };

  return {
    group,
    available: result.available,
    truncated: result.truncated,
    bucketSeconds: result.bucketSeconds,
    tiles: result.tiles.map((tile) => shapeTile(tile, bucketed)),
    tables: result.tables.map((table) => shapeMetricTable(table, opts)),
    skipped: result.skipped,
  };
}

// ---- compare_nodes -----------------------------------------------------------------------

function catalogTable(key: string): MetricTableSpec {
  const spec = METRIC_TABLES.find((t) => t.key === key);
  if (!spec) throw new Error(`metric catalog has no table ${key}`);
  return spec;
}

/** The node's cumulative counters (`app.nodes.counter`) compare_nodes reads, as reset-aware increases. */
const NODE_COUNTERS = [
  ['leaseRenewFailures', 'Lease renew failures', 'lease_renew_failures'],
  ['watchdogTrips', 'Watchdog trips', 'watchdog_trips'],
  ['heartbeatFailures', 'Heartbeat failures', 'heartbeat_failures'],
  ['claimFailures', 'Claim failures', 'claim_failures'],
  ['jobsSucceeded', 'Jobs succeeded', 'succeeded'],
  ['jobsFailed', 'Jobs failed', 'failed'],
] as const;

export const NODE_COUNTER_TABLE = 'app_nodes_counter';

/**
 * The catalog's per-node vitals table plus the node counters' increases over
 * the window. Not in `METRIC_TABLES`: the dashboard does not show it.
 */
export const NODE_COMPARISON_TABLE: MetricTableSpec = (() => {
  const nodes = catalogTable('nodes');

  return {
    ...nodes,
    key: 'nodeComparison',
    label: 'Node comparison',
    parts: [
      ...nodes.parts,
      ...NODE_COUNTERS.map(([column, label, counter]) => ({
        column,
        label,
        unit: 'count' as const,
        table: NODE_COUNTER_TABLE,
        requiredColumns: ['counter'],
        where: [{ column: 'counter', op: '=' as const, value: counter }],
        seriesAggregate: 'sum' as const,
        over: 'increase' as const,
      })),
    ],
  };
})();

/** Node-offered job types and whether each lacks an eligible node (the catalog's table). */
export const NO_ELIGIBLE_NODE_TABLE: MetricTableSpec = catalogTable('noEligibleNodeTypes');

/** The vitals compared against the fleet median. */
const MEDIAN_COLUMNS = [
  'cpuCores',
  'rssBytes',
  'heapUsedBytes',
  'heapPct',
  'stateDirFreePct',
  'slotsUsed',
  'slotsTotal',
] as const;

/** Flag names (constants: always shared). */
export const NODE_FLAGS = {
  cpuHigh: `cpu_over_${NODE_OUTLIER_FACTOR}x_fleet_median`,
  rssHigh: `rss_over_${NODE_OUTLIER_FACTOR}x_fleet_median`,
  heapHigh: `heap_used_over_${NODE_OUTLIER_FACTOR}x_fleet_median`,
  heapNearLimit: `heap_above_${NODE_HEAP_HIGH_PCT}pct_of_limit`,
  diskLow: `state_dir_free_below_${NODE_DISK_FREE_MIN_PCT}pct`,
  slotsFull: 'slots_full',
  leaseRenewFailures: 'lease_renew_failures',
  watchdogTrips: 'watchdog_trips',
  heartbeatFailures: 'heartbeat_failures',
  claimFailures: 'claim_failures',
  noCurrentVitals: 'no_current_vitals',
} as const;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function numberAt(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The flags one node raises against the fleet medians. */
export function nodeFlags(row: Record<string, unknown>, medians: Record<string, number | null>): string[] {
  const flags: string[] = [];
  const over = (key: string) => {
    const value = numberAt(row, key);
    const m = medians[key];
    return value !== null && m !== null && m !== undefined && m > 0 && value > NODE_OUTLIER_FACTOR * m;
  };
  const positive = (key: string) => (numberAt(row, key) ?? 0) > 0;

  if (over('cpuCores')) flags.push(NODE_FLAGS.cpuHigh);
  if (over('rssBytes')) flags.push(NODE_FLAGS.rssHigh);
  if (over('heapUsedBytes')) flags.push(NODE_FLAGS.heapHigh);
  if ((numberAt(row, 'heapPct') ?? 0) >= NODE_HEAP_HIGH_PCT) flags.push(NODE_FLAGS.heapNearLimit);
  const free = numberAt(row, 'stateDirFreePct');
  if (free !== null && free < NODE_DISK_FREE_MIN_PCT) flags.push(NODE_FLAGS.diskLow);
  const slots = numberAt(row, 'slotsTotal');
  if (slots !== null && slots > 0 && (numberAt(row, 'slotsUsed') ?? 0) >= slots) flags.push(NODE_FLAGS.slotsFull);
  if (positive('leaseRenewFailures')) flags.push(NODE_FLAGS.leaseRenewFailures);
  if (positive('watchdogTrips')) flags.push(NODE_FLAGS.watchdogTrips);
  if (positive('heartbeatFailures')) flags.push(NODE_FLAGS.heartbeatFailures);
  if (positive('claimFailures')) flags.push(NODE_FLAGS.claimFailures);
  if (MEDIAN_COLUMNS.every((key) => numberAt(row, key) === null)) flags.push(NODE_FLAGS.noCurrentVitals);

  return flags;
}

/** Fleet health counts from the verdict's `nodes` probe (fresh readings only). */
export function fleetHealth(result: TelemetryQueryResult | null): Record<'healthy' | 'stale' | 'offline', number> | null {
  const rows = rowObjects(result).filter((r) => r.m === 'health');
  if (rows.length === 0) return null;

  const newest = Math.max(-Infinity, ...rows.map((r) => instantMs(r.at) ?? -Infinity));
  const out = { healthy: 0, stale: 0, offline: 0 };
  for (const r of rows) {
    const at = instantMs(r.at);
    if (at !== null && at < newest - VERDICT_FRESH_MS) continue;
    const k = strOrNull(r.k);
    const v = numOrNull(r.v);
    // Only the known health values become keys: a label value never names an output field.
    if (v !== null && (k === 'healthy' || k === 'stale' || k === 'offline')) out[k] += v;
  }

  return out;
}

/** Job types with due work and no eligible node, from the computed `noEligibleNodeTypes` table. */
export function typesWithoutEligibleNode(
  table: MetricTable | null,
  share: boolean,
): { offered: number; withoutEligibleNode: number; jobTypes: string[] | null } | null {
  if (!table) return null;
  const without = table.rows.filter((row) => row.noEligibleNode === true);

  return {
    offered: table.rows.length,
    withoutEligibleNode: without.length,
    jobTypes: share ? without.slice(0, METRICS_LIST_MAX).map((row) => String(row.key)) : null,
  };
}

/** `compare_nodes`: per-node vitals and counters side by side with the fleet median, and flags. */
export function compareNodesOutput(
  input: {
    nodes: MetricTable | null;
    noEligible: MetricTable | null;
    health: Record<'healthy' | 'stale' | 'offline', number> | null;
  },
  opts: ShareOptions,
): Record<string, unknown> {
  const rows = input.nodes?.rows ?? [];
  const medians = Object.fromEntries(
    MEDIAN_COLUMNS.map((key) => {
      const m = median(rows.map((row) => numberAt(row, key)).filter((v): v is number => v !== null));
      return [key, m === null ? null : roundForDisplay(m)];
    }),
  ) as Record<string, number | null>;

  const flags = rows.map((row) => nodeFlags(row, medians));
  const table: MetricTable | null = input.nodes
    ? {
        ...input.nodes,
        columns: [...input.nodes.columns, { key: 'flags', label: 'Flags', unit: 'text' }],
        rows: rows.map((row) => ({ ...row, flags: null })),
      }
    : null;

  const shaped = table ? shapeMetricTable(table, opts) : null;
  // Flags are constants: shared whatever the policy (filled in after shaping, row by row).
  if (shaped) {
    const at = shaped.columns.indexOf('flags');
    shaped.rows.forEach((row, i) => {
      row[at] = flags[i];
    });
  }

  return {
    fleet: {
      nodes: rows.length,
      health: input.health,
      median: medians,
      nodesWithFlags: flags.filter((list) => list.length > 0).length,
    },
    nodes: shaped ?? { skipped: 'no node metric table exists yet (app.nodes.* gauges)' },
    typesWithoutEligibleNode: typesWithoutEligibleNode(input.noEligible, opts.shareResults) ?? {
      skipped: 'the app_nodes_types_no_eligible_node table does not exist yet',
    },
  };
}

// ---- health_overview: saturation ------------------------------------------------------------

type Level = 'ok' | 'degraded' | 'critical';

function above(value: number, t: { degraded: number; critical: number }): Level {
  return value >= t.critical ? 'critical' : value >= t.degraded ? 'degraded' : 'ok';
}

function round(value: number): number {
  return roundForDisplay(value);
}

/**
 * The saturation section of `health_overview`: the verdict probes' readings
 * (`verdictInputsFrom`), each with a level against the dashboard's own
 * verdict thresholds. A probe whose tables are absent is listed in
 * `skipped`; one that ran but had no fresh reading in `noReading`.
 */
export function saturationOutput(
  inputs: Partial<VerdictInput>,
  ran: Record<VerdictProbe, boolean>,
  share: boolean,
): Record<string, unknown> {
  const t = DASHBOARD_VERDICT_THRESHOLDS;
  const label = (value: string | null | undefined) => (share ? (value ?? null) : null);
  const out: Record<string, unknown> = {};

  if (inputs.disk) {
    out.disk = {
      worstUtilizationPct: round(inputs.disk.utilizationPct),
      level: above(inputs.disk.utilizationPct, t.diskUtilizationPct),
      mountpoint: label(inputs.disk.mountpoint),
    };
  }
  if (inputs.memory) {
    out.memory = {
      worstUtilizationPct: round(inputs.memory.utilizationPct),
      level: above(inputs.memory.utilizationPct, t.memoryUtilizationPct),
      host: label(inputs.memory.host),
    };
  }
  if (inputs.dbConnections) {
    out.dbConnections = {
      utilizationPct: round(inputs.dbConnections.utilizationPct),
      level: above(inputs.dbConnections.utilizationPct, t.dbConnectionsPct),
      instance: label(inputs.dbConnections.instance),
    };
  }
  if (inputs.oldestPendingJob || inputs.backupAgeHours !== undefined) {
    out.queue = {
      ...(inputs.oldestPendingJob
        ? {
            oldestPendingJobSeconds: round(inputs.oldestPendingJob.ageSeconds),
            level: above(inputs.oldestPendingJob.ageSeconds / 60, t.oldestPendingJobMinutes),
            jobType: label(inputs.oldestPendingJob.jobType),
          }
        : {}),
      ...(typeof inputs.backupAgeHours === 'number'
        ? {
            lastBackupHoursAgo: round(inputs.backupAgeHours),
            backupLevel:
              inputs.backupAgeHours > t.backupAgeHours.critical
                ? 'critical'
                : inputs.backupAgeHours > t.backupAgeHours.degraded
                  ? 'degraded'
                  : 'ok',
          }
        : {}),
    };
  }
  if (inputs.nodes) {
    out.nodes = {
      staleNodes: inputs.nodes.stale,
      typesWithoutEligibleNode: inputs.nodes.noEligibleNodeTypes.length,
      jobTypes: share ? inputs.nodes.noEligibleNodeTypes.slice(0, METRICS_LIST_MAX) : null,
    };
  }
  if (inputs.uptimeFailures) {
    out.uptime = {
      failingChecks: inputs.uptimeFailures.length,
      everyCheckFailed: inputs.uptimeFailures.filter((f) => f.allFailed).length,
      urls: share ? inputs.uptimeFailures.slice(0, METRICS_LIST_MAX).map((f) => f.url) : null,
    };
  }
  if (inputs.tls) {
    out.tls = {
      soonestDaysLeft: round(inputs.tls.daysLeft),
      level: inputs.tls.daysLeft < t.tlsDaysLeft.critical ? 'critical' : inputs.tls.daysLeft < t.tlsDaysLeft.degraded ? 'degraded' : 'ok',
      url: label(inputs.tls.url),
    };
  }
  if (inputs.collector) {
    const attempted = inputs.collector.failed + inputs.collector.sent;
    const failedPct = attempted > 0 ? (inputs.collector.failed / attempted) * 100 : 0;
    out.collector = {
      exportFailures: inputs.collector.failed,
      pointsSent: inputs.collector.sent,
      failedPct: round(failedPct),
      level: failedPct >= t.collectorFailedPct.critical ? 'critical' : inputs.collector.failed > 0 ? 'degraded' : 'ok',
      exporter: label(inputs.collector.exporter),
    };
  }

  const read: Record<VerdictProbe, boolean> = {
    host: !!(inputs.disk || inputs.memory),
    database: !!inputs.dbConnections,
    queue: !!(inputs.oldestPendingJob || inputs.backupAgeHours !== undefined),
    nodes: !!inputs.nodes,
    uptime: !!inputs.uptimeFailures,
    tls: !!inputs.tls,
    pipeline: !!inputs.collector,
  };

  out.skipped = VERDICT_PROBES.filter((probe) => !ran[probe]);
  out.noReading = VERDICT_PROBES.filter((probe) => ran[probe] && !read[probe]);
  if (!share) out.note = METRICS_HIDDEN_NOTE;

  return out;
}
