/**
 * `MetricSeriesChart` (issue #127): one labelled image naming every line,
 * a cap on how many lines are drawn, and nothing at all without series.
 * (jsdom has no layout, so assertions stay on the accessible name.)
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../../../utils/test-utils';
import {
  METRIC_CHART_MAX_LINES,
  MetricSeriesChart,
} from '../../../../../components/telemetry/dashboard/metrics/MetricSeriesChart';
import { mockDashboardMetrics } from '../../../../mocks/fixtures/telemetryDashboard';
import type { DashboardMetricSeries } from '../../../../../services/telemetryDashboard';

const settled = mockDashboardMetrics.queue.series;

describe('MetricSeriesChart', () => {
  it('names the chart and each line (split series by their group value)', () => {
    render(<MetricSeriesChart title="Jobs settled per minute by outcome" series={settled} height={200} spanMs={3_600_000} compact={false} />);
    expect(
      screen.getByRole('img', { name: 'Jobs settled per minute by outcome: succeeded, failed, 4 buckets' }),
    ).toBeInTheDocument();
  });

  it('uses the series label when a series is not split', () => {
    render(
      <MetricSeriesChart title="CPU and memory" series={mockDashboardMetrics.host.series.slice(0, 2)} height={200} spanMs={3_600_000} compact />,
    );
    expect(screen.getByRole('img', { name: /CPU utilization, Memory utilization/ })).toBeInTheDocument();
  });

  it(`draws at most ${METRIC_CHART_MAX_LINES} lines and says how many more there are`, () => {
    const many: DashboardMetricSeries[] = Array.from({ length: METRIC_CHART_MAX_LINES + 2 }, (_, i) => ({
      ...settled[0],
      groupBy: `g${i}`,
    }));
    render(<MetricSeriesChart title="Many" series={many} height={200} spanMs={3_600_000} compact={false} />);
    expect(screen.getByText('2 more not shown.')).toBeInTheDocument();
  });

  it('renders nothing without series', () => {
    render(<MetricSeriesChart title="Empty" series={[]} height={200} spanMs={3_600_000} compact={false} testId="chart" />);
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
