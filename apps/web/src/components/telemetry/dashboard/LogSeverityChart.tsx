/**
 * Log severity timeline — issue #578, epic #576.
 *
 * Log records per bucket, stacked by the API's severity bands (error ≥ 17,
 * warn 13–16, info 9–12, other). Only the bands the reader selected with the
 * severity chips (`sev`) are drawn; `other` (debug, trace, unnumbered) rides
 * with `info`, the band nearest it, so the default error+warn view stays about
 * problems.
 */
import { Box, useTheme } from '@mui/material';
import { BarChart } from '@mui/x-charts/BarChart';
import type { DashboardLogsBucket, DashboardSeverity } from '../../../services/telemetryDashboard';
import { timelineXAxis } from './timelineAxis';
import { ZoomBrush } from './ZoomBrush';
import type { TimelineChartProps } from './ApiTimelineChart';

export interface LogSeverityChartProps extends TimelineChartProps {
  buckets: DashboardLogsBucket[];
  severities: DashboardSeverity[];
}

export function LogSeverityChart({
  buckets,
  severities,
  height,
  spanMs,
  compact,
  zoom,
  onZoomBuckets,
}: LogSeverityChartProps) {
  const theme = useTheme();
  const starts = buckets.map((bucket) => bucket.t);
  const bands: { id: keyof Omit<DashboardLogsBucket, 't'>; label: string; color: string; shown: boolean }[] = [
    { id: 'error', label: 'Error', color: theme.palette.error.main, shown: severities.includes('error') },
    { id: 'warn', label: 'Warn', color: theme.palette.warning.main, shown: severities.includes('warn') },
    { id: 'info', label: 'Info', color: theme.palette.info.main, shown: severities.includes('info') },
    { id: 'other', label: 'Other', color: theme.palette.grey[500], shown: severities.includes('info') },
  ];
  const shown = bands.filter((band) => band.shown);

  return (
    <Box
      role="img"
      aria-label={`Log records per bucket by severity (${shown.map((band) => band.label).join(', ')}), ${buckets.length} buckets`}
      sx={{ minWidth: 0, width: '100%' }}
    >
      <BarChart
        height={height}
        skipAnimation
        series={shown.map((band) => ({
          id: band.id,
          label: band.label,
          data: buckets.map((bucket) => bucket[band.id]),
          stack: 'severity',
          color: band.color,
        }))}
        xAxis={[timelineXAxis(starts, spanMs, compact ? 4 : undefined)]}
        yAxis={[{ width: compact ? 44 : 48, min: 0 }]}
        grid={{ horizontal: true }}
        margin={{ top: 8, right: 8, bottom: 4, left: 4 }}
        slotProps={{ legend: { position: { vertical: compact ? 'bottom' : 'top', horizontal: 'center' } } }}
      >
        <ZoomBrush values={starts} drag={zoom.drag} tap={zoom.tap} onSelect={onZoomBuckets} />
      </BarChart>
    </Box>
  );
}
