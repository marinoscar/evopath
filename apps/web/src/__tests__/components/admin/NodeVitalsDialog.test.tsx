/**
 * `NodeVitalsDialog` — a worker node's full vitals snapshot (issue #131).
 *
 * Pins what the compact cell cannot show: event-loop p99, uptime, versions,
 * the counters table, "Vitals reported <relative time>", and that every meter
 * is a labelled progressbar whose reading is also in words.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NodeVitalsDialog, VITALS_COUNTER_ROWS } from '../../../components/admin/NodeVitalsDialog';
import {
  fullVitals,
  lowDiskVitals,
  partialVitals,
  vitalsNode,
} from '../../mocks/fixtures/nodeVitals';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const THREE_MIN_AGO = '2026-01-01T11:57:00.000Z';

function renderDialog(overrides: Parameters<typeof vitalsNode>[0] | null, onClose = vi.fn()) {
  render(
    <NodeVitalsDialog
      node={overrides === null ? null : vitalsNode(overrides)}
      now={NOW}
      onClose={onClose}
    />,
  );
  return onClose;
}

describe('NodeVitalsDialog', () => {
  it('renders nothing while closed', () => {
    renderDialog(null);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is titled with the node and says when vitals were reported', () => {
    renderDialog({ lastVitals: fullVitals, lastVitalsAt: THREE_MIN_AGO });
    const dialog = screen.getByRole('dialog', { name: 'Vitals — worker-a (build-box-01)' });
    expect(within(dialog).getByText('Vitals reported 3 minutes ago')).toBeInTheDocument();
  });

  it('shows the full snapshot: CPU, RSS, event-loop p99, uptime and versions', () => {
    renderDialog({ lastVitals: fullVitals, lastVitalsAt: THREE_MIN_AGO });
    const dialog = screen.getByRole('dialog');

    const field = (label: string) => within(dialog).getByText(label).nextElementSibling;
    expect(field('CPU')).toHaveTextContent('42%');
    expect(field('Resident memory (RSS)')).toHaveTextContent('512 MB');
    expect(field('Event-loop delay p99')).toHaveTextContent('13 ms');
    expect(field('Uptime')).toHaveTextContent('2d 3h');
    expect(field('CLI version')).toHaveTextContent('1.9.0');
    expect(field('Node.js version')).toHaveTextContent('v24.1.0');
    expect(field('pg_dump version')).toHaveTextContent('16.4');
  });

  it('draws each meter as a labelled progressbar whose reading is in words', () => {
    renderDialog({ lastVitals: fullVitals, lastVitalsAt: THREE_MIN_AGO });

    expect(screen.getByRole('progressbar', { name: 'Heap used' })).toHaveAttribute(
      'aria-valuetext',
      '256 MB of 1 GB (25%)',
    );
    expect(
      screen.getByRole('progressbar', { name: 'State directory disk used' }),
    ).toHaveAttribute('aria-valuetext', '50 GB free of 100 GB (50% free)');
    expect(screen.getByRole('progressbar', { name: 'Job slots in use' })).toHaveAttribute(
      'aria-valuetext',
      '1 of 4 (25%)',
    );
  });

  it('says "low" in the disk reading when under 10% free', () => {
    renderDialog({ lastVitals: lowDiskVitals, lastVitalsAt: THREE_MIN_AGO });
    expect(
      screen.getByRole('progressbar', { name: 'State directory disk used' }),
    ).toHaveAttribute('aria-valuetext', '5 GB free of 100 GB (5% free, low)');
  });

  it('lists every counter in a table with its count', () => {
    renderDialog({ lastVitals: fullVitals, lastVitalsAt: THREE_MIN_AGO });
    const table = screen.getByRole('table', { name: 'Node counters' });

    // A header row plus one row per counter.
    expect(within(table).getAllByRole('row')).toHaveLength(VITALS_COUNTER_ROWS.length + 1);
    const count = (label: string) =>
      within(within(table).getByRole('rowheader', { name: label }).closest('tr')!).getAllByRole(
        'cell',
      )[0];

    expect(count('Claims')).toHaveTextContent('120');
    expect(count('Empty polls')).toHaveTextContent('3,456');
    expect(count('Succeeded')).toHaveTextContent('110');
    expect(count('Failed')).toHaveTextContent('7');
    expect(count('Rate limited')).toHaveTextContent('3');
    expect(count('Claim failures')).toHaveTextContent('2');
    expect(count('Lease renewals')).toHaveTextContent('900');
    expect(count('Lease renew failures')).toHaveTextContent('1');
    expect(count('Heartbeat failures')).toHaveTextContent('4');
    expect(count('Watchdog trips')).toHaveTextContent('5');
  });

  it('renders unreported fields and counters as a dash, never as zero', () => {
    renderDialog({ lastVitals: partialVitals, lastVitalsAt: THREE_MIN_AGO });
    const dialog = screen.getByRole('dialog');

    expect(within(dialog).getByText('Resident memory (RSS)').nextElementSibling).toHaveTextContent(
      '—',
    );
    expect(within(dialog).getByText('CLI version').nextElementSibling).toHaveTextContent('—');
    // No bar is drawn for a reading that cannot be computed.
    expect(screen.queryByRole('progressbar', { name: 'Heap used' })).not.toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Node counters' });
    const claimsRow = within(table).getByRole('rowheader', { name: 'Claims' }).closest('tr')!;
    expect(within(claimsRow).getAllByRole('cell')[0]).toHaveTextContent('—');
  });

  it('says, in words, that a stale node’s vitals may be out of date', () => {
    renderDialog({ health: 'stale', lastVitals: fullVitals, lastVitalsAt: THREE_MIN_AGO });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This node is stale: these are the last vitals it sent',
    );
  });

  it('shows no staleness warning for a healthy node', () => {
    renderDialog({ lastVitals: fullVitals, lastVitalsAt: THREE_MIN_AGO });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains an empty state for a node that never reported vitals', () => {
    renderDialog({ lastVitals: null });
    expect(screen.getByTestId('node-vitals-empty')).toHaveTextContent(
      'This node has not reported vitals yet.',
    );
    expect(screen.queryByRole('table', { name: 'Node counters' })).not.toBeInTheDocument();
  });

  it('closes from its Close button', async () => {
    const user = userEvent.setup();
    const onClose = renderDialog({ lastVitals: fullVitals });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
