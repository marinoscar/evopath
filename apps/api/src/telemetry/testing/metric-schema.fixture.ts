import type { TelemetrySchema } from '../dto/telemetry-query.dto';

// =============================================================================
// Test fixture: the metric tables the catalog reads, as the store reports them
// (issue #126)
// =============================================================================
//
// Tag columns per table, copied from `information_schema.columns` of a
// GreptimeDB v1.2.1 fed by collector 0.145.0 (hostmetrics, prometheus/self,
// postgresql, httpcheck, nginx — the configuration of
// infra/otel/otel-collector-config.yaml) and by the API's OTLP metric exporter
// (2026-09-30). `httpcheck_tls_cert_remaining_seconds` is only written for an
// `https://` target and is taken from docs/specs/telemetry.md §11.3. Every
// table also has `greptime_timestamp` (TIMESTAMP) and `greptime_value`
// (FIELD, Float64).
//
// Used by the unit tests (as a `TelemetrySchema`) and by the live GreptimeDB
// tier (to create look-alike tables).
// =============================================================================

export const VERIFIED_METRIC_TAGS: Record<string, readonly string[]> = {
  app_backup_last_success_timestamp_seconds: [
    'app_instance_id',
    'host_name',
    'job',
    'service_name',
  ],
  app_jobs_duration_seconds_bucket: [
    'app_instance_id',
    'executor',
    'host_name',
    'job',
    'job_type',
    'le',
    'outcome',
    'service_name',
  ],
  app_jobs_oldest_pending_age_seconds: [
    'app_instance_id',
    'host_name',
    'job',
    'job_type',
    'service_name',
  ],
  app_jobs_queue_depth: [
    'app_instance_id',
    'host_name',
    'job',
    'job_type',
    'service_name',
    'status',
  ],
  app_jobs_settled_total: [
    'app_instance_id',
    'executor',
    'host_name',
    'job',
    'job_type',
    'outcome',
    'service_name',
  ],
  app_nodes_count: ['app_instance_id', 'health', 'host_name', 'job', 'service_name', 'status'],
  app_nodes_cpu_utilization: [
    'app_instance_id',
    'host_name',
    'job',
    'node_id',
    'node_name',
    'service_name',
  ],
  app_nodes_heap_limit_bytes: [
    'app_instance_id',
    'host_name',
    'job',
    'node_id',
    'node_name',
    'service_name',
  ],
  app_nodes_heap_used_bytes: [
    'app_instance_id',
    'host_name',
    'job',
    'node_id',
    'node_name',
    'service_name',
  ],
  app_nodes_memory_rss_bytes: [
    'app_instance_id',
    'host_name',
    'job',
    'node_id',
    'node_name',
    'service_name',
  ],
  app_nodes_slots_total: [
    'app_instance_id',
    'host_name',
    'job',
    'node_id',
    'node_name',
    'service_name',
  ],
  app_nodes_slots_used: [
    'app_instance_id',
    'host_name',
    'job',
    'node_id',
    'node_name',
    'service_name',
  ],
  app_nodes_state_dir_free_bytes: [
    'app_instance_id',
    'host_name',
    'job',
    'node_id',
    'node_name',
    'service_name',
  ],
  app_nodes_state_dir_total_bytes: [
    'app_instance_id',
    'host_name',
    'job',
    'node_id',
    'node_name',
    'service_name',
  ],
  app_nodes_types_no_eligible_node: [
    'app_instance_id',
    'host_name',
    'job',
    'job_type',
    'service_name',
  ],
  greptime_mito_write_stalling_count: [
    'host_name',
    'instance',
    'job',
    'service_instance_id',
    'service_name',
    'worker',
  ],
  httpcheck_duration_milliseconds: ['host_name', 'http_url'],
  httpcheck_error: ['error_message', 'host_name', 'http_url'],
  httpcheck_status: [
    'host_name',
    'http_method',
    'http_status_class',
    'http_status_code',
    'http_url',
  ],
  httpcheck_tls_cert_remaining_seconds: ['host_name', 'http_tls_cn', 'http_tls_issuer', 'http_url'],
  nginx_connections_current: ['host_name', 'state'],
  nginx_requests_total: ['host_name'],
  otelcol_exporter_queue_capacity: [
    'data_type',
    'exporter',
    'host_name',
    'instance',
    'job',
    'service_instance_id',
    'service_name',
    'service_version',
  ],
  otelcol_exporter_queue_size: [
    'data_type',
    'exporter',
    'host_name',
    'instance',
    'job',
    'service_instance_id',
    'service_name',
    'service_version',
  ],
  otelcol_exporter_send_failed_metric_points_total: [
    'exporter',
    'host_name',
    'instance',
    'job',
    'service_instance_id',
    'service_name',
    'service_version',
  ],
  otelcol_exporter_sent_metric_points_total: [
    'exporter',
    'host_name',
    'instance',
    'job',
    'service_instance_id',
    'service_name',
    'service_version',
  ],
  otelcol_receiver_refused_metric_points_total: [
    'host_name',
    'instance',
    'job',
    'receiver',
    'service_instance_id',
    'service_name',
    'service_version',
    'transport',
  ],
  postgresql_backends: ['host_name', 'instance', 'postgresql_database_name', 'service_instance_id'],
  postgresql_blks_hit_total: [
    'host_name',
    'instance',
    'postgresql_database_name',
    'service_instance_id',
  ],
  postgresql_blks_read_total: [
    'host_name',
    'instance',
    'postgresql_database_name',
    'service_instance_id',
  ],
  postgresql_commits_total: [
    'host_name',
    'instance',
    'postgresql_database_name',
    'service_instance_id',
  ],
  postgresql_connection_max: ['host_name', 'instance', 'service_instance_id'],
  postgresql_db_size_bytes: [
    'host_name',
    'instance',
    'postgresql_database_name',
    'service_instance_id',
  ],
  postgresql_deadlocks_total: [
    'host_name',
    'instance',
    'postgresql_database_name',
    'service_instance_id',
  ],
  postgresql_rollbacks_total: [
    'host_name',
    'instance',
    'postgresql_database_name',
    'service_instance_id',
  ],
  postgresql_table_size_bytes: [
    'host_name',
    'instance',
    'postgresql_database_name',
    'postgresql_table_name',
    'service_instance_id',
  ],
  system_cpu_load_average_1m: ['host_name'],
  system_cpu_utilization_ratio: ['cpu', 'host_name', 'state'],
  system_disk_io_bytes_total: ['device', 'direction', 'host_name'],
  system_filesystem_usage_bytes: ['device', 'host_name', 'mode', 'mountpoint', 'state', 'type'],
  system_filesystem_utilization_ratio: ['device', 'host_name', 'mode', 'mountpoint', 'type'],
  system_memory_utilization_ratio: ['host_name', 'state'],
  system_network_io_bytes_total: ['device', 'direction', 'host_name'],
  up: ['host_name', 'instance', 'job', 'service_instance_id', 'service_name', 'service_version'],
};

/** The schema entry of one verified metric table (semantic types reported, as the store does). */
export function metricTableSchema(name: string, tags = VERIFIED_METRIC_TAGS[name]) {
  return {
    name,
    rows: null,
    columns: [
      { name: 'greptime_timestamp', type: 'timestamp(3)', semanticType: 'TIMESTAMP' },
      { name: 'greptime_value', type: 'double', semanticType: 'FIELD' },
      ...tags.map((tag) => ({ name: tag, type: 'string', semanticType: 'TAG' })),
    ],
  };
}

/** A schema holding every verified metric table (or only `only`). */
export function metricCatalogSchema(only?: readonly string[]): TelemetrySchema {
  const names = only ?? Object.keys(VERIFIED_METRIC_TAGS);
  return { tables: names.map((name) => metricTableSchema(name)) };
}
