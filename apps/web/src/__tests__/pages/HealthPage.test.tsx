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
import { catalogMetric, mockLatest, mockMeasurement } from '../mocks/fixtures/measurements';
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
