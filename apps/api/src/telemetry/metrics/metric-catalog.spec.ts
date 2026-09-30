import { DASHBOARD_VERDICT_THRESHOLDS } from '../dashboard/telemetry-dashboard.verdict';
import { metricTableSchema, VERIFIED_METRIC_TAGS } from '../testing/metric-schema.fixture';
import {
  familiesOf,
  familyByKey,
  METRIC_FAMILIES,
  METRIC_GROUPS,
  METRIC_RATIOS,
  METRIC_TABLES,
  metricTablesOf,
  ratiosOf,
  tablesOf,
  tableWith,
} from './metric-catalog';

// =============================================================================
// The metric catalog's invariants (issue #126)
// =============================================================================

describe('metric catalog', () => {
  it('has unique keys across families, ratios and tables', () => {
    const keys = [...METRIC_FAMILIES, ...METRIC_RATIOS, ...METRIC_TABLES].map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(METRIC_GROUPS)('group %s has at least one family and one table', (group) => {
    expect(familiesOf(group).length).toBeGreaterThan(0);
    expect(tablesOf(group).length).toBeGreaterThan(0);
  });

  it('covers the required families of each group', () => {
    const keys = (group: (typeof METRIC_GROUPS)[number]) => [
      ...familiesOf(group).map((f) => f.key),
      ...ratiosOf(group).map((r) => r.key),
      ...tablesOf(group).map((t) => t.key),
    ];
    expect(keys('host')).toEqual(
      expect.arrayContaining([
        'cpuUtilization',
        'memoryUtilization',
        'load1m',
        'filesystemUtilization',
        'diskIo',
        'networkIo',
        'filesystems',
      ])
    );
    expect(keys('database')).toEqual(
      expect.arrayContaining([
        'dbConnections',
        'dbConnectionMax',
        'dbConnectionUtilization',
        'dbSize',
        'dbCommits',
        'dbRollbacks',
        'dbDeadlocks',
        'dbCacheHitRatio',
        'largestTables',
      ])
    );
    expect(keys('queue')).toEqual(
      expect.arrayContaining([
        'queueDepth',
        'oldestPendingAge',
        'jobsSettled',
        'jobFailureRatio',
        'jobDurationP95',
        'backupAge',
        'jobTypes',
      ])
    );
    expect(keys('nodes')).toEqual(
      expect.arrayContaining(['nodesByHealth', 'noEligibleNode', 'nodes', 'noEligibleNodeTypes'])
    );
    expect(keys('uptime')).toEqual(
      expect.arrayContaining([
        'httpDuration',
        'tlsDaysLeft',
        'nginxRequests',
        'nginxConnections',
        'uptimeTargets',
      ])
    );
    expect(keys('pipeline')).toEqual(
      expect.arrayContaining([
        'exporterSent',
        'exporterFailed',
        'exporterQueueUtilization',
        'receiverRefused',
        'greptimeWriteStalls',
        'scrapeTargetsDown',
        'scrapeTargets',
      ])
    );
  });

  it.each(METRIC_FAMILIES.map((f) => [f.key, f] as const))(
    'family %s reads only columns the verified table has',
    (_key, family) => {
      const tags = VERIFIED_METRIC_TAGS[family.table];
      expect(tags).toBeDefined();
      const used = [
        ...family.requiredColumns,
        family.groupBy,
        ...(family.where ?? []).map((p) => p.column),
      ].filter((c): c is string => !!c);
      for (const column of used) expect(tags).toContain(column);
      if (family.kind === 'histogram') expect(tags).toContain('le');
    }
  );

  it('uses the kind the table name implies (`_total` counters, `_bucket` histograms)', () => {
    for (const family of METRIC_FAMILIES) {
      if (family.table.endsWith('_total')) expect(family.kind).toBe('counter');
      else if (family.table.endsWith('_bucket')) expect(family.kind).toBe('histogram');
      else expect(family.kind).toBe('gauge');
    }
  });

  it('never applies the service filter to collector-scraped tables', () => {
    for (const family of METRIC_FAMILIES) {
      if (!family.table.startsWith('app_')) expect(family.filters).toEqual(['host']);
      else expect(family.filters).toEqual(['service', 'instance']);
    }
  });

  it('builds ratios from families of the same group', () => {
    for (const ratio of METRIC_RATIOS) {
      for (const ref of [...ratio.numerator, ...ratio.denominator]) {
        expect(familyByKey(ref.family)?.group).toBe(ratio.group);
      }
    }
  });

  it.each(METRIC_TABLES.map((t) => [t.key, t] as const))(
    'table %s reads verified tables and columns',
    (_key, spec) => {
      for (const part of spec.parts) {
        const tags = VERIFIED_METRIC_TAGS[part.table];
        expect(tags).toBeDefined();
        expect(tags).toContain(spec.keyColumn);
        for (const column of [
          ...(part.requiredColumns ?? []),
          ...(part.where ?? []).map((w) => w.column),
        ]) {
          expect(tags).toContain(column);
        }
      }
      for (const derived of spec.derived ?? []) {
        expect(spec.parts.map((p) => p.column)).toEqual(
          expect.arrayContaining([derived.numerator, derived.denominator])
        );
      }
      if (spec.histogram) expect(familyByKey(spec.histogram.family)?.kind).toBe('histogram');
      if (spec.orderByValue) expect(spec.parts).toHaveLength(1);
    }
  );

  it('declares the verdict thresholds of DASHBOARD_VERDICT_THRESHOLDS', () => {
    const t = DASHBOARD_VERDICT_THRESHOLDS;
    expect(familyByKey('filesystemUtilization')?.verdict).toEqual({
      ...t.diskUtilizationPct,
      direction: 'above',
    });
    expect(familyByKey('memoryUtilization')?.verdict).toEqual({
      ...t.memoryUtilizationPct,
      direction: 'above',
    });
    expect(familyByKey('tlsDaysLeft')?.verdict).toEqual({ ...t.tlsDaysLeft, direction: 'below' });
    expect(familyByKey('backupAge')?.verdict).toEqual({ ...t.backupAgeHours, direction: 'above' });
    expect(familyByKey('oldestPendingAge')?.verdict).toEqual({
      degraded: 600,
      critical: 1800,
      direction: 'above',
    });
    expect(METRIC_RATIOS.find((r) => r.key === 'dbConnectionUtilization')?.verdict).toEqual({
      ...t.dbConnectionsPct,
      direction: 'above',
    });
  });

  describe('metricTablesOf', () => {
    it('keeps metric tables with their tag columns, sorted', () => {
      const tables = metricTablesOf({
        tables: [
          metricTableSchema('system_cpu_utilization_ratio'),
          {
            name: 'opentelemetry_logs',
            rows: null,
            columns: [{ name: 'timestamp', type: 'timestamp', semanticType: 'TIMESTAMP' }],
          },
        ],
      });
      expect([...tables.keys()]).toEqual(['system_cpu_utilization_ratio']);
      expect(tables.get('system_cpu_utilization_ratio')?.tags).toEqual([
        'cpu',
        'host_name',
        'state',
      ]);
    });

    it('treats every other column as a tag when the store reports no semantic types', () => {
      const tables = metricTablesOf({
        tables: [
          {
            name: 'up',
            rows: null,
            columns: ['greptime_timestamp', 'greptime_value', 'job', 'instance'].map((name) => ({
              name,
              type: 'string',
              semanticType: null,
            })),
          },
        ],
      });
      expect(tables.get('up')?.tags).toEqual(['instance', 'job']);
    });

    it('tableWith needs every required column', () => {
      const tables = metricTablesOf({ tables: [metricTableSchema('up')] });
      expect(tableWith(tables, 'up', ['job'])).not.toBeNull();
      expect(tableWith(tables, 'up', ['nope'])).toBeNull();
      expect(tableWith(tables, 'absent', [])).toBeNull();
    });
  });
});
