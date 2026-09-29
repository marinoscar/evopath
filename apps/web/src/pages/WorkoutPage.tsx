/**
 * One workout (`/train/workouts/:workoutId`), E4.3. In progress: the active
 * logger (exercises, fast set entry, Finish). Completed: the same cards,
 * still editable, with a "Completed" header, the totals, Edit details and
 * Delete workout. Owned by the `train` destination through the `/train`
 * prefix.
 *
 * `workouts:read` decides whether there is anything to show and
 * `workouts:write` whether anything can change; the API enforces both.
 * Nothing here involves AI (E4.5's "Prefill from photo" slot renders nothing).
 */
import { useState } from 'react';
import { Link as RouterLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Link,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { Add as AddIcon, ArrowBack as ArrowBackIcon, SearchOff as SearchOffIcon } from '@mui/icons-material';
import { usePermissions } from '../hooks/usePermissions';
import { useWorkout } from '../hooks/useWorkout';
import { useWeightUnit } from '../hooks/useWeightUnit';
import { useGyms } from '../hooks/useGyms';
import {
  MAX_EXERCISES_PER_WORKOUT,
  WORKOUTS_UNAVAILABLE,
  WORKOUT_NOTES_MAX,
  workoutErrorMessage,
  type Workout,
  type WorkoutExerciseView,
} from '../services/workouts';
import { setHasValues } from '../utils/workoutFormat';
import { WorkoutHeader } from '../components/train/WorkoutHeader';
import { WorkoutExerciseCard } from '../components/train/WorkoutExerciseCard';
import { ExercisePickerDialog } from '../components/train/ExercisePickerDialog';
import { SummaryStats, WorkoutSummaryDialog } from '../components/train/WorkoutSummaryDialog';
import { EditWorkoutDialog } from '../components/train/EditWorkoutDialog';
import { ReadinessCard } from '../components/train/StartWorkoutDialog';

export const WORKOUT_NOT_FOUND_TITLE = 'Workout not found';

/** Sets holding values that are not marked done. */
export function unfinishedValuedSets(workout: Workout): string[] {
  const ids: string[] = [];
  for (const entry of workout.exercises) {
    for (const set of entry.sets) if (!set.completed && setHasValues(set)) ids.push(set.id);
  }
  return ids;
}

function BackLink() {
  return (
    <Link
      component={RouterLink}
      to="/train"
      underline="hover"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, mb: 1 }}
    >
      <ArrowBackIcon fontSize="small" aria-hidden />
      Train
    </Link>
  );
}

function WorkoutNotesField({
  workout,
  canWrite,
  onSave,
}: {
  workout: Workout;
  canWrite: boolean;
  onSave: (notes: string | null) => Promise<unknown>;
}) {
  const [text, setText] = useState(workout.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  return (
    <TextField
      label="Workout notes"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const next = text.trim() === '' ? null : text.trim();
        if (next === workout.notes) return;
        onSave(next)
          .then(() => setError(null))
          .catch((err: unknown) => setError(workoutErrorMessage(err, 'Notes not saved')));
      }}
      disabled={!canWrite}
      multiline
      minRows={2}
      fullWidth
      error={error !== null}
      helperText={error ?? undefined}
      slotProps={{ htmlInput: { maxLength: WORKOUT_NOTES_MAX } }}
    />
  );
}

export default function WorkoutPage() {
  const { workoutId } = useParams<{ workoutId: string }>();
  const { hasPermission } = usePermissions();
  const canRead = hasPermission('workouts:read');
  const canWrite = hasPermission('workouts:write');
  const location = useLocation();
  const navigate = useNavigate();
  const unit = useWeightUnit();
  const { gyms } = useGyms({ enabled: canRead && hasPermission('gyms:read') });
  const w = useWorkout(canRead ? workoutId : undefined);
  const workout = w.workout;

  const initialNotice = (location.state as { notice?: string } | null)?.notice ?? null;
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [snack, setSnack] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [confirmFinish, setConfirmFinish] = useState<string[] | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<WorkoutExerciseView | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!canRead) {
    return (
      <Container maxWidth="md">
        <Box sx={{ py: 4 }}>
          <BackLink />
          <Alert severity="info">{WORKOUTS_UNAVAILABLE}</Alert>
        </Box>
      </Container>
    );
  }

  if (w.notFound) {
    return (
      <Container maxWidth="md">
        <Box sx={{ py: 4 }}>
          <BackLink />
          <Box sx={{ textAlign: 'center', py: 4 }}>
            <SearchOffIcon aria-hidden sx={{ fontSize: 40, color: 'text.secondary' }} />
            <Typography variant="h5" component="h1" gutterBottom>
              {WORKOUT_NOT_FOUND_TITLE}
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              It may have been deleted, or the link is wrong.
            </Typography>
            <Button component={RouterLink} to="/train" variant="contained">
              Back to Train
            </Button>
          </Box>
        </Box>
      </Container>
    );
  }

  if (w.isLoading && !workout) {
    return (
      <Container maxWidth="md">
        <Box sx={{ py: 4, display: 'flex', justifyContent: 'center' }}>
          <CircularProgress aria-label="Loading workout" />
        </Box>
      </Container>
    );
  }

  if (!workout) {
    return (
      <Container maxWidth="md">
        <Box sx={{ py: 4 }}>
          <BackLink />
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={() => void w.refresh()}>
                Retry
              </Button>
            }
          >
            {w.error ?? 'Could not load the workout.'}
          </Alert>
        </Box>
      </Container>
    );
  }

  const completed = workout.status === 'completed';
  const atExerciseLimit = workout.exercises.length >= MAX_EXERCISES_PER_WORKOUT;

  const addExercises = async (ids: string[]) => {
    const added = await w.addExercises(ids);
    // Start each new exercise with an empty row, ready to type into.
    for (const entry of added) {
      if (entry.sets.length === 0) {
        await w.addSet(entry.id, {}).catch(() => undefined);
      }
    }
  };

  const doFinish = async (markDone: string[]) => {
    setConfirmFinish(null);
    setFinishing(true);
    setActionError(null);
    try {
      for (const setId of markDone) await w.updateSet(setId, { completed: true });
      await w.finish();
      setSummaryOpen(true);
    } catch (err) {
      setActionError(workoutErrorMessage(err, 'Could not finish the workout'));
    } finally {
      setFinishing(false);
    }
  };

  const handleFinish = async () => {
    const pending = unfinishedValuedSets(workout);
    setFinishing(true);
    await w.settle();
    setFinishing(false);
    if (pending.length > 0) setConfirmFinish(pending);
    else await doFinish([]);
  };

  const handleRemoveExercise = async (entry: WorkoutExerciseView) => {
    setRemoveTarget(null);
    try {
      await w.removeExercise(entry.id);
      setSnack(`Removed ${entry.exercise.name}`);
    } catch (err) {
      setActionError(workoutErrorMessage(err, 'Could not remove the exercise'));
    }
  };

  const requestRemove = (entry: WorkoutExerciseView) => {
    if (entry.sets.some(setHasValues)) setRemoveTarget(entry);
    else void handleRemoveExercise(entry);
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await w.remove();
      navigate('/train', { replace: true });
    } catch (err) {
      setDeleting(false);
      setDeleteOpen(false);
      setActionError(workoutErrorMessage(err, 'Could not delete the workout'));
    }
  };

  const exerciseCards = (
    <Stack spacing={2}>
      {workout.exercises.length === 0 && (
        <Typography color="text.secondary">
          {completed ? 'No exercises were logged.' : 'Add an exercise to start logging sets.'}
        </Typography>
      )}
      {workout.exercises.map((entry, i) => (
        <WorkoutExerciseCard
          key={entry.id}
          entry={entry}
          unit={unit}
          canWrite={canWrite}
          isFirst={i === 0}
          isLast={i === workout.exercises.length - 1}
          onMove={(weId, dir) => {
            w.moveExercise(weId, dir).catch((err: unknown) =>
              setActionError(workoutErrorMessage(err, 'Could not move the exercise')),
            );
          }}
          onRemove={requestRemove}
          onUpdateEntry={w.updateExercise}
          onAddSet={w.addSet}
          onSaveSet={w.updateSet}
          onDeleteSet={(setId) => {
            w.deleteSet(setId).catch((err: unknown) =>
              setActionError(workoutErrorMessage(err, 'Could not delete the set')),
            );
          }}
        />
      ))}
      {canWrite && (
        <Button
          variant="outlined"
          startIcon={<AddIcon />}
          onClick={() => setPickerOpen(true)}
          disabled={atExerciseLimit}
          sx={{ minHeight: 44, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
        >
          Add exercise
        </Button>
      )}
      {/* E4.5: "Prefill from photo" goes here; nothing renders until then. */}
    </Stack>
  );

  const readiness = workout.readinessSnapshot;

  return (
    <Container maxWidth={completed ? 'lg' : 'md'}>
      <Box sx={{ py: { xs: 2, sm: 4 } }}>
        <BackLink />
        {notice && (
          <Alert severity="info" onClose={() => setNotice(null)} sx={{ mb: 2 }}>
            {notice}
          </Alert>
        )}
        {actionError && (
          <Alert severity="error" onClose={() => setActionError(null)} sx={{ mb: 2 }}>
            {actionError}
          </Alert>
        )}
        <WorkoutHeader
          workout={workout}
          canWrite={canWrite}
          gyms={gyms}
          onRename={(name) => w.update({ name })}
          onChangeGym={(gymId) =>
            w.update({ gymId }).catch((err: unknown) => {
              setActionError(workoutErrorMessage(err, 'Could not change the gym'));
              throw err;
            })
          }
          onFinish={() => void handleFinish()}
          finishing={finishing}
          onEditDetails={() => setEditOpen(true)}
          onDelete={() => setDeleteOpen(true)}
        />

        {completed ? (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 2fr) minmax(0, 1fr)' },
              gap: 2,
              alignItems: 'start',
            }}
          >
            <Box sx={{ minWidth: 0 }}>{exerciseCards}</Box>
            <Stack spacing={2} sx={{ minWidth: 0 }}>
              <Card variant="outlined" component="section" aria-labelledby="workout-totals-heading">
                <CardContent>
                  <Typography id="workout-totals-heading" variant="subtitle2" component="h2" sx={{ mb: 1 }}>
                    Totals
                  </Typography>
                  <SummaryStats workout={workout} unit={unit} />
                </CardContent>
              </Card>
              {workout.notes && (
                <Card variant="outlined" component="section" aria-labelledby="workout-notes-heading">
                  <CardContent>
                    <Typography id="workout-notes-heading" variant="subtitle2" component="h2">
                      Notes
                    </Typography>
                    <Typography variant="body2" sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                      {workout.notes}
                    </Typography>
                  </CardContent>
                </Card>
              )}
              {readiness && <ReadinessCard checkIn={readiness} title="Readiness at start" />}
            </Stack>
          </Box>
        ) : (
          <Stack spacing={2}>
            {readiness && <ReadinessCard checkIn={readiness} title="Readiness at start" />}
            {exerciseCards}
            <WorkoutNotesField
              key={workout.id}
              workout={workout}
              canWrite={canWrite}
              onSave={(notes) => w.update({ notes })}
            />
          </Stack>
        )}
      </Box>

      {canWrite && (
        <ExercisePickerDialog
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          gym={workout.gym}
          onAdd={addExercises}
          canCreate={hasPermission('exercises:write')}
        />
      )}

      <Dialog open={confirmFinish !== null} onClose={() => setConfirmFinish(null)} aria-labelledby="confirm-finish-title">
        <DialogTitle id="confirm-finish-title">Finish workout?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirmFinish?.length === 1
              ? '1 set is not marked done. Mark it done, or leave it?'
              : `${confirmFinish?.length ?? 0} sets are not marked done. Mark them done, or leave them?`}
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Button onClick={() => setConfirmFinish(null)}>Cancel</Button>
          <Button onClick={() => void doFinish([])}>Leave them</Button>
          <Button variant="contained" onClick={() => void doFinish(confirmFinish ?? [])}>
            Mark done
          </Button>
        </DialogActions>
      </Dialog>

      <WorkoutSummaryDialog open={summaryOpen} workout={workout} unit={unit} onClose={() => setSummaryOpen(false)} />

      {canWrite && completed && (
        <EditWorkoutDialog
          open={editOpen}
          workout={workout}
          gyms={gyms}
          onClose={() => setEditOpen(false)}
          onSave={(input) => w.update(input)}
        />
      )}

      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} aria-labelledby="delete-workout-title">
        <DialogTitle id="delete-workout-title">Delete workout?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {workout.name} and every set in it will be deleted. This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteOpen(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button color="error" variant="contained" onClick={() => void handleDelete()} disabled={deleting}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={removeTarget !== null} onClose={() => setRemoveTarget(null)} aria-labelledby="remove-exercise-title">
        <DialogTitle id="remove-exercise-title">Remove {removeTarget?.exercise.name}?</DialogTitle>
        <DialogContent>
          <DialogContentText>Its logged sets will be removed from this workout.</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoveTarget(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => removeTarget && void handleRemoveExercise(removeTarget)}>
            Remove
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snack !== null}
        autoHideDuration={4000}
        onClose={() => setSnack(null)}
        message={snack ?? ''}
      />
    </Container>
  );
}
