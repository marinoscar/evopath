/**
 * Top lifts in the range (E5.9): best set, estimated 1RM, the last top sets,
 * and a trend chip that says its direction in words next to an arrow (never
 * colour alone). "PR" marks a personal record set inside the range.
 */
import { Box, Chip, List, ListItem, Stack, Typography } from '@mui/material';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import TrendingDownIcon from '@mui/icons-material/TrendingDown';
import TrendingFlatIcon from '@mui/icons-material/TrendingFlat';
import EmojiEventsOutlinedIcon from '@mui/icons-material/EmojiEventsOutlined';
import type { LiftPerformance, LiftTrend } from '../../services/programs';
import { formatWeight, type WeightUnit } from '../../utils/units';
import { weekLabel } from './ChartFrame';

export interface PerformanceListProps {
  performance: LiftPerformance[];
  weightUnit: WeightUnit;
  /** At most this many lifts (the API orders them by sessions). */
  limit?: number;
}

function pctText(value: number | null): string {
  if (value === null) return '';
  const rounded = Math.round(value * 10) / 10;
  return ` ${rounded > 0 ? '+' : ''}${rounded}%`;
}

export function trendText(trend: LiftTrend, trendPct: number | null): string {
  switch (trend) {
    case 'up':
      return `Trending up${pctText(trendPct)}`;
    case 'down':
      return `Trending down${pctText(trendPct)}`;
    case 'flat':
      return 'Holding steady';
    default:
      return 'Not enough sessions yet';
  }
}

function TrendChip({ lift }: { lift: LiftPerformance }) {
  const icon =
    lift.trend === 'up' ? (
      <TrendingUpIcon />
    ) : lift.trend === 'down' ? (
      <TrendingDownIcon />
    ) : lift.trend === 'flat' ? (
      <TrendingFlatIcon />
    ) : undefined;
  const color = lift.trend === 'up' ? 'success' : lift.trend === 'down' ? 'warning' : 'default';
  return (
    <Chip
      size="small"
      variant="outlined"
      color={color}
      icon={icon}
      label={trendText(lift.trend, lift.trendPct)}
    />
  );
}

function setText(weightKg: number | null, reps: number | null, unit: WeightUnit): string {
  const weight = weightKg === null ? '' : formatWeight(weightKg, unit);
  if (weight && reps !== null) return `${weight} × ${reps}`;
  if (weight) return weight;
  return reps !== null ? `${reps} reps` : '—';
}

export function PerformanceList({ performance, weightUnit, limit = 8 }: PerformanceListProps) {
  if (performance.length === 0) {
    return <Typography color="text.secondary">No working sets logged in this range.</Typography>;
  }
  return (
    <List disablePadding>
      {performance.slice(0, limit).map((lift) => (
        <ListItem key={lift.exerciseId} divider disableGutters sx={{ display: 'block', py: 1.5 }}>
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 0.5 }}
          >
            <Typography
              component="h3"
              variant="subtitle1"
              sx={{ overflowWrap: 'anywhere', mr: 'auto' }}
            >
              {lift.name}
            </Typography>
            <TrendChip lift={lift} />
            {lift.prInRange && (
              <Chip
                size="small"
                color="primary"
                icon={<EmojiEventsOutlinedIcon />}
                label="PR in range"
              />
            )}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {lift.sessions} {lift.sessions === 1 ? 'session' : 'sessions'} · best{' '}
            {setText(lift.best.weightKg, lift.best.reps, weightUnit)}
            {lift.best.e1rmKg !== null
              ? ` · est. 1RM ${formatWeight(lift.best.e1rmKg, weightUnit)}`
              : ''}
          </Typography>
          {lift.lastTopSets.length > 0 && (
            <Box component="p" sx={{ m: 0, typography: 'body2', color: 'text.secondary' }}>
              Last top sets:{' '}
              {lift.lastTopSets
                .map(
                  (s) =>
                    `${weekLabel(s.date)} ${setText(s.weightKg, s.reps, weightUnit)}${s.rpe !== null ? ` @ RPE ${s.rpe}` : ''}`
                )
                .join('; ')}
            </Box>
          )}
        </ListItem>
      ))}
    </List>
  );
}
