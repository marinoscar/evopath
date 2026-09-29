/**
 * After Finish (E4.3): duration, exercises, sets and volume in the display
 * unit, as the API totalled them. PR chips arrive with E4.4.
 */
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from '@mui/material';
import type { Workout } from '../../services/workouts';
import type { WeightUnit } from '../../utils/units';
import { formatDuration, formatVolume } from '../../utils/workoutFormat';

export function SummaryStats({ workout, unit }: { workout: Workout; unit: WeightUnit }) {
  const { summary } = workout;
  const stats: Array<[string, string]> = [
    ['Duration', summary.durationSeconds !== null ? formatDuration(summary.durationSeconds) : '—'],
    ['Exercises', String(summary.exerciseCount)],
    ['Sets', String(summary.setCount)],
    ['Volume', formatVolume(summary.volumeKg, unit)],
  ];
  return (
    <Box
      component="dl"
      sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 2, m: 0 }}
    >
      {stats.map(([label, value]) => (
        <Box key={label}>
          <Typography component="dt" variant="caption" color="text.secondary">
            {label}
          </Typography>
          <Typography component="dd" variant="h6" sx={{ m: 0 }}>
            {value}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

export interface WorkoutSummaryDialogProps {
  open: boolean;
  workout: Workout | null;
  unit: WeightUnit;
  onClose: () => void;
}

export function WorkoutSummaryDialog({ open, workout, unit, onClose }: WorkoutSummaryDialogProps) {
  return (
    <Dialog open={open && workout !== null} onClose={onClose} fullWidth maxWidth="xs" aria-labelledby="workout-summary-title">
      <DialogTitle id="workout-summary-title">Workout finished</DialogTitle>
      <DialogContent>
        {workout && (
          <>
            <Typography sx={{ mb: 2, overflowWrap: 'anywhere' }}>{workout.name}</Typography>
            <SummaryStats workout={workout} unit={unit} />
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={onClose}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}
