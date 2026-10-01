/**
 * The Health page (issue #53, E2.3): latest values and quick entry, end to
 * end against a stateful MSW API that converts like the real one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import HealthPage from '../../pages/HealthPage';
import { comingInLabel } from '../../config/roadmap';
import { resetMeasurementCatalogCache } from '../../hooks/useMeasurementCatalog';
import type { LatestItem, MeasurementDto } from '../../services/health';
import { mockHealthProfileSaved } from '../mocks/fixtures/health';
import { catalogMetric, mockLatest, mockListPage, mockMeasurement } from '../mocks/fixtures/measurements';
import { statefulCheckInApi } from '../mocks/fixtures/checkInApi';

type PostBody = { readings: Array<{ metricKey: string; value: number; unit: string; method?: string }> };

/** A tiny in-memory API: POST stores canonical values, latest reads them back. */
function statefulApi(initial: LatestItem[] = mockLatest()) {
  const state = { latest: initial, posts: [] as PostBody[], latestCalls: 0 };
  server.use(
    http.get('*/api/health-profile', () => HttpResponse.json({ data: mockHealthProfileSaved })),
    http.get('*/api/measurements/latest', () => {
      state.latestCalls += 1;
      return HttpResponse.json({ data: { items: state.latest } });
    }),
    http.post('*/api/measurements', async ({ request }) => {
      const body = (await request.json()) as PostBody;
      state.posts.push(body);
      const items: MeasurementDto[] = body.readings.map((r) => {
        const factor = catalogMetric(r.metricKey).units.find((u) => u.unit === r.unit)!.factor;
        return mockMeasurement(r.metricKey, Math.round(r.value * factor * 10000) / 10000, {
          entryId: 'entry-1',
          measuredAt: new Date().toISOString(),
          method: r.method ?? 'unspecified',
        });
      });
      state.latest = state.latest.map((item) => {
        const saved = items.find((i) => i.metricKey === item.metricKey);
        return saved ? { metricKey: item.metricKey, latest: saved, previous: item.latest } : item;
      });
      return HttpResponse.json({ data: { entryId: 'entry-1', items } }, { status: 201 });
    }),
  );
  return state;
}

describe('HealthPage', () => {
  beforeEach(() => {
    resetMeasurementCatalogCache();
  });

  it('renders the h1, the subtitle and no roadmap chip', async () => {
    statefulApi();
    render(<HealthPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Health' })).toBeInTheDocument();
    expect(screen.getByText('Your body and how you feel')).toBeInTheDocument();
    await screen.findByRole('region', { name: 'Weight' });
    expect(screen.queryByText(comingInLabel('health'))).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('shows skeletons while loading, then five empty tiles and no BMI', async () => {
    statefulApi();
    render(<HealthPage />);
    expect(screen.getByTestId('latest-measurements-skeleton')).toBeInTheDocument();
    await screen.findByRole('region', { name: 'Weight' });
    expect(screen.getAllByText('No data yet')).toHaveLength(5);
    expect(screen.queryByRole('region', { name: 'BMI' })).toBeNull();
  });

  it('logs a weight with type + Enter and shows it after one refetch', async () => {
    const api = statefulApi();
    const user = userEvent.setup();
    render(<HealthPage />);
    await screen.findByRole('region', { name: 'Weight' });
    expect(api.latestCalls).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Log measurement' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Weight' })).toHaveFocus());
    await user.keyboard('208.4{Enter}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.posts).toEqual([{ readings: [{ metricKey: 'weight', value: 208.4, unit: 'lb' }] }]);

    const weight = screen.getByRole('region', { name: 'Weight' });
    await waitFor(() => expect(weight).toHaveTextContent('208.4 lb'));
    expect(within(weight).getByText('Today')).toBeInTheDocument();
    expect(within(weight).queryByText(/since previous reading/)).toBeNull();
    expect(api.latestCalls).toBe(2);
    // Weight and profile height (1778 mm) now give a BMI.
    expect(await screen.findByRole('region', { name: 'BMI' })).toBeInTheDocument();
    // Focus returns to the trigger.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Log measurement' })).toHaveFocus());
  });

  it('a second reading shows the delta in the user unit', async () => {
    statefulApi(mockLatest({ weight: { latest: mockMeasurement('weight', 94.5327) } }));
    const user = userEvent.setup();
    render(<HealthPage />);
    await screen.findByText('208.4');

    await user.click(screen.getByRole('button', { name: 'Log weight' }));
    await user.keyboard('207.9{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const weight = screen.getByRole('region', { name: 'Weight' });
    await waitFor(() => expect(weight).toHaveTextContent('207.9 lb'));
    expect(within(weight).getByText('-0.5 lb')).toBeInTheDocument();
  });

  it('a chosen method shows as a chip and is preselected next time', async () => {
    const api = statefulApi();
    const user = userEvent.setup();
    render(<HealthPage />);
    await screen.findByRole('region', { name: 'Body fat' });

    await user.click(screen.getByRole('button', { name: 'Log body fat' }));
    await user.keyboard('27.8');
    await user.click(screen.getByRole('button', { name: 'Details' }));
    await user.click(await screen.findByRole('combobox', { name: 'Body fat method' }));
    await user.click(await screen.findByRole('option', { name: 'Smart scale' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const fat = screen.getByRole('region', { name: 'Body fat' });
    await waitFor(() => expect(within(fat).getByText('Smart scale')).toBeInTheDocument());
    expect(api.posts[0].readings[0]).toEqual({ metricKey: 'body_fat_pct', value: 27.8, unit: '%', method: 'smart_scale' });

    await user.click(screen.getByRole('button', { name: 'Log body fat' }));
    await user.keyboard('27.5');
    await user.click(screen.getByRole('button', { name: 'Details' }));
    expect(await screen.findByRole('combobox', { name: 'Body fat method' })).toHaveTextContent('Smart scale');
  });

  it('has the Daily check-in section after the tiles (#56), checked in from the page', async () => {
    statefulApi();
    const checkIns = statefulCheckInApi();
    const user = userEvent.setup();
    render(<HealthPage />);
    await screen.findByRole('region', { name: 'Weight' });
    const section = screen.getByRole('region', { name: 'Daily check-in' });
    const tiles = screen.getByRole('region', { name: 'Latest measurements' });
    expect(tiles.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await within(section).findByText('Not done today')).toBeInTheDocument();

    await user.click(within(section).getByRole('button', { name: 'Check in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Daily check-in' });
    const energy = await within(dialog).findByRole('group', { name: /^Energy/ });
    await user.click(within(energy).getByRole('button', { name: '4' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await within(section).findByRole('list', { name: 'Scores' })).toHaveTextContent('Energy 4');
    expect(checkIns.puts).toHaveLength(1);
  });

  it('links to the biomarkers from a Blood work section after the check-in (H5, #189)', async () => {
    statefulApi();
    statefulCheckInApi();
    render(<HealthPage />);
    await screen.findByRole('region', { name: 'Weight' });
    const checkIn = screen.getByRole('region', { name: 'Daily check-in' });
    const bloodWork = screen.getByRole('region', { name: 'Blood work' });
    expect(checkIn.compareDocumentPosition(bloodWork) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(bloodWork).getByRole('link', { name: 'View biomarkers' })).toHaveAttribute('href', '/health/biomarkers');
  });

  it('links to the progress photos from a section after Blood work (E7.9, #249)', async () => {
    statefulApi();
    statefulCheckInApi();
    render(<HealthPage />);
    await screen.findByRole('region', { name: 'Weight' });
    const bloodWork = screen.getByRole('region', { name: 'Blood work' });
    const photos = screen.getByRole('region', { name: 'Progress photos' });
    expect(bloodWork.compareDocumentPosition(photos) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(photos).getByText(/Private to you\. Never shared with AI or put in notifications\./)).toBeInTheDocument();
    expect(within(photos).getByRole('link', { name: 'View progress photos' })).toHaveAttribute(
      'href',
      '/health/progress-photos',
    );
  });

  it('a viewer without health_data:write sees disabled Log buttons', async () => {
    statefulApi();
    render(<HealthPage />, {
      wrapperOptions: { user: { ...mockUser, permissions: ['health_data:read'] } },
    });
    await screen.findByRole('region', { name: 'Weight' });
    expect(screen.getByRole('button', { name: 'Log measurement' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Log weight' })).toBeDisabled();
    const checkIn = screen.getByRole('region', { name: 'Daily check-in' });
    expect(await within(checkIn).findByRole('button', { name: 'Check in' })).toBeDisabled();
  });

  it('a user without health_data:read sees the unavailable message and nothing is fetched', async () => {
    const api = statefulApi();
    render(<HealthPage />, { wrapperOptions: { user: { ...mockUser, permissions: [] } } });
    expect(screen.getByText('Health data is not available for your account')).toBeInTheDocument();
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Log measurement' })).toBeNull();
    expect(api.latestCalls).toBe(0);
  });

  it('a 403 from the API shows the unavailable message', async () => {
    statefulApi();
    server.use(
      http.get('*/api/measurements/latest', () => HttpResponse.json({ message: 'Forbidden' }, { status: 403 })),
    );
    render(<HealthPage />);
    expect(await screen.findByText('Health data is not available for your account')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Weight' })).toBeNull();
  });

  it('a load error shows an Alert with Retry', async () => {
    const api = statefulApi();
    let fail = true;
    server.use(
      http.get('*/api/measurements/latest', () =>
        fail
          ? HttpResponse.json({ message: 'Service unavailable' }, { status: 503 })
          : HttpResponse.json({ data: { items: api.latest } }),
      ),
    );
    const user = userEvent.setup();
    render(<HealthPage />);
    expect(await screen.findByText(/Could not load your measurements/)).toBeInTheDocument();

    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Weight' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    statefulApi(mockLatest({ weight: { latest: mockMeasurement('weight', 80) } }));
    const { container } = render(<HealthPage />);
    await screen.findByRole('region', { name: 'BMI' });
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});

// -----------------------------------------------------------------------------
// Trend and History (issue #60, E2.5)
// -----------------------------------------------------------------------------

type PatchBody = {
  notes?: string | null;
  measuredAt?: string;
  readings?: Array<{ metricKey: string; value: number; unit: string; method?: string }>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A stateful API over stored rows (canonical values): list, latest and series
 * all read the ACTIVE rows, PATCH supersedes (revision + 1) and DELETE removes
 * the entry, so the page's refreshes can be observed end to end.
 */
function historyApi(initial: MeasurementDto[]) {
  const state = { rows: [...initial], patches: [] as PatchBody[], deletes: [] as string[], seriesCalls: 0 };
  const newestFirst = () => [...state.rows].sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt));
  const toCanonical = (metricKey: string, value: number, unit: string) => {
    const factor = catalogMetric(metricKey).units.find((u) => u.unit === unit)!.factor;
    return Math.round(value * factor * 10000) / 10000;
  };
  server.use(
    http.get('*/api/health-profile', () => HttpResponse.json({ data: mockHealthProfileSaved })),
    http.get('*/api/measurements/latest', () => {
      const items = mockLatest().map((item) => {
        const rows = newestFirst().filter((r) => r.metricKey === item.metricKey);
        return { metricKey: item.metricKey, latest: rows[0] ?? null, previous: rows[1] ?? null };
      });
      return HttpResponse.json({ data: { items } });
    }),
    http.get('*/api/measurements/series', ({ request }) => {
      state.seriesCalls += 1;
      const url = new URL(request.url);
      const metricKey = url.searchParams.get('metricKey')!;
      const points = newestFirst()
        .filter((r) => r.metricKey === metricKey)
        .reverse()
        .map((r) => ({ id: r.id, measuredAt: r.measuredAt, value: r.value, method: r.method, origin: r.origin }));
      return HttpResponse.json({
        data: { metricKey, unit: catalogMetric(metricKey).canonicalUnit, points, truncated: false },
      });
    }),
    http.get('*/api/measurements', ({ request }) => {
      const url = new URL(request.url);
      const metricKey = url.searchParams.get('metricKey');
      const rows = newestFirst().filter((r) => !metricKey || r.metricKey === metricKey);
      return HttpResponse.json({ data: mockListPage(rows, { pageSize: 100 }) });
    }),
    http.patch('*/api/measurements/entries/:entryId', async ({ request, params }) => {
      const body = (await request.json()) as PatchBody;
      state.patches.push(body);
      const entryId = String(params.entryId);
      state.rows = state.rows.map((row) => {
        if (row.entryId !== entryId) return row;
        const change = body.readings?.find((r) => r.metricKey === row.metricKey);
        return {
          ...row,
          id: `${row.id}-r${row.revision + 1}`,
          value: change ? toCanonical(row.metricKey, change.value, change.unit) : row.value,
          method: change?.method ?? row.method,
          notes: body.notes !== undefined ? body.notes : row.notes,
          measuredAt: body.measuredAt ?? row.measuredAt,
          revision: row.revision + 1,
          edited: true,
        };
      });
      return HttpResponse.json({ data: { entryId, items: state.rows.filter((r) => r.entryId === entryId) } });
    }),
    http.delete('*/api/measurements/entries/:entryId', ({ params }) => {
      state.deletes.push(String(params.entryId));
      state.rows = state.rows.filter((r) => r.entryId !== params.entryId);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return state;
}

/** Two weights: 209.4 lb five days ago, 208.4 lb (smart scale) today. */
function twoWeights(): MeasurementDto[] {
  const now = Date.now();
  return [
    mockMeasurement('weight', 94.9863, {
      entryId: 'older',
      measuredAt: new Date(now - 5 * DAY_MS).toISOString(),
      method: 'scale',
    }),
    mockMeasurement('weight', 94.5327, {
      entryId: 'newer',
      measuredAt: new Date(now - 60 * 60 * 1000).toISOString(),
      method: 'smart_scale',
    }),
  ];
}

describe('HealthPage: Trend and History (#60)', () => {
  beforeEach(() => {
    resetMeasurementCatalogCache();
  });

  it('stacks tiles, Trend, then History as h2 sections, with no tabs', async () => {
    historyApi(twoWeights());
    render(<HealthPage />);
    const tiles = await screen.findByRole('region', { name: 'Latest measurements' });
    const trend = await screen.findByRole('region', { name: 'Trend' });
    const history = screen.getByRole('region', { name: 'History' });
    expect(within(trend).getByRole('heading', { level: 2, name: 'Trend' })).toBeInTheDocument();
    expect(within(history).getByRole('heading', { level: 2, name: 'History' })).toBeInTheDocument();
    expect(tiles.compareDocumentPosition(trend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(trend.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(await within(history).findAllByTestId('history-entry')).toHaveLength(2);
  });

  it('editing a weight updates the row (Edited), the tile and the chart without a reload', async () => {
    const api = historyApi(twoWeights());
    const user = userEvent.setup();
    render(<HealthPage />);
    const history = await screen.findByRole('region', { name: 'History' });
    const rows = await within(history).findAllByTestId('history-entry');
    expect(rows[0]).toHaveTextContent('208.4 lb');
    expect(within(rows[0]).queryByText('Edited')).toBeNull();
    expect(await screen.findByRole('img', { name: /latest 208\.4 lb/ })).toBeInTheDocument();

    await user.click(within(rows[0]).getByRole('button', { name: /^Edit weight entry from/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit entry' });
    const weight = within(dialog).getByRole('textbox', { name: 'Weight' });
    await waitFor(() => expect(weight).toHaveValue('208.4'));
    await user.clear(weight);
    await user.type(weight, '210');
    expect(within(dialog).getByText('Was 208.4 lb')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(api.patches).toEqual([{ readings: [{ metricKey: 'weight', value: 210, unit: 'lb' }] }]);
    // The API kept the old row (a new revision); the page shows the new one.
    await waitFor(() => expect(within(history).getAllByTestId('history-entry')[0]).toHaveTextContent('210.0 lb'));
    expect(within(within(history).getAllByTestId('history-entry')[0]).getByText('Edited')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('region', { name: 'Weight' })).toHaveTextContent('210.0 lb'));
    expect(await screen.findByRole('img', { name: /latest 210\.0 lb/ })).toBeInTheDocument();
  });

  it('deleting asks for confirmation naming the entry; Cancel changes nothing; Delete falls back', async () => {
    const api = historyApi(twoWeights());
    const user = userEvent.setup();
    render(<HealthPage />);
    const history = await screen.findByRole('region', { name: 'History' });
    const rows = await within(history).findAllByTestId('history-entry');

    await user.click(within(rows[0]).getByRole('button', { name: /^Delete weight entry from/ }));
    let dialog = await screen.findByRole('dialog', { name: 'Delete entry?' });
    expect(dialog).toHaveTextContent(/Weight 208\.4 lb from/);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.deletes).toEqual([]);
    expect(within(history).getAllByTestId('history-entry')).toHaveLength(2);

    await user.click(within(within(history).getAllByTestId('history-entry')[0]).getByRole('button', { name: /^Delete weight/ }));
    dialog = await screen.findByRole('dialog', { name: 'Delete entry?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(api.deletes).toEqual(['newer']);
    expect(await screen.findByText('Entry deleted')).toBeInTheDocument();
    await waitFor(() => expect(within(history).getAllByTestId('history-entry')).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Weight' })).toHaveTextContent('209.4 lb'));
    expect(await screen.findByText('Log at least two readings to see a trend')).toBeInTheDocument();
  });

  it('a new reading logged from the page refetches the chart and History', async () => {
    const api = historyApi(twoWeights());
    const user = userEvent.setup();
    server.use(
      http.post('*/api/measurements', async ({ request }) => {
        const body = (await request.json()) as PostBody;
        const items = body.readings.map((r) =>
          mockMeasurement(r.metricKey, Math.round(r.value * 0.45359237 * 10000) / 10000, {
            entryId: 'logged',
            measuredAt: new Date().toISOString(),
          }),
        );
        api.rows.push(...items);
        return HttpResponse.json({ data: { entryId: 'logged', items } }, { status: 201 });
      }),
    );
    render(<HealthPage />);
    const history = await screen.findByRole('region', { name: 'History' });
    await within(history).findAllByTestId('history-entry');
    const seriesBefore = api.seriesCalls;

    await user.click(screen.getByRole('button', { name: 'Log measurement' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Weight' })).toHaveFocus());
    await user.keyboard('207.9{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await waitFor(() => expect(within(history).getAllByTestId('history-entry')).toHaveLength(3));
    expect(api.seriesCalls).toBeGreaterThan(seriesBefore);
    expect(await screen.findByRole('img', { name: /3 readings, latest 207\.9 lb/ })).toBeInTheDocument();
  });

  it('a viewer without health_data:write sees no enabled Edit or Delete', async () => {
    historyApi(twoWeights());
    render(<HealthPage />, {
      wrapperOptions: { user: { ...mockUser, permissions: ['health_data:read'] } },
    });
    const history = await screen.findByRole('region', { name: 'History' });
    await within(history).findAllByTestId('history-entry');
    for (const button of within(history).getAllByRole('button', { name: /^(Edit|Delete) / })) {
      expect(button).toBeDisabled();
    }
  });
});

