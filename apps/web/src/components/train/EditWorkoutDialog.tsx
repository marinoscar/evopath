/**
 * Edit details of a completed workout (E4.3): name, date, gym and notes.
 * Only changed fields are sent; the API checks the date window and answers
 * with a message shown in place.
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
} from '@mui/material';
import {
  WORKOUT_NAME_MAX,
  WORKOUT_NOTES_MAX,
  workoutErrorMessage,
  type UpdateWorkoutInput,
  type Workout,
} from '../../services/workouts';
import type { GymSummary } from '../../services/gyms';
import { useCompactDialog } from '../gyms/useCompactDialog';
import { NO_GYM_LABEL } from './StartWorkoutDialog';

export interface EditWorkoutDialogProps {
  open: boolean;
  workout: Workout;
  gyms: GymSummary[];
  onClose: () => void;
  onSave: (input: UpdateWorkoutInput) => Promise<unknown>;
}

export function EditWorkoutDialog({ open, workout, gyms, onClose, onSave }: EditWorkoutDialogProps) {
  const fullScreen = useCompactDialog();
  const [name, setName] = useState(workout.name);
  const [date, setDate] = useState(workout.date);
  const [gymId, setGymId] = useState(workout.gymId ?? '');
  const [notes, setNotes] = useState(workout.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(workout.name);
      setDate(workout.date);
      setGymId(workout.gymId ?? '');
      setNotes(workout.notes ?? '');
      setError(null);
      setBusy(false);
    }
    // Reset only when (re)opened.
  }, [open]);

  // A gym the workout points at that is no longer in the list (deleted) still needs an option.
  const gymOptions = workout.gym && !gyms.some((g) => g.id === workout.gym?.id) ? [...gyms, { id: workout.gym.id, name: workout.gym.name }] : gyms;

  const handleSave = async () => {
    const input: UpdateWorkoutInput = {};
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Give the workout a name.');
      return;
    }
    if (trimmedName !== workout.name) input.name = trimmedName;
    if (date && date !== workout.date) input.date = date;
    const nextGym = gymId === '' ? null : gymId;
    if (nextGym !== workout.gymId) input.gymId = nextGym;
    const nextNotes = notes.trim() === '' ? null : notes.trim();
    if (nextNotes !== workout.notes) input.notes = nextNotes;
    if (Object.keys(input).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(input);
      onClose();
    } catch (err) {
      setError(workoutErrorMessage(err, 'Could not save the workout'));
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
      aria-labelledby="edit-workout-title"
    >
      <DialogTitle id="edit-workout-title">Edit details</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            slotProps={{ htmlInput: { maxLength: WORKOUT_NAME_MAX } }}
          />
          <TextField
            label="Date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <TextField select label="Gym" value={gymId} onChange={(e) => setGymId(e.target.value)}>
            {gymOptions.map((gym) => (
              <MenuItem key={gym.id} value={gym.id}>
                {gym.name}
              </MenuItem>
            ))}
            <MenuItem value="">{NO_GYM_LABEL}</MenuItem>
          </TextField>
          <TextField
            label="Notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            multiline
            minRows={3}
            slotProps={{ htmlInput: { maxLength: WORKOUT_NOTES_MAX } }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void handleSave()} disabled={busy}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
