/**
 * Requests per day as a bar chart, with a table view of the same numbers
 * (issue #444, epic #420).
 *
 * NO CHART LIBRARY. The app ships none (Job Insights is tiles and tables), and
 * one single-series bar chart does not justify adding one: the bars are plain
 * flex boxes, which also means they shrink with their container — 90 bars at
 * 360px get thinner, they never push the page into a horizontal scroll.
 *
 * ACCESSIBLE BY CONSTRUCTION:
 *   - one series in the theme's primary colour, so no identity rides on hue
 *     and there is no legend to decode — the heading names it;
 *   - the plot is a `role="img"` with a text summary (total, busiest day);
 *   - every bar has a hover tooltip with its exact numbers;
 *   - a Chart / Table toggle swaps in the same data as a real table, which is
 *     the view screen-reader and keyboard users are pointed at.
 */
import { useMemo, useState } from 'react';
import { Box, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import type { AiUsageSeriesEntry } from '../../../services/ai';
import { AiUsageTable } from './AiUsageTable';
import { formatCount, formatUsageDay } from './aiUsageFormat';

const PLOT_HEIGHT = 160;

export interface AiUsageDailyChartProps {
  /** One entry per day, oldest first — see `fillDailySeries`. */
  days: AiUsageSeriesEntry[];
  /** Persistence key for the table view's `DataTable`. */
  tableId: string;
  /** Prefix for element ids, so two charts on one page never collide. */
  idPrefix: string;
}

export function AiUsageDailyChart({ days, tableId, idPrefix }: AiUsageDailyChartProps) {
  const [view, setView] = useState<'chart' | 'table'>('chart');

  const { max, total, busiest } = useMemo(() => {
    let maxValue = 0;
    let sum = 0;
    let top: AiUsageSeriesEntry | null = null;
    for (const day of days) {
      sum += day.requests;
      if (day.requests > maxValue) {
        maxValue = day.requests;
        top = day;
      }
    }
    return { max: maxValue, total: sum, busiest: top };
  }, [days]);

  const summary =
    days.length === 0
      ? 'No days in range.'
      : `Requests per day from ${formatUsageDay(days[0].key)} to ${formatUsageDay(
          days[days.length - 1].key,
        )}: ${formatCount(total)} in total` +
        (busiest
          ? `, busiest ${formatUsageDay(busiest.key)} with ${formatCount(busiest.requests)}.`
          : ', none on any day.');

  const titleId = `${idPrefix}-daily-title`;

  return (
    <Box component="section" aria-labelledby={titleId} sx={{ minWidth: 0 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 1,
          mb: 1,
        }}
      >
        <Typography id={titleId} variant="h6" component="h2">
          Requests per day
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={view}
          aria-label="Requests per day view"
          onChange={(_, next) => {
            if (next !== null) setView(next as 'chart' | 'table');
          }}
        >
          <ToggleButton value="chart">Chart</ToggleButton>
          <ToggleButton value="table">Table</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      {view === 'table' ? (
        <AiUsageTable
          rows={[...days].reverse()}
          keyLabel="Day"
          isDay
          tableId={tableId}
          ariaLabel="Requests per day"
          emptyText="No usage in this range."
          data-testid={`${idPrefix}-daily-table`}
        />
      ) : (
        <Box>
          <Box sx={{ display: 'flex', gap: 1, minWidth: 0 }}>
            {/* One recessive y-axis reference: the maximum. */}
            <Typography
              variant="caption"
              color="text.secondary"
              aria-hidden
              sx={{ width: 32, flexShrink: 0, textAlign: 'right', lineHeight: 1 }}
            >
              {formatCount(max)}
            </Typography>
            <Box
              role="img"
              aria-label={summary}
              data-testid={`${idPrefix}-daily-chart`}
              sx={{
                flex: 1,
                minWidth: 0,
                height: PLOT_HEIGHT,
                display: 'flex',
                alignItems: 'flex-end',
                gap: days.length > 45 ? '1px' : '2px',
                borderBottom: 1,
                borderColor: 'divider',
                backgroundImage: (theme) =>
                  `linear-gradient(to bottom, ${theme.palette.divider} 1px, transparent 1px)`,
              }}
            >
              {days.map((day) => {
                const pct = max > 0 ? (day.requests / max) * 100 : 0;
                return (
                  <Tooltip
                    key={day.key}
                    arrow
                    title={`${formatUsageDay(day.key)}: ${formatCount(day.requests)} requests, ${formatCount(
                      day.failed,
                    )} failed`}
                  >
                    {/* The hit target is the full column height, larger than the bar. */}
                    <Box
                      data-testid="ai-usage-day-bar"
                      data-day={day.key}
                      data-requests={day.requests}
                      sx={{
                        flex: 1,
                        minWidth: 0,
                        maxWidth: 32,
                        height: '100%',
                        display: 'flex',
                        alignItems: 'flex-end',
                        '&:hover > span': { bgcolor: 'primary.dark' },
                      }}
                    >
                      <Box
                        component="span"
                        sx={{
                          display: 'block',
                          width: '100%',
                          height: day.requests > 0 ? `max(${pct}%, 2px)` : 0,
                          bgcolor: 'primary.main',
                          borderRadius: '4px 4px 0 0',
                        }}
                      />
                    </Box>
                  </Tooltip>
                );
              })}
            </Box>
          </Box>
          {days.length > 0 && (
            <Box
              aria-hidden
              sx={{
                display: 'flex',
                justifyContent: 'space-between',
                pl: 5,
                mt: 0.5,
                color: 'text.secondary',
              }}
            >
              <Typography variant="caption">{formatUsageDay(days[0].key)}</Typography>
              <Typography variant="caption">
                {formatUsageDay(days[days.length - 1].key)}
              </Typography>
            </Box>
          )}
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 0.5 }}
          >
            Hover a bar for its exact numbers, or switch to Table.
          </Typography>
        </Box>
      )}
    </Box>
  );
}
