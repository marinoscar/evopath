/**
 * API timeline — issue #578, epic #576.
 *
 * Server requests per bucket as bars stacked by status class (2xx, 3xx, 4xx,
 * 5xx), with p95 latency as a line on a secondary (ms) axis. Composed from
 * `@mui/x-charts` parts because a bar + line pair on two y axes is not one of
 * the packaged charts. Colours come from the theme palette, so both modes
 * work; the legend names every series, so colour is never the only key.
 *
 * Zoom: see `ZoomBrush` — the caller chooses drag and/or tap per layout.
 */
import { Box, useTheme } from '@mui/material';
import { ChartsDataProvider } from '@mui/x-charts/ChartsDataProvider';
import { ChartsWrapper } from '@mui/x-charts/ChartsWrapper';
import { ChartsSurface } from '@mui/x-charts/ChartsSurface';
import { ChartsLegend } from '@mui/x-charts/ChartsLegend';
import { ChartsGrid } from '@mui/x-charts/ChartsGrid';
import { BarPlot } from '@mui/x-charts/BarChart';
import { LinePlot } from '@mui/x-charts/LineChart';
import { ChartsXAxis } from '@mui/x-charts/ChartsXAxis';
import { ChartsYAxis } from '@mui/x-charts/ChartsYAxis';
import { ChartsTooltip } from '@mui/x-charts/ChartsTooltip';
import { ChartsAxisHighlight } from '@mui/x-charts/ChartsAxisHighlight';
import type { DashboardApiBucket } from '../../../services/telemetryDashboard';
import { formatDuration } from './format';
import { TIMELINE_AXIS_ID, timelineXAxis } from './timelineAxis';
import { ZoomBrush } from './ZoomBrush';

export interface TimelineChartProps {
  height: number;
  spanMs: number;
  /** Phone: legend below and at most 4 x labels. */
  compact: boolean;
  zoom: { drag: boolean; tap: boolean };
  onZoomBuckets: (startIndex: number, endIndex: number) => void;
}

export interface ApiTimelineChartProps extends TimelineChartProps {
  buckets: DashboardApiBucket[];
}

export function ApiTimelineChart({ buckets, height, spanMs, compact, zoom, onZoomBuckets }: ApiTimelineChartProps) {
  const theme = useTheme();
  const starts = buckets.map((bucket) => bucket.t);
  const bar = (id: 's2xx' | 's3xx' | 's4xx' | 's5xx', label: string, color: string) => ({
    type: 'bar' as const,
    id,
    label,
    data: buckets.map((bucket) => bucket[id]),
    stack: 'status',
    color,
    yAxisId: 'requests',
  });

  return (
    <Box
      role="img"
      aria-label={`API requests per bucket by status class (2xx, 3xx, 4xx, 5xx) with p95 latency, ${buckets.length} buckets`}
      sx={{ minWidth: 0, width: '100%' }}
    >
      <ChartsDataProvider
        height={height}
        skipAnimation
        series={[
          bar('s2xx', '2xx', theme.palette.success.main),
          bar('s3xx', '3xx', theme.palette.info.main),
          bar('s4xx', '4xx', theme.palette.warning.main),
          bar('s5xx', '5xx', theme.palette.error.main),
          {
            type: 'line',
            id: 'p95',
            label: 'p95 latency',
            data: buckets.map((bucket) => bucket.p95Ms),
            yAxisId: 'latency',
            color: theme.palette.text.primary,
            connectNulls: false,
            showMark: false,
            valueFormatter: (value: number | null) => (value === null ? '—' : formatDuration(value)),
          },
        ]}
        xAxis={[timelineXAxis(starts, spanMs, compact ? 4 : undefined)]}
        yAxis={[
          { id: 'requests', position: 'left', width: compact ? 44 : 48, min: 0 },
          {
            id: 'latency',
            position: 'right',
            width: compact ? 44 : 56,
            min: 0,
            valueFormatter: (value: number) => formatDuration(value),
          },
        ]}
        margin={{ top: 8, right: 4, bottom: 4, left: 4 }}
      >
        <ChartsWrapper legendPosition={{ vertical: compact ? 'bottom' : 'top', horizontal: 'center' }}>
          <ChartsLegend />
          <ChartsSurface>
            <ChartsGrid horizontal />
            <BarPlot />
            <LinePlot />
            <ChartsAxisHighlight x="band" />
            <ChartsXAxis axisId={TIMELINE_AXIS_ID} />
            <ChartsYAxis axisId="requests" />
            <ChartsYAxis axisId="latency" />
            <ZoomBrush values={starts} drag={zoom.drag} tap={zoom.tap} onSelect={onZoomBuckets} />
          </ChartsSurface>
          <ChartsTooltip trigger="axis" />
        </ChartsWrapper>
      </ChartsDataProvider>
    </Box>
  );
}
