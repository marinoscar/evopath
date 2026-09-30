import type { TelemetryQueryResult } from '../greptime/greptime.client';
import { metricCatalogSchema } from '../testing/metric-schema.fixture';
import {
  familiesOf,
  LARGEST_TABLES_MAX_ROWS,
  metricTablesOf,
  tablesOf,
  type MetricTables,
} from './metric-catalog';
import {
  computeMetricGroup,
  METRIC_FRESH_MS,
  metricBucketSeconds,
  type MetricGroupResult,
} from './metric-group';
import { METRIC_MAX_GROUPS, METRIC_TABLE_MAX_ROWS } from './metric-sql';

// =============================================================================
// One metric group, computed (issue #126)
// =============================================================================
//
// The store is a fake that answers each statement by the table it reads, so
// these tests cover the shaping: tiles (latest / rate / quantile, previous
// window, sparkline), series per group, tables per key, ratios, delta-gauge
// freshness, row caps, and skipping absent tables.
// =============================================================================

const FROM = new Date('2026-09-27T21:00:00.000Z');
const TO = new Date('2026-09-27T22:00:00.000Z');
const PREVIOUS_FROM = new Date('2026-09-27T20:00:00.000Z');
const WINDOW = { from: FROM, to: TO, previousFrom: PREVIOUS_FROM, bucketSeconds: 60 };
const NOW = TO;

const ALL: MetricTables = metricTablesOf(metricCatalogSchema());

/** A store instant as the reader returns it: UTC text, no zone. */
function at(iso: string): string {
  return iso.replace('T', ' ').replace('Z', '').padEnd(26, '0');
}
const T = (hhmm: string) => at(`2026-09-27T${hhmm}:00.000Z`);

function result(names: string[], rows: unknown[][]): TelemetryQueryResult {
  return { fields: names.map((name) => ({ name, dataTypeID: 25 })), rows };
}
const series = (rows: Array<[string, string, number | string]>) => result(['t', 'g', 'v'], rows);
const latest = (rows: Array<[string, string, number | string, string]>) =>
  result(['m', 'k', 'v', 'at'], rows);

type Answer = (sql: string) => TelemetryQueryResult | undefined;

function runner(answer: Answer) {
  const sql: string[] = [];
  return {
    sql,
    maybe: jest.fn(async (statement: string | null) => {
      if (!statement) return null;
      sql.push(statement);
      return answer(statement) ?? result([], []);
    }),
  };
}

/** Answers a statement reading `table` with `value` (first matching entry wins). */
function byTable(
  entries: Array<[table: string, value: TelemetryQueryResult, shape?: RegExp]>
): Answer {
  return (sql) =>
    entries.find(
      ([table, , shape]) => sql.includes(`FROM "${table}"`) && (!shape || shape.test(sql))
    )?.[1];
}

async function compute(
  group: Parameters<typeof computeMetricGroup>[0]['group'],
  answer: Answer,
  tables = ALL,
  filters = {}
) {
  const r = runner(answer);
  const out = await computeMetricGroup({
    group,
    window: WINDOW,
    filters,
    tables,
    runner: r,
    now: NOW,
  });
  return { out, runner: r };
}

const tile = (out: MetricGroupResult, key: string) => out.tiles.find((t) => t.key === key);

describe('computeMetricGroup', () => {
  it('uses buckets of at least one minute', () => {
    expect(metricBucketSeconds(10)).toBe(60);
    expect(metricBucketSeconds(300)).toBe(300);
  });

  it('runs one statement per family and table of the group, none for absent tables', async () => {
    const { out, runner: r } = await compute('host', () => undefined);
    const expected = familiesOf('host').length + tablesOf('host').length;
    expect(r.sql).toHaveLength(expected);
    expect(out.available).toBe(true);
    expect(out.skipped).toEqual([]);
    expect(out.bucketSeconds).toBe(60);
  });

  it('skips every family, ratio and table without its table, and reports the group unavailable', async () => {
    const { out, runner: r } = await compute(
      'database',
      () => undefined,
      metricTablesOf({ tables: [] })
    );
    expect(r.sql).toEqual([]);
    expect(out.available).toBe(false);
    expect(out.tiles).toEqual([]);
    expect(out.skipped).toEqual(
      expect.arrayContaining([
        'dbConnections',
        'dbConnectionMax',
        'dbConnectionUtilization',
        'dbCacheHitRatio',
        'largestTables',
      ])
    );
  });

  describe('gauges', () => {
    it('tile the latest bucket of each window, scaled, with a per-bucket sparkline', async () => {
      const { out } = await compute(
        'host',
        byTable([
          [
            'system_memory_utilization_ratio',
            series([
              [T('20:30'), '', 0.4],
              [T('20:59'), '', 0.5],
              [T('21:10'), '', 0.6],
              [T('21:59'), '', 0.925],
            ]),
          ],
        ])
      );
      const memory = tile(out, 'memoryUtilization')!;
      expect(memory.value).toBe(92.5);
      expect(memory.previous).toBe(50);
      expect(memory.unit).toBe('%');
      expect(memory.sparkline).toHaveLength(60);
      expect(memory.sparkline[10]).toBe(60);
      expect(memory.sparkline[59]).toBe(92.5);
      expect(memory.sparkline[0]).toBeNull();

      const s = out.series.find((x) => x.key === 'memoryUtilization')!;
      expect(s).toMatchObject({ dimension: null, groupBy: null, unit: '%' });
      expect(s.points[59]).toEqual({ t: '2026-09-27T21:59:00.000Z', v: 92.5 });
    });

    it('combine groups with the tile aggregate and split series by group', async () => {
      const { out } = await compute(
        'host',
        byTable([
          [
            'system_filesystem_utilization_ratio',
            series([
              [T('21:59'), '/', 0.5],
              [T('21:59'), '/data', 0.875],
            ]),
          ],
        ])
      );
      expect(tile(out, 'filesystemUtilization')!.value).toBe(87.5);
      const fs = out.series.filter((x) => x.key === 'filesystemUtilization');
      expect(fs.map((x) => [x.dimension, x.groupBy])).toEqual([
        ['mountpoint', '/'],
        ['mountpoint', '/data'],
      ]);
    });

    it('ignore a group that stopped reporting (delta gauges), and read a missing tile group as 0', async () => {
      const { out } = await compute(
        'queue',
        byTable([
          [
            'app_jobs_queue_depth',
            series([
              [T('21:20'), 'running', 4], // drained since 21:20
              [T('21:58'), 'pending', 7],
              [T('21:59'), 'pending', 6],
            ]),
          ],
          [
            'app_jobs_oldest_pending_age_seconds',
            series([
              [T('21:10'), 'report.pdf', 5000], // drained type: not the current oldest
              [T('21:59'), 'export.csv', 120],
            ]),
          ],
        ])
      );
      expect(tile(out, 'queueDepth.pending')!.value).toBe(6);
      expect(tile(out, 'queueDepth.running')!.value).toBe(0);
      expect(tile(out, 'oldestPendingAge')!.value).toBe(120);
    });

    it('turn a Unix-seconds instant into an age in hours', async () => {
      const lastBackup = (TO.getTime() - 30 * 3_600_000) / 1000;
      const { out } = await compute(
        'queue',
        byTable([
          ['app_backup_last_success_timestamp_seconds', series([[T('21:59'), '', lastBackup]])],
        ])
      );
      expect(tile(out, 'backupAge')!.value).toBe(30);
    });

    it('count groups for countPositive / countZero tiles', async () => {
      const { out } = await compute(
        'pipeline',
        byTable([
          [
            'up',
            series([
              [T('21:59'), 'dead', 0],
              [T('21:59'), 'greptimedb', 1],
              [T('21:59'), 'otelcol-contrib', 1],
            ]),
          ],
        ])
      );
      expect(tile(out, 'scrapeTargetsDown')!.value).toBe(1);
    });

    it('cut a family at METRIC_MAX_GROUPS groups and flag truncation', async () => {
      const rows = Array.from(
        { length: METRIC_MAX_GROUPS + 1 },
        (_, i) => [T('21:59'), `/m${String(i).padStart(2, '0')}`, 0.1] as [string, string, number]
      );
      const { out } = await compute(
        'host',
        byTable([['system_filesystem_utilization_ratio', series(rows)]])
      );
      expect(out.series.filter((x) => x.key === 'filesystemUtilization')).toHaveLength(
        METRIC_MAX_GROUPS
      );
      expect(out.truncated).toBe(true);
    });
  });

  describe('counters', () => {
    it('tile the window rate and chart the per-bucket rate', async () => {
      // 6,000 bytes in the current hour → 1.67 B/s; 3,600 in the previous → 1 B/s.
      const { out } = await compute(
        'host',
        byTable([
          [
            'system_disk_io_bytes_total',
            series([
              [T('20:30'), 'read', 3600],
              [T('21:30'), 'read', 1200],
              [T('21:30'), 'write', 4800],
            ]),
          ],
        ])
      );
      const disk = tile(out, 'diskIo')!;
      expect(disk.value).toBe(1.67);
      expect(disk.previous).toBe(1);
      expect(disk.unit).toBe('bytes/s');
      expect(disk.sparkline[30]).toBe(100); // 6000 B in one 60 s bucket
      const read = out.series.find((x) => x.key === 'diskIo' && x.groupBy === 'read')!;
      expect(read.points[30].v).toBe(20);
    });

    it('report per-minute and count rates', async () => {
      const { out } = await compute(
        'queue',
        byTable([
          [
            'app_jobs_settled_total',
            series([
              [T('21:10'), 'succeeded', 114],
              [T('21:20'), 'failed', 6],
            ]),
          ],
        ])
      );
      expect(tile(out, 'jobsSettled')!.value).toBe(2);
      expect(tile(out, 'jobsSettled')!.unit).toBe('per_min');
      // failed / (succeeded + failed)
      expect(tile(out, 'jobFailureRatio')!.value).toBe(5);
    });

    it('is null, not zero, without any row in the window', async () => {
      const { out } = await compute('host', () => undefined);
      expect(tile(out, 'diskIo')).toMatchObject({ value: null, previous: null });
    });
  });

  describe('ratios', () => {
    it('divide the latest gauge values', async () => {
      const { out } = await compute(
        'database',
        byTable([
          ['postgresql_backends', series([[T('21:59'), '', 85]])],
          ['postgresql_connection_max', series([[T('21:59'), '', 100]])],
        ])
      );
      expect(tile(out, 'dbConnectionUtilization')!.value).toBe(85);
      expect(out.series.find((s) => s.key === 'dbConnectionUtilization')!.points[59].v).toBe(85);
    });

    it('divide counter increases over the window (hit / (hit + read))', async () => {
      const { out } = await compute(
        'database',
        byTable([
          ['postgresql_blks_hit_total', series([[T('21:30'), '', 990]])],
          ['postgresql_blks_read_total', series([[T('21:30'), '', 10]])],
        ])
      );
      expect(tile(out, 'dbCacheHitRatio')!.value).toBe(99);
    });

    it('is skipped when a family it needs is absent', async () => {
      const tables = metricTablesOf(metricCatalogSchema(['postgresql_backends']));
      const { out } = await compute('database', () => undefined, tables);
      expect(out.skipped).toEqual(
        expect.arrayContaining(['dbConnectionMax', 'dbConnectionUtilization'])
      );
      expect(tile(out, 'dbConnectionUtilization')).toBeUndefined();
    });
  });

  describe('histograms', () => {
    it('tile the quantile per window and add it per key to the job types table', async () => {
      const buckets = (period: string, g: string, counts: Array<[string, number]>) =>
        counts.map(([le, v]) => [period, g, le, v]);
      const { out } = await compute(
        'queue',
        byTable([
          [
            'app_jobs_duration_seconds_bucket',
            result(
              ['period', 'g', 'le', 'v'],
              [
                ...buckets('current', 'export.csv', [
                  ['1', 50],
                  ['2', 90],
                  ['4', 100],
                  ['inf', 100],
                ]),
                ...buckets('previous', 'export.csv', [
                  ['1', 100],
                  ['inf', 100],
                ]),
              ]
            ),
          ],
          ['app_jobs_queue_depth', latest([['pending', 'export.csv', 3, T('21:59')]]), /UNION ALL/],
        ])
      );
      expect(tile(out, 'jobDurationP95')).toMatchObject({
        value: 3,
        unit: 'seconds',
        sparkline: [],
      });
      expect(tile(out, 'jobDurationP95')!.previous).toBeCloseTo(0.95);
      const row = out.tables.find((t) => t.key === 'jobTypes')!.rows[0];
      expect(row).toMatchObject({ key: 'export.csv', pending: 3, durationP95Seconds: 3 });
    });
  });

  describe('tables', () => {
    it('build one row per key with scaled, derived and freshness columns', async () => {
      const { out } = await compute(
        'nodes',
        byTable([
          [
            'app_nodes_cpu_utilization',
            latest([
              ['cpuCores', 'node-a', 0.5, T('21:59')],
              ['heapUsedBytes', 'node-a', 50, T('21:59')],
              ['heapLimitBytes', 'node-a', 200, T('21:59')],
              ['stateDirFreeBytes', 'node-a', 10, T('21:59')],
              ['stateDirTotalBytes', 'node-a', 100, T('21:59')],
              ['cpuCores', 'node-b', 1.5, T('21:40')], // stale: older than the newest cpu reading by > 150 s
            ]),
            /UNION ALL/,
          ],
        ])
      );
      const nodes = out.tables.find((t) => t.key === 'nodes')!;
      expect(nodes.columns.map((c) => c.key)).toEqual([
        'key',
        'cpuCores',
        'rssBytes',
        'heapUsedBytes',
        'heapLimitBytes',
        'stateDirFreeBytes',
        'stateDirTotalBytes',
        'slotsUsed',
        'slotsTotal',
        'heapPct',
        'stateDirFreePct',
        'lastSeenAt',
      ]);
      expect(nodes.rows[0]).toMatchObject({
        key: 'node-a',
        cpuCores: 0.5,
        heapPct: 25,
        stateDirFreePct: 10,
        rssBytes: null,
      });
      expect(nodes.rows[0].lastSeenAt).toBe('2026-09-27T21:59:00.000Z');
      expect(nodes.rows[1]).toMatchObject({
        key: 'node-b',
        cpuCores: null,
        lastSeenAt: '2026-09-27T21:40:00.000Z',
      });
      expect(METRIC_FRESH_MS).toBe(150_000);
    });

    it('turn a boolean part into true/false', async () => {
      const { out } = await compute(
        'nodes',
        byTable([
          [
            'app_nodes_types_no_eligible_node',
            latest([
              ['noEligibleNode', 'export.csv', 1, T('21:59')],
              ['noEligibleNode', 'report.pdf', 0, T('21:59')],
            ]),
            /GROUP BY k ORDER BY k, m/,
          ],
        ])
      );
      expect(out.tables.find((t) => t.key === 'noEligibleNodeTypes')!.rows).toEqual([
        { key: 'export.csv', noEligibleNode: true, lastSeenAt: '2026-09-27T21:59:00.000Z' },
        { key: 'report.pdf', noEligibleNode: false, lastSeenAt: '2026-09-27T21:59:00.000Z' },
      ]);
    });

    it('join the uptime status, errors and latest readings per URL', async () => {
      const { out } = await compute(
        'uptime',
        byTable([
          [
            'httpcheck_status',
            result(
              ['k', 'last_at', 'last_ok_at', 'checks', 'ok_checks', 'ok_now', 'code'],
              [
                ['http://nginx/api/health/live', T('21:59'), T('21:59'), '120', '120', '1', '200'],
                ['http://nginx/bad', T('21:59'), null, '120', '0', '0', '503'],
                ['http://old/', T('21:30'), T('21:30'), '10', '10', '1', '200'], // no longer probed
              ]
            ),
          ],
          [
            'httpcheck_error',
            result(
              ['k', 'errors', 'message', 'at'],
              [['http://nginx/bad', '3', 'dial tcp: refused', T('21:58')]]
            ),
          ],
          [
            'httpcheck_duration_milliseconds',
            latest([['durationMs', 'http://nginx/api/health/live', 1.5, T('21:59')]]),
            /UNION ALL/,
          ],
        ])
      );
      const rows = out.tables.find((t) => t.key === 'uptimeTargets')!.rows;
      expect(rows.map((r) => [r.key, r.up, r.statusCode, r.failedChecks])).toEqual([
        ['http://nginx/api/health/live', true, '200', 0],
        ['http://nginx/bad', false, '503', 120],
        ['http://old/', false, '200', 0],
      ]);
      expect(rows[0].durationMs).toBe(1.5);
      expect(rows[1].lastError).toBe('dial tcp: refused');
    });

    it('cap rows at METRIC_TABLE_MAX_ROWS and flag truncation', async () => {
      const rows = Array.from(
        { length: METRIC_TABLE_MAX_ROWS + 1 },
        (_, i) =>
          ['up', `job-${String(i).padStart(3, '0')}`, 1, T('21:59')] as [
            string,
            string,
            number,
            string,
          ]
      );
      const { out } = await compute('pipeline', byTable([['up', latest(rows), /AS m/]]));
      expect(out.tables.find((t) => t.key === 'scrapeTargets')!.rows).toHaveLength(
        METRIC_TABLE_MAX_ROWS
      );
      expect(out.truncated).toBe(true);
    });

    it('cap largestTables at its own maxRows, not the default (#176)', async () => {
      const sized = (n: number) =>
        latest(
          Array.from(
            { length: n },
            (_, i) =>
              ['sizeBytes', `public.t${String(i).padStart(4, '0')}`, n - i, T('21:59')] as [
                string,
                string,
                number,
                string,
              ]
          )
        );
      // Past the default cap but within its own: every row kept, not truncated.
      const within = await compute(
        'database',
        byTable([['postgresql_table_size_bytes', sized(METRIC_TABLE_MAX_ROWS + 30)]])
      );
      expect(within.out.tables.find((t) => t.key === 'largestTables')!.rows).toHaveLength(
        METRIC_TABLE_MAX_ROWS + 30
      );
      expect(within.out.truncated).toBe(false);
      expect(within.runner.sql.find((s) => s.includes('postgresql_table_size_bytes'))).toMatch(
        new RegExp(`LIMIT ${LARGEST_TABLES_MAX_ROWS + 1}$`)
      );

      // Past its own cap: cut there and flagged.
      const beyond = await compute(
        'database',
        byTable([['postgresql_table_size_bytes', sized(LARGEST_TABLES_MAX_ROWS + 1)]])
      );
      expect(beyond.out.tables.find((t) => t.key === 'largestTables')!.rows).toHaveLength(
        LARGEST_TABLES_MAX_ROWS
      );
      expect(beyond.out.truncated).toBe(true);
    });

    it('keep the SQL order for a value-ordered table', async () => {
      const { out } = await compute(
        'database',
        byTable([
          [
            'postgresql_table_size_bytes',
            latest([
              ['sizeBytes', 'public.z', 900, T('21:59')],
              ['sizeBytes', 'public.a', 100, T('21:59')],
            ]),
          ],
        ])
      );
      expect(out.tables.find((t) => t.key === 'largestTables')!.rows.map((r) => r.key)).toEqual([
        'public.z',
        'public.a',
      ]);
    });
  });

  it('passes the host filter to collector-scraped families only', async () => {
    const { runner: r } = await compute('host', () => undefined, ALL, {
      host: 'vm1',
      service: 'api',
    });
    for (const sql of r.sql) {
      expect(sql).toContain(`"host_name" = 'vm1'`);
      expect(sql).not.toContain('"service_name"');
    }
  });
});
