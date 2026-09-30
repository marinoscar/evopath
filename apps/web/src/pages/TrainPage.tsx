/**
 * Train (`/train`), E4.3. The weight unit in use, Start workout (or a Resume
 * banner while a workout is in progress), the exercise library, and History.
 *
 * With `programs:read`, the active plan's session for today comes first
 * (`TodayPlanCard`, shared with the Today page), then "This week" (sessions
 * done of planned, adherence, a link to the plan's Progress view).
 *
 * `workouts:read` decides whether there is anything to show and
 * `workouts:write` whether Start is offered; the API enforces both. The one
 * AI affordance, "Adjust today's workout" (E6.1), is gated on AI being on
 * and `ai:use` and never replaces Start.
 */
import { useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Container,
  Stack,
  Typography,
} from '@mui/material';
import {
  EventNote as PlansIcon,
  MenuBook as MenuBookIcon,
  PlayArrow as PlayArrowIcon,
} from '@mui/icons-material';
import { usePermissions } from '../hooks/usePermissions';
import { useWorkouts } from '../hooks/useWorkouts';
import { useWeightUnit } from '../hooks/useWeightUnit';
import { WORKOUTS_UNAVAILABLE, type StartWorkoutResult } from '../services/workouts';
import { StartWorkoutDialog } from '../components/train/StartWorkoutDialog';
import { WorkoutHistoryList } from '../components/train/WorkoutHistoryList';
import { WeightUnitLabel } from '../components/train/WeightUnitLabel';
import { ElapsedTimer } from '../components/train/WorkoutHeader';
import { TodayPlanCard } from '../components/training/TodayPlanCard';
import { ThisWeekCard } from '../components/training/ThisWeekCard';
import { AdjustWorkoutEntry } from '../components/training/adapt/AdjustWorkoutEntry';

export const TRAIN_SUBTITLE = 'Log a workout in a few taps and look back at every session.';
export const WORKOUT_IN_PROGRESS_NOTICE = 'You already have a workout in progress.';

export default function TrainPage() {
  const { hasPermission } = usePermissions();
  const canRead = hasPermission('workouts:read');
  const canWrite = hasPermission('workouts:write');
  const canBrowseExercises = hasPermission('exercises:read');
  const canReadPrograms = hasPermission('programs:read');
  const navigate = useNavigate();
  const unit = useWeightUnit();
  const history = useWorkouts({ enabled: canRead });
  const [startOpen, setStartOpen] = useState(false);

  const onStarted = (result: StartWorkoutResult) => {
    setStartOpen(false);
    navigate(`/train/workouts/${result.id}`, {
      state: result.existing ? { notice: WORKOUT_IN_PROGRESS_NOTICE } : undefined,
    });
  };

  const inProgress = history.inProgress;

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Train
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 0.5 }}>
          {TRAIN_SUBTITLE}
        </Typography>
        <Box sx={{ mb: 3 }}>
          <WeightUnitLabel unit={unit} />
        </Box>

        {canReadPrograms && (
          <Card variant="outlined" component="section" aria-labelledby="today-plan-heading" sx={{ mb: 3 }}>
            <CardContent sx={{ '&:last-child': { pb: 0 } }}>
              <Typography id="today-plan-heading" variant="h6" component="h2" sx={{ mb: 1 }}>
                Today&apos;s plan
              </Typography>
              <TodayPlanCard canStart={canWrite} canWritePrograms={hasPermission('programs:write')} />
            </CardContent>
            <CardActions sx={{ px: 2, pb: 2 }}>
              <Button component={RouterLink} to="/train/plans" startIcon={<PlansIcon />} sx={{ minHeight: 44 }}>
                Plans
              </Button>
            </CardActions>
          </Card>
        )}
        {canReadPrograms && <ThisWeekCard sx={{ mb: 3 }} />}
        {/* E6.1: "Adjust today's workout", hidden with a reason when AI is off. */}
        <AdjustWorkoutEntry sx={{ mb: 3 }} />

        {!canRead ? (
          <Alert severity="info">{WORKOUTS_UNAVAILABLE}</Alert>
        ) : (
          <Stack spacing={3}>
            {inProgress ? (
              <Card variant="outlined" component="section" aria-labelledby="resume-heading" sx={{ borderColor: 'primary.main' }}>
                <CardContent>
                  <Typography id="resume-heading" variant="h6" component="h2">
                    Workout in progress
                  </Typography>
                  <Typography sx={{ overflowWrap: 'anywhere' }}>
                    {inProgress.name}
                    {inProgress.gym ? ` · ${inProgress.gym.name}` : ''}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Elapsed <ElapsedTimer startedAt={inProgress.startedAt} />
                  </Typography>
                </CardContent>
                <CardActions sx={{ px: 2, pb: 2 }}>
                  <Button
                    component={RouterLink}
                    to={`/train/workouts/${inProgress.id}`}
                    variant="contained"
                    startIcon={<PlayArrowIcon />}
                    sx={{ minHeight: 44 }}
                  >
                    Resume workout
                  </Button>
                </CardActions>
              </Card>
            ) : null}

            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {canWrite && !inProgress && (
                <Button
                  variant="contained"
                  size="large"
                  startIcon={<PlayArrowIcon />}
                  onClick={() => setStartOpen(true)}
                  disabled={history.isLoading}
                  sx={{ minHeight: 44, width: { xs: '100%', sm: 'auto' } }}
                >
                  Start workout
                </Button>
              )}
              {canBrowseExercises && (
                <Button
                  component={RouterLink}
                  to="/train/exercises"
                  variant="outlined"
                  startIcon={<MenuBookIcon />}
                  sx={{ minHeight: 44, width: { xs: '100%', sm: 'auto' } }}
                >
                  Exercise library
                </Button>
              )}
            </Box>

            <Box component="section" aria-labelledby="history-heading">
              <Typography id="history-heading" variant="h6" component="h2" sx={{ mb: 1 }}>
                History
              </Typography>
              <WorkoutHistoryList
                items={history.items}
                unit={unit}
                total={history.total}
                hasMore={history.hasMore}
                isLoading={history.isLoading}
                isLoadingMore={history.isLoadingMore}
                error={history.error}
                onLoadMore={() => void history.loadMore()}
                onRetry={() => void history.refresh()}
              />
            </Box>
          </Stack>
        )}
      </Box>
      {canWrite && (
        <StartWorkoutDialog open={startOpen} onClose={() => setStartOpen(false)} onStarted={onStarted} />
      )}
    </Container>
  );
}
