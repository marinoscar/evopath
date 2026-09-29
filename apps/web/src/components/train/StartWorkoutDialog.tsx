/**
 * Start a workout (E4.3). Name (optional), gym (the default preselected, or
 * "No gym / bodyweight"), and today's readiness check-in shown read-only:
 * information only, never advice and never a gate. `POST /workouts` answers
 * `existing: true` when a workout is already in progress; the caller then
 * opens that one instead.
 *
 * The API picks the default gym when `gymId` is omitted, so "No gym" on a
 * user who has a default gym is a start followed by `PATCH gymId: null`.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Link,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  startWorkout,
  updateWorkout,
  workoutErrorMessage,
  WORKOUT_NAME_MAX,
  type StartWorkoutResult,
} from '../../services/workouts';
import { CHECK_IN_FIELDS, type CheckIn } from '../../services/health';
import { useGyms } from '../../hooks/useGyms';
import { useCheckIn } from '../../hooks/useCheckIn';
import { usePermissions } from '../../hooks/usePermissions';
import { formatShortTime } from '../../utils/measurementDates';
import { useCompactDialog } from '../gyms/useCompactDialog';

export const NO_GYM_VALUE = '';
export const NO_GYM_LABEL = 'No gym / bodyweight';

const SHORT_LABEL: Record<string, string> = {
  energy: 'Energy',
  sleepQuality: 'Sleep',
  soreness: 'Soreness',
  stress: 'Stress',
};

/** "Energy 4/5 · Sleep 3/5 · Soreness 2/5", only the scores that are set. */
export function readinessLine(checkIn: Pick<CheckIn, 'energy' | 'sleepQuality' | 'soreness' | 'stress'>): string {
  return CHECK_IN_FIELDS.flatMap(({ field, fallbackLabel }) => {
    const value = checkIn[field];
    return value === null ? [] : [`${SHORT_LABEL[field] ?? fallbackLabel} ${value}/5`];
  }).join(' · ');
}

export function ReadinessCard({
  checkIn,
  title = 'Readiness',
}: {
  checkIn: Pick<CheckIn, 'energy' | 'sleepQuality' | 'soreness' | 'stress' | 'note' | 'updatedAt'>;
  title?: string;
}) {
  const line = readinessLine(checkIn);
  if (!line && !checkIn.note) return null;
  return (
    <Card variant="outlined" component="section" aria-label={title}>
      <CardContent sx={{ '&:last-child': { pb: 2 } }}>
        <Typography variant="subtitle2" component="h3">
          {title}
        </Typography>
        {line && <Typography variant="body2">{line}</Typography>}
        {checkIn.note && (
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {checkIn.note}
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary">
          From your check-in, as of {formatShortTime(checkIn.updatedAt)}
        </Typography>
      </CardContent>
    </Card>
  );
}

export interface StartWorkoutDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the started (or already running) workout. */
  onStarted: (result: StartWorkoutResult) => void;
}

export function StartWorkoutDialog({ open, onClose, onStarted }: StartWorkoutDialogProps) {
  const fullScreen = useCompactDialog();
  const { hasPermission } = usePermissions();
  const canReadGyms = hasPermission('gyms:read');
  const { gyms, isLoading: gymsLoading } = useGyms({ enabled: open && canReadGyms });
  const { checkIn } = useCheckIn({ enabled: open && hasPermission('health_data:read') });
  const [name, setName] = useState('');
  const [gymId, setGymId] = useState<string>(NO_GYM_VALUE);
  const [touchedGym, setTouchedGym] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultGym = useMemo(() => gyms.find((g) => g.isDefault) ?? null, [gyms]);

  useEffect(() => {
    if (!open) {
      setName('');
      setTouchedGym(false);
      setGymId(NO_GYM_VALUE);
      setError(null);
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    if (open && !touchedGym) setGymId(defaultGym?.id ?? NO_GYM_VALUE);
  }, [open, touchedGym, defaultGym]);

  const handleStart = async () => {
    setBusy(true);
    setError(null);
    try {
      const trimmed = name.trim();
      let result = await startWorkout({
        ...(trimmed ? { name: trimmed } : {}),
        ...(gymId ? { gymId } : {}),
      });
      // "No gym" chosen, but the API applied the default gym.
      if (!result.existing && gymId === NO_GYM_VALUE && result.gymId !== null) {
        const cleared = await updateWorkout(result.id, { gymId: null });
        result = { ...cleared, existing: false };
      }
      onStarted(result);
    } catch (err) {
      setError(workoutErrorMessage(err, 'Could not start the workout'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="xs"
      aria-labelledby="start-workout-title"
    >
      <DialogTitle id="start-workout-title">Start workout</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Name (optional)"
            placeholder="Workout"
            value={name}
            onChange={(e) => setName(e.target.value)}
            slotProps={{ htmlInput: { maxLength: WORKOUT_NAME_MAX } }}
            fullWidth
          />
          {canReadGyms && (
            <TextField
              select
              label="Gym"
              value={gymsLoading && !touchedGym ? NO_GYM_VALUE : gymId}
              onChange={(e) => {
                setTouchedGym(true);
                setGymId(e.target.value);
              }}
              fullWidth
              helperText="Exercises are filtered to what this gym has."
            >
              {gyms.map((gym) => (
                <MenuItem key={gym.id} value={gym.id}>
                  {gym.name}
                  {gym.isDefault ? ' (default)' : ''}
                </MenuItem>
              ))}
              <MenuItem value={NO_GYM_VALUE}>{NO_GYM_LABEL}</MenuItem>
            </TextField>
          )}
          {canReadGyms && !gymsLoading && gyms.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No gyms yet. You can train without one, or{' '}
              <Link component={RouterLink} to="/gyms">
                Add a gym
              </Link>
              .
            </Typography>
          )}
          {checkIn && (
            <Box>
              <ReadinessCard checkIn={checkIn} />
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void handleStart()} disabled={busy}>
          {busy ? 'Starting…' : 'Start'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
