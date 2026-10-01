/**
 * Edit one week: its workouts (name, weekday, add, remove) and their
 * exercises (move up and down with
 * buttons, keyboard and touch friendly; remove; add through the exercise
 * picker). Weekday chips disable a day another workout of the week uses.
 *
 * Each exercise's prescription fields follow its `trackingMode` (#263):
 * `weight_reps` / `bodyweight_reps` edit sets, reps, RPE, rest and load;
 * `time` edits minutes; `distance_time` edits minutes and/or a distance (km
 * or mi from the Health Profile). Cardio rows keep RPE and priority.
 * Presentation only: the page owns the tree and saves it.
 */
import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  FormControl,
  FormControlLabel,
  FormLabel,
  IconButton,
  InputAdornment,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  ArrowDownward as DownIcon,
  ArrowUpward as UpIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material';
import {
  PLAN_LIMITS,
  type LoadGuidance,
  type PlanExercise,
  type PlanWeek,
  type PlanWorkout,
  type PrescriptionShape,
} from '../../services/programs';
import { displayToKg, kgToDisplay, type WeightUnit } from '../../utils/units';
import { distanceInputText, distanceUnitFor, parseDistance, type DistanceUnit } from '../../utils/workoutFormat';
import { rowShape, type TrackingModes } from './planEdits';
import { WeekdayPicker } from './WeekdayPicker';
import { byWeekday } from './PlanViewer';

export interface WeekEditorProps {
  week: PlanWeek;
  names: Record<string, string>;
  unit: WeightUnit;
  errors: Record<string, string>;
  /** Exercise id -> `trackingMode`; picks each row's prescription fields. */
  modes?: TrackingModes;
  onExerciseChange: (workoutId: string, exerciseId: string, patch: Partial<PlanExercise>) => void;
  onMoveExercise: (workoutId: string, exerciseId: string, delta: -1 | 1) => void;
  onRemoveExercise: (workoutId: string, exerciseId: string) => void;
  onAddExercise: (workoutId: string) => void;
  onWorkoutChange: (workoutId: string, patch: Partial<PlanWorkout>) => void;
  onRemoveWorkout: (workoutId: string) => void;
  onAddWorkout: () => void;
}

const LOAD_GUIDANCE: Array<{ value: LoadGuidance; label: string }> = [
  { value: 'choose_start', label: 'Choose a starting load' },
  { value: 'from_history', label: 'From your last session' },
  { value: 'fixed', label: 'Fixed load' },
];

const num = (value: string) => (value.trim() === '' ? NaN : Number(value));

/** Minutes as typed -> whole seconds; blank -> null; not a number -> NaN (the row then says why). */
export function minutesToSeconds(text: string): number | null {
  if (text.trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? Math.round(value * 60) : NaN;
}

const secondsToMinutesText = (seconds: number | null | undefined) =>
  seconds === null || seconds === undefined || !Number.isFinite(seconds) ? '' : String(Math.round((seconds / 60) * 100) / 100);

/**
 * The cardio prescription (#263): minutes, and for `distance_time` a
 * distance in the user's unit. Either may be blank for `distance_time`, not
 * both; the row's errors say so.
 */
function CardioFields({
  exercise,
  name,
  shape,
  distanceUnit,
  err,
  onChange,
}: {
  exercise: PlanExercise;
  name: string;
  shape: Exclude<PrescriptionShape, 'reps'>;
  distanceUnit: DistanceUnit;
  err: (field: string) => string | undefined;
  onChange: (patch: Partial<PlanExercise>) => void;
}) {
  const [minutesText, setMinutesText] = useState(secondsToMinutesText(exercise.targetDurationSeconds));
  const [distanceText, setDistanceText] = useState(distanceInputText(exercise.targetDistanceMeters ?? null, distanceUnit));
  const width = { xs: 'calc(50% - 4px)', sm: 130 };
  return (
    <>
      {shape === 'distance_duration' && (
        <TextField
          label="Distance"
          size="small"
          value={distanceText}
          onChange={(e) => {
            setDistanceText(e.target.value);
            const parsed = parseDistance(e.target.value, distanceUnit);
            onChange({ targetDistanceMeters: parsed.ok ? parsed.value : NaN });
          }}
          error={!!err('targetDistanceMeters')}
          helperText={err('targetDistanceMeters') ?? 'Optional'}
          sx={{ width }}
          slotProps={{
            input: { endAdornment: <InputAdornment position="end">{distanceUnit}</InputAdornment> },
            htmlInput: { inputMode: 'decimal', 'aria-label': `Distance in ${distanceUnit}, ${name}` },
          }}
        />
      )}
      <TextField
        label="Minutes"
        type="number"
        size="small"
        value={minutesText}
        onChange={(e) => {
          setMinutesText(e.target.value);
          onChange({ targetDurationSeconds: minutesToSeconds(e.target.value) });
        }}
        error={!!err('targetDurationSeconds')}
        helperText={err('targetDurationSeconds') ?? (shape === 'distance_duration' ? 'Optional' : undefined)}
        sx={{ width }}
        slotProps={{
          input: { endAdornment: <InputAdornment position="end">min</InputAdornment> },
          htmlInput: {
            min: PLAN_LIMITS.targetDurationSeconds.min / 60,
            max: PLAN_LIMITS.targetDurationSeconds.max / 60,
            step: 1,
            inputMode: 'numeric',
            'aria-label': `Minutes, ${name}`,
          },
        }}
      />
    </>
  );
}

function ExerciseEditRow({
  exercise,
  name,
  index,
  count,
  unit,
  errors,
  shape,
  onChange,
  onMove,
  onRemove,
}: {
  exercise: PlanExercise;
  name: string;
  index: number;
  count: number;
  unit: WeightUnit;
  errors: Record<string, string>;
  shape: PrescriptionShape;
  onChange: (patch: Partial<PlanExercise>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const id = exercise.id ?? `row-${index}`;
  const err = (field: string) => errors[`${id}.${field}`];
  const [loadText, setLoadText] = useState(
    exercise.targetLoadKg === null || exercise.targetLoadKg === undefined ? '' : String(kgToDisplay(exercise.targetLoadKg, unit)),
  );
  const field = (label: string, key: keyof PlanExercise, props: Record<string, unknown> = {}) => (
    <TextField
      label={label}
      type="number"
      size="small"
      value={Number.isFinite(exercise[key] as number) ? (exercise[key] as number) : ''}
      onChange={(e) => onChange({ [key]: num(e.target.value) } as Partial<PlanExercise>)}
      error={!!err(key)}
      helperText={err(key)}
      sx={{ width: { xs: 'calc(50% - 4px)', sm: 110 } }}
      slotProps={{ htmlInput: { 'aria-label': `${label}, ${name}`, ...props } }}
    />
  );
  return (
    <Box component="li" sx={{ listStyle: 'none', py: 1.5, borderTop: 1, borderColor: 'divider' }} data-testid="edit-exercise">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography sx={{ fontWeight: 600, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{name}</Typography>
        <IconButton id={`${id}-up`} aria-label={`Move ${name} up`} onClick={() => onMove(-1)} disabled={index === 0}>
          <UpIcon />
        </IconButton>
        <IconButton id={`${id}-down`} aria-label={`Move ${name} down`} onClick={() => onMove(1)} disabled={index === count - 1}>
          <DownIcon />
        </IconButton>
        <IconButton aria-label={`Remove ${name}`} onClick={onRemove}>
          <DeleteIcon />
        </IconButton>
      </Stack>
      <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: 'wrap', mt: 1 }}>
        {shape === 'reps' ? (
          <>
            {field('Sets', 'targetSets', { min: PLAN_LIMITS.targetSets.min, max: PLAN_LIMITS.targetSets.max })}
            {field('Min reps', 'repMin', { min: PLAN_LIMITS.reps.min, max: PLAN_LIMITS.reps.max })}
            {field('Max reps', 'repMax', { min: PLAN_LIMITS.reps.min, max: PLAN_LIMITS.reps.max })}
          </>
        ) : (
          <CardioFields
            exercise={exercise}
            name={name}
            shape={shape}
            distanceUnit={distanceUnitFor(unit)}
            err={err}
            onChange={onChange}
          />
        )}
        <TextField
          label="RPE"
          type="number"
          size="small"
          value={exercise.targetRpe ?? ''}
          onChange={(e) => onChange({ targetRpe: e.target.value.trim() === '' ? null : Number(e.target.value) })}
          error={!!err('targetRpe')}
          helperText={err('targetRpe')}
          sx={{ width: { xs: 'calc(50% - 4px)', sm: 110 } }}
          slotProps={{ htmlInput: { min: 1, max: 10, step: 0.5, 'aria-label': `RPE, ${name}` } }}
        />
        {shape === 'reps' && field('Rest (s)', 'restSeconds', { min: 0, max: PLAN_LIMITS.restSeconds.max, step: 15 })}
        {shape === 'reps' && (
          <TextField
            select
            label="Load"
            size="small"
            value={exercise.loadGuidance ?? 'choose_start'}
            onChange={(e) => onChange({ loadGuidance: e.target.value as LoadGuidance })}
            sx={{ width: { xs: '100%', sm: 220 } }}
            slotProps={{ htmlInput: { 'aria-label': `Load guidance, ${name}` } }}
          >
            {LOAD_GUIDANCE.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
        )}
        {shape === 'reps' && exercise.loadGuidance === 'fixed' && (
          <TextField
            label="Weight"
            type="number"
            size="small"
            value={loadText}
            onChange={(e) => {
              setLoadText(e.target.value);
              const value = num(e.target.value);
              onChange({ targetLoadKg: Number.isFinite(value) ? displayToKg(value, unit) : null });
            }}
            error={!!err('targetLoadKg')}
            helperText={err('targetLoadKg')}
            sx={{ width: { xs: 'calc(50% - 4px)', sm: 130 } }}
            slotProps={{
              input: { endAdornment: <InputAdornment position="end">{unit}</InputAdornment> },
              htmlInput: { min: 0, step: unit === 'kg' ? 0.5 : 1, 'aria-label': `Weight in ${unit}, ${name}` },
            }}
          />
        )}
        <FormControlLabel
          control={
            <Checkbox checked={!!exercise.isPriority} onChange={(e) => onChange({ isPriority: e.target.checked })} />
          }
          label="Priority"
        />
      </Stack>
    </Box>
  );
}

export function WeekEditor({
  week,
  names,
  unit,
  errors,
  modes,
  onExerciseChange,
  onMoveExercise,
  onRemoveExercise,
  onAddExercise,
  onWorkoutChange,
  onRemoveWorkout,
  onAddWorkout,
}: WeekEditorProps) {
  // Keyboard reorder: keep focus on the row that moved.
  const [lastMove, setLastMove] = useState<{ id: string; delta: -1 | 1 } | null>(null);
  useEffect(() => {
    if (!lastMove) return;
    const primary = document.getElementById(`${lastMove.id}-${lastMove.delta === -1 ? 'up' : 'down'}`) as HTMLButtonElement | null;
    const fallback = document.getElementById(`${lastMove.id}-${lastMove.delta === -1 ? 'down' : 'up'}`) as HTMLButtonElement | null;
    (primary && !primary.disabled ? primary : fallback)?.focus();
  }, [lastMove]);

  return (
    <Stack spacing={2}>
      {byWeekday(week.workouts).map((workout) => {
        const wid = workout.id ?? '';
        const usedElsewhere = week.workouts
          .filter((w) => w.id !== workout.id)
          .map((w) => w.weekday)
          .filter((d): d is number => typeof d === 'number');
        return (
          <Card key={wid} variant="outlined" component="section" aria-label={`Workout ${workout.name}`} data-testid="edit-workout">
            <CardContent>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                <TextField
                  label="Workout name"
                  size="small"
                  value={workout.name}
                  onChange={(e) => onWorkoutChange(wid, { name: e.target.value })}
                  error={!!errors[`${wid}.name`]}
                  helperText={errors[`${wid}.name`]}
                  sx={{ flex: 1 }}
                  slotProps={{ htmlInput: { maxLength: PLAN_LIMITS.nameMax } }}
                />
                <IconButton aria-label={`Remove workout ${workout.name}`} onClick={() => onRemoveWorkout(wid)}>
                  <DeleteIcon />
                </IconButton>
              </Stack>
              <FormControl sx={{ mt: 1.5 }} error={!!errors[`${wid}.weekday`]}>
                <FormLabel component="legend" sx={{ fontSize: 14 }}>
                  Day
                </FormLabel>
                <WeekdayPicker
                  single
                  label={`Day for ${workout.name}`}
                  value={workout.weekday ? [workout.weekday] : []}
                  disabledDays={usedElsewhere}
                  onChange={(days) => onWorkoutChange(wid, { weekday: days[0] ?? null })}
                />
                {errors[`${wid}.weekday`] && (
                  <Typography variant="caption" color="error">
                    {errors[`${wid}.weekday`]}
                  </Typography>
                )}
              </FormControl>
              <Box component="ul" sx={{ p: 0, m: 0, mt: 1 }} aria-label={`${workout.name} exercises`}>
                {workout.exercises.map((exercise, index) => (
                  <ExerciseEditRow
                    key={exercise.id ?? index}
                    exercise={exercise}
                    name={names[exercise.exerciseId] ?? 'Exercise'}
                    index={index}
                    count={workout.exercises.length}
                    unit={unit}
                    errors={errors}
                    shape={rowShape(exercise, modes)}
                    onChange={(patch) => onExerciseChange(wid, exercise.id ?? '', patch)}
                    onMove={(delta) => {
                      onMoveExercise(wid, exercise.id ?? '', delta);
                      setLastMove({ id: exercise.id ?? '', delta });
                    }}
                    onRemove={() => onRemoveExercise(wid, exercise.id ?? '')}
                  />
                ))}
              </Box>
              <Button
                startIcon={<AddIcon />}
                onClick={() => onAddExercise(wid)}
                disabled={workout.exercises.length >= PLAN_LIMITS.exercisesPerWorkoutMax}
                sx={{ mt: 1, minHeight: 44 }}
              >
                Add exercise
              </Button>
            </CardContent>
          </Card>
        );
      })}
      <Box>
        <Button
          variant="outlined"
          startIcon={<AddIcon />}
          onClick={onAddWorkout}
          disabled={week.workouts.length >= PLAN_LIMITS.workoutsPerWeekMax}
          sx={{ minHeight: 44 }}
        >
          Add workout
        </Button>
      </Box>
    </Stack>
  );
}

export default WeekEditor;
