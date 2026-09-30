/**
 * The six infrastructure sections (issue #127): what each shows for an
 * available group, and the unavailable / skipped / empty / loading / error
 * states every section shares.
 */
import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AddIcon from '@mui/icons-material/Add';
import { render } from '../../../../utils/test-utils';
import {
  MetricSection,
  MetricsNotCollected,
  metricsAssistantContext,
  sectionHasContent,
} from '../../../../../components/telemetry/dashboard/metrics/MetricSections';
import type { DashboardResource } from '../../../../../hooks/useTelemetryDashboard';
import type { DashboardMetricGroup, DashboardMetrics } from '../../../../../services/telemetryDashboard';
import { mockDashboardMetrics } from '../../../../mocks/fixtures/telemetryDashboard';

const NOW = Date.parse('2026-09-27T11:00:00.000Z');

function resource(overrides: Partial<DashboardResource<DashboardMetrics>> = {}): DashboardResource<DashboardMetrics> {
  return {
    data: null,
    error: null,
    isLoading: false,
    isRefreshing: false,
    fetchedAt: null,
    reload: vi.fn(),
    ...overrides,
  };
}

function renderSection(group: DashboardMetricGroup, res: DashboardResource<DashboardMetrics>, onClick = vi.fn()) {
  render(
    <MetricSection
      group={group}
      resource={res}
      layout="desktop"
      spanMs={3_600_000}
      now={NOW}
      actions={[{ key: 'open', label: 'Open in Explorer', icon: <AddIcon />, onClick }]}
    />,
  );
  return onClick;
}

const loaded = (group: DashboardMetricGroup, patch: Partial<DashboardMetrics> = {}) =>
  resource({ data: { ...mockDashboardMetrics[group], ...patch } });

describe('MetricSection — per group', () => {
  it('Infrastructure: CPU/memory/load/worst-disk tiles, a CPU and memory chart, filesystems with a bar', () => {
    renderSection('host', loaded('host'));
    const region = screen.getByRole('region', { name: 'Infrastructure' });
    expect(region).toHaveAttribute('id', 'telemetry-section-host');
    const tiles = within(region).getByTestId('metric-tiles-host');
    expect(within(tiles).getByTestId('tile-cpuUtilization')).toHaveTextContent('24.1');
    expect(within(tiles).getByTestId('tile-load1m')).toHaveTextContent('0.82');
    expect(within(tiles).getByTestId('tile-filesystemUtilization')).toHaveTextContent('91.2');
    // Only the declared tiles: disk IO is in the response but not a headline.
    expect(within(tiles).queryByTestId('tile-diskIo')).not.toBeInTheDocument();
    expect(within(region).getByRole('img', { name: /^CPU and memory utilization: CPU utilization, Memory utilization/ })).toBeInTheDocument();
    const table = within(region).getByRole('table', { name: 'Filesystems' });
    expect(within(table).getByRole('progressbar', { name: 'Used on /' })).toBeInTheDocument();
    expect(table).toHaveTextContent('45 GB');
    // Skipped families are named in a note, never an error.
    expect(region).toHaveTextContent('1 metric of this section is not collected in this store.');
  });

  it('Database: connections %, size, commits/s, cache hit; connections chart; largest tables', () => {
    renderSection('database', loaded('database'));
    const region = screen.getByRole('region', { name: 'Database' });
    expect(within(region).getByTestId('tile-dbConnectionUtilization')).toHaveTextContent('42%');
    expect(within(region).getByTestId('tile-dbSize')).toHaveTextContent('512MB');
    expect(within(region).getByTestId('tile-dbCommits')).toHaveTextContent('12.5/s');
    expect(within(region).getByTestId('tile-dbCacheHitRatio')).toHaveTextContent('99.1');
    expect(within(region).getByRole('img', { name: /Connections, Max connections/ })).toBeInTheDocument();
    expect(within(region).getByRole('table', { name: 'Largest tables' })).toHaveTextContent('300 MB');
  });

  it('Job queue: depth, oldest pending, failure ratio, p95, backup age; settle-rate chart; job types', () => {
    renderSection('queue', loaded('queue'));
    const region = screen.getByRole('region', { name: 'Job queue' });
    for (const key of ['queueDepth.pending', 'oldestPendingAge', 'jobFailureRatio', 'jobDurationP95', 'backupAge']) {
      expect(within(region).getByTestId(`tile-${key}`)).toBeInTheDocument();
    }
    expect(within(region).getByTestId('tile-oldestPendingAge')).toHaveTextContent('15min');
    expect(within(region).getByTestId('tile-backupAge')).toHaveTextContent('30h');
    expect(within(region).getByRole('img', { name: /by outcome: succeeded, failed/ })).toBeInTheDocument();
    expect(within(region).getByRole('table', { name: 'Job types' })).toHaveTextContent('export.csv');
  });

  it('Worker nodes: health tiles, a node table and the types with no eligible node — in words', () => {
    renderSection('nodes', loaded('nodes'));
    const region = screen.getByRole('region', { name: 'Worker nodes' });
    expect(within(region).getByTestId('tile-nodesByHealth.stale')).toHaveTextContent('1');
    const nodes = within(region).getByRole('table', { name: 'Nodes' });
    expect(within(nodes).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Node',
      'CPU',
      'RSS',
      'Heap used',
      'Disk free',
      'Slots used',
      'Last reading',
    ]);
    expect(nodes).toHaveTextContent('0.35 cores');
    expect(within(nodes).getByRole('progressbar', { name: 'Heap used on worker-a' })).toBeInTheDocument();
    expect(nodes).toHaveTextContent('25%');
    expect(nodes).toHaveTextContent('2 / 4');
    const types = within(region).getByRole('table', { name: 'Node-offered job types' });
    const rows = within(types).getAllByRole('row').slice(1);
    // The type with no eligible node comes first, and says so.
    expect(rows[0]).toHaveTextContent('media.transcode');
    expect(rows[0]).toHaveTextContent('None eligible');
    expect(rows[1]).toHaveTextContent('Available');
    expect(within(region).queryByRole('img')).not.toBeInTheDocument();
  });

  it('Uptime & dependencies: failing URLs first as "Down", latency, TLS days; nginx chart', () => {
    renderSection('uptime', loaded('uptime'));
    const region = screen.getByRole('region', { name: 'Uptime & dependencies' });
    const table = within(region).getByRole('table', { name: 'Uptime targets' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('https://app.example.com/');
    expect(rows[0]).toHaveTextContent('Down');
    expect(rows[0]).toHaveTextContent('503');
    expect(rows[0]).toHaveTextContent('12 days');
    expect(rows[0]).toHaveTextContent('connection refused');
    expect(rows[1]).toHaveTextContent('Up');
    expect(within(region).getByRole('img', { name: /nginx connections by state: active, waiting/ })).toBeInTheDocument();
    expect(within(region).getByTestId('tile-tlsDaysLeft')).toHaveTextContent('12days');
  });

  it('Telemetry pipeline: export failures, queue fill, refused; per-job up table', () => {
    const data: DashboardMetrics = {
      ...mockDashboardMetrics.pipeline,
      available: true,
      sql: ['SELECT /* pipeline */ 1'],
      skipped: [],
      tiles: [
        { key: 'exporterFailed', label: 'Metric points failed', value: 12, previous: 0, unit: 'count', sparkline: [] },
        { key: 'exporterQueueUtilization', label: 'Exporter queue used', value: 5, previous: 1, unit: '%', sparkline: [] },
        { key: 'receiverRefused', label: 'Metric points refused', value: 0, previous: 0, unit: 'count', sparkline: [] },
      ],
      tables: [
        {
          key: 'scrapeTargets',
          label: 'Scrape targets',
          columns: [
            { key: 'key', label: 'Scrape job', unit: 'text' },
            { key: 'up', label: 'Up', unit: 'boolean' },
            { key: 'lastSeenAt', label: 'Last reading', unit: 'timestamp' },
          ],
          rows: [
            { key: 'greptimedb', up: true, lastSeenAt: null },
            { key: 'postgres', up: false, lastSeenAt: null },
          ],
        },
      ],
    };
    renderSection('pipeline', resource({ data }));
    const region = screen.getByRole('region', { name: 'Telemetry pipeline' });
    expect(within(region).getByTestId('tile-exporterFailed')).toHaveTextContent('12');
    const rows = within(within(region).getByRole('table', { name: 'Scrape targets' })).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('postgresDown');
    expect(rows[1]).toHaveTextContent('greptimedbUp');
  });
});

describe('MetricSection — states', () => {
  it('is hidden entirely when the group is not available', () => {
    renderSection('pipeline', loaded('pipeline'));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('shows a skeleton before the first answer', () => {
    renderSection('database', resource({ isLoading: true }));
    expect(screen.getByRole('region', { name: 'Database' })).toBeInTheDocument();
    expect(screen.getByTestId('panel-metrics-database-skeleton')).toBeInTheDocument();
  });

  it('shows its own error with a Retry that reloads it alone', async () => {
    const res = resource({
      error: { message: 'The statement timed out', reason: 'TELEMETRY_QUERY_TIMEOUT' } as DashboardResource<DashboardMetrics>['error'],
    });
    renderSection('queue', res);
    const region = screen.getByRole('region', { name: 'Job queue' });
    expect(region).toHaveTextContent('The statement timed out');
    await userEvent.setup().click(within(region).getByRole('button', { name: 'Retry' }));
    expect(res.reload).toHaveBeenCalledTimes(1);
  });

  it('says so when an available group has nothing to draw', () => {
    renderSection('database', loaded('database', { tiles: [], series: [], tables: [] }));
    expect(screen.getByRole('region', { name: 'Database' })).toHaveTextContent(
      'Nothing collected for this section in this window.',
    );
    expect(sectionHasContent('database', { ...mockDashboardMetrics.database, tiles: [], series: [], tables: [] })).toBe(false);
  });

  it('leaves out what was skipped and notes a truncated list', () => {
    renderSection('database', loaded('database', { tables: [], skipped: ['largestTables', 'dbDeadlocks'], truncated: true }));
    const region = screen.getByRole('region', { name: 'Database' });
    expect(within(region).queryByRole('table')).not.toBeInTheDocument();
    expect(region).toHaveTextContent('2 metrics of this section are not collected in this store.');
    expect(region).toHaveTextContent('Some lists were cut short.');
  });

  it("hands the group's statements to its actions", async () => {
    const onClick = renderSection('host', loaded('host'));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open in Explorer' }));
    expect(onClick).toHaveBeenCalledWith(mockDashboardMetrics.host.sql);
  });
});

describe('helpers', () => {
  it('MetricsNotCollected names the hidden sections, or renders nothing', () => {
    const { rerender } = render(<MetricsNotCollected groups={['database', 'pipeline']} />);
    expect(screen.getByTestId('metrics-not-collected')).toHaveTextContent(
      'Not collected in this telemetry store: Database, Telemetry pipeline.',
    );
    rerender(<MetricsNotCollected groups={[]} />);
    expect(screen.queryByTestId('metrics-not-collected')).not.toBeInTheDocument();
  });

  it('metricsAssistantContext describes the section as shown', () => {
    const context = metricsAssistantContext('host', mockDashboardMetrics.host);
    expect(context).toMatchObject({ kind: 'metrics', title: 'Infrastructure', group: 'host', skipped: ['networkIo'] });
    if (context.kind !== 'metrics') throw new Error('unreachable');
    expect(context.tiles.map((tile) => tile.key)).toEqual(['cpuUtilization', 'memoryUtilization', 'load1m', 'filesystemUtilization']);
    expect(context.tables.map((table) => table.key)).toEqual(['filesystems']);
  });
});
