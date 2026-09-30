/**
 * `MetricTable` and its cells (issue #127): labelled by its caption, cells
 * formatted by column unit, `null` → "—", status as icon + word, virtual and
 * missing columns.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../../utils/test-utils';
import {
  MetricTable,
  StatusCell,
  UtilizationBar,
} from '../../../../../components/telemetry/dashboard/metrics/MetricTable';
import { topNStorageKey } from '../../../../../components/telemetry/dashboard/metrics/topNPreference';
import type { DashboardMetricTable } from '../../../../../services/telemetryDashboard';
import { mockDashboardMetrics } from '../../../../mocks/fixtures/telemetryDashboard';

const NOW = Date.parse('2026-09-27T11:00:00.000Z');

describe('MetricTable', () => {
  it('renders every column by unit, labelled by the table label', () => {
    render(<MetricTable table={mockDashboardMetrics.queue.tables[0]} now={NOW} />);
    const table = screen.getByRole('table', { name: 'Job types' });
    const headers = within(table).getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toEqual(['Job type', 'Pending', 'Running', 'Oldest pending', 'Succeeded', 'Failed', 'Duration p95', 'Last reading']);
    const row = within(table).getByRole('row', { name: /export\.csv/ });
    expect(within(row).getByRole('rowheader')).toHaveTextContent('export.csv');
    expect(row).toHaveTextContent('15 min');
    expect(row).toHaveTextContent('4.2 s');
    expect(row).toHaveTextContent('30s ago');
    // A null cell reads "—".
    expect(within(table).getByRole('row', { name: /db\.backup/ })).toHaveTextContent('—');
  });

  it('draws only the requested columns the response has, plus virtual ones', () => {
    const nodes = mockDashboardMetrics.nodes.tables[0];
    render(
      <MetricTable
        table={nodes}
        now={NOW}
        columns={[
          { key: 'key' },
          { key: 'rssBytes' },
          { key: 'notInTheResponse' },
          { key: 'slots', label: 'Slots used', requires: ['slotsUsed', 'slotsTotal'], render: (row) => `${String(row.slotsUsed)} / ${String(row.slotsTotal)}` },
          { key: 'ghost', label: 'Ghost', requires: ['missing'], render: () => 'x' },
        ]}
      />,
    );
    const table = screen.getByRole('table', { name: 'Nodes' });
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Node', 'RSS', 'Slots used']);
    expect(table).toHaveTextContent('256 MB');
    expect(table).toHaveTextContent('2 / 4');
  });

  it('sorts rows when asked and says so when a table is empty', () => {
    const targets = mockDashboardMetrics.uptime.tables[0];
    const { unmount } = render(
      <MetricTable table={targets} now={NOW} sortRows={(a, b) => Number(b.up === false) - Number(a.up === false)} />,
    );
    const rows = within(screen.getByRole('table', { name: 'Uptime targets' })).getAllByRole('rowheader');
    expect(rows[0]).toHaveTextContent('https://app.example.com/');
    unmount();

    render(<MetricTable table={{ ...targets, rows: [] }} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('Uptime targets: nothing reported in this window.')).toBeInTheDocument();
  });
});

describe('cells', () => {
  it('StatusCell says Up or Down in words, with an icon', () => {
    const { container, rerender } = render(<StatusCell ok okText="Up" badText="Down" />);
    expect(container).toHaveTextContent('Up');
    expect(container.querySelector('[data-testid="CheckCircleOutlinedIcon"]')).not.toBeNull();
    rerender(<StatusCell ok={false} okText="Up" badText="Down" />);
    expect(container).toHaveTextContent('Down');
    expect(container.querySelector('[data-testid="ErrorOutlineOutlinedIcon"]')).not.toBeNull();
    rerender(<StatusCell ok={null} okText="Up" badText="Down" />);
    expect(container).toHaveTextContent('—');
  });

  it('UtilizationBar carries its value as text and a labelled bar', () => {
    const { rerender } = render(<UtilizationBar value={91.2} label="Used on /" />);
    const bar = screen.getByRole('progressbar', { name: 'Used on /' });
    expect(bar).toHaveAttribute('aria-valuenow', '91.2');
    expect(screen.getByText('91.2%')).toBeInTheDocument();
    rerender(<UtilizationBar value={null} label="Used on /" />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

/** A "Largest tables" table of `count` rows, largest first (the API's order). */
function largestTables(count: number): DashboardMetricTable {
  return {
    key: 'largestTables',
    label: 'Largest tables',
    columns: [
      { key: 'key', label: 'Table', unit: 'text' },
      { key: 'sizeBytes', label: 'Size', unit: 'bytes' },
    ],
    rows: Array.from({ length: count }, (_, i) => ({ key: `table_${i + 1}`, sizeBytes: (count - i) * 1024 ** 2 })),
  };
}

const TOP_N = { options: [10, 20, 50, 'all'], default: 10 } as const;
const bodyRows = () => within(screen.getByRole('table', { name: 'Largest tables' })).getAllByRole('rowheader');

describe('MetricTable — Top N (#176)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('shows the default 10 of N, in server order, and says so', () => {
    render(<MetricTable table={largestTables(63)} topN={TOP_N} now={NOW} />);
    const rows = bodyRows();
    expect(rows).toHaveLength(10);
    expect(rows[0]).toHaveTextContent('table_1');
    expect(rows[9]).toHaveTextContent('table_10');
    expect(screen.getByRole('combobox', { name: 'Rows to show for Largest tables' })).toHaveTextContent('Top 10');
    expect(screen.getByText('Showing 10 of 63')).toBeInTheDocument();
  });

  it('Top 20 shows 20; All shows every row and drops the caption; the choice is stored', async () => {
    const user = userEvent.setup();
    render(<MetricTable table={largestTables(63)} topN={TOP_N} now={NOW} />);
    const select = screen.getByRole('combobox', { name: 'Rows to show for Largest tables' });

    await user.click(select);
    await user.click(screen.getByRole('option', { name: 'Top 20' }));
    expect(bodyRows()).toHaveLength(20);
    expect(screen.getByText('Showing 20 of 63')).toBeInTheDocument();
    expect(window.localStorage.getItem(topNStorageKey('largestTables'))).toBe('20');

    await user.click(select);
    await user.click(screen.getByRole('option', { name: 'All' }));
    expect(bodyRows()).toHaveLength(63);
    expect(screen.queryByTestId('metric-table-shown-largestTables')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(topNStorageKey('largestTables'))).toBe('all');
  });

  it('restores a stored choice and ignores one that is no longer offered', () => {
    window.localStorage.setItem(topNStorageKey('largestTables'), '50');
    const { unmount } = render(<MetricTable table={largestTables(63)} topN={TOP_N} now={NOW} />);
    expect(bodyRows()).toHaveLength(50);
    expect(screen.getByRole('combobox', { name: 'Rows to show for Largest tables' })).toHaveTextContent('Top 50');
    unmount();

    window.localStorage.setItem(topNStorageKey('largestTables'), '7');
    render(<MetricTable table={largestTables(63)} topN={TOP_N} now={NOW} />);
    expect(bodyRows()).toHaveLength(10);
  });

  it('has no selector and no caption when the table has 10 rows or fewer', () => {
    render(<MetricTable table={largestTables(10)} topN={TOP_N} now={NOW} />);
    expect(bodyRows()).toHaveLength(10);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByTestId('metric-table-shown-largestTables')).not.toBeInTheDocument();
  });

  it('slices after sortRows', () => {
    render(
      <MetricTable
        table={largestTables(15)}
        topN={TOP_N}
        sortRows={(a, b) => Number(b.key === 'table_15') - Number(a.key === 'table_15')}
        now={NOW}
      />,
    );
    const rows = bodyRows();
    expect(rows).toHaveLength(10);
    expect(rows[0]).toHaveTextContent('table_15');
  });

  it('without topN every row is drawn', () => {
    render(<MetricTable table={largestTables(30)} now={NOW} />);
    expect(bodyRows()).toHaveLength(30);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});
