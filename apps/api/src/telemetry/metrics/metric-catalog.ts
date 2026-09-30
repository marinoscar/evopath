import type { TelemetrySchema } from '../dto/telemetry-query.dto';
import { DASHBOARD_VERDICT_THRESHOLDS } from '../dashboard/telemetry-dashboard.verdict';

// =============================================================================
// The metric catalog (issue #126, epic #576)
// =============================================================================
//
// A DECLARATIVE list of the metric families the Telemetry Dashboard reads from
// the Prometheus-style metric tables the collector and the API write
// (docs/specs/telemetry.md §11.3 and §11.13), grouped into six groups:
//
//   host      hostmetrics: CPU, memory, load, filesystems, disk and network IO
//   database  the postgresql receiver: connections, size, commits, cache hits
//   queue     app.jobs.* and app.backup.*: depth, age, settle rate, duration
//   nodes     app.nodes.*: fleet health and per-node vitals
//   uptime    httpcheck and nginx: status per URL, latency, TLS, edge traffic
//   pipeline  the collector's and GreptimeDB's own counters, and `up`
//
// Nothing here runs SQL: `metric-sql.ts` renders a family into a statement,
// and `metric-group.ts` turns the rows into tiles, series and tables. A family
// whose table, or one of whose `requiredColumns`, is absent from the store is
// SKIPPED (reported in `skipped`), never an error: every table appears only
// once its source has written a row.
//
// Every metric table has `greptime_timestamp` (time index) and
// `greptime_value` (Float64); every other column is a String tag, and a
// series is one combination of tag values. Semantics:
//
//   gauge      a level. Per timestamp the rows are combined across series
//              (`seriesAggregate`: sum for "how many", max for "the worst"),
//              then per bucket (`bucketAggregate`).
//   counter    cumulative (`_total`). The increase between consecutive points
//              of ONE series (`lag` over every tag column) is summed; a drop
//              is a reset and counts the new value (Prometheus semantics); the
//              first point of a series in the window has no predecessor and
//              contributes nothing (conservative: never an invented spike).
//   histogram  cumulative `_bucket` counters with a string `le` tag; the
//              quantile is interpolated from the increases per `le`.
//
// API gauges are reported identically by every replica (docs §11.13), so
// they are never summed across replicas on purpose; replicas export at
// different instants, so per-timestamp rows rarely mix two replicas.
// =============================================================================

export const METRIC_GROUPS = ['host', 'database', 'queue', 'nodes', 'uptime', 'pipeline'] as const;
export type MetricGroup = (typeof METRIC_GROUPS)[number];

export const METRIC_GROUP_LABELS: Record<MetricGroup, string> = {
  host: 'Host',
  database: 'Database',
  queue: 'Job queue',
  nodes: 'Worker nodes',
  uptime: 'Uptime and edge',
  pipeline: 'Telemetry pipeline',
};

/** Display units of tiles, series and table columns. */
export const METRIC_UNITS = [
  '%',
  'bytes',
  'bytes/s',
  'count',
  'per_s',
  'per_min',
  'ms',
  'seconds',
  'hours',
  'days',
  'cores',
  'load',
  'timestamp',
  'text',
  'boolean',
] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

/** The request filters a family may honour, and the column each one matches. */
export type MetricFilterKey = 'service' | 'instance' | 'host';
export const METRIC_FILTER_COLUMNS: Record<MetricFilterKey, string> = {
  service: 'service_name',
  instance: 'app_instance_id',
  host: 'host_name',
};

/** API tables (`app_*`): the service and the instance id. Their `host_name` is the API container, not a host. */
const APP_FILTERS: readonly MetricFilterKey[] = ['service', 'instance'];
/** Tables the collector scraped itself: `host_name` is the real host. */
const HOST_FILTERS: readonly MetricFilterKey[] = ['host'];

export const METRIC_TIME_COLUMN = 'greptime_timestamp';
export const METRIC_VALUE_COLUMN = 'greptime_value';

/** A fixed label predicate. Values are catalog constants, never request input. */
export interface MetricPredicate {
  column: string;
  op: '=' | '<>';
  value: string;
}

export type SeriesAggregate = 'sum' | 'max' | 'min' | 'avg';
export type BucketAggregate = 'avg' | 'max' | 'min';
/** How a family's groups combine into one tile. */
export type TileAggregate = 'sum' | 'max' | 'min' | 'countPositive' | 'countZero';

export interface MetricVerdictThresholds {
  degraded: number;
  critical: number;
  /** `above`: value >= threshold fires; `below`: value < threshold fires. */
  direction: 'above' | 'below';
}

interface MetricFamilyBase {
  key: string;
  group: MetricGroup;
  label: string;
  table: string;
  unit: MetricUnit;
  /** Tag columns the family reads, beyond the time and value columns. Absent → skipped. */
  requiredColumns: readonly string[];
  /** Fixed label predicates. */
  where?: readonly MetricPredicate[];
  /** The label column series are split by (one series per value). */
  groupBy?: string;
  /** Which request filters apply. */
  filters: readonly MetricFilterKey[];
  /** How groups combine into the tile (default: `sum`). */
  tileAggregate?: TileAggregate;
  /** One tile per listed group value instead of one combined tile. */
  tileGroups?: readonly string[];
  /** Emit a tile (default true). */
  tile?: boolean;
  /** Emit series (default true). */
  series?: boolean;
  /** The verdict thresholds the summary applies to this family (documentary; the rule lives in the verdict). */
  verdict?: MetricVerdictThresholds;
}

export interface GaugeFamily extends MetricFamilyBase {
  kind: 'gauge';
  /** Per-row value expression (fixed SQL over `greptime_value`); default the value itself. */
  valueSql?: string;
  seriesAggregate: SeriesAggregate;
  bucketAggregate: BucketAggregate;
  /** Display multiplier (ratio → %: 100). */
  scale?: number;
  /** `ageHours`: the value is a Unix-seconds instant, shown as hours before the bucket end (or now). */
  transform?: 'ageHours';
}

export interface CounterFamily extends MetricFamilyBase {
  kind: 'counter';
  /** `per_s` / `per_min`: increase over time; `count`: the increase itself. */
  rate: 'per_s' | 'per_min' | 'count';
  /** Display multiplier applied after the rate. */
  scale?: number;
}

export interface HistogramFamily extends MetricFamilyBase {
  kind: 'histogram';
  /** The quantile shown, e.g. 0.95. */
  quantile: number;
  /** Display multiplier (s → ms: 1000). */
  scale?: number;
}

export type MetricFamily = GaugeFamily | CounterFamily | HistogramFamily;

/** A reference to (some groups of) a family, for ratios. */
export interface MetricRef {
  family: string;
  /** Only these group values (default: every group). */
  groups?: readonly string[];
}

/** A family derived from others: `sum(numerator) / sum(denominator) * scale`, bucket by bucket. */
export interface MetricRatio {
  key: string;
  group: MetricGroup;
  label: string;
  unit: MetricUnit;
  numerator: readonly MetricRef[];
  /** The denominator; `numerator` is added to it when `addNumerator` (hit / (hit + read)). */
  denominator: readonly MetricRef[];
  addNumerator?: boolean;
  scale: number;
  verdict?: MetricVerdictThresholds;
}

/** One column of a per-key table, read as the latest (or max/min/increase/count) value per key. */
export interface MetricTablePart {
  column: string;
  label: string;
  unit: MetricUnit;
  table: string;
  /** Tag columns needed beyond the key column. */
  requiredColumns?: readonly string[];
  valueSql?: string;
  where?: readonly MetricPredicate[];
  /** Per timestamp across series sharing the key. */
  seriesAggregate: SeriesAggregate;
  /** Over the window: the latest value, an extreme, the counter increase, or the number of timestamps. */
  over: 'last' | 'max' | 'min' | 'increase' | 'count';
  scale?: number;
}

/** A computed column of a table: `numerator / denominator * scale` (both are part columns). */
export interface MetricTableDerived {
  column: string;
  label: string;
  unit: MetricUnit;
  numerator: string;
  denominator: string;
  scale: number;
}

export interface MetricTableSpec {
  key: string;
  group: MetricGroup;
  label: string;
  /** The label column every part is keyed by (one row per value). */
  keyColumn: string;
  keyLabel: string;
  filters: readonly MetricFilterKey[];
  parts: readonly MetricTablePart[];
  derived?: readonly MetricTableDerived[];
  /** Order rows by the first part's value, descending (the statement then has ONE part). */
  orderByValue?: boolean;
  /** Extra per-key columns from a histogram family (quantile per key). */
  histogram?: { column: string; label: string; family: string };
  /** Extra per-URL status columns from `httpcheck_status` / `httpcheck_error`. */
  httpcheck?: boolean;
  /** Rows this table returns at most; default `METRIC_TABLE_MAX_ROWS` (#176). */
  maxRows?: number;
}

// ---- tables ------------------------------------------------------------------

export const HOST_TABLES = {
  cpuUtilization: 'system_cpu_utilization_ratio',
  memoryUtilization: 'system_memory_utilization_ratio',
  load1m: 'system_cpu_load_average_1m',
  filesystemUtilization: 'system_filesystem_utilization_ratio',
  filesystemUsage: 'system_filesystem_usage_bytes',
  diskIo: 'system_disk_io_bytes_total',
  networkIo: 'system_network_io_bytes_total',
} as const;

/** Where `/filters` reads the distinct host names from: small, always written by hostmetrics. */
export const HOST_DISTINCT_TABLE = HOST_TABLES.load1m;

export const HTTPCHECK_STATUS_TABLE = 'httpcheck_status';
export const HTTPCHECK_ERROR_TABLE = 'httpcheck_error';

const T = DASHBOARD_VERDICT_THRESHOLDS;
const eq = (column: string, value: string): MetricPredicate => ({ column, op: '=', value });

// ---- families ------------------------------------------------------------------

export const METRIC_FAMILIES: readonly MetricFamily[] = [
  // ---- host ----
  {
    key: 'cpuUtilization',
    group: 'host',
    label: 'CPU utilization',
    table: HOST_TABLES.cpuUtilization,
    kind: 'gauge',
    unit: '%',
    // Busy = 1 - idle, averaged over every CPU (and host, unless filtered).
    valueSql: '1 - "greptime_value"',
    where: [eq('state', 'idle')],
    requiredColumns: ['state', 'cpu', 'host_name'],
    seriesAggregate: 'avg',
    bucketAggregate: 'avg',
    scale: 100,
    filters: HOST_FILTERS,
    tileAggregate: 'max',
  },
  {
    key: 'memoryUtilization',
    group: 'host',
    label: 'Memory utilization',
    table: HOST_TABLES.memoryUtilization,
    kind: 'gauge',
    unit: '%',
    where: [eq('state', 'used')],
    requiredColumns: ['state', 'host_name'],
    seriesAggregate: 'max',
    bucketAggregate: 'max',
    scale: 100,
    filters: HOST_FILTERS,
    tileAggregate: 'max',
    verdict: { ...T.memoryUtilizationPct, direction: 'above' },
  },
  {
    key: 'load1m',
    group: 'host',
    label: 'Load (1 min)',
    table: HOST_TABLES.load1m,
    kind: 'gauge',
    unit: 'load',
    requiredColumns: ['host_name'],
    seriesAggregate: 'max',
    bucketAggregate: 'max',
    filters: HOST_FILTERS,
    tileAggregate: 'max',
  },
  {
    key: 'filesystemUtilization',
    group: 'host',
    label: 'Filesystem utilization',
    table: HOST_TABLES.filesystemUtilization,
    kind: 'gauge',
    unit: '%',
    groupBy: 'mountpoint',
    requiredColumns: ['mountpoint', 'host_name'],
    seriesAggregate: 'max',
    bucketAggregate: 'max',
    scale: 100,
    filters: HOST_FILTERS,
    tileAggregate: 'max',
    verdict: { ...T.diskUtilizationPct, direction: 'above' },
  },
  {
    key: 'diskIo',
    group: 'host',
    label: 'Disk IO',
    table: HOST_TABLES.diskIo,
    kind: 'counter',
    unit: 'bytes/s',
    rate: 'per_s',
    groupBy: 'direction',
    requiredColumns: ['device', 'direction', 'host_name'],
    filters: HOST_FILTERS,
  },
  {
    // The collector container's network namespace, not the host's NICs (§11.2).
    key: 'networkIo',
    group: 'host',
    label: 'Network IO (collector)',
    table: HOST_TABLES.networkIo,
    kind: 'counter',
    unit: 'bytes/s',
    rate: 'per_s',
    groupBy: 'direction',
    requiredColumns: ['device', 'direction', 'host_name'],
    filters: HOST_FILTERS,
  },

  // ---- database ----
  {
    key: 'dbConnections',
    group: 'database',
    label: 'Connections',
    table: 'postgresql_backends',
    kind: 'gauge',
    unit: 'count',
    requiredColumns: ['instance'],
    seriesAggregate: 'sum',
    bucketAggregate: 'max',
    filters: HOST_FILTERS,
  },
  {
    key: 'dbConnectionMax',
    group: 'database',
    label: 'Max connections',
    table: 'postgresql_connection_max',
    kind: 'gauge',
    unit: 'count',
    requiredColumns: ['instance'],
    seriesAggregate: 'max',
    bucketAggregate: 'max',
    filters: HOST_FILTERS,
    series: false,
  },
  {
    key: 'dbSize',
    group: 'database',
    label: 'Database size',
    table: 'postgresql_db_size_bytes',
    kind: 'gauge',
    unit: 'bytes',
    groupBy: 'postgresql_database_name',
    requiredColumns: ['postgresql_database_name'],
    seriesAggregate: 'max',
    bucketAggregate: 'max',
    filters: HOST_FILTERS,
  },
  {
    key: 'dbCommits',
    group: 'database',
    label: 'Commits',
    table: 'postgresql_commits_total',
    kind: 'counter',
    unit: 'per_s',
    rate: 'per_s',
    requiredColumns: ['postgresql_database_name'],
    filters: HOST_FILTERS,
  },
  {
    key: 'dbRollbacks',
    group: 'database',
    label: 'Rollbacks',
    table: 'postgresql_rollbacks_total',
    kind: 'counter',
    unit: 'per_s',
    rate: 'per_s',
    requiredColumns: ['postgresql_database_name'],
    filters: HOST_FILTERS,
  },
  {
    key: 'dbDeadlocks',
    group: 'database',
    label: 'Deadlocks',
    table: 'postgresql_deadlocks_total',
    kind: 'counter',
    unit: 'count',
    rate: 'count',
    requiredColumns: ['postgresql_database_name'],
    filters: HOST_FILTERS,
  },
  {
    key: 'dbBlocksHit',
    group: 'database',
    label: 'Blocks hit',
    table: 'postgresql_blks_hit_total',
    kind: 'counter',
    unit: 'count',
    rate: 'count',
    requiredColumns: ['postgresql_database_name'],
    filters: HOST_FILTERS,
    tile: false,
    series: false,
  },
  {
    key: 'dbBlocksRead',
    group: 'database',
    label: 'Blocks read',
    table: 'postgresql_blks_read_total',
    kind: 'counter',
    unit: 'count',
    rate: 'count',
    requiredColumns: ['postgresql_database_name'],
    filters: HOST_FILTERS,
    tile: false,
    series: false,
  },

  // ---- queue ----
  {
    key: 'queueDepth',
    group: 'queue',
    label: 'Queue depth',
    table: 'app_jobs_queue_depth',
    kind: 'gauge',
    unit: 'count',
    groupBy: 'status',
    requiredColumns: ['status', 'job_type'],
    seriesAggregate: 'sum',
    bucketAggregate: 'max',
    filters: APP_FILTERS,
    tileGroups: ['pending', 'running'],
  },
  {
    key: 'oldestPendingAge',
    group: 'queue',
    label: 'Oldest pending job',
    table: 'app_jobs_oldest_pending_age_seconds',
    kind: 'gauge',
    unit: 'seconds',
    groupBy: 'job_type',
    requiredColumns: ['job_type'],
    seriesAggregate: 'max',
    bucketAggregate: 'max',
    filters: APP_FILTERS,
    tileAggregate: 'max',
    verdict: {
      degraded: T.oldestPendingJobMinutes.degraded * 60,
      critical: T.oldestPendingJobMinutes.critical * 60,
      direction: 'above',
    },
  },
  {
    key: 'jobsSettled',
    group: 'queue',
    label: 'Jobs settled',
    table: 'app_jobs_settled_total',
    kind: 'counter',
    unit: 'per_min',
    rate: 'per_min',
    groupBy: 'outcome',
    requiredColumns: ['outcome', 'job_type'],
    filters: APP_FILTERS,
  },
  {
    key: 'jobDurationP95',
    group: 'queue',
    label: 'Job duration p95',
    table: 'app_jobs_duration_seconds_bucket',
    kind: 'histogram',
    unit: 'seconds',
    quantile: 0.95,
    groupBy: 'job_type',
    requiredColumns: ['le', 'job_type'],
    filters: APP_FILTERS,
    series: false,
  },
  {
    key: 'backupAge',
    group: 'queue',
    label: 'Last successful backup',
    table: 'app_backup_last_success_timestamp_seconds',
    kind: 'gauge',
    unit: 'hours',
    requiredColumns: [],
    seriesAggregate: 'max',
    bucketAggregate: 'max',
    transform: 'ageHours',
    filters: APP_FILTERS,
    verdict: { ...T.backupAgeHours, direction: 'above' },
  },

  // ---- nodes ----
  {
    key: 'nodesByHealth',
    group: 'nodes',
    label: 'Worker nodes',
    table: 'app_nodes_count',
    kind: 'gauge',
    unit: 'count',
    groupBy: 'health',
    requiredColumns: ['health', 'status'],
    seriesAggregate: 'sum',
    bucketAggregate: 'max',
    filters: APP_FILTERS,
    tileGroups: ['healthy', 'stale', 'offline'],
  },
  {
    key: 'noEligibleNode',
    group: 'nodes',
    label: 'Job types without an eligible node',
    table: 'app_nodes_types_no_eligible_node',
    kind: 'gauge',
    unit: 'count',
    groupBy: 'job_type',
    requiredColumns: ['job_type'],
    seriesAggregate: 'max',
    bucketAggregate: 'max',
    filters: APP_FILTERS,
    tileAggregate: 'countPositive',
    series: false,
  },

  // ---- uptime ----
  {
    key: 'httpDuration',
    group: 'uptime',
    label: 'Check duration',
    table: 'httpcheck_duration_milliseconds',
    kind: 'gauge',
    unit: 'ms',
    groupBy: 'http_url',
    requiredColumns: ['http_url'],
    seriesAggregate: 'max',
    bucketAggregate: 'avg',
    filters: HOST_FILTERS,
    tileAggregate: 'max',
  },
  {
    key: 'tlsDaysLeft',
    group: 'uptime',
    label: 'TLS certificate days left',
    table: 'httpcheck_tls_cert_remaining_seconds',
    kind: 'gauge',
    unit: 'days',
    groupBy: 'http_url',
    requiredColumns: ['http_url'],
    seriesAggregate: 'min',
    bucketAggregate: 'min',
    scale: 1 / 86_400,
    filters: HOST_FILTERS,
    tileAggregate: 'min',
    verdict: { ...T.tlsDaysLeft, direction: 'below' },
  },
  {
    key: 'nginxRequests',
    group: 'uptime',
    label: 'nginx requests',
    table: 'nginx_requests_total',
    kind: 'counter',
    unit: 'per_s',
    rate: 'per_s',
    requiredColumns: ['host_name'],
    filters: HOST_FILTERS,
  },
  {
    key: 'nginxConnections',
    group: 'uptime',
    label: 'nginx connections',
    table: 'nginx_connections_current',
    kind: 'gauge',
    unit: 'count',
    groupBy: 'state',
    requiredColumns: ['state', 'host_name'],
    seriesAggregate: 'sum',
    bucketAggregate: 'max',
    filters: HOST_FILTERS,
    tileGroups: ['active'],
  },

  // ---- pipeline ----
  {
    key: 'exporterSent',
    group: 'pipeline',
    label: 'Metric points sent',
    table: 'otelcol_exporter_sent_metric_points_total',
    kind: 'counter',
    unit: 'per_s',
    rate: 'per_s',
    groupBy: 'exporter',
    requiredColumns: ['exporter'],
    filters: HOST_FILTERS,
  },
  {
    key: 'exporterFailed',
    group: 'pipeline',
    label: 'Metric points failed',
    table: 'otelcol_exporter_send_failed_metric_points_total',
    kind: 'counter',
    unit: 'count',
    rate: 'count',
    groupBy: 'exporter',
    requiredColumns: ['exporter'],
    filters: HOST_FILTERS,
  },
  {
    key: 'exporterQueueSize',
    group: 'pipeline',
    label: 'Exporter queue size',
    table: 'otelcol_exporter_queue_size',
    kind: 'gauge',
    unit: 'count',
    groupBy: 'exporter',
    requiredColumns: ['exporter'],
    seriesAggregate: 'max',
    bucketAggregate: 'max',
    filters: HOST_FILTERS,
    tileAggregate: 'max',
  },
  {
    key: 'exporterQueueCapacity',
    group: 'pipeline',
    label: 'Exporter queue capacity',
    table: 'otelcol_exporter_queue_capacity',
    kind: 'gauge',
    unit: 'count',
    groupBy: 'exporter',
    requiredColumns: ['exporter'],
    seriesAggregate: 'max',
    bucketAggregate: 'max',
    filters: HOST_FILTERS,
    tileAggregate: 'max',
    tile: false,
    series: false,
  },
  {
    key: 'receiverRefused',
    group: 'pipeline',
    label: 'Metric points refused',
    table: 'otelcol_receiver_refused_metric_points_total',
    kind: 'counter',
    unit: 'count',
    rate: 'count',
    groupBy: 'receiver',
    requiredColumns: ['receiver'],
    filters: HOST_FILTERS,
  },
  {
    key: 'greptimeWriteStalls',
    group: 'pipeline',
    label: 'GreptimeDB write stalls',
    table: 'greptime_mito_write_stalling_count',
    kind: 'gauge',
    unit: 'count',
    requiredColumns: [],
    seriesAggregate: 'sum',
    bucketAggregate: 'max',
    filters: HOST_FILTERS,
  },
  {
    key: 'scrapeTargetsDown',
    group: 'pipeline',
    label: 'Scrape targets down',
    table: 'up',
    kind: 'gauge',
    unit: 'count',
    // `job` names the scrape target readably (`greptimedb`, `otelcol-contrib`);
    // the collector's own `instance` is its random service instance id.
    groupBy: 'job',
    requiredColumns: ['job'],
    seriesAggregate: 'min',
    bucketAggregate: 'min',
    filters: HOST_FILTERS,
    tileAggregate: 'countZero',
    series: false,
  },
];

// ---- ratios ------------------------------------------------------------------

export const METRIC_RATIOS: readonly MetricRatio[] = [
  {
    key: 'dbConnectionUtilization',
    group: 'database',
    label: 'Connections used',
    unit: '%',
    numerator: [{ family: 'dbConnections' }],
    denominator: [{ family: 'dbConnectionMax' }],
    scale: 100,
    verdict: { ...T.dbConnectionsPct, direction: 'above' },
  },
  {
    key: 'dbCacheHitRatio',
    group: 'database',
    label: 'Cache hit ratio',
    unit: '%',
    numerator: [{ family: 'dbBlocksHit' }],
    denominator: [{ family: 'dbBlocksRead' }],
    addNumerator: true,
    scale: 100,
  },
  {
    key: 'jobFailureRatio',
    group: 'queue',
    label: 'Job failure ratio',
    unit: '%',
    numerator: [{ family: 'jobsSettled', groups: ['failed'] }],
    denominator: [{ family: 'jobsSettled', groups: ['succeeded'] }],
    addNumerator: true,
    scale: 100,
  },
  {
    key: 'exporterQueueUtilization',
    group: 'pipeline',
    label: 'Exporter queue used',
    unit: '%',
    numerator: [{ family: 'exporterQueueSize' }],
    denominator: [{ family: 'exporterQueueCapacity' }],
    scale: 100,
  },
];

// ---- tables ------------------------------------------------------------------

/** Rows of `largestTables`: every table of a realistic schema; bounded so a runaway schema can't blow the payload (#176). */
export const LARGEST_TABLES_MAX_ROWS = 500;

export const METRIC_TABLES: readonly MetricTableSpec[] = [
  {
    key: 'filesystems',
    group: 'host',
    label: 'Filesystems',
    keyColumn: 'mountpoint',
    keyLabel: 'Mountpoint',
    filters: HOST_FILTERS,
    parts: [
      {
        column: 'utilizationPct',
        label: 'Used',
        unit: '%',
        table: HOST_TABLES.filesystemUtilization,
        seriesAggregate: 'max',
        over: 'last',
        scale: 100,
      },
      {
        column: 'usedBytes',
        label: 'Used bytes',
        unit: 'bytes',
        table: HOST_TABLES.filesystemUsage,
        requiredColumns: ['state'],
        where: [eq('state', 'used')],
        seriesAggregate: 'max',
        over: 'last',
      },
      {
        column: 'freeBytes',
        label: 'Free bytes',
        unit: 'bytes',
        table: HOST_TABLES.filesystemUsage,
        requiredColumns: ['state'],
        where: [eq('state', 'free')],
        seriesAggregate: 'max',
        over: 'last',
      },
    ],
  },
  {
    key: 'largestTables',
    group: 'database',
    label: 'Largest tables',
    keyColumn: 'postgresql_table_name',
    keyLabel: 'Table',
    filters: HOST_FILTERS,
    orderByValue: true,
    maxRows: LARGEST_TABLES_MAX_ROWS,
    parts: [
      {
        column: 'sizeBytes',
        label: 'Size',
        unit: 'bytes',
        table: 'postgresql_table_size_bytes',
        seriesAggregate: 'max',
        over: 'last',
      },
    ],
  },
  {
    key: 'jobTypes',
    group: 'queue',
    label: 'Job types',
    keyColumn: 'job_type',
    keyLabel: 'Job type',
    filters: APP_FILTERS,
    parts: [
      {
        column: 'pending',
        label: 'Pending',
        unit: 'count',
        table: 'app_jobs_queue_depth',
        requiredColumns: ['status'],
        where: [eq('status', 'pending')],
        seriesAggregate: 'max',
        over: 'last',
      },
      {
        column: 'running',
        label: 'Running',
        unit: 'count',
        table: 'app_jobs_queue_depth',
        requiredColumns: ['status'],
        where: [eq('status', 'running')],
        seriesAggregate: 'max',
        over: 'last',
      },
      {
        column: 'oldestPendingSeconds',
        label: 'Oldest pending',
        unit: 'seconds',
        table: 'app_jobs_oldest_pending_age_seconds',
        seriesAggregate: 'max',
        over: 'last',
      },
      {
        column: 'succeeded',
        label: 'Succeeded',
        unit: 'count',
        table: 'app_jobs_settled_total',
        requiredColumns: ['outcome'],
        where: [eq('outcome', 'succeeded')],
        seriesAggregate: 'sum',
        over: 'increase',
      },
      {
        column: 'failed',
        label: 'Failed',
        unit: 'count',
        table: 'app_jobs_settled_total',
        requiredColumns: ['outcome'],
        where: [eq('outcome', 'failed')],
        seriesAggregate: 'sum',
        over: 'increase',
      },
    ],
    histogram: { column: 'durationP95Seconds', label: 'Duration p95', family: 'jobDurationP95' },
  },
  {
    key: 'nodes',
    group: 'nodes',
    label: 'Nodes',
    keyColumn: 'node_name',
    keyLabel: 'Node',
    filters: APP_FILTERS,
    parts: [
      {
        column: 'cpuCores',
        label: 'CPU',
        unit: 'cores',
        table: 'app_nodes_cpu_utilization',
        seriesAggregate: 'max',
        over: 'last',
      },
      {
        column: 'rssBytes',
        label: 'RSS',
        unit: 'bytes',
        table: 'app_nodes_memory_rss_bytes',
        seriesAggregate: 'max',
        over: 'last',
      },
      {
        column: 'heapUsedBytes',
        label: 'Heap used',
        unit: 'bytes',
        table: 'app_nodes_heap_used_bytes',
        seriesAggregate: 'max',
        over: 'last',
      },
      {
        column: 'heapLimitBytes',
        label: 'Heap limit',
        unit: 'bytes',
        table: 'app_nodes_heap_limit_bytes',
        seriesAggregate: 'max',
        over: 'last',
      },
      {
        column: 'stateDirFreeBytes',
        label: 'Disk free',
        unit: 'bytes',
        table: 'app_nodes_state_dir_free_bytes',
        seriesAggregate: 'max',
        over: 'last',
      },
      {
        column: 'stateDirTotalBytes',
        label: 'Disk size',
        unit: 'bytes',
        table: 'app_nodes_state_dir_total_bytes',
        seriesAggregate: 'max',
        over: 'last',
      },
      {
        column: 'slotsUsed',
        label: 'Slots used',
        unit: 'count',
        table: 'app_nodes_slots_used',
        seriesAggregate: 'max',
        over: 'last',
      },
      {
        column: 'slotsTotal',
        label: 'Slots',
        unit: 'count',
        table: 'app_nodes_slots_total',
        seriesAggregate: 'max',
        over: 'last',
      },
    ],
    derived: [
      {
        column: 'heapPct',
        label: 'Heap used',
        unit: '%',
        numerator: 'heapUsedBytes',
        denominator: 'heapLimitBytes',
        scale: 100,
      },
      {
        column: 'stateDirFreePct',
        label: 'Disk free',
        unit: '%',
        numerator: 'stateDirFreeBytes',
        denominator: 'stateDirTotalBytes',
        scale: 100,
      },
    ],
  },
  {
    key: 'noEligibleNodeTypes',
    group: 'nodes',
    label: 'Node-offered job types',
    keyColumn: 'job_type',
    keyLabel: 'Job type',
    filters: APP_FILTERS,
    parts: [
      {
        column: 'noEligibleNode',
        label: 'No eligible node',
        unit: 'boolean',
        table: 'app_nodes_types_no_eligible_node',
        seriesAggregate: 'max',
        over: 'last',
      },
    ],
  },
  {
    key: 'uptimeTargets',
    group: 'uptime',
    label: 'Uptime targets',
    keyColumn: 'http_url',
    keyLabel: 'URL',
    filters: HOST_FILTERS,
    httpcheck: true,
    parts: [
      {
        column: 'durationMs',
        label: 'Duration',
        unit: 'ms',
        table: 'httpcheck_duration_milliseconds',
        seriesAggregate: 'max',
        over: 'last',
      },
      {
        column: 'tlsDaysLeft',
        label: 'TLS days left',
        unit: 'days',
        table: 'httpcheck_tls_cert_remaining_seconds',
        seriesAggregate: 'min',
        over: 'last',
        scale: 1 / 86_400,
      },
    ],
  },
  {
    key: 'scrapeTargets',
    group: 'pipeline',
    label: 'Scrape targets',
    keyColumn: 'job',
    keyLabel: 'Scrape job',
    filters: HOST_FILTERS,
    parts: [
      {
        column: 'up',
        label: 'Up',
        unit: 'boolean',
        table: 'up',
        seriesAggregate: 'min',
        over: 'last',
      },
    ],
  },
];

// ---- lookups -----------------------------------------------------------------

export function familiesOf(group: MetricGroup): MetricFamily[] {
  return METRIC_FAMILIES.filter((f) => f.group === group);
}

export function ratiosOf(group: MetricGroup): MetricRatio[] {
  return METRIC_RATIOS.filter((r) => r.group === group);
}

export function tablesOf(group: MetricGroup): MetricTableSpec[] {
  return METRIC_TABLES.filter((t) => t.group === group);
}

export function familyByKey(key: string): MetricFamily | undefined {
  return METRIC_FAMILIES.find((f) => f.key === key);
}

// ---- what the store has ----------------------------------------------------------

/** One metric table as the store describes it. */
export interface MetricTableInfo {
  columns: ReadonlySet<string>;
  /** Tag columns: every series-identifying column (the `lag` partition of a counter). */
  tags: readonly string[];
}

/** Discovered metric tables, by name. A table absent here does not exist (yet). */
export type MetricTables = ReadonlyMap<string, MetricTableInfo>;

/**
 * Every table of the schema that looks like a metric table (has the time and
 * value columns), with its tag columns: `semantic_type = 'TAG'` where the
 * store reports it, else every column but the time and value.
 */
export function metricTablesOf(schema: TelemetrySchema): MetricTables {
  const tables = new Map<string, MetricTableInfo>();
  for (const table of schema.tables) {
    const names = new Set(table.columns.map((c) => c.name));
    if (!names.has(METRIC_TIME_COLUMN) || !names.has(METRIC_VALUE_COLUMN)) continue;
    const reported = table.columns.some((c) => c.semanticType);
    const tags = table.columns
      .filter((c) =>
        reported
          ? String(c.semanticType).toUpperCase() === 'TAG'
          : c.name !== METRIC_TIME_COLUMN && c.name !== METRIC_VALUE_COLUMN
      )
      .map((c) => c.name)
      .sort();
    tables.set(table.name, { columns: names, tags });
  }
  return tables;
}

/** The table's info when it exists with every required column, else null. */
export function tableWith(
  tables: MetricTables,
  table: string,
  required: readonly string[]
): MetricTableInfo | null {
  const info = tables.get(table);
  if (!info) return null;
  return required.every((c) => info.columns.has(c)) ? info : null;
}
