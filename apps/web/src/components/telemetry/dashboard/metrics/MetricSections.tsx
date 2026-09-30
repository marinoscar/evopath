/**
 * The Telemetry Dashboard's infrastructure sections — issue #127, epic #576.
 *
 * Six first-class sections, one per `/metrics` group (#126): Infrastructure
 * (host), Database, Job queue, Worker nodes, Uptime & dependencies and
 * Telemetry pipeline. Each is its own `DashboardPanel` over its own request
 * (`useDashboardMetrics`), so it loads, fails and retries alone, and carries
 * the same header actions as every other panel ("Ask assistant", "Open in
 * Explorer" with the group's FIRST statement — loaded, never run).
 *
 * What a section shows is declared below ({@link SECTION_SPECS}): which tiles,
 * which series go in one chart, which tables with which columns. Anything the
 * response lacks — a table not collected in this store, a skipped family — is
 * simply left out; a group the store has nothing of (`available: false`) hides
 * the whole section, and the page says so in one line.
 *
 * The API decides every value, threshold and row; this only presents them.
 */
import type { ReactNode } from 'react';
import { Grid, Stack, Typography, useTheme, type Theme } from '@mui/material';
import type { DashboardResource } from '../../../../hooks/useTelemetryDashboard';
import type {
  DashboardMetricGroup,
  DashboardMetricSeries,
  DashboardMetricTable,
  DashboardMetrics,
  DashboardTile,
} from '../../../../services/telemetryDashboard';
import type { AssistantPanelContext } from '../assistantPrompt';
import { DashboardPanel, type PanelAction } from '../DashboardPanel';
import type { DashboardLayout } from '../DashboardFilterBar';
import { KpiTiles } from '../KpiTiles';
import { MetricSeriesChart } from './MetricSeriesChart';
import {
  MetricTable,
  StatusCell,
  UtilizationBar,
  type MetricTableColumnSpec,
  type MetricTableTopN,
} from './MetricTable';
import { metricPanelId, metricSectionAnchor, metricSectionTitle } from './metricSections';

type Row = DashboardMetricTable['rows'][number];

interface ChartSpec {
  title: string;
  /** Series keys, in legend order; every series of a key (one per `groupBy`) is drawn. */
  keys: string[];
  /** Fixed colours per `groupBy` value (the settle outcomes). */
  colors?: Record<string, (theme: Theme) => string>;
}

interface TableSpec {
  key: string;
  columns?: MetricTableColumnSpec[];
  sortRows?: (a: Row, b: Row) => number;
  /** Offer a "Top N" row limit (applied after `sortRows`). */
  topN?: MetricTableTopN;
}

interface SectionSpec {
  tiles: string[];
  charts: ChartSpec[];
  tables: TableSpec[];
}

/** Failing rows first (`up === false`, `noEligibleNode === true`); stable otherwise. */
const problemsFirst = (a: Row, b: Row) =>
  Number(b.up === false || b.noEligibleNode === true) - Number(a.up === false || a.noEligibleNode === true);

const upStatus: MetricTableColumnSpec = {
  key: 'up',
  requires: ['up'],
  render: (row) => <StatusCell ok={row.up} okText="Up" badText="Down" />,
};

export const SECTION_SPECS: Record<DashboardMetricGroup, SectionSpec> = {
  host: {
    tiles: ['cpuUtilization', 'memoryUtilization', 'load1m', 'filesystemUtilization'],
    charts: [{ title: 'CPU and memory utilization', keys: ['cpuUtilization', 'memoryUtilization'] }],
    tables: [
      {
        key: 'filesystems',
        columns: [
          { key: 'key' },
          {
            key: 'utilizationPct',
            requires: ['utilizationPct'],
            render: (row, column) => (
              <UtilizationBar value={row.utilizationPct} label={`${column?.label ?? 'Used'} on ${String(row.key)}`} />
            ),
          },
          { key: 'usedBytes' },
          { key: 'freeBytes' },
          { key: 'lastSeenAt' },
        ],
      },
    ],
  },
  database: {
    tiles: ['dbConnectionUtilization', 'dbSize', 'dbCommits', 'dbCacheHitRatio'],
    charts: [{ title: 'Connections and the connection limit', keys: ['dbConnections', 'dbConnectionMax'] }],
    tables: [{ key: 'largestTables', topN: { options: [10, 20, 50, 'all'], default: 10 } }],
  },
  queue: {
    tiles: ['queueDepth.pending', 'oldestPendingAge', 'jobFailureRatio', 'jobDurationP95', 'backupAge'],
    charts: [
      {
        title: 'Jobs settled per minute by outcome',
        keys: ['jobsSettled'],
        colors: {
          succeeded: (theme) => theme.palette.success.main,
          failed: (theme) => theme.palette.error.main,
        },
      },
    ],
    tables: [{ key: 'jobTypes' }],
  },
  nodes: {
    tiles: ['nodesByHealth.healthy', 'nodesByHealth.stale', 'nodesByHealth.offline', 'noEligibleNode'],
    charts: [],
    tables: [
      {
        key: 'nodes',
        columns: [
          { key: 'key' },
          { key: 'cpuCores' },
          { key: 'rssBytes' },
          {
            key: 'heapPct',
            requires: ['heapPct'],
            render: (row, column) => (
              <UtilizationBar value={row.heapPct} label={`${column?.label ?? 'Heap used'} on ${String(row.key)}`} />
            ),
          },
          { key: 'stateDirFreePct' },
          {
            key: 'slots',
            label: 'Slots used',
            requires: ['slotsUsed', 'slotsTotal'],
            render: (row) =>
              row.slotsUsed === null && row.slotsTotal === null
                ? '—'
                : `${typeof row.slotsUsed === 'number' ? row.slotsUsed : '—'} / ${typeof row.slotsTotal === 'number' ? row.slotsTotal : '—'}`,
          },
          { key: 'lastSeenAt' },
        ],
      },
      {
        key: 'noEligibleNodeTypes',
        sortRows: problemsFirst,
        columns: [
          { key: 'key' },
          {
            key: 'noEligibleNode',
            label: 'Eligible node',
            requires: ['noEligibleNode'],
            render: (row) => (
              <StatusCell
                ok={typeof row.noEligibleNode === 'boolean' ? !row.noEligibleNode : null}
                okText="Available"
                badText="None eligible"
              />
            ),
          },
          { key: 'lastSeenAt' },
        ],
      },
    ],
  },
  uptime: {
    tiles: ['nginxConnections.active', 'nginxRequests', 'tlsDaysLeft', 'httpDuration'],
    charts: [{ title: 'nginx connections by state', keys: ['nginxConnections'] }],
    tables: [
      {
        key: 'uptimeTargets',
        sortRows: problemsFirst,
        columns: [
          { key: 'key' },
          upStatus,
          { key: 'statusCode' },
          { key: 'durationMs' },
          { key: 'tlsDaysLeft' },
          { key: 'failedChecks' },
          { key: 'checks' },
          { key: 'lastError' },
          { key: 'lastSeenAt' },
        ],
      },
    ],
  },
  pipeline: {
    tiles: ['exporterFailed', 'exporterQueueUtilization', 'receiverRefused', 'scrapeTargetsDown'],
    charts: [],
    tables: [{ key: 'scrapeTargets', sortRows: problemsFirst, columns: [{ key: 'key' }, upStatus, { key: 'lastSeenAt' }] }],
  },
};

/** The section's tiles, in the spec's order, that the response carries. */
export function sectionTiles(group: DashboardMetricGroup, data: DashboardMetrics): DashboardTile[] {
  const byKey = new Map(data.tiles.map((tile) => [tile.key, tile]));
  return SECTION_SPECS[group].tiles.flatMap((key) => {
    const tile = byKey.get(key);
    return tile ? [tile] : [];
  });
}

/** The section's tables, in the spec's order, that the response carries. */
export function sectionTables(group: DashboardMetricGroup, data: DashboardMetrics): DashboardMetricTable[] {
  return SECTION_SPECS[group].tables.flatMap((spec) => data.tables.filter((table) => table.key === spec.key));
}

function chartSeries(chart: ChartSpec, data: DashboardMetrics): DashboardMetricSeries[] {
  return chart.keys.flatMap((key) => data.series.filter((series) => series.key === key));
}

/** What "Ask assistant" describes for a section. */
export function metricsAssistantContext(group: DashboardMetricGroup, data: DashboardMetrics): AssistantPanelContext {
  return {
    kind: 'metrics',
    title: metricSectionTitle(group),
    group,
    tiles: sectionTiles(group, data),
    tables: sectionTables(group, data),
    skipped: data.skipped,
  };
}

function SectionBody({
  group,
  data,
  layout,
  spanMs,
  now,
}: {
  group: DashboardMetricGroup;
  data: DashboardMetrics;
  layout: DashboardLayout;
  spanMs: number;
  now?: number;
}) {
  const theme = useTheme();
  const spec = SECTION_SPECS[group];
  const tiles = sectionTiles(group, data);
  const charts = spec.charts
    .map((chart) => ({ chart, series: chartSeries(chart, data) }))
    .filter(({ series }) => series.length > 0);
  const tables = spec.tables.flatMap((tableSpec) =>
    data.tables.filter((table) => table.key === tableSpec.key).map((table) => ({ table, tableSpec })),
  );
  const both = charts.length > 0 && tables.length > 0;
  const compact = layout === 'phone';

  const notes: ReactNode[] = [];
  if (data.skipped.length > 0) {
    notes.push(
      <span key="skipped" title={data.skipped.join(', ')}>
        {data.skipped.length === 1
          ? '1 metric of this section is not collected in this store.'
          : `${data.skipped.length} metrics of this section are not collected in this store.`}
      </span>,
    );
  }
  if (data.truncated) notes.push(<span key="truncated">Some lists were cut short.</span>);

  return (
    <Stack spacing={{ xs: 1.5, sm: 2 }} sx={{ minWidth: 0 }}>
      {tiles.length > 0 && <KpiTiles tiles={tiles} now={now} testId={`metric-tiles-${group}`} />}
      {(charts.length > 0 || tables.length > 0) && (
        <Grid container spacing={{ xs: 1.5, sm: 2 }}>
          {charts.map(({ chart, series }) => (
            <Grid key={chart.title} size={{ xs: 12, lg: both ? 5 : 12 }} sx={{ minWidth: 0 }}>
              <MetricSeriesChart
                title={chart.title}
                series={series}
                height={compact ? 200 : 240}
                spanMs={spanMs}
                compact={compact}
                testId={`metric-chart-${group}`}
                colorFor={(s) => (s.groupBy && chart.colors?.[s.groupBy] ? chart.colors[s.groupBy](theme) : undefined)}
              />
            </Grid>
          ))}
          {tables.map(({ table, tableSpec }) => (
            <Grid key={table.key} size={{ xs: 12, lg: both ? 7 : 12 }} sx={{ minWidth: 0 }}>
              <MetricTable
                table={table}
                columns={tableSpec.columns}
                sortRows={tableSpec.sortRows}
                topN={tableSpec.topN}
                now={now}
              />
            </Grid>
          ))}
        </Grid>
      )}
      {notes.length > 0 && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {notes}
        </Typography>
      )}
    </Stack>
  );
}

/** Whether a section has anything to draw for the response. */
export function sectionHasContent(group: DashboardMetricGroup, data: DashboardMetrics): boolean {
  const spec = SECTION_SPECS[group];
  return (
    sectionTiles(group, data).length > 0 ||
    spec.charts.some((chart) => chartSeries(chart, data).length > 0) ||
    sectionTables(group, data).length > 0
  );
}

export interface MetricSectionProps {
  group: DashboardMetricGroup;
  resource: DashboardResource<DashboardMetrics>;
  actions: PanelAction[];
  layout: DashboardLayout;
  spanMs: number;
  /** For relative times; the page's clock. */
  now?: number;
}

/**
 * One infrastructure section. Hidden entirely once the API says the group is
 * not `available`; until the first answer it shows the panel's skeleton, and a
 * failure is this section's own (Retry refetches it alone).
 */
export function MetricSection({ group, resource, actions, layout, spanMs, now }: MetricSectionProps) {
  const { data } = resource;
  if (data && !data.available) return null;
  return (
    <DashboardPanel
      id={metricPanelId(group)}
      anchorId={metricSectionAnchor(group)}
      title={metricSectionTitle(group)}
      actions={actions}
      sql={data?.sql}
      isLoading={resource.isLoading}
      isRefreshing={resource.isRefreshing}
      error={resource.error}
      onRetry={resource.reload}
      isEmpty={!!data && !sectionHasContent(group, data)}
      emptyMessage="Nothing collected for this section in this window."
      skeletonHeight={200}
    >
      {data && <SectionBody group={group} data={data} layout={layout} spanMs={spanMs} now={now} />}
    </DashboardPanel>
  );
}

/**
 * The one-line hint for the groups the store has nothing of (#127): their
 * sections are hidden, so say which, rather than leave the reader wondering.
 */
export function MetricsNotCollected({ groups }: { groups: DashboardMetricGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <Typography variant="caption" color="text.secondary" component="p" data-testid="metrics-not-collected" sx={{ m: 0 }}>
      Not collected in this telemetry store: {groups.map(metricSectionTitle).join(', ')}.
    </Typography>
  );
}
