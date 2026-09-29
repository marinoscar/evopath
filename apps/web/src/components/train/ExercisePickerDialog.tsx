/**
 * Add exercises to a workout (E4.3). Full screen below `sm`.
 *
 * With a gym, "At <gym>" is ON: only exercises that gym can do
 * (`GET /exercises?gymId=&availableOnly=true`). OFF shows everything, the
 * unavailable ones dimmed with "Needs: …" from the API's `missing`; adding one
 * is still allowed (the user knows their gym). A Recent section (exercises of
 * the last five workouts) leads while nothing is searched. Several exercises
 * can be picked; they are added in the order picked. A custom exercise can
 * be created from here and is picked at once.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  InputAdornment,
  List,
  ListItem,
  ListItemText,
  ListSubheader,
  Skeleton,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { Add as AddIcon, Search as SearchIcon } from '@mui/icons-material';
import {
  EXERCISE_QUERY_MAX,
  MUSCLES,
  muscleLabel,
  type Exercise,
  type ExerciseDetail,
  type ExerciseInput,
} from '../../services/exercises';
import type { GymRef } from '../../services/workouts';
import { useExercises } from '../../hooks/useExercises';
import { useRecentExercises } from '../../hooks/useWorkouts';
import { useCompactDialog } from '../gyms/useCompactDialog';
import { CustomExerciseDialog } from './CustomExerciseDialog';

export interface ExercisePickerDialogProps {
  open: boolean;
  onClose: () => void;
  /** The workout's gym; null offers everything. */
  gym: GymRef | null;
  /** Resolves once added; rejects to show the API error in place. */
  onAdd: (exerciseIds: string[]) => Promise<unknown>;
  /** `exercises:write`: offer "Create custom exercise". */
  canCreate: boolean;
}

export function needsLine(exercise: Pick<Exercise, 'available' | 'missing'>): string | null {
  if (exercise.available !== false) return null;
  const missing = exercise.missing ?? [];
  return missing.length > 0 ? `Needs: ${missing.join(' or ')}` : 'Not available at this gym';
}

export function ExercisePickerDialog({ open, onClose, gym, onAdd, canCreate }: ExercisePickerDialogProps) {
  const fullScreen = useCompactDialog();
  const [q, setQ] = useState('');
  const [muscle, setMuscle] = useState<string | null>(null);
  const [atGym, setAtGym] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filterToGym = gym !== null && atGym;
  const { exercises, isLoading, error: loadError, refresh, create } = useExercises({
    q,
    muscle,
    gymId: gym?.id ?? null,
    availableOnly: filterToGym,
    enabled: open,
  });
  const recent = useRecentExercises(open);

  useEffect(() => {
    if (open) {
      setQ('');
      setMuscle(null);
      setAtGym(true);
      setSelected([]);
      setNames({});
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const byId = useMemo(() => new Map(exercises.map((e) => [e.id, e])), [exercises]);
  const recentShown = useMemo(
    () => (q.trim() === '' && muscle === null ? recent.filter((r) => byId.has(r.id)).map((r) => byId.get(r.id)!) : []),
    [q, muscle, recent, byId],
  );

  const toggle = (exercise: Pick<Exercise, 'id' | 'name'>) => {
    setNames((prev) => ({ ...prev, [exercise.id]: exercise.name }));
    setSelected((prev) => (prev.includes(exercise.id) ? prev.filter((id) => id !== exercise.id) : [...prev, exercise.id]));
  };

  const handleAdd = async () => {
    if (selected.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(selected);
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not add the exercises');
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async (input: ExerciseInput): Promise<ExerciseDetail> => {
    const created = await create(input);
    toggle(created);
    return created;
  };

  const renderRow = (exercise: Exercise, keyPrefix: string) => {
    const needs = needsLine(exercise);
    const order = selected.indexOf(exercise.id);
    const checked = order >= 0;
    const labelId = `${keyPrefix}-${exercise.id}-label`;
    const detailId = `${keyPrefix}-${exercise.id}-detail`;
    return (
      <ListItem key={`${keyPrefix}-${exercise.id}`} disablePadding>
        <Box
          component="label"
          sx={{
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            minHeight: 48,
            px: 1,
            cursor: 'pointer',
            borderRadius: 1,
            opacity: needs ? 0.6 : 1,
            '&:hover': { bgcolor: 'action.hover' },
          }}
        >
          <Checkbox
            checked={checked}
            onChange={() => toggle(exercise)}
            slotProps={{ input: { 'aria-labelledby': labelId, 'aria-describedby': detailId } }}
          />
          <ListItemText
            primary={exercise.name}
            secondary={[exercise.primaryMuscles.map(muscleLabel).join(', '), needs].filter(Boolean).join(' · ')}
            slotProps={{
              primary: { id: labelId },
              secondary: { id: detailId, sx: { overflowWrap: 'anywhere' } },
            }}
          />
          {checked && <Chip size="small" color="primary" label={order + 1} aria-hidden />}
        </Box>
      </ListItem>
    );
  };

  let body;
  if (loadError && exercises.length === 0 && !isLoading) {
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={refresh}>
            Retry
          </Button>
        }
      >
        {loadError}
      </Alert>
    );
  } else if (isLoading && exercises.length === 0) {
    body = (
      <Stack spacing={1} data-testid="picker-skeleton">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} variant="rounded" height={48} />
        ))}
      </Stack>
    );
  } else if (exercises.length === 0) {
    body = (
      <Typography color="text.secondary" sx={{ py: 2 }}>
        {filterToGym
          ? `No exercises found at ${gym?.name}. Turn off the gym filter to see everything.`
          : 'No exercises found.'}
      </Typography>
    );
  } else {
    body = (
      <List aria-label="Exercises to add" dense disablePadding>
        {recentShown.length > 0 && (
          <>
            <ListSubheader disableSticky sx={{ px: 0 }}>
              Recent
            </ListSubheader>
            {recentShown.map((e) => renderRow(e, 'recent'))}
            <ListSubheader disableSticky sx={{ px: 0 }}>
              All exercises
            </ListSubheader>
          </>
        )}
        {exercises.map((e) => renderRow(e, 'all'))}
      </List>
    );
  }

  return (
    <>
      <Dialog
        open={open}
        onClose={busy ? undefined : onClose}
        fullScreen={fullScreen}
        fullWidth
        maxWidth="sm"
        aria-labelledby="exercise-picker-title"
      >
        <DialogTitle id="exercise-picker-title">Add exercises</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5}>
            {error && <Alert severity="error">{error}</Alert>}
            <TextField
              type="search"
              label="Search exercises"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              fullWidth
              size="small"
              slotProps={{
                htmlInput: { maxLength: EXERCISE_QUERY_MAX },
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon />
                    </InputAdornment>
                  ),
                },
              }}
            />
            {gym && (
              <FormControlLabel
                control={<Switch checked={atGym} onChange={(e) => setAtGym(e.target.checked)} />}
                label={`At ${gym.name}`}
              />
            )}
            {gym && atGym && (
              <Button size="small" onClick={() => setAtGym(false)} sx={{ alignSelf: 'flex-start' }}>
                Show all
              </Button>
            )}
            <Box
              role="group"
              aria-label="Filter by muscle"
              sx={{ display: 'flex', gap: 1, overflowX: 'auto', pb: 0.5 }}
            >
              <Chip
                label="All muscles"
                clickable
                color={muscle === null ? 'primary' : 'default'}
                variant={muscle === null ? 'filled' : 'outlined'}
                aria-pressed={muscle === null}
                onClick={() => setMuscle(null)}
              />
              {MUSCLES.map((m) => (
                <Chip
                  key={m}
                  label={muscleLabel(m)}
                  clickable
                  color={muscle === m ? 'primary' : 'default'}
                  variant={muscle === m ? 'filled' : 'outlined'}
                  aria-pressed={muscle === m}
                  onClick={() => setMuscle(muscle === m ? null : m)}
                />
              ))}
            </Box>
            {body}
            {canCreate && (
              <Button
                startIcon={<AddIcon />}
                onClick={() => setCreateOpen(true)}
                sx={{ alignSelf: 'flex-start' }}
              >
                Create custom exercise
              </Button>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1, pl: 1, overflowWrap: 'anywhere' }}>
            {selected.length > 0 ? selected.map((id) => names[id]).filter(Boolean).join(', ') : ''}
          </Typography>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="contained" onClick={() => void handleAdd()} disabled={busy || selected.length === 0}>
            {selected.length > 1 ? `Add ${selected.length} exercises` : 'Add exercise'}
          </Button>
        </DialogActions>
      </Dialog>
      {canCreate && (
        <CustomExerciseDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreate={handleCreate} />
      )}
    </>
  );
}
