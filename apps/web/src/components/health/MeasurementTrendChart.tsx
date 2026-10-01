/**
 * Trend: one metric over the last 30 / 90 / 180 / 365 days, issue #60 (E2.5).
 *
 * METHOD IS SHOWN, NEVER MERGED (VISION §18, §86). Each method is its own
 * series (legend entry, colour, tooltip line): a method's points are joined
 * across the instants where only another method has a reading
 * (`connectNulls`), and no line ever runs from one method to another. When
 * the range holds more than one method an info alert says the values are not
 * directly comparable. Blood pressure is two metrics (systolic, diastolic),
 * two requests, and a series per metric per method.
 *
 * Built on the high-level `LineChart` of `@mui/x-charts`: one plot, one
 * y-axis and a time x-axis are exactly what it packages, so the composition
 * primitives `ApiTimelineChart` needs (bars + line on two axes) buy nothing
 * here. Colours come from the theme's categorical chart series
 * (`theme/chartPalette.ts`) for the current colour scheme (no literal colours,
 * never a status colour), picked by the method's catalog position so a method
 * keeps its colour across ranges. The wrapper is `role="img"` with a
 * summary as its name; the History list below is the full text equivalent.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  ListSubheader,
  MenuItem,
  Skeleton,
  Stack,
  TextField,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import { LineChart } from '@mui/x-charts/LineChart';
import { useChartSeries } from '../../theme/chartPalette';
import { HEALTH_DATA_UNAVAILABLE, type MetricDef, type UnitSystem } from '../../services/health';
import { useMeasurementSeries } from '../../hooks/useMeasurementSeries';
import { EmptyState } from '../common/EmptyState';
import { LogMeasurementButton } from './LogMeasurementButton';
import {
  BP_DIASTOLIC,
  BP_SYSTOLIC,
  distinctMethods,
  metricChoices,
  rangeText,
  summaryLabel,
  toGroupedChartSeries,
  yDomain,
  type ChartGroupInput,
  type MetricChoice,
} from '../../utils/measurementSeries';
import { displayUnit, formatMeasurement, formatNumber, toDisplay, withUnit } from '../../utils/measurementUnits';
import { formatDateTime } from '../../utils/measurementDates';

export const TREND_RANGES = [30, 90, 180, 365] as const;
export type TrendRange = (typeof TREND_RANGES)[number];
export const DEFAULT_TREND_RANGE: TrendRange = 90;

const CHART_HEIGHT = { compact: 280, regular: 360 } as const;

/**
 * The value (y) axis layout. In `@mui/x-charts` the y-axis `width` holds the
 * rotated unit label, the tick marks AND the tick labels (about 30px goes to
 * the label, tick and gaps); a tick label wider than what is left is cut to
 * an ellipsis. 48px on a phone left ~18px, so `210.5` read `2...`. 68px
 * leaves ~38px, room for a five-character tick (`210.5`, `1234`) at the
 * default tick font. On a phone the numeric ticks are also capped at four so
 * they do not crowd the 280px-high plot; desktop keeps its layout (60px,
 * library tick count), which its visual baseline already shows readable.
 */
export const VALUE_AXIS = {
  compact: { width: 68, tickNumber: 4 },
  regular: { width: 60, tickNumber: undefined },
} as const;

export function valueAxisLayout(compact: boolean): { width: number; tickNumber: number | undefined } {
  return compact ? VALUE_AXIS.compact : VALUE_AXIS.regular;
}

const MIN_POINTS_FOR_TREND = 2;
const PART_LABEL: Record<string, string> = { [BP_SYSTOLIC]: 'Systolic', [BP_DIASTOLIC]: 'Diastolic' };

export interface MeasurementTrendChartProps {
  metrics: readonly MetricDef[];
  /** Method key → label, in catalog order. */
  methodLabels: ReadonlyMap<string, string>;
  unitSystem: UnitSystem;
  canLog: boolean;
  /** Opens the quick-entry dialog focused on this metric (body and vital metrics only). */
  onLog: (metricKey: string) => void;
  /** Bumped by the page after any change (log, edit, delete): refetch. */
  refreshToken?: number;
  /** Fixed chart width; tests only (jsdom has no layout). Omitted = fill the container. */
  width?: number;
  initialMetric?: string;
  initialRange?: TrendRange;
}

/** The value as the user reads it, for the tooltip and the summary. A score reads `4 of 5`. */
function formatDisplayValue(metric: MetricDef, displayValue: number, unitSystem: UnitSystem): string {
  if (metric.scale) return `${formatNumber(metric, displayValue)} of ${metric.scale.max}`;
  return withUnit(formatNumber(metric, displayValue), displayUnit(metric, unitSystem));
}

function formatCanonical(metric: MetricDef, canonical: number, unitSystem: UnitSystem): string {
  if (metric.scale) return formatDisplayValue(metric, toDisplay(metric, canonical, unitSystem), unitSystem);
  return formatMeasurement(metric, canonical, unitSystem);
}

export function MeasurementTrendChart({
  metrics,
  methodLabels,
  unitSystem,
  canLog,
  onLog,
  refreshToken = 0,
  width,
  initialMetric = 'weight',
  initialRange = DEFAULT_TREND_RANGE,
}: MeasurementTrendChartProps) {
  const theme = useTheme();
  const palette = useChartSeries();
  const ids = useId();
  // A local layout choice for the chart height and value axis, NOT one of the
  // five coupled `sm` shell gates (docs/specs/settings-ui.md#breakpoint-gates).
  const compact = useMediaQuery(theme.breakpoints.down('sm'));
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const choices = useMemo(() => metricChoices(metrics), [metrics]);
  const [choiceId, setChoiceId] = useState(
    () => (choices.find((c) => c.id === initialMetric) ?? choices[0])?.id ?? '',
  );
  const [days, setDays] = useState<TrendRange>(initialRange);
  const choice: MetricChoice | undefined = choices.find((c) => c.id === choiceId) ?? choices[0];
  const metricsByKey = useMemo(() => new Map(metrics.map((m) => [m.key, m])), [metrics]);
  const primary = choice ? metricsByKey.get(choice.metricKeys[0]) : undefined;

  const data = useMeasurementSeries(choice?.metricKeys ?? [], days, { enabled: !!choice });

  const { refresh } = data;
  const lastToken = useRef(refreshToken);
  useEffect(() => {
    if (lastToken.current === refreshToken) return;
    lastToken.current = refreshToken;
    refresh();
  }, [refreshToken, refresh]);

  const chart = useMemo(() => {
    if (!choice || !primary || data.series.length === 0) return null;
    const grouped = choice.metricKeys.length > 1;
    const groups: ChartGroupInput[] = data.series.map((series) => {
      const metric = metricsByKey.get(series.metricKey) ?? primary;
      return {
        key: series.metricKey,
        label: grouped ? (PART_LABEL[series.metricKey] ?? metric.label) : null,
        points: series.points,
        toDisplay: (canonical: number) => toDisplay(metric, canonical, unitSystem),
      };
    });
    const built = toGroupedChartSeries(groups, methodLabels);
    const allPoints = data.series.flatMap((series) => series.points);
    const methods = distinctMethods(allPoints, methodLabels);
    const count = data.series[0]?.points.length ?? 0;

    const lastOf = (key: string) => {
      const series = data.series.find((s) => s.metricKey === key);
      return series?.points[series.points.length - 1];
    };
    let latest: string | undefined;
    let range: string | undefined;
    if (grouped) {
      const sys = metricsByKey.get(BP_SYSTOLIC);
      const dia = metricsByKey.get(BP_DIASTOLIC);
      const lastSys = lastOf(BP_SYSTOLIC);
      const lastDia = lastOf(BP_DIASTOLIC);
      if (sys && dia && lastSys && lastDia) {
        latest = withUnit(
          `${formatMeasurement(sys, lastSys.value, unitSystem, { withUnit: false })}/${formatMeasurement(
            dia,
            lastDia.value,
            unitSystem,
            { withUnit: false },
          )}`,
          displayUnit(sys, unitSystem),
        );
        const sysRange = rangeText(sys, data.series[0].points.map((p) => p.value), unitSystem);
        const diaRange = rangeText(dia, data.series[1]?.points.map((p) => p.value) ?? [], unitSystem);
        range = [sysRange && `systolic ${sysRange}`, diaRange && `diastolic ${diaRange}`].filter(Boolean).join(', ');
      }
    } else {
      const last = lastOf(primary.key);
      if (last) latest = formatCanonical(primary, last.value, unitSystem);
      const values = data.series[0].points.map((p) => p.value);
      range = primary.scale
        ? values.length
          ? `${formatNumber(primary, Math.min(...values))} to ${formatNumber(primary, Math.max(...values))}`
          : undefined
        : rangeText(primary, values, unitSystem);
    }

    const domain = primary.scale
      ? { min: primary.scale.min, max: primary.scale.max }
      : yDomain(built.series.flatMap((s) => s.data));

    return { built, methods, count, latest, range, domain };
  }, [choice, primary, data.series, metricsByKey, methodLabels, unitSystem]);

  const colorFor = (groupIndex: number, groupCount: number, method: string) => {
    const methodIndex = Math.max(0, primary?.methods.indexOf(method) ?? 0);
    return palette[(methodIndex * groupCount + groupIndex) % palette.length];
  };

  const height = compact ? CHART_HEIGHT.compact : CHART_HEIGHT.regular;
  const valueAxis = valueAxisLayout(compact);
  const isMeasurementMetric = primary ? primary.category !== 'wellness' : false;
  const unitLabel = primary ? (primary.scale ? 'Score' : displayUnit(primary, unitSystem)) : '';

  const renderBody = () => {
    if (data.forbidden) return <Alert severity="info">{HEALTH_DATA_UNAVAILABLE}</Alert>;
    if (data.error && !data.isLoading) {
      return (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={data.refresh}>
              Retry
            </Button>
          }
        >
          Could not load the chart. {data.error}
        </Alert>
      );
    }
    if (!chart || !choice || !primary || !data.range) {
      return <Skeleton variant="rounded" height={height} data-testid="measurement-trend-skeleton" />;
    }
    if (chart.count === 0) {
      return (
        <EmptyState
          Icon={ShowChartIcon}
          headingLevel="h3"
          title={`No ${choice.label.toLowerCase()} readings in the last ${days} days`}
          description={
            isMeasurementMetric
              ? 'Log a reading to start your trend.'
              : 'Record a daily check-in to see how you feel over time.'
          }
          action={
            isMeasurementMetric ? (
              <LogMeasurementButton variant="outlined" canLog={canLog} onClick={() => onLog(choice.metricKeys[0])}>
                Log {choice.label.toLowerCase()}
              </LogMeasurementButton>
            ) : undefined
          }
        />
      );
    }
    if (chart.count < MIN_POINTS_FOR_TREND) {
      return (
        <EmptyState
          Icon={ShowChartIcon}
          headingLevel="h3"
          title="Log at least two readings to see a trend"
          description="Your reading is listed in History below."
        />
      );
    }

    const groupKeys = choice.metricKeys;
    const summary = summaryLabel({
      metric: choice.label,
      days,
      count: chart.count,
      latest: chart.latest,
      range: chart.range,
    });

    return (
      <Stack spacing={2}>
        {chart.methods.length > 1 && (
          <Alert severity="info">
            This range mixes measurement methods (
            {chart.methods.map((m) => methodLabels.get(m) ?? m).join(', ')}). Values from different methods are not
            directly comparable.
          </Alert>
        )}
        {data.truncated && <Alert severity="info">Showing your most recent 1000 readings.</Alert>}
        <Box role="img" aria-label={summary} data-testid="measurement-trend-chart" sx={{ width: '100%', minWidth: 0 }}>
          <LineChart
            height={height}
            width={width}
            skipAnimation={reducedMotion}
            grid={{ horizontal: true }}
            xAxis={[
              {
                id: 'time',
                scaleType: 'time',
                data: chart.built.xData,
                min: data.range.from,
                max: data.range.to,
                tickNumber: compact ? 3 : 6,
                valueFormatter: (value: Date, context) =>
                  context.location === 'tick'
                    ? value.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                    : formatDateTime(value),
              },
            ]}
            yAxis={[
              {
                id: 'value',
                label: unitLabel,
                width: valueAxis.width,
                ...(chart.domain ? { min: chart.domain.min, max: chart.domain.max } : {}),
                ...(primary.scale
                  ? {
                      tickInterval: Array.from(
                        { length: primary.scale.max - primary.scale.min + 1 },
                        (_, i) => primary.scale!.min + i,
                      ),
                    }
                  : valueAxis.tickNumber !== undefined
                    ? { tickNumber: valueAxis.tickNumber }
                    : {}),
                valueFormatter: (value: number) => formatNumber(primary, value),
              },
            ]}
            series={chart.built.series.map((series) => {
              const metric = metricsByKey.get(series.groupKey) ?? primary;
              return {
                id: series.id,
                label: series.label,
                data: series.data,
                connectNulls: true,
                showMark: true,
                color: colorFor(groupKeys.indexOf(series.groupKey), groupKeys.length, series.method),
                valueFormatter: (value: number | null) =>
                  value === null ? null : formatDisplayValue(metric, value, unitSystem),
              };
            })}
            slotProps={{ legend: { position: { vertical: 'bottom', horizontal: 'center' } } }}
            margin={{ top: 8, right: compact ? 8 : 16, bottom: 4, left: 4 }}
          />
        </Box>
      </Stack>
    );
  };

  return (
    <Stack spacing={2}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 }}>
        <TextField
          id={`${ids}-metric`}
          select
          size="small"
          label="Metric"
          value={choice?.id ?? ''}
          onChange={(event) => setChoiceId(event.target.value)}
          sx={{ width: { xs: '100%', sm: 240 } }}
        >
          {(['Body', 'Vitals', 'How you feel'] as const).flatMap((group) => {
            const inGroup = choices.filter((c) => c.group === group);
            if (inGroup.length === 0) return [];
            return [
              <ListSubheader key={`group-${group}`}>{group}</ListSubheader>,
              ...inGroup.map((c) => (
                <MenuItem key={c.id} value={c.id}>
                  {c.label}
                </MenuItem>
              )),
            ];
          })}
        </TextField>
        <Box role="group" aria-label="Range" sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {TREND_RANGES.map((range) => (
            <Chip
              key={range}
              label={`${range} days`}
              clickable
              color={range === days ? 'primary' : 'default'}
              variant={range === days ? 'filled' : 'outlined'}
              aria-pressed={range === days}
              onClick={() => setDays(range)}
              sx={{ minHeight: 44, borderRadius: 22 }}
            />
          ))}
        </Box>
      </Box>
      {renderBody()}
    </Stack>
  );
}

export default MeasurementTrendChart;
