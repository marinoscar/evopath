import type { DashboardSqlFilters } from '../dashboard/telemetry-dashboard.sql';
import { analyzeStatement, applyRowCap } from '../query/sql-guard';
import { metricCatalogSchema, metricTableSchema } from '../testing/metric-schema.fixture';
import {
  HOST_DISTINCT_TABLE,
  LARGEST_TABLES_MAX_ROWS,
  METRIC_FAMILIES,
  METRIC_TABLES,
  metricTablesOf,
  type MetricFamily,
  type MetricTables,
} from './metric-catalog';
import {
  counterSeriesSql,
  distinctHostsSql,
  filterPredicates,
  gaugeSeriesSql,
  histogramIncreaseSql,
  latestByKeySql,
  METRIC_TABLE_MAX_ROWS,
  presentParts,
  tableMaxRows,
  uptimeErrorsSql,
  uptimeStatusSql,
  type LatestPart,
} from './metric-sql';
import { verdictProbeSql } from './metric-verdict';

// =============================================================================
// Metric catalog SQL (issue #126)
// =============================================================================
//
// Snapshots pin the exact text of every builder, for every catalog family and
// table, with and without the request filters. Each shape was run against
// GreptimeDB v1.2.1 over tables written by collector 0.145.0 and the API's
// OTLP exporter when written (and the live tier re-runs them): a diff here
// needs the same check. Every statement must be exactly one SELECT the guard
// accepts with a literal top-level LIMIT; an absent table or column yields
// null, never a statement.
// =============================================================================

const FROM = new Date('2026-09-27T20:00:00.000Z');
const CURRENT_FROM = new Date('2026-09-27T21:00:00.000Z');
const TO = new Date('2026-09-27T22:00:00.000Z');
const WINDOW = { from: FROM, to: TO, bucketSeconds: 60 };
const NONE: DashboardSqlFilters = {};
const FILTERED: DashboardSqlFilters = { service: 'my-app-api', instance: 'inst-1', host: "vm'1" };

const TABLES: MetricTables = metricTablesOf(metricCatalogSchema());
const EMPTY: MetricTables = metricTablesOf({ tables: [] });

function expectGuarded(sql: string): void {
  const statement = analyzeStatement(sql);
  expect(statement.kind).toBe('select');
  expect(['kept', 'clamped']).toContain(applyRowCap(statement, 1_000_000).strategy);
}

function familySql(
  family: MetricFamily,
  tables: MetricTables,
  filters: DashboardSqlFilters
): string | null {
  const info = tables.get(family.table) ?? null;
  if (family.kind === 'gauge') return gaugeSeriesSql(family, info, WINDOW, filters);
  if (family.kind === 'counter') return counterSeriesSql(family, info, WINDOW, filters);
  return histogramIncreaseSql(family, info, { from: FROM, to: TO }, CURRENT_FROM, filters);
}

function tableParts(key: string, tables: MetricTables): LatestPart[] {
  const spec = METRIC_TABLES.find((t) => t.key === key)!;
  return spec.parts.map((p) => ({
    name: p.column,
    table: p.table,
    info: tables.get(p.table) ?? null,
    keyColumn: spec.keyColumn,
    requiredColumns: p.requiredColumns,
    valueSql: p.valueSql,
    where: p.where,
    seriesAggregate: p.seriesAggregate,
    over: p.over,
    filters: spec.filters,
  }));
}

describe('metric catalog SQL', () => {
  describe.each(METRIC_FAMILIES.map((f) => [f.key, f] as const))('family %s', (_key, family) => {
    it('matches the snapshot without filters', () => {
      const sql = familySql(family, TABLES, NONE)!;
      expect(sql).toMatchSnapshot();
      expectGuarded(sql);
    });

    it('matches the snapshot with the request filters', () => {
      const sql = familySql(family, TABLES, FILTERED)!;
      expect(sql).toMatchSnapshot();
      expectGuarded(sql);
    });

    it('is skipped (null) when its table is absent', () => {
      expect(familySql(family, EMPTY, NONE)).toBeNull();
    });

    it('applies only the filters the family declares', () => {
      const sql = familySql(family, TABLES, FILTERED)!;
      expect(sql.includes(`"service_name" = 'my-app-api'`)).toBe(
        family.filters.includes('service')
      );
      expect(sql.includes(`"app_instance_id" = 'inst-1'`)).toBe(
        family.filters.includes('instance')
      );
      expect(sql.includes(`"host_name" = 'vm''1'`)).toBe(family.filters.includes('host'));
    });
  });

  describe.each(METRIC_TABLES.map((t) => [t.key, t] as const))('table %s', (key, spec) => {
    it('matches the snapshot without and with filters', () => {
      for (const filters of [NONE, FILTERED]) {
        const sql = latestByKeySql(tableParts(key, TABLES), FROM, TO, filters, {
          orderByValue: spec.orderByValue,
          maxKeys: tableMaxRows(spec),
        })!;
        expect(sql).toMatchSnapshot();
        expectGuarded(sql);
      }
    });

    it('is skipped (null) when no part table exists', () => {
      expect(
        latestByKeySql(tableParts(key, EMPTY), FROM, TO, NONE, { orderByValue: spec.orderByValue })
      ).toBeNull();
    });
  });

  it('keeps only the parts whose table and columns exist', () => {
    const tables = metricTablesOf({ tables: [metricTableSchema('app_nodes_cpu_utilization')] });
    const parts = tableParts('nodes', tables);
    expect(presentParts(parts).map((p) => p.name)).toEqual(['cpuCores']);
    const sql = latestByKeySql(parts, FROM, TO, NONE)!;
    expect(sql).not.toContain('UNION ALL');
    // key-major order, a cap of maxKeys × parts + 1
    expect(sql).toMatch(/ORDER BY k, m LIMIT 51$/);
  });

  it('skips a part whose fixed predicate column is absent', () => {
    const tables = metricTablesOf({
      tables: [metricTableSchema('app_jobs_queue_depth', ['job_type', 'service_name'])],
    });
    expect(latestByKeySql(tableParts('jobTypes', tables), FROM, TO, NONE)).toBeNull();
  });

  it('orders a single value-ordered part by value, descending', () => {
    const sql = latestByKeySql(tableParts('largestTables', TABLES), FROM, TO, NONE, {
      orderByValue: true,
    })!;
    expect(sql).toMatch(/ORDER BY v DESC, k LIMIT 51$/);
    expect(() =>
      latestByKeySql(tableParts('nodes', TABLES), FROM, TO, NONE, { orderByValue: true })
    ).toThrow(RangeError);
  });

  it('caps largestTables at its own maxRows, every other table at the default (#176)', () => {
    const largest = METRIC_TABLES.find((t) => t.key === 'largestTables')!;
    expect(tableMaxRows(largest)).toBe(LARGEST_TABLES_MAX_ROWS);
    const sql = latestByKeySql(tableParts('largestTables', TABLES), FROM, TO, NONE, {
      orderByValue: true,
      maxKeys: tableMaxRows(largest),
    })!;
    expect(sql).toMatch(new RegExp(`ORDER BY v DESC, k LIMIT ${LARGEST_TABLES_MAX_ROWS + 1}$`));
    expect(sql).toMatch(/LIMIT 501$/);
    for (const spec of METRIC_TABLES.filter((t) => t.key !== 'largestTables'))
      expect(tableMaxRows(spec)).toBe(METRIC_TABLE_MAX_ROWS);
  });

  it('partitions a counter by every tag column, so each series is diffed on its own', () => {
    const family = METRIC_FAMILIES.find((f) => f.key === 'jobsSettled')!;
    const sql = familySql(family, TABLES, NONE)!;
    expect(sql).toContain(
      'lag("greptime_value") OVER (PARTITION BY "app_instance_id", "executor", "host_name", "job", "job_type", "outcome", "service_name" ORDER BY "greptime_timestamp")'
    );
    expect(sql).toContain('CASE WHEN p IS NULL THEN 0 WHEN v >= p THEN v - p ELSE v END');
  });

  it('bounds a family by rows per group × groups + 1', () => {
    const family = METRIC_FAMILIES.find((f) => f.key === 'cpuUtilization')!;
    // 2 h of 60 s buckets = 120 (+2 slack) per group, 20 groups, + 1.
    expect(familySql(family, TABLES, NONE)).toMatch(/LIMIT 2441$/);
  });

  describe('request filters', () => {
    const info = TABLES.get('app_jobs_queue_depth')!;

    it('quote the validated value', () => {
      expect(filterPredicates(info, ['service'], { service: "a'b" })).toEqual([
        `"service_name" = 'a''b'`,
      ]);
    });

    it('match nothing on a table without the column', () => {
      const bare = metricTablesOf({
        tables: [metricTableSchema('app_jobs_queue_depth', ['job_type', 'status'])],
      });
      expect(
        filterPredicates(bare.get('app_jobs_queue_depth')!, ['instance'], { instance: 'inst-1' })
      ).toEqual(['1 = 0']);
    });

    it('ignore a filter the family does not declare', () => {
      expect(filterPredicates(info, ['service'], { host: 'vm1' })).toEqual([]);
    });
  });

  describe('uptime', () => {
    it.each([NONE, FILTERED])('status and errors match the snapshot (%#)', (filters) => {
      const status = uptimeStatusSql(TABLES.get('httpcheck_status')!, CURRENT_FROM, TO, filters, [
        'host',
      ])!;
      const errors = uptimeErrorsSql(TABLES.get('httpcheck_error')!, CURRENT_FROM, TO, filters, [
        'host',
      ])!;
      expect(status).toMatchSnapshot();
      expect(errors).toMatchSnapshot();
      expectGuarded(status);
      expectGuarded(errors);
    });

    it('reads the status code only once the column exists', () => {
      const bare = metricTablesOf({
        tables: [
          metricTableSchema('httpcheck_status', [
            'host_name',
            'http_method',
            'http_status_class',
            'http_url',
          ]),
        ],
      });
      const sql = uptimeStatusSql(bare.get('httpcheck_status')!, CURRENT_FROM, TO, NONE, ['host'])!;
      expect(sql).toContain('NULL AS code');
      expectGuarded(sql);
    });

    it('is skipped without the tables', () => {
      expect(uptimeStatusSql(null, CURRENT_FROM, TO, NONE, ['host'])).toBeNull();
      expect(uptimeErrorsSql(null, CURRENT_FROM, TO, NONE, ['host'])).toBeNull();
    });
  });

  describe('distinct hosts', () => {
    it('matches the snapshot', () => {
      const sql = distinctHostsSql(
        TABLES.get(HOST_DISTINCT_TABLE)!,
        HOST_DISTINCT_TABLE,
        CURRENT_FROM,
        TO,
        201
      )!;
      expect(sql).toMatchSnapshot();
      expectGuarded(sql);
    });

    it('is skipped without the table', () => {
      expect(distinctHostsSql(null, HOST_DISTINCT_TABLE, CURRENT_FROM, TO, 201)).toBeNull();
    });
  });

  describe('verdict probes', () => {
    it('match the snapshot', () => {
      const probes = verdictProbeSql(TABLES, { from: CURRENT_FROM, to: TO });
      for (const sql of Object.values(probes)) {
        expect(sql).not.toBeNull();
        expectGuarded(sql!);
      }
      expect(probes).toMatchSnapshot();
    });

    it('are all null on a store without metric tables', () => {
      expect(
        Object.values(verdictProbeSql(EMPTY, { from: CURRENT_FROM, to: TO })).every(
          (s) => s === null
        )
      ).toBe(true);
    });

    it('look back ten minutes for gauges and use the window for counters', () => {
      const probes = verdictProbeSql(TABLES, { from: CURRENT_FROM, to: TO });
      expect(probes.host).toContain(`"greptime_timestamp" >= '2026-09-27T21:50:00.000Z'`);
      expect(probes.pipeline).toContain(`"greptime_timestamp" >= '2026-09-27T21:00:00.000Z'`);
    });
  });

  it('never lets a filter value break out of its literal', () => {
    const family = METRIC_FAMILIES.find((f) => f.key === 'queueDepth')!;
    const sql = familySql(family, TABLES, { service: "x'; DROP TABLE up; --" })!;
    expect(sql).toContain(`"service_name" = 'x''; DROP TABLE up; --'`);
    expectGuarded(sql);
  });
});
