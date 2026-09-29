/**
 * The delete confirmation (issue #60, E2.5): names what goes, Cancel changes
 * nothing, 204 reports success, 404 reports "already gone", other errors stay
 * in the dialog.
 */
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { DeleteEntryDialog, entrySummary } from '../../../components/health/DeleteEntryDialog';
import { groupByEntry } from '../../../utils/measurementSeries';
import { mockMeasurement, mockMetricCatalog } from '../../mocks/fixtures/measurements';

const METRICS = new Map(mockMetricCatalog.metrics.map((m) => [m.key, m]));
const [ENTRY] = groupByEntry([
  mockMeasurement('weight', 94.5327, { entryId: 'e1', measuredAt: '2026-09-29T08:00:00.000Z' }),
]);

function renderDialog() {
  const onClose = vi.fn();
  const onDeleted = vi.fn();
  const onMissing = vi.fn();
  const user = userEvent.setup();
  render(
    <DeleteEntryDialog
      open
      entry={ENTRY}
      metricsByKey={METRICS}
      unitSystem="imperial"
      onClose={onClose}
      onDeleted={onDeleted}
      onMissing={onMissing}
    />,
  );
  return { onClose, onDeleted, onMissing, user };
}

function captureDeletes(respond: () => Response) {
  const paths: string[] = [];
  server.use(
    http.delete('*/api/measurements/entries/:entryId', ({ request }) => {
      paths.push(new URL(request.url).pathname);
      return respond();
    }),
  );
  return paths;
}

describe('DeleteEntryDialog', () => {
  it('names the entry in the user unit', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Delete entry?' })).toHaveTextContent('Weight 208.4 lb from Sep 29');
  });

  it('summarises a multi-reading entry', () => {
    const [entry] = groupByEntry([
      mockMeasurement('bp_systolic', 128, { entryId: 'bp', measuredAt: '2026-09-28T08:00:00.000Z' }),
      mockMeasurement('bp_diastolic', 84, { entryId: 'bp', measuredAt: '2026-09-28T08:00:00.000Z' }),
      mockMeasurement('resting_hr', 58, { entryId: 'bp', measuredAt: '2026-09-28T08:00:00.000Z' }),
    ]);
    expect(entrySummary(entry, METRICS, 'metric')).toBe(
      'Blood pressure 128/84 mmHg and Resting heart rate 58 bpm from Sep 28',
    );
  });

  it('Cancel sends nothing', async () => {
    const paths = captureDeletes(() => new HttpResponse(null, { status: 204 }));
    const { user, onClose, onDeleted } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(paths).toEqual([]);
  });

  it('Delete calls DELETE and reports success on 204', async () => {
    const paths = captureDeletes(() => new HttpResponse(null, { status: 204 }));
    const { user, onClose, onDeleted } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalled();
    expect(paths).toEqual(['/api/measurements/entries/e1']);
  });

  it('reports an entry already gone (404) without an error', async () => {
    captureDeletes(() => HttpResponse.json({ message: 'Not found' }, { status: 404 }));
    const { user, onMissing, onDeleted, onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onMissing).toHaveBeenCalledTimes(1));
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the dialog open with a message on a network failure', async () => {
    captureDeletes(() => HttpResponse.json({ message: 'Down' }, { status: 503 }));
    const { user, onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Could not delete. Check your connection and try again.')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
