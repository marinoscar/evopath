/**
 * The Train page's History (E4.3): completed workouts, newest first, with
 * "Load more". Each row opens the workout's detail view.
 */
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  List,
  ListItem,
  ListItemButton,
  Paper,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material';
import { FitnessCenter as FitnessCenterIcon } from '@mui/icons-material';
import type { WorkoutListItem } from '../../services/workouts';
import type { WeightUnit } from '../../utils/units';
import { formatDayLabel } from '../../utils/localDates';
import { formatDuration, formatVolume } from '../../utils/workoutFormat';
import { EmptyState } from '../common/EmptyState';

export const HISTORY_EMPTY_TITLE = 'No workouts yet. Start one, log sets in a few taps.';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 exercises · 9 sets · 2,030 lb". */
export function workoutCountsLine(
  item: Pick<WorkoutListItem, 'exerciseCount' | 'setCount' | 'volumeKg'>,
  unit: WeightUnit,
): string {
  const parts = [plural(item.exerciseCount, 'exercise', 'exercises'), plural(item.setCount, 'set', 'sets')];
  if (item.volumeKg > 0) parts.push(formatVolume(item.volumeKg, unit));
  return parts.join(' · ');
}

export interface WorkoutHistoryListProps {
  items: WorkoutListItem[];
  unit: WeightUnit;
  total: number;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  onLoadMore: () => void;
  onRetry: () => void;
}

export function WorkoutHistoryList({
  items,
  unit,
  total,
  hasMore,
  isLoading,
  isLoadingMore,
  error,
  onLoadMore,
  onRetry,
}: WorkoutHistoryListProps) {
  if (isLoading && items.length === 0) {
    return (
      <Stack spacing={1} data-testid="history-skeleton">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} variant="rounded" height={72} />
        ))}
      </Stack>
    );
  }
  if (error && items.length === 0) {
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={onRetry}>
            Retry
          </Button>
        }
      >
        {error}
      </Alert>
    );
  }
  if (items.length === 0) {
    return <EmptyState Icon={FitnessCenterIcon} title={HISTORY_EMPTY_TITLE} headingLevel="h3" />;
  }

  return (
    <Stack spacing={2}>
      <Paper variant="outlined">
        <List aria-label="Workout history" disablePadding>
          {items.map((item, i) => (
            <ListItem key={item.id} disablePadding divider={i < items.length - 1}>
              <ListItemButton
                component={RouterLink}
                to={`/train/workouts/${item.id}`}
                sx={{ py: 1.5, minHeight: 56, alignItems: 'flex-start' }}
              >
                <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
                    <Typography component="span" sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
                      {item.name}
                    </Typography>
                    {item.gym && <Chip size="small" variant="outlined" label={item.gym.name} />}
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    {formatDayLabel(item.date)}
                    {item.durationSeconds !== null ? ` · ${formatDuration(item.durationSeconds)}` : ''}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {workoutCountsLine(item, unit)}
                  </Typography>
                </Box>
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      </Paper>
      {error && <Alert severity="error">{error}</Alert>}
      {hasMore && (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
          <Button variant="outlined" onClick={onLoadMore} disabled={isLoadingMore}>
            {isLoadingMore ? 'Loading…' : 'Load more'}
          </Button>
          <Typography variant="caption" color="text.secondary">
            Showing {items.length} of {total}
          </Typography>
        </Box>
      )}
    </Stack>
  );
}
