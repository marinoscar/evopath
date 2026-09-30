/**
 * Planned versus completed sessions per week (E5.9), with missed and the
 * adherence percent in the summary and the data table. A partial week (it
 * straddles the range edge or is not over yet) is marked in its label.
 */
import { useMediaQuery, useTheme } from '@mui/material';
import { BarChart } from '@mui/x-charts/BarChart';
import { rainbowSurgePalette } from '@mui/x-charts/colorPalettes';
import type { PlanSignals } from '../../services/programs';
import { ChartFrame, weekLabel } from './ChartFrame';

export interface AdherenceChartProps {
  adherence: PlanSignals['adherence'];
  /** Fixed width; tests only (jsdom has no layout). */
  width?: number;
}

export function formatPct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}%`;
}

export function AdherenceChart({ adherence, width }: AdherenceChartProps) {
  const theme = useTheme();
  // A local chart layout choice, not one of the coupled shell gates.
  const compact = useMediaQuery(theme.breakpoints.down('sm'));
  const palette = rainbowSurgePalette(theme.palette.mode);
  const { weeks, totals } = adherence;
  const labels = weeks.map((w) => `${weekLabel(w.weekStart)}${w.partial ? '*' : ''}`);
  const summary =
    `Planned versus completed sessions over ${weeks.length} weeks: ` +
    `${totals.completed} of ${totals.planned} completed, ${totals.missed} missed, ` +
    `adherence ${formatPct(totals.adherencePct)}.`;

  return (
    <ChartFrame
      summary={summary}
      tableLabel="Weekly adherence"
      columns={['Week of', 'Planned', 'Completed', 'Missed', 'Extra', 'Adherence']}
      rows={weeks.map((w) => [
        `${weekLabel(w.weekStart)}${w.partial ? ' (partial week)' : ''}`,
        w.planned,
        w.completed,
        w.missed,
        w.extra,
        formatPct(w.adherencePct),
      ])}
    >
      <BarChart
        height={compact ? 200 : 240}
        width={width}
        skipAnimation
        xAxis={[{ scaleType: 'band', data: labels, tickLabelStyle: { fontSize: 11 } }]}
        yAxis={[{ min: 0, width: 32, tickMinStep: 1 }]}
        series={[
          {
            id: 'planned',
            label: 'Planned',
            data: weeks.map((w) => w.planned),
            color: theme.palette.grey[theme.palette.mode === 'dark' ? 600 : 400],
          },
          {
            id: 'completed',
            label: 'Completed',
            data: weeks.map((w) => w.completed),
            color: palette[0],
          },
        ]}
        grid={{ horizontal: true }}
        margin={{ top: 8, right: 8, bottom: 4, left: 4 }}
        slotProps={{ legend: { position: { vertical: 'top', horizontal: 'center' } } }}
      />
    </ChartFrame>
  );
}
