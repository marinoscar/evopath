/**
 * New custom exercise (E4.1). Name, muscles, movement pattern, how it is
 * tracked, two flags, notes, and a simple "Needs equipment" picker over the
 * equipment-type catalog (`GET /api/equipment-types`, the gyms feature's
 * service). Every picked type becomes its own requirement group, so the
 * exercise needs ALL of them; richer "any of" groups come with a later editor.
 *
 * The bounds mirror the API's Zod schema so the form can explain a problem
 * before the round trip; the API validates again and decides. Below `sm` the
 * dialog goes full screen (a presentation choice local to this dialog, not one
 * of the navigation breakpoint gates).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
} from '@mui/material';
import {
  EXERCISE_NAME_MAX,
  EXERCISE_NOTES_MAX,
  MOVEMENT_PATTERNS,
  MUSCLES,
  PRIMARY_MUSCLES_MAX,
  REQUIREMENT_GROUPS_MAX,
  SECONDARY_MUSCLES_MAX,
  TRACKING_MODES,
  exerciseErrorMessage,
  muscleLabel,
  patternLabel,
  trackingLabel,
  type ExerciseDetail,
  type ExerciseInput,
} from '../../services/exercises';
import type { EquipmentType } from '../../services/gyms';
import { useEquipmentTypes } from '../../hooks/useEquipmentTypes';
import { useCompactDialog } from '../gyms/useCompactDialog';

export interface CustomExerciseDialogProps {
  open: boolean;
  onClose: () => void;
  /** Creates the exercise; rejects to show the API error in place. */
  onCreate: (input: ExerciseInput) => Promise<ExerciseDetail | void>;
}

interface FormErrors {
  name?: string;
  primaryMuscles?: string;
  movementPattern?: string;
}

export function CustomExerciseDialog({ open, onClose, onCreate }: CustomExerciseDialogProps) {
  const fullScreen = useCompactDialog();
  const [name, setName] = useState('');
  const [primaryMuscles, setPrimaryMuscles] = useState<string[]>([]);
  const [secondaryMuscles, setSecondaryMuscles] = useState<string[]>([]);
  const [movementPattern, setMovementPattern] = useState('');
  const [trackingMode, setTrackingMode] = useState<string>('weight_reps');
  const [isUnilateral, setIsUnilateral] = useState(false);
  const [isBodyweight, setIsBodyweight] = useState(false);
  const [notes, setNotes] = useState('');
  const [equipment, setEquipment] = useState<EquipmentType[]>([]);
  const [equipmentQuery, setEquipmentQuery] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    types,
    isLoading: typesLoading,
    error: typesError,
  } = useEquipmentTypes({
    q: equipmentQuery,
    enabled: open,
  });

  useEffect(() => {
    if (open) {
      setName('');
      setPrimaryMuscles([]);
      setSecondaryMuscles([]);
      setMovementPattern('');
      setTrackingMode('weight_reps');
      setIsUnilateral(false);
      setIsBodyweight(false);
      setNotes('');
      setEquipment([]);
      setEquipmentQuery('');
      setErrors({});
      setError(null);
    }
  }, [open]);

  // A muscle is primary or secondary, never both.
  const secondaryOptions = useMemo(
    () => MUSCLES.filter((m) => !primaryMuscles.includes(m)),
    [primaryMuscles]
  );

  const validate = (): FormErrors => {
    const next: FormErrors = {};
    const trimmed = name.trim();
    if (trimmed === '') next.name = 'Enter a name.';
    else if (trimmed.length > EXERCISE_NAME_MAX)
      next.name = `Use at most ${EXERCISE_NAME_MAX} characters.`;
    if (primaryMuscles.length === 0) next.primaryMuscles = 'Pick at least one primary muscle.';
    if (movementPattern === '') next.movementPattern = 'Pick a movement pattern.';
    return next;
  };

  const submit = async () => {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const input: ExerciseInput = {
        name: name.trim(),
        primaryMuscles,
        secondaryMuscles: secondaryMuscles.filter((m) => !primaryMuscles.includes(m)),
        movementPattern,
        trackingMode,
        isUnilateral,
        isBodyweight,
        notes: notes.trim() === '' ? null : notes.trim(),
        requirements: equipment.map((t) => ({ equipmentTypeIds: [t.id] })),
      };
      await onCreate(input);
      onClose();
    } catch (err) {
      setError(exerciseErrorMessage(err, 'Could not create the exercise'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      aria-labelledby="custom-exercise-title"
      fullScreen={fullScreen}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle id="custom-exercise-title">New custom exercise</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={Boolean(errors.name)}
            helperText={errors.name ?? `${name.length}/${EXERCISE_NAME_MAX}`}
            slotProps={{ htmlInput: { maxLength: EXERCISE_NAME_MAX } }}
            autoFocus
          />
          <Autocomplete
            multiple
            options={[...MUSCLES]}
            value={primaryMuscles}
            onChange={(_e, value) => setPrimaryMuscles(value.slice(0, PRIMARY_MUSCLES_MAX))}
            getOptionLabel={muscleLabel}
            getOptionDisabled={(option) =>
              primaryMuscles.length >= PRIMARY_MUSCLES_MAX && !primaryMuscles.includes(option)
            }
            renderInput={(params) => (
              <TextField
                {...params}
                label="Primary muscles"
                required={primaryMuscles.length === 0}
                error={Boolean(errors.primaryMuscles)}
                helperText={errors.primaryMuscles ?? `1 to ${PRIMARY_MUSCLES_MAX}`}
              />
            )}
          />
          <Autocomplete
            multiple
            options={secondaryOptions}
            value={secondaryMuscles.filter((m) => !primaryMuscles.includes(m))}
            onChange={(_e, value) => setSecondaryMuscles(value.slice(0, SECONDARY_MUSCLES_MAX))}
            getOptionLabel={muscleLabel}
            getOptionDisabled={(option) =>
              secondaryMuscles.length >= SECONDARY_MUSCLES_MAX && !secondaryMuscles.includes(option)
            }
            renderInput={(params) => (
              <TextField
                {...params}
                label="Secondary muscles"
                helperText={`Optional, up to ${SECONDARY_MUSCLES_MAX}`}
              />
            )}
          />
          <TextField
            select
            label="Movement pattern"
            required
            value={movementPattern}
            onChange={(e) => setMovementPattern(e.target.value)}
            error={Boolean(errors.movementPattern)}
            helperText={errors.movementPattern}
          >
            {MOVEMENT_PATTERNS.map((p) => (
              <MenuItem key={p} value={p}>
                {patternLabel(p)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label="Tracking"
            value={trackingMode}
            onChange={(e) => setTrackingMode(e.target.value)}
            helperText="How a set of this exercise is measured."
          >
            {TRACKING_MODES.map((m) => (
              <MenuItem key={m} value={m}>
                {trackingLabel(m)}
              </MenuItem>
            ))}
          </TextField>
          <Stack direction="row" sx={{ flexWrap: 'wrap', columnGap: 2 }}>
            <FormControlLabel
              control={
                <Checkbox
                  checked={isUnilateral}
                  onChange={(e) => setIsUnilateral(e.target.checked)}
                />
              }
              label="One side at a time"
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={isBodyweight}
                  onChange={(e) => setIsBodyweight(e.target.checked)}
                />
              }
              label="Bodyweight"
            />
          </Stack>
          <Autocomplete
            multiple
            options={types}
            value={equipment}
            loading={typesLoading}
            // The API searches; show what it returned.
            filterOptions={(options) => options}
            onInputChange={(_e, value, reason) => {
              if (reason !== 'reset') setEquipmentQuery(value);
            }}
            onChange={(_e, value) => setEquipment(value.slice(0, REQUIREMENT_GROUPS_MAX))}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            getOptionLabel={(option) => option.name}
            getOptionDisabled={(option) =>
              equipment.length >= REQUIREMENT_GROUPS_MAX &&
              !equipment.some((e) => e.id === option.id)
            }
            renderInput={(params) => (
              <TextField
                {...params}
                label="Needs equipment"
                helperText={
                  typesError ??
                  `Optional, up to ${REQUIREMENT_GROUPS_MAX}. Leave empty when it needs nothing.`
                }
                error={Boolean(typesError)}
              />
            )}
          />
          <TextField
            label="Notes"
            multiline
            minRows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            helperText={`${notes.length}/${EXERCISE_NOTES_MAX}`}
            slotProps={{ htmlInput: { maxLength: EXERCISE_NOTES_MAX } }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void submit()} disabled={busy}>
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default CustomExerciseDialog;
