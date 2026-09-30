/**
 * The Today page's "Today's workout" card body (E4.6): Resume the workout in
 * progress, or Start one (the Train page's `StartWorkoutDialog`, mounted in
 * place, then the logger); the last completed workout at a glance; and this
 * week's count. With `programs:read`, the active plan's session for today
 * (`TodayPlanCard`, shared with Train) comes first.
 *
 * Rendered inside `TodayCard`, which keeps the frame, the `h2` and the
 * "Open Train" link. Loading and failure are quiet and local: the other
 * Today cards never wait on this one.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { Box, Button, Link, Skeleton, Typography } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { usePermissions } from '../../hooks/usePermissions';
import { useWorkoutSummary } from '../../hooks/useWorkoutSummary';
import {
  WORKOUTS_UNAVAILABLE,
  type StartWorkoutResult,
  type WorkoutSummaryInProgress,
  type WorkoutSummaryLast,
} from '../../services/workouts';
import { formatWeight, type WeightUnit } from '../../utils/units';
import { formatDaysAgo, formatDuration, formatVolume, pluralize } from '../../utils/workoutFormat';
import { StartWorkoutDialog } from '../train/StartWorkoutDialog';
import { TodayPlanCard } from '../training/TodayPlanCard';
import { WORKOUT_IN_PROGRESS_NOTICE } from '../../pages/TrainPage';

/** How often the in-progress elapsed time is re-rendered. */
const ELAPSED_TICK_MS = 30_000;

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function InProgress({ workout }: { workout: WorkoutSummaryInProgress }) {
  const now = useNow(true);
  const started = new Date(workout.startedAt).getTime();
  const elapsed = Number.isNaN(started) ? null : Math.max(0, (now - started) / 1000);
  const details = [
    elapsed === null ? null : `${formatDuration(elapsed)} elapsed`,
    workout.gym?.name ?? null,
    `${pluralize(workout.completedSetCount, 'set')} done`,
  ].filter(Boolean);

  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="overline" color="primary" component="p">
        Workout in progress
      </Typography>
      <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{workout.name}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {details.join(' · ')}
      </Typography>
      <Button
        component={RouterLink}
        to={`/train/workouts/${workout.id}`}
        variant="contained"
        startIcon={<PlayArrowIcon aria-hidden />}
      >
        Resume workout
      </Button>
    </Box>
  );
}

function LastWorkout({
  last,
  daysSinceLast,
  unit,
}: {
  last: WorkoutSummaryLast;
  daysSinceLast: number | null;
  unit: WeightUnit;
}) {
  const when = daysSinceLast === null ? null : formatDaysAgo(daysSinceLast);
  const meta = [when, last.gym?.name ?? null, last.durationSeconds === null ? null : formatDuration(last.durationSeconds)]
    .filter(Boolean)
    .join(' · ');
  const counts = [
    pluralize(last.exerciseCount, 'exercise'),
    pluralize(last.setCount, 'set'),
    ...(last.volumeKg > 0 ? [formatVolume(last.volumeKg, unit)] : []),
  ].join(', ');

  return (
    <Box data-testid="today-workout-last">
      <Typography variant="subtitle2" component="h3">
        Last workout
      </Typography>
      <Link
        component={RouterLink}
        to={`/train/workouts/${last.id}`}
        sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}
      >
        {last.name}
      </Link>
      {meta && (
        <Typography variant="body2" color="text.secondary">
          {meta}
        </Typography>
      )}
      <Typography variant="body2" color="text.secondary">
        {counts}
      </Typography>
      {last.topLifts.length > 0 && (
        <Box component="ul" aria-label="Top lifts" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
          {last.topLifts.map((lift) => (
            <Typography component="li" variant="body2" key={lift.exerciseName}>
              {lift.exerciseName}: {formatWeight(lift.weightKg, unit)} × {lift.reps}
            </Typography>
          ))}
        </Box>
      )}
    </Box>
  );
}

function Training({ canWrite }: { canWrite: boolean }) {
  const { summary, isLoading, error, forbidden, weightUnit, refresh } = useWorkoutSummary();
  const navigate = useNavigate();
  const [startOpen, setStartOpen] = useState(false);

  const onStarted = (result: StartWorkoutResult) => {
    setStartOpen(false);
    navigate(`/train/workouts/${result.id}`, {
      state: result.existing ? { notice: WORKOUT_IN_PROGRESS_NOTICE } : undefined,
    });
  };

  let body: ReactNode;
  if (forbidden) {
    body = <Typography color="text.secondary">{WORKOUTS_UNAVAILABLE}</Typography>;
  } else if (!summary && isLoading) {
    body = (
      <Box data-testid="today-workout-skeleton">
        <Skeleton width="60%" />
        <Skeleton width="40%" />
      </Box>
    );
  } else if (!summary) {
    body = (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography color="text.secondary">Couldn&apos;t load training</Typography>
        <Button size="small" onClick={() => void refresh()}>
          Retry
        </Button>
      </Box>
    );
  } else {
    const { inProgress, last, thisWeek, daysSinceLast } = summary;
    body = (
      <Box>
        {inProgress ? (
          <InProgress workout={inProgress} />
        ) : (
          canWrite && (
            <Button
              variant="contained"
              startIcon={<PlayArrowIcon aria-hidden />}
              onClick={() => setStartOpen(true)}
              sx={{ mb: 2 }}
            >
              Start workout
            </Button>
          )
        )}
        {last ? (
          <LastWorkout last={last} daysSinceLast={daysSinceLast} unit={weightUnit} />
        ) : (
          <Typography color="text.secondary">No workouts yet.</Typography>
        )}
        {(last || thisWeek.workoutCount > 0) && (
          <Typography variant="body2" sx={{ mt: 1 }}>
            This week: {pluralize(thisWeek.workoutCount, 'workout')}
          </Typography>
        )}
        {error && (
          // A background refresh failed; the summary above is the last good one.
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Couldn&apos;t load training
            </Typography>
            <Button size="small" onClick={() => void refresh()}>
              Retry
            </Button>
          </Box>
        )}
      </Box>
    );
  }

  return (
    <>
      {body}
      {canWrite && (
        <StartWorkoutDialog open={startOpen} onClose={() => setStartOpen(false)} onStarted={onStarted} />
      )}
    </>
  );
}

export function TodayWorkout() {
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('workouts:write');
  const plan = hasPermission('programs:read') ? (
    <TodayPlanCard canStart={canWrite} canWritePrograms={hasPermission('programs:write')} />
  ) : null;
  if (!hasPermission('workouts:read')) {
    return (
      <>
        {plan}
        <Typography color="text.secondary">{WORKOUTS_UNAVAILABLE}</Typography>
      </>
    );
  }
  return (
    <>
      {plan}
      <Training canWrite={canWrite} />
    </>
  );
}

export default TodayWorkout;
