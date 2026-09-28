/**
 * `BroadcastDetailDialog`'s failed-row summary (issue #459, epic #319).
 *
 * The rest of the dialog (channels, progress, the composed content, the
 * approximate delivery breakdown) has no dedicated suite of its own — this
 * file covers exactly what #459 added: the `broadcast-failed-summary` alert
 * and the "Stopped" vs "Finished" date label, both gated on `status ===
 * 'failed'` and nothing else.
 */

import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { BroadcastDetailDialog } from '../../../components/admin/BroadcastDetailDialog';
import type { BroadcastDetail } from '../../../services/broadcasts';

function detail(overrides: Partial<BroadcastDetail> = {}): BroadcastDetail {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Release notes',
    body: 'What shipped this week.',
    link: null,
    ctaLabel: null,
    eventKey: 'admin.broadcast',
    channels: ['browser'],
    status: 'sent',
    scheduledFor: null,
    startedAt: '2026-05-01T10:00:00.000Z',
    finishedAt: '2026-05-01T10:04:00.000Z',
    canceledAt: null,
    audienceCutoff: '2026-05-01T10:00:00.000Z',
    recipientsTargeted: 1284,
    recipientsDispatched: 1284,
    lastError: null,
    createdById: 'admin-user-id',
    createdAt: '2026-05-01T09:00:00.000Z',
    updatedAt: '2026-05-01T10:04:00.000Z',
    approximateDeliveryAttempts: [],
    ...overrides,
  };
}

function renderDialog(broadcast: BroadcastDetail | null) {
  return render(
    <BroadcastDetailDialog
      open
      broadcast={broadcast}
      isLoading={false}
      error={null}
      onClose={() => {}}
    />,
  );
}

describe('BroadcastDetailDialog', () => {
  it('shows the failed summary alert with the dispatched/targeted counts, for a failed broadcast', () => {
    renderDialog(
      detail({
        status: 'failed',
        recipientsDispatched: 400,
        recipientsTargeted: 1284,
        lastError: 'Chunk job job-1 failed permanently after 3 attempt(s): smtp outage',
      }),
    );

    const alert = screen.getByTestId('broadcast-failed-summary');
    expect(alert).toHaveTextContent('Stopped after 400 of 1284 recipients');
    expect(alert).toHaveTextContent('resume it from the broadcasts list');
  });

  it('renders an em dash for the target count when the audience was never counted', () => {
    renderDialog(
      detail({ status: 'failed', recipientsDispatched: 0, recipientsTargeted: null }),
    );

    const alert = screen.getByTestId('broadcast-failed-summary');
    expect(alert).toHaveTextContent('Stopped after 0 of — recipients');
  });

  it('labels the finishedAt field "Stopped" for a failed broadcast', () => {
    renderDialog(detail({ status: 'failed', finishedAt: '2026-05-01T10:04:00.000Z' }));

    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.queryByText('Finished')).not.toBeInTheDocument();
  });

  it('labels the finishedAt field "Finished" for every other status', () => {
    renderDialog(detail({ status: 'sent' }));

    expect(screen.getByText('Finished')).toBeInTheDocument();
    expect(screen.queryByText('Stopped')).not.toBeInTheDocument();
  });

  it('omits the failed summary alert entirely for a non-failed broadcast', () => {
    renderDialog(detail({ status: 'sending' }));

    expect(screen.queryByTestId('broadcast-failed-summary')).not.toBeInTheDocument();
  });

  it('still renders lastError as its own alert alongside the failed summary', () => {
    renderDialog(
      detail({
        status: 'failed',
        lastError: 'Chunk job job-1 failed permanently after 3 attempt(s): smtp outage',
      }),
    );

    expect(screen.getByTestId('broadcast-failed-summary')).toBeInTheDocument();
    expect(
      screen.getByText('Chunk job job-1 failed permanently after 3 attempt(s): smtp outage'),
    ).toBeInTheDocument();
  });
});
