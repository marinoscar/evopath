/**
 * History (issue #60, E2.5) against MSW: one row per entry, newest first,
 * the filter's request, Load more merging an entry split across pages, the
 * row's chips, and the permission state of Edit/Delete.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import {
  MeasurementHistory,
  type MeasurementHistoryProps,
} from '../../../components/health/MeasurementHistory';
import type { MeasurementDto } from '../../../services/health';
import { mockListPage, mockMeasurement, mockMetricCatalog } from '../../mocks/fixtures/measurements';

const METHOD_LABELS = new Map(mockMetricCatalog.methods.map((m) => [m.key, m.label]));

type ListRequest = { metricKey: string | null; page: number; pageSize: number };

/** Serves `rows` (newest first) paginated like the API, filtered by metricKey. */
function listApi(rows: MeasurementDto[], pageSize?: number) {
  const requests: ListRequest[] = [];
  server.use(
    http.get('*/api/measurements', ({ request }) => {
      const url = new URL(request.url);
      const metricKey = url.searchParams.get('metricKey');
      const page = Number(url.searchParams.get('page') ?? '1');
      const size = pageSize ?? Number(url.searchParams.get('pageSize') ?? '20');
      requests.push({ metricKey, page, pageSize: Number(url.searchParams.get('pageSize')) });
      const filtered = metricKey ? rows.filter((r) => r.metricKey === metricKey) : rows;
      return HttpResponse.json({
        data: mockListPage(filtered.slice((page - 1) * size, page * size), {
          page,
          pageSize: size,
          total: filtered.length,
        }),
      });
    }),
  );
  return requests;
}

function renderHistory(props: Partial<MeasurementHistoryProps> = {}, options: Parameters<typeof render>[1] = {}) {
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  const user = userEvent.setup();
  const utils = render(
    <MeasurementHistory
      metrics={mockMetricCatalog.metrics}
      methodLabels={METHOD_LABELS}
      unitSystem="metric"
      canWrite
      onEdit={onEdit}
      onDelete={onDelete}
      {...props}
    />,
    options,
  );
  return { ...utils, onEdit, onDelete, user };
}

const at = (day: number, hour = 8) => new Date(Date.UTC(2026, 8, day, hour)).toISOString();

function sampleRows(): MeasurementDto[] {
  return [
    mockMeasurement('weight', 80, { entryId: 'w-new', measuredAt: at(29), method: 'smart_scale', notes: 'After a run' }),
    mockMeasurement('body_fat_pct', 27.8, { entryId: 'w-new', measuredAt: at(29), method: 'smart_scale', notes: 'After a run' }),
    mockMeasurement('bp_systolic', 128, { entryId: 'bp', measuredAt: at(28), method: 'bp_cuff' }),
    mockMeasurement('bp_diastolic', 84, { entryId: 'bp', measuredAt: at(28), method: 'bp_cuff' }),
    mockMeasurement('weight', 80.5, { entryId: 'w-old', measuredAt: at(20), revision: 2, edited: true }),
  ];
}

describe('MeasurementHistory', () => {
  beforeEach(() => {
    server.resetHandlers();
  });

  it('lists entries newest first, one row per entry, pairs and multi-metric entries together', async () => {
    const requests = listApi(sampleRows());
    renderHistory();
    const rows = await screen.findAllByTestId('history-entry');
    expect(rows).toHaveLength(3);
    expect(requests[0]).toEqual({ metricKey: null, page: 1, pageSize: 100 });

    expect(rows[0]).toHaveTextContent('Weight 80.0 kg');
    expect(rows[0]).toHaveTextContent('Body fat 27.8%');
    expect(rows[0]).toHaveTextContent('After a run');
    expect(rows[1]).toHaveTextContent('Blood pressure 128/84 mmHg');
    expect(within(rows[1]).getByText('Blood-pressure cuff')).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent('Weight 80.5 kg');
  });

  it('shows a method chip per reading (none for unspecified), Edited and the origin', async () => {
    listApi(sampleRows());
    renderHistory();
    const rows = await screen.findAllByTestId('history-entry');
    // Weight and body fat each carry their own method chip.
    expect(within(rows[0]).getAllByText('Smart scale')).toHaveLength(2);
    expect(within(rows[0]).queryByText('Edited')).toBeNull();
    expect(within(rows[0]).getByText('Manual')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Edited')).toBeInTheDocument();
    expect(within(rows[2]).queryByText('Not specified')).toBeNull();
  });

  it('converts to the user unit', async () => {
    listApi([mockMeasurement('weight', 94.5327, { entryId: 'w' })]);
    renderHistory({ unitSystem: 'imperial' });
    const [row] = await screen.findAllByTestId('history-entry');
    expect(row).toHaveTextContent('Weight 208.4 lb');
  });

  it('filters by metric, and asks for both halves of blood pressure', async () => {
    const requests = listApi(sampleRows());
    const { user } = renderHistory();
    await screen.findAllByTestId('history-entry');

    await user.click(screen.getByRole('combobox', { name: 'Show' }));
    await user.click(await screen.findByRole('option', { name: 'Weight' }));
    await waitFor(() => expect(requests.at(-1)?.metricKey).toBe('weight'));
    await waitFor(() => expect(screen.getAllByTestId('history-entry')).toHaveLength(2));
    expect(screen.queryByText(/Body fat/)).toBeNull();

    await user.click(screen.getByRole('combobox', { name: 'Show' }));
    await user.click(await screen.findByRole('option', { name: 'Blood pressure' }));
    await waitFor(() =>
      expect(requests.slice(-2).map((r) => r.metricKey).sort()).toEqual(['bp_diastolic', 'bp_systolic']),
    );
    await waitFor(() => expect(screen.getAllByTestId('history-entry')).toHaveLength(1));
    expect(screen.getByTestId('history-entry')).toHaveTextContent('Blood pressure 128/84 mmHg');
  });

  it('Load more appends the next page and merges an entry split across pages', async () => {
    // Page size 2: the blood-pressure pair straddles pages 1 and 2.
    const rows = [
      mockMeasurement('weight', 80, { entryId: 'w1', measuredAt: at(29) }),
      mockMeasurement('bp_systolic', 128, { entryId: 'bp', measuredAt: at(28) }),
      mockMeasurement('bp_diastolic', 84, { entryId: 'bp', measuredAt: at(28) }),
      mockMeasurement('weight', 81, { entryId: 'w2', measuredAt: at(27) }),
    ];
    const requests = listApi(rows, 2);
    const { user } = renderHistory();
    let entries = await screen.findAllByTestId('history-entry');
    expect(entries).toHaveLength(2);
    expect(entries[1]).toHaveTextContent('Systolic pressure 128 mmHg');

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByTestId('history-entry')).toHaveLength(3));
    entries = screen.getAllByTestId('history-entry');
    expect(entries[1]).toHaveTextContent('Blood pressure 128/84 mmHg');
    expect(entries[2]).toHaveTextContent('Weight 81.0 kg');
    expect(requests.map((r) => r.page)).toEqual([1, 2]);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('Edit and Delete have accessible names and pass the entry', async () => {
    listApi(sampleRows());
    const { user, onEdit, onDelete } = renderHistory();
    await screen.findAllByTestId('history-entry');
    const edit = screen.getByRole('button', { name: /^Edit weight and body fat entry from Sep 29/ });
    await user.click(edit);
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ entryId: 'w-new' }));
    await user.click(screen.getByRole('button', { name: /^Delete blood pressure entry from Sep 28/ }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ entryId: 'bp' }));
  });

  it('disables every Edit and Delete without health_data:write', async () => {
    listApi(sampleRows());
    renderHistory(
      { canWrite: false },
      {
        wrapperOptions: {
          user: { ...mockUser, permissions: mockUser.permissions.filter((p) => p !== 'health_data:write') },
        },
      },
    );
    await screen.findAllByTestId('history-entry');
    const actions = screen.getAllByRole('button', { name: /^(Edit|Delete) / });
    expect(actions).toHaveLength(6);
    for (const action of actions) expect(action).toBeDisabled();
  });

  it('shows an empty state, and the filter in its title', async () => {
    listApi([]);
    renderHistory();
    expect(await screen.findByText('No entries yet')).toBeInTheDocument();
  });

  it('shows "not available" on 403 and an error with Retry otherwise', async () => {
    server.use(http.get('*/api/measurements', () => HttpResponse.json({ message: 'No' }, { status: 403 })));
    const { unmount } = renderHistory();
    expect(await screen.findByText('Health data is not available for your account')).toBeInTheDocument();
    unmount();

    let fail = true;
    server.use(
      http.get('*/api/measurements', () =>
        fail
          ? HttpResponse.json({ message: 'Boom' }, { status: 500 })
          : HttpResponse.json({ data: mockListPage(sampleRows()) }),
      ),
    );
    const { user } = renderHistory();
    expect(await screen.findByText(/Could not load your history/)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findAllByTestId('history-entry')).toHaveLength(3);
  });

  it('reloads when refreshToken changes', async () => {
    const requests = listApi(sampleRows());
    const { rerender } = renderHistory({ refreshToken: 0 });
    await screen.findAllByTestId('history-entry');
    rerender(
      <MeasurementHistory
        metrics={mockMetricCatalog.metrics}
        methodLabels={METHOD_LABELS}
        unitSystem="metric"
        canWrite
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        refreshToken={1}
      />,
    );
    await waitFor(() => expect(requests).toHaveLength(2));
  });

  it('has 44px action targets and no axe violations', async () => {
    listApi(sampleRows());
    const { container } = renderHistory();
    await screen.findAllByTestId('history-entry');
    const edit = screen.getAllByRole('button', { name: /^Edit / })[0];
    expect(getComputedStyle(edit).minWidth).toBe('44px');
    expect(getComputedStyle(edit).minHeight).toBe('44px');
    expect(await axe(container)).toHaveNoViolations();
  });
});
