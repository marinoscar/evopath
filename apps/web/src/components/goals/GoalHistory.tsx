/**
 * One goal's past periods (#268), from `GET /api/goals/:id/history` (newest
 * first): the period's dates, done of target, and a Hit / Missed chip, with
 * the current streak above. Loaded when shown.
 */
import { Box, Button, Chip, Skeleton, Stack, Typography } from '@mui/material';
import { useGoalHistory } from '../../hooks/useGoals';
import type { Goal } from '../../services/goals';
import { localDateIn } from '../../utils/localDates';
import {
  formatGoalAmount,
  formatPeriodRange,
  historyStreak,
  type DistanceUnit,
} from '../../utils/goalFormat';

export function GoalHistory({ goal, unit, id }: { goal: Goal; unit: DistanceUnit; id?: string }) {
  const { history, isLoading, error, refresh } = useGoalHistory(goal.id);

  if (isLoading && history.length === 0) {
    return (
      <Box id={id} data-testid="goal-history-skeleton">
        <Skeleton width="60%" />
        <Skeleton width="50%" />
      </Box>
    );
  }
  if (error && history.length === 0) {
    return (
      <Box id={id} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography color="text.secondary">{error}</Typography>
        <Button size="small" onClick={() => void refresh()}>
          Retry
        </Button>
      </Box>
    );
  }
  if (history.length === 0) {
    return (
      <Typography id={id} color="text.secondary">
        No history yet. Check back after the first {goal.period}.
      </Typography>
    );
  }

  const today = localDateIn(null);
  const streak = historyStreak(history, today);
  return (
    <Box id={id}>
      <Typography variant="body2" sx={{ mb: 1 }}>
        {streak > 0 ? `Current streak: ${streak} ${goal.period}${streak === 1 ? '' : 's'}` : 'No current streak.'}
      </Typography>
      <Stack component="ul" spacing={1} sx={{ listStyle: 'none', m: 0, p: 0 }} aria-label={`${goal.title} history`}>
        {history.map((period) => (
          <Box
            component="li"
            key={period.periodStart}
            sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', justifyContent: 'space-between' }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2">{formatPeriodRange(period.periodStart, period.periodEnd)}</Typography>
              <Typography variant="body2" color="text.secondary">
                {formatGoalAmount({ done: period.done, target: period.target, goal }, unit)}
              </Typography>
            </Box>
            {period.hit ? (
              <Chip size="small" color="success" label="Hit" />
            ) : period.periodEnd >= today ? (
              <Chip size="small" variant="outlined" label="In progress" />
            ) : (
              <Chip size="small" variant="outlined" label="Missed" />
            )}
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

export default GoalHistory;
