/**
 * The trend of one lab analyte, H5 (#189): every result over time, with the
 * reference range the lab printed drawn as a band.
 *
 * RANGES DIFFER PER EVENT. Two labs (or one lab after a method change) print
 * different limits for the same analyte, so the band is not one horizontal
 * strip: it is drawn per result, a step from halfway to the previous result to
 * halfway to the next (`referenceBands` in `utils/biomarkers.ts`). A one-sided
 * range (`≤ 200`) runs to the plot's edge; a result without limits leaves a
 * gap rather than borrowing a neighbour's range.
 *
 * Built from the `@mui/x-charts` composition primitives (as
 * `ApiTimelineChart`), because the band is a custom layer under the line that
 * reads the chart's own scales (`useXScale`, `useYScale`). Colours come from
 * the theme; the wrapper is `role="img"` with a summary as its name, and the
 * results table below is the full text equivalent.
 */
import { useMemo } from 'react';
import { Box, alpha, useMediaQuery, useTheme } from '@mui/material';
import { ChartsDataProvider } from '@mui/x-charts/ChartsDataProvider';
import { ChartsWrapper } from '@mui/x-charts/ChartsWrapper';
import { ChartsSurface } from '@mui/x-charts/ChartsSurface';
import { ChartsGrid } from '@mui/x-charts/ChartsGrid';
import { LinePlot, MarkPlot } from '@mui/x-charts/LineChart';
import { ChartsXAxis } from '@mui/x-charts/ChartsXAxis';
import { ChartsYAxis } from '@mui/x-charts/ChartsYAxis';
import { ChartsTooltip } from '@mui/x-charts/ChartsTooltip';
import { ChartsAxisHighlight } from '@mui/x-charts/ChartsAxisHighlight';
import { useDrawingArea, useXScale, useYScale } from '@mui/x-charts/hooks';
import type { LabSeriesPoint } from '../../../services/biomarkers';
import {
  biomarkerXDomain,
  biomarkerYDomain,
  formatLabValue,
  referenceBands,
  type ReferenceBandStep,
} from '../../../utils/biomarkers';
import { withUnit } from '../../../utils/measurementUnits';
import { formatDateTime } from '../../../utils/measurementDates';

const CHART_HEIGHT = { compact: 260, regular: 340 } as const;
const X_AXIS_ID = 'time';
const Y_AXIS_ID = 'value';

/** The band, under the line: one rectangle per result that has a printed range. */
function ReferenceBandLayer({ steps, color }: { steps: readonly ReferenceBandStep[]; color: string }) {
  const xScale = useXScale<'time'>(X_AXIS_ID);
  const yScale = useYScale<'linear'>(Y_AXIS_ID);
  const area = useDrawingArea();
  const top = area.top;
  const bottom = area.top + area.height;
  const left = area.left;
  const right = area.left + area.width;
  const clampX = (x: number) => Math.min(right, Math.max(left, x));
  const clampY = (y: number) => Math.min(bottom, Math.max(top, y));

  return (
    <g data-testid="reference-band" aria-hidden="true">
      {steps.map((step) => {
        const x0 = clampX(xScale(new Date(step.x0)));
        const x1 = clampX(xScale(new Date(step.x1)));
        const yHigh = step.high === null ? top : clampY(yScale(step.high));
        const yLow = step.low === null ? bottom : clampY(yScale(step.low));
        return (
          <rect
            key={step.id}
            data-testid="reference-band-step"
            data-low={step.low ?? ''}
            data-high={step.high ?? ''}
            x={Math.min(x0, x1)}
            y={Math.min(yHigh, yLow)}
            width={Math.abs(x1 - x0)}
            height={Math.abs(yLow - yHigh)}
            fill={color}
          />
        );
      })}
    </g>
  );
}

export interface BiomarkerTrendChartProps {
  label: string;
  /** Canonical unit. */
  unit: string;
  decimals?: number;
  /** Oldest first, as `GET /api/measurements/series` answers. */
  points: readonly LabSeriesPoint[];
  /** Fixed width; tests only (jsdom has no layout). Omitted = fill the container. */
  width?: number;
}

export function BiomarkerTrendChart({ label, unit, decimals, points, width }: BiomarkerTrendChartProps) {
  const theme = useTheme();
  // A local layout choice for the chart height, NOT one of the five coupled `sm` shell gates.
  const compact = useMediaQuery(theme.breakpoints.down('sm'));
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  const model = useMemo(() => {
    const xDomain = biomarkerXDomain(points);
    const yDomain = biomarkerYDomain(points);
    if (!xDomain || !yDomain) return null;
    return { xDomain, yDomain, steps: referenceBands(points, xDomain) };
  }, [points]);

  if (!model) return null;

  const format = (value: number) => withUnit(formatLabValue(value, decimals), unit);
  const values = points.map((p) => p.value);
  const latest = points[points.length - 1];
  const summary =
    `${label}, ${points.length} result${points.length === 1 ? '' : 's'}` +
    (latest ? `, latest ${format(latest.value)} on ${formatDateTime(latest.measuredAt)}` : '') +
    (points.length > 1 ? `, lowest ${format(Math.min(...values))}, highest ${format(Math.max(...values))}` : '') +
    (model.steps.length > 0 ? '. The shaded band is the reference range the lab printed for each result' : '');

  const height = compact ? CHART_HEIGHT.compact : CHART_HEIGHT.regular;
  const lineColor = theme.palette.primary.main;
  const bandColor = alpha(theme.palette.success.main, theme.palette.mode === 'dark' ? 0.22 : 0.16);

  return (
    <Box role="img" aria-label={summary} data-testid="biomarker-trend-chart" sx={{ width: '100%', minWidth: 0 }}>
      <ChartsDataProvider
        height={height}
        width={width}
        skipAnimation={reducedMotion}
        series={[
          {
            type: 'line',
            id: 'value',
            label,
            data: values,
            color: lineColor,
            showMark: true,
            valueFormatter: (value: number | null) => (value === null ? null : format(value)),
          },
        ]}
        xAxis={[
          {
            id: X_AXIS_ID,
            scaleType: 'time',
            data: points.map((p) => new Date(p.measuredAt)),
            min: new Date(model.xDomain.min),
            max: new Date(model.xDomain.max),
            tickNumber: compact ? 3 : 6,
            valueFormatter: (value: Date, context) =>
              context.location === 'tick'
                ? value.toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
                : formatDateTime(value),
          },
        ]}
        yAxis={[
          {
            id: Y_AXIS_ID,
            label: unit,
            width: compact ? 64 : 60,
            min: model.yDomain.min,
            max: model.yDomain.max,
            ...(compact ? { tickNumber: 4 } : {}),
            valueFormatter: (value: number) => formatLabValue(value, decimals),
          },
        ]}
        margin={{ top: 8, right: compact ? 8 : 16, bottom: 4, left: 4 }}
      >
        <ChartsWrapper>
          <ChartsSurface>
            <ChartsGrid horizontal />
            <ReferenceBandLayer steps={model.steps} color={bandColor} />
            <LinePlot />
            <MarkPlot />
            <ChartsAxisHighlight x="line" />
            <ChartsXAxis axisId={X_AXIS_ID} />
            <ChartsYAxis axisId={Y_AXIS_ID} />
          </ChartsSurface>
          <ChartsTooltip trigger="axis" />
        </ChartsWrapper>
      </ChartsDataProvider>
    </Box>
  );
}

export default BiomarkerTrendChart;
