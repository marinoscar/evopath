/**
 * A multi-series line chart over `/metrics` `series` — issue #127, epic #576.
 *
 * One line per series the caller passes (a family split by its `dimension`
 * draws one line per `groupBy` value — per mountpoint, per outcome, per
 * state). Every series in one chart shares a unit, so there is one y axis,
 * formatted by that unit. A `null` point is a GAP (nothing measured), never a
 * zero. The legend names every line, so colour is never the only key; the
 * chart itself is one labelled image, and the numbers it shows are also in the
 * section's tiles and table.
 *
 * Built on `@mui/x-charts`, like the API and log timelines.
 */
import { Box, Typography, useTheme } from '@mui/material';
import { LineChart } from '@mui/x-charts/LineChart';
import type { DashboardMetricSeries } from '../../../../services/telemetryDashboard';
import { formatBucketLabel, formatMetricValue, formatTimestamp } from '../format';

/** Lines past this many are left out (and said so): a 20-line chart reads as noise. */
export const METRIC_CHART_MAX_LINES = 8;

export interface MetricSeriesChartProps {
  /** What the chart shows, e.g. "CPU and memory utilization" — its accessible name. */
  title: string;
  series: DashboardMetricSeries[];
  height: number;
  spanMs: number;
  /** Phone: legend below and at most 4 x labels. */
  compact: boolean;
  /** A fixed colour for a line (`outcome` → success/error); others take the palette in order. */
  colorFor?: (series: DashboardMetricSeries) => string | undefined;
  testId?: string;
}

/** A line's legend name: the split value when split, else the series label. */
export function seriesName(series: DashboardMetricSeries): string {
  return series.groupBy ?? series.label;
}

export function MetricSeriesChart({
  title,
  series,
  height,
  spanMs,
  compact,
  colorFor,
  testId,
}: MetricSeriesChartProps) {
  const theme = useTheme();
  if (series.length === 0) return null;
  const shown = series.slice(0, METRIC_CHART_MAX_LINES);
  const hidden = series.length - shown.length;
  const unit = shown[0].unit;
  // Every series of a group shares the window's buckets; the longest wins if one is short.
  const starts = shown.reduce<string[]>(
    (longest, s) => (s.points.length > longest.length ? s.points.map((p) => p.t) : longest),
    [],
  );
  // Distinct hues first (primary and info are both blue in this theme).
  const palette = [
    theme.palette.primary.main,
    theme.palette.secondary.main,
    theme.palette.warning.main,
    theme.palette.success.main,
    theme.palette.error.main,
    theme.palette.info.main,
    theme.palette.grey[500],
    theme.palette.text.primary,
  ];
  const step = compact ? Math.max(1, Math.ceil(starts.length / 4)) : 1;

  return (
    <Box data-testid={testId} sx={{ minWidth: 0, width: '100%' }}>
      <Box
        role="img"
        aria-label={`${title}: ${shown.map(seriesName).join(', ')}, ${starts.length} buckets`}
        sx={{ minWidth: 0, width: '100%' }}
      >
        <LineChart
          height={height}
          skipAnimation
          series={shown.map((s, index) => ({
            id: `${s.key}:${s.groupBy ?? ''}`,
            label: seriesName(s),
            data: starts.map((t) => s.points.find((p) => p.t === t)?.v ?? null),
            color: colorFor?.(s) ?? palette[index % palette.length],
            connectNulls: false,
            showMark: false,
            valueFormatter: (value: number | null) => formatMetricValue(value, s.unit),
          }))}
          xAxis={[
            {
              scaleType: 'point',
              data: starts,
              valueFormatter: (value: string, context) =>
                context.location === 'tick' ? formatBucketLabel(value, spanMs) : formatTimestamp(value),
              ...(compact
                ? { tickInterval: (_value: string, index: number) => index % step === 0 }
                : { tickLabelInterval: 'auto' as const }),
              height: 28,
            },
          ]}
          yAxis={[
            {
              width: compact ? 52 : 64,
              min: 0,
              ...(unit === '%' ? { max: 100 } : {}),
              valueFormatter: (value: number) => formatMetricValue(value, unit),
            },
          ]}
          grid={{ horizontal: true }}
          margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
          slotProps={{ legend: { position: { vertical: compact ? 'bottom' : 'top', horizontal: 'center' } } }}
        />
      </Box>
      {hidden > 0 && (
        <Typography variant="caption" color="text.secondary">
          {hidden} more not shown.
        </Typography>
      )}
    </Box>
  );
}
