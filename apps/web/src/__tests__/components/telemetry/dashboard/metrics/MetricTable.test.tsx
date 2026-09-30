/**
 * `MetricTable` and its cells (issue #127): labelled by its caption, cells
 * formatted by column unit, `null` → "—", status as icon + word, virtual and
 * missing columns.
 */
import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { render } from '../../../../utils/test-utils';
import {
  MetricTable,
  StatusCell,
  UtilizationBar,
} from '../../../../../components/telemetry/dashboard/metrics/MetricTable';
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
