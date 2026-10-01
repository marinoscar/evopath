/**
 * One exercise of a workout (E4.3): name, muscles, the "Last time" slot
 * (E4.4: `ExerciseLastTime` from `LastTimeLine.tsx`; nothing renders while absent), the set rows, Add set, and
 * an overflow menu (Move up/down, Notes, Equipment used, Remove exercise).
 *
 * Completing the LAST row adds the next one (the server copies weight and
 * reps from it) and moves focus to its first field, so a set is: type, tap
 * the check, type the next.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Menu,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { Add as AddIcon, MoreHoriz as MoreHorizIcon } from '@mui/icons-material';
import {
  MAX_SETS_PER_EXERCISE,
  WORKOUT_NOTES_MAX,
  workoutErrorMessage,
  type EquipmentTypeRef,
  type SetInput,
  type SetLogView,
  type UpdateWorkoutExerciseInput,
  type WorkoutExerciseView,
} from '../../services/workouts';
import { muscleLabel } from '../../services/exercises';
import { useEquipmentTypes } from '../../hooks/useEquipmentTypes';
import type { WeightUnit } from '../../utils/units';
import { SetRow } from './SetRow';
import { PlannedTargetProgress } from './PlannedTargetProgress';
import type { PlannedTarget } from '../../hooks/usePlannedTargets';

export interface WorkoutExerciseCardProps {
  entry: WorkoutExerciseView;
  unit: WeightUnit;
  canWrite: boolean;
  isFirst: boolean;
  isLast: boolean;
  /** E4.4's "Last time" line (`ExerciseLastTime`); nothing renders when absent. */
  lastTime?: ReactNode;
  /** #263: the plan's time or distance target; pre-fills sets and shows progress. */
  target?: PlannedTarget | null;
  onMove: (weId: string, direction: -1 | 1) => void;
  onRemove: (entry: WorkoutExerciseView) => void;
  onUpdateEntry: (weId: string, input: UpdateWorkoutExerciseInput) => Promise<unknown>;
  onAddSet: (weId: string, input?: SetInput, options?: { auto?: boolean }) => Promise<SetLogView>;
  onSaveSet: (setId: string, input: SetInput) => Promise<SetLogView>;
  onDeleteSet: (setId: string) => void;
}

function NotesDialog({
  open,
  initial,
  exerciseName,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: string;
  exerciseName: string;
  onClose: () => void;
  onSave: (notes: string | null) => Promise<unknown>;
}) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setText(initial);
      setError(null);
    }
  }, [open, initial]);
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs" aria-labelledby="entry-notes-title">
      <DialogTitle id="entry-notes-title">Notes: {exerciseName}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
        <TextField
          label="Notes"
          value={text}
          onChange={(e) => setText(e.target.value)}
          multiline
          minRows={3}
          fullWidth
          sx={{ mt: 1 }}
          slotProps={{ htmlInput: { maxLength: WORKOUT_NOTES_MAX } }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave(text.trim() === '' ? null : text.trim());
              onClose();
            } catch (err) {
              setError(workoutErrorMessage(err, 'Could not save the notes'));
            } finally {
              setBusy(false);
            }
          }}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function EquipmentDialog({
  open,
  current,
  exerciseName,
  onClose,
  onSave,
}: {
  open: boolean;
  current: EquipmentTypeRef | null;
  exerciseName: string;
  onClose: () => void;
  onSave: (equipmentTypeId: string | null) => Promise<unknown>;
}) {
  const [q, setQ] = useState('');
  const [value, setValue] = useState<EquipmentTypeRef | null>(current);
  const [error, setError] = useState<string | null>(null);
  const { types, isLoading } = useEquipmentTypes({ q, enabled: open });
  useEffect(() => {
    if (open) {
      setValue(current);
      setError(null);
    }
  }, [open, current]);
  const options: EquipmentTypeRef[] = types.map((t) => ({ id: t.id, slug: t.slug, name: t.name }));
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs" aria-labelledby="entry-equipment-title">
      <DialogTitle id="entry-equipment-title">Equipment used: {exerciseName}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
        <Autocomplete
          options={options}
          value={value}
          loading={isLoading}
          onChange={(_, v) => setValue(v)}
          onInputChange={(_, v) => setQ(v)}
          getOptionLabel={(o) => o.name}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          filterOptions={(x) => x}
          renderInput={(params) => <TextField {...params} label="Equipment" sx={{ mt: 1 }} />}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={async () => {
            try {
              await onSave(value?.id ?? null);
              onClose();
            } catch (err) {
              setError(workoutErrorMessage(err, 'Could not save the equipment'));
            }
          }}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function WorkoutExerciseCard({
  entry,
  unit,
  canWrite,
  isFirst,
  isLast,
  lastTime,
  target = null,
  onMove,
  onRemove,
  onUpdateEntry,
  onAddSet,
  onSaveSet,
  onDeleteSet,
}: WorkoutExerciseCardProps) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [equipmentOpen, setEquipmentOpen] = useState(false);
  const [focusSetId, setFocusSetId] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const name = entry.exercise.name;
  const headingId = `exercise-${entry.id}-heading`;
  const atLimit = entry.sets.length >= MAX_SETS_PER_EXERCISE;

  /** `auto`: added by itself after the last set was completed (Finish may discard it). */
  const addSet = async (auto = false) => {
    if (adding) return;
    setAdding(true);
    setAddError(null);
    try {
      const created = await onAddSet(entry.id, {}, { auto });
      setFocusSetId(created.id);
    } catch (err) {
      setAddError(workoutErrorMessage(err, 'Could not add a set'));
    } finally {
      setAdding(false);
    }
  };

  const onCompleted = (saved: SetLogView) => {
    const sets = entryRef.current.sets;
    const last = sets[sets.length - 1];
    if (last && last.id === saved.id && sets.length < MAX_SETS_PER_EXERCISE) void addSet(true);
  };

  const closeMenu = () => setMenuAnchor(null);

  return (
    <Card variant="outlined" component="section" aria-labelledby={headingId}>
      <CardContent sx={{ px: { xs: 1.5, sm: 2 }, '&:last-child': { pb: 1.5 } }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
          <Box sx={{ minWidth: 0, flexGrow: 1 }}>
            <Typography id={headingId} variant="h6" component="h2" sx={{ overflowWrap: 'anywhere' }}>
              {name}
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
              {entry.exercise.primaryMuscles.map((m) => (
                <Chip key={m} size="small" variant="outlined" label={muscleLabel(m)} />
              ))}
              {entry.equipmentType && <Chip size="small" label={entry.equipmentType.name} />}
            </Box>
          </Box>
          <IconButton
            aria-label={`Actions for ${name}`}
            aria-haspopup="menu"
            onClick={(e) => setMenuAnchor(e.currentTarget)}
            sx={{ width: 44, height: 44 }}
          >
            <MoreHorizIcon />
          </IconButton>
          <Menu anchorEl={menuAnchor} open={menuAnchor !== null} onClose={closeMenu}>
            <MenuItem
              disabled={!canWrite || isFirst}
              onClick={() => {
                closeMenu();
                onMove(entry.id, -1);
              }}
            >
              Move up
            </MenuItem>
            <MenuItem
              disabled={!canWrite || isLast}
              onClick={() => {
                closeMenu();
                onMove(entry.id, 1);
              }}
            >
              Move down
            </MenuItem>
            <MenuItem
              disabled={!canWrite}
              onClick={() => {
                closeMenu();
                setNotesOpen(true);
              }}
            >
              Notes
            </MenuItem>
            <MenuItem
              disabled={!canWrite}
              onClick={() => {
                closeMenu();
                setEquipmentOpen(true);
              }}
            >
              Equipment used
            </MenuItem>
            <MenuItem
              disabled={!canWrite}
              onClick={() => {
                closeMenu();
                onRemove(entry);
              }}
              sx={{ color: 'error.main' }}
            >
              Remove exercise
            </MenuItem>
          </Menu>
        </Box>
        {lastTime ? <Box sx={{ mt: 0.5 }}>{lastTime}</Box> : null}
        {target && <PlannedTargetProgress target={target} sets={entry.sets} unit={unit} exerciseName={name} />}
        {entry.notes && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
            {entry.notes}
          </Typography>
        )}

        <Box sx={{ mt: 1 }}>
          {entry.sets.map((set) => (
            <SetRow
              key={set.id}
              set={set}
              trackingMode={entry.exercise.trackingMode}
              unit={unit}
              canWrite={canWrite}
              target={target ? { durationSeconds: target.durationSeconds, distanceMeters: target.distanceMeters } : null}
              autoFocus={focusSetId === set.id}
              onAutoFocused={() => setFocusSetId(null)}
              onSave={onSaveSet}
              onCompleted={onCompleted}
              onDelete={onDeleteSet}
            />
          ))}
        </Box>
        {addError && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {addError}
          </Alert>
        )}
        {canWrite && (
          <Button
            startIcon={<AddIcon />}
            onClick={() => void addSet()}
            disabled={adding || atLimit}
            sx={{ mt: 1, minHeight: 44 }}
            aria-label={`Add set to ${name}`}
          >
            Add set
          </Button>
        )}
      </CardContent>
      {canWrite && (
        <>
          <NotesDialog
            open={notesOpen}
            initial={entry.notes ?? ''}
            exerciseName={name}
            onClose={() => setNotesOpen(false)}
            onSave={(notes) => onUpdateEntry(entry.id, { notes })}
          />
          <EquipmentDialog
            open={equipmentOpen}
            current={entry.equipmentType}
            exerciseName={name}
            onClose={() => setEquipmentOpen(false)}
            onSave={(equipmentTypeId) => onUpdateEntry(entry.id, { equipmentTypeId })}
          />
        </>
      )}
    </Card>
  );
}
