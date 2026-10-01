/**
 * The Today page's "Goals" card body (#268): one row per active goal from
 * `GET /api/goals/progress` with a progress ring, the line ("2 of 4 walks ·
 * 3 days left", "5,240 / 8,000 steps"), on track / behind / hit, and a
 * Check in button that opens the check-in sheet (an "any workout" goal reads
 * "I did it", since the API counts a manual `workout_any` check-in, with
 * "Log a workout" as the second action). Saving refreshes progress in
 * place. No active goal: "Set a goal", linking to `/train/goals`.
 *
 * Progress that includes activity synced from the Android app (#283) carries
 * a "Health Connect" chip.
 *
 * `GoalsGate` shows the card only with `goals:read`; Check in needs
 * `goals:write`. The API enforces both and computes every number shown.
 *
 * Rendered inside `TodayCard`, which keeps the frame, the `h2` and the
 * "Open Goals" link.
 */
import { useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Button, Chip, Skeleton, Stack, Typography } from '@mui/material';
import { usePermissions } from '../../hooks/usePermissions';
import { useGoalProgress } from '../../hooks/useGoals';
import { useDistanceUnit } from '../../hooks/useDistanceUnit';
import type { Goal, GoalProgress } from '../../services/goals';
import {
  STANDING_LABELS,
  offersWorkoutLog,
  formatGoalProgress,
  formatStreak,
  goalStanding,
  progressPercent,
  type DistanceUnit,
} from '../../utils/goalFormat';
import { GoalProgressRing } from '../goals/GoalProgressRing';
import { CheckInSheet } from '../goals/CheckInSheet';
import { HealthConnectChip, countsHealthConnect } from '../goals/HealthConnectChip';

export function GoalsGate({ children }: { children: ReactNode }) {
  const { hasPermission } = usePermissions();
  return hasPermission('goals:read') ? <>{children}</> : null;
}

const STANDING_COLOR = { hit: 'success', onTrack: 'primary', behind: 'warning' } as const;

function GoalRow({
  item,
  unit,
  canWrite,
  onCheckIn,
}: {
  item: GoalProgress;
  unit: DistanceUnit;
  canWrite: boolean;
  onCheckIn: (goal: Goal) => void;
}) {
  const standing = goalStanding(item);
  const percent = progressPercent(item.done, item.target);
  const line = formatGoalProgress(item, unit);
  const streak = formatStreak(item.streakPeriods, item.goal.period);
  const workoutLog = offersWorkoutLog(item.goal);
  // A sessions goal opens the sheet on "I did it"; say so on the button.
  const checkInLabel = workoutLog && item.goal.metric === 'sessions' ? 'I did it' : 'Check in';
  return (
    <Box
      component="li"
      data-testid={`today-goal-${item.goalId}`}
      sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}
    >
      <GoalProgressRing value={percent} label={`${item.goal.title}: ${line}`} color={STANDING_COLOR[standing]} />
      <Box sx={{ flex: '1 1 140px', minWidth: 0 }}>
        <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{item.goal.title}</Typography>
        <Typography variant="body2" color="text.secondary">
          {line}
        </Typography>
        <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5, flexWrap: 'wrap' }}>
          <Chip size="small" variant="outlined" color={STANDING_COLOR[standing]} label={STANDING_LABELS[standing]} />
          {streak && <Chip size="small" variant="outlined" label={streak} />}
          {countsHealthConnect(item.entries ?? []) && <HealthConnectChip />}
        </Box>
      </Box>
      {canWrite && (
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
          <Button
            variant="outlined"
            size="small"
            onClick={() => onCheckIn(item.goal)}
            aria-label={`${checkInLabel}: ${item.goal.title}`}
            sx={{ minHeight: 44 }}
          >
            {checkInLabel}
          </Button>
          {workoutLog && (
            <Button component={RouterLink} to="/train" size="small" sx={{ minHeight: 44 }}>
              Log a workout
            </Button>
          )}
        </Box>
      )}
    </Box>
  );
}

export function TodayGoals() {
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('goals:write');
  const unit = useDistanceUnit();
  const { progress, isLoading, error, refresh } = useGoalProgress();
  const [checkInGoal, setCheckInGoal] = useState<Goal | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  let body: ReactNode;
  if (isLoading && progress.length === 0) {
    body = (
      <Box data-testid="today-goals-skeleton">
        <Skeleton width="70%" />
        <Skeleton width="50%" />
      </Box>
    );
  } else if (error && progress.length === 0) {
    body = (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography color="text.secondary">Could not load your goals.</Typography>
        <Button size="small" onClick={() => void refresh()}>
          Retry
        </Button>
      </Box>
    );
  } else if (progress.length === 0) {
    body = (
      <Box>
        <Typography color="text.secondary" sx={{ mb: 1 }}>
          Walk four times a week, 8,000 steps a day: pick a target and check in as you go.
        </Typography>
        <Button component={RouterLink} to="/train/goals" variant="outlined" size="small">
          Set a goal
        </Button>
      </Box>
    );
  } else {
    body = (
      <Stack component="ul" spacing={2} sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {progress.map((item) => (
          <GoalRow
            key={item.goalId}
            item={item}
            unit={unit}
            canWrite={canWrite}
            onCheckIn={(goal) => {
              setSaved(null);
              setCheckInGoal(goal);
            }}
          />
        ))}
      </Stack>
    );
  }

  return (
    <Box sx={{ mb: 1 }}>
      {body}
      <Typography role="status" variant="body2" color="success.main" sx={{ mt: saved ? 1 : 0 }}>
        {saved ?? ''}
      </Typography>
      <CheckInSheet
        open={checkInGoal !== null}
        goal={checkInGoal}
        onClose={() => setCheckInGoal(null)}
        onSaved={() => {
          setSaved(`Checked in: ${checkInGoal?.title ?? 'goal'}.`);
          setCheckInGoal(null);
          void refresh();
        }}
      />
    </Box>
  );
}

export default TodayGoals;
