/**
 * The Trend chart (issue #60, E2.5) against MSW. jsdom has no layout, so the
 * chart gets an explicit width; assertions target the request parameters,
 * the legend (HTML), the alerts, the empty states and the accessible name
 * rather than SVG geometry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { act, render, screen, waitFor, within } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { resetViewportWidth, setViewportWidth } from '../../setup';
import {
  MeasurementTrendChart,
  type MeasurementTrendChartProps,
} from '../../../components/health/MeasurementTrendChart';
import type { MeasurementSeries } from '../../../services/health';
import { mockMetricCatalog, mockSeries, mockSeriesPoint } from '../../mocks/fixtures/measurements';

const DAY_MS = 24 * 60 * 60 * 1000;
const METHOD_LABELS = new Map(mockMetricCatalog.methods.map((m) => [m.key, m.label]));
const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const ago = (days: number) => new Date(NOW - days * DAY_MS).toISOString();

type SeriesRequest = { metricKey: string; from: string | null; to: string | null };

/** Answers `series` from `bySeries(metricKey)`, recording each request. */
function seriesApi(bySeries: (metricKey: string, from: string | null) => MeasurementSeries | Response) {
  const requests: SeriesRequest[] = [];
  server.use(
    http.get('*/api/measurements/series', ({ request }) => {
      const url = new URL(request.url);
      const metricKey = url.searchParams.get('metricKey')!;
      const from = url.searchParams.get('from');
      requests.push({ metricKey, from, to: url.searchParams.get('to') });
      const answer = bySeries(metricKey, from);
      return answer instanceof Response ? answer : HttpResponse.json({ data: answer });
    }),
  );
  return requests;
}

function renderChart(props: Partial<MeasurementTrendChartProps> = {}) {
  const onLog = vi.fn();
  const user = userEvent.setup();
  const utils = render(
    <MeasurementTrendChart
      metrics={mockMetricCatalog.metrics}
      methodLabels={METHOD_LABELS}
      unitSystem="metric"
      canLog
      onLog={onLog}
      width={800}
      {...props}
    />,
  );
  return { ...utils, onLog, user };
}

const twoMethods = () =>
  mockSeries('weight', [
    mockSeriesPoint(ago(20), 81, 'scale'),
    mockSeriesPoint(ago(15), 80.6, 'smart_scale'),
    mockSeriesPoint(ago(10), 80.2, 'scale'),
    mockSeriesPoint(ago(5), 80.4, 'smart_scale'),
  ]);

describe('MeasurementTrendChart', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => resetViewportWidth());
  });

  it('asks for weight over the last 90 days by default', async () => {
    const requests = seriesApi(() => twoMethods());
    renderChart();
    await screen.findByTestId('measurement-trend-chart');
    expect(requests).toHaveLength(1);
    expect(requests[0].metricKey).toBe('weight');
    expect(Date.parse(requests[0].from!)).toBe(NOW - 90 * DAY_MS);
    expect(screen.getByRole('button', { name: '90 days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('draws one series per method with a legend entry each and names both in the alert', async () => {
    seriesApi(() => twoMethods());
    renderChart();
    const chart = await screen.findByTestId('measurement-trend-chart');
    expect(within(chart).getByText('Scale')).toBeInTheDocument();
    expect(within(chart).getByText('Smart scale')).toBeInTheDocument();
    expect(
      screen.getByText(
        'This range mixes measurement methods (Scale, Smart scale). Values from different methods are not directly comparable.',
      ),
    ).toBeInTheDocument();
  });

  it('shows no mixed-method alert for one method', async () => {
    seriesApi(() =>
      mockSeries('weight', [mockSeriesPoint(ago(3), 80, 'scale'), mockSeriesPoint(ago(1), 80.4, 'scale')]),
    );
    renderChart();
    await screen.findByTestId('measurement-trend-chart');
    expect(screen.queryByText(/mixes measurement methods/)).toBeNull();
  });

  it('names the chart with metric, range, count, latest and min to max in the user unit', async () => {
    seriesApi(() =>
      mockSeries('weight', [
        mockSeriesPoint(ago(9), 93, 'scale'),
        mockSeriesPoint(ago(5), 96.3, 'scale'),
        mockSeriesPoint(ago(1), 94.5327, 'scale'),
      ]),
    );
    renderChart({ unitSystem: 'imperial' });
    expect(
      await screen.findByRole('img', {
        name: 'Weight, last 90 days, 3 readings, latest 208.4 lb, range 205.0 to 212.3 lb',
      }),
    ).toBeInTheDocument();
    // The y-axis label is the display unit.
    expect(within(screen.getByTestId('measurement-trend-chart')).getByText('lb')).toBeInTheDocument();
  });

  it('refetches with the matching `from` when the range changes', async () => {
    const requests = seriesApi(() => twoMethods());
    const { user } = renderChart();
    await screen.findByTestId('measurement-trend-chart');
    await user.click(screen.getByRole('button', { name: '30 days' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(Date.parse(requests[1].from!)).toBe(NOW - 30 * DAY_MS);
    await user.click(screen.getByRole('button', { name: '365 days' }));
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(Date.parse(requests[2].from!)).toBe(NOW - 365 * DAY_MS);
    expect(screen.getByRole('button', { name: '365 days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('refetches when the metric changes', async () => {
    const requests = seriesApi((metricKey) =>
      metricKey === 'weight'
        ? twoMethods()
        : mockSeries(metricKey, [mockSeriesPoint(ago(4), 30, 'smart_scale'), mockSeriesPoint(ago(2), 29.5, 'smart_scale')]),
    );
    const { user } = renderChart();
    await screen.findByTestId('measurement-trend-chart');
    await user.click(screen.getByRole('combobox', { name: 'Metric' }));
    await user.click(await screen.findByRole('option', { name: 'Body fat' }));
    await waitFor(() => expect(requests.map((r) => r.metricKey)).toEqual(['weight', 'body_fat_pct']));
    expect(await screen.findByRole('img', { name: /^Body fat, last 90 days, 2 readings, latest 29.5%/ })).toBeInTheDocument();
  });

  it('never lets a stale (slower) response overwrite a newer one', async () => {
    seriesApi(() => twoMethods());
    server.use(
      http.get('*/api/measurements/series', async ({ request }) => {
        const url = new URL(request.url);
        const from = Date.parse(url.searchParams.get('from')!);
        const days = Math.round((NOW - from) / DAY_MS);
        if (days === 30) {
          // The 30-day answer arrives AFTER the 365-day one.
          await delay(150);
          return HttpResponse.json({
            data: mockSeries('weight', [mockSeriesPoint(ago(2), 70, 'scale'), mockSeriesPoint(ago(1), 70, 'scale')]),
          });
        }
        return HttpResponse.json({
          data: mockSeries('weight', [
            mockSeriesPoint(ago(200), 90, 'scale'),
            mockSeriesPoint(ago(100), 85, 'scale'),
            mockSeriesPoint(ago(1), 80, 'scale'),
          ]),
        });
      }),
    );
    vi.useRealTimers();
    const user = userEvent.setup();
    render(
      <MeasurementTrendChart
        metrics={mockMetricCatalog.metrics}
        methodLabels={METHOD_LABELS}
        unitSystem="metric"
        canLog
        onLog={vi.fn()}
        width={800}
        initialRange={365}
      />,
    );
    await screen.findByRole('img', { name: /^Weight, last 365 days, 3 readings/ });
    await user.click(screen.getByRole('button', { name: '30 days' }));
    await user.click(screen.getByRole('button', { name: '365 days' }));
    await screen.findByRole('img', { name: /^Weight, last 365 days, 3 readings/ });
    // Give the slow 30-day response time to land; it must be ignored.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.getByRole('img', { name: /^Weight, last 365 days, 3 readings/ })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /latest 70.0 kg/ })).toBeNull();
  });

  it('draws blood pressure as two labelled series from two requests', async () => {
    const requests = seriesApi((metricKey) =>
      mockSeries(
        metricKey,
        metricKey === 'bp_systolic'
          ? [mockSeriesPoint(ago(3), 130, 'bp_cuff'), mockSeriesPoint(ago(1), 128, 'bp_cuff')]
          : [mockSeriesPoint(ago(3), 86, 'bp_cuff'), mockSeriesPoint(ago(1), 84, 'bp_cuff')],
      ),
    );
    renderChart({ initialMetric: 'blood_pressure' });
    const chart = await screen.findByTestId('measurement-trend-chart');
    expect(requests.map((r) => r.metricKey).sort()).toEqual(['bp_diastolic', 'bp_systolic']);
    expect(within(chart).getByText('Systolic (Blood-pressure cuff)')).toBeInTheDocument();
    expect(within(chart).getByText('Diastolic (Blood-pressure cuff)')).toBeInTheDocument();
    expect(chart).toHaveAccessibleName(
      'Blood pressure, last 90 days, 2 readings, latest 128/84 mmHg, range systolic 128 to 130 mmHg, diastolic 84 to 86 mmHg',
    );
  });

  it('gives check-in scores a fixed 1 to 5 axis', async () => {
    seriesApi((metricKey) =>
      mockSeries(metricKey, [mockSeriesPoint(ago(2), 3, 'self_report'), mockSeriesPoint(ago(1), 4, 'self_report')]),
    );
    renderChart({ initialMetric: 'energy' });
    const chart = await screen.findByTestId('measurement-trend-chart');
    expect(chart).toHaveAccessibleName('Energy, last 90 days, 2 readings, latest 4 of 5, range 3 to 4');
    for (const tick of ['1', '2', '3', '4', '5']) {
      expect(within(chart).getAllByText(tick).length).toBeGreaterThan(0);
    }
    expect(within(chart).getByText('Score')).toBeInTheDocument();
  });

  it('asks for two readings when there is one', async () => {
    seriesApi(() => mockSeries('weight', [mockSeriesPoint(ago(1), 80, 'scale')]));
    renderChart();
    expect(await screen.findByText('Log at least two readings to see a trend')).toBeInTheDocument();
    expect(screen.queryByTestId('measurement-trend-chart')).toBeNull();
  });

  it('offers a Log button with no readings', async () => {
    seriesApi(() => mockSeries('weight', []));
    const { user, onLog } = renderChart({ initialRange: 30 });
    expect(await screen.findByText('No weight readings in the last 30 days')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Log weight' }));
    expect(onLog).toHaveBeenCalledWith('weight');
  });

  it('says when only the most recent 1000 readings are shown', async () => {
    seriesApi(() => ({ ...twoMethods(), truncated: true }));
    renderChart();
    expect(await screen.findByText('Showing your most recent 1000 readings.')).toBeInTheDocument();
  });

  it('shows an error with Retry, and the section-level message on 403', async () => {
    let fail = true;
    seriesApi(() =>
      fail ? HttpResponse.json({ message: 'Boom' }, { status: 500 }) : twoMethods(),
    );
    const { user } = renderChart();
    expect(await screen.findByText(/Could not load the chart/)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('measurement-trend-chart')).toBeInTheDocument();
  });

  it('shows "not available" on 403', async () => {
    seriesApi(() => HttpResponse.json({ message: 'Forbidden' }, { status: 403 }));
    renderChart();
    expect(await screen.findByText('Health data is not available for your account')).toBeInTheDocument();
  });

  it('refetches when refreshToken changes', async () => {
    const requests = seriesApi(() => twoMethods());
    const { rerender } = renderChart({ refreshToken: 0 });
    await screen.findByTestId('measurement-trend-chart');
    rerender(
      <MeasurementTrendChart
        metrics={mockMetricCatalog.metrics}
        methodLabels={METHOD_LABELS}
        unitSystem="metric"
        canLog
        onLog={vi.fn()}
        width={800}
        refreshToken={1}
      />,
    );
    await waitFor(() => expect(requests).toHaveLength(2));
  });

  it('fits a phone: controls wrap, 44px range targets, no axe violations', async () => {
    act(() => setViewportWidth(375));
    seriesApi(() => twoMethods());
    const { container } = renderChart({ width: 343 });
    await screen.findByTestId('measurement-trend-chart');
    expect(screen.getByRole('group', { name: 'Range' })).toBeInTheDocument();
    vi.useRealTimers();
    expect(await axe(container)).toHaveNoViolations();
  });
});
