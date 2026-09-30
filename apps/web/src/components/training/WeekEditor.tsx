/**
 * Edit one week: its workouts (name, weekday, add, remove) and their
 * exercises (sets, reps, RPE, rest, priority, load; move up and down with
 * buttons, keyboard and touch friendly; remove; add through the exercise
 * picker). Weekday chips disable a day another workout of the week uses.
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
import { PLAN_LIMITS, type LoadGuidance, type PlanExercise, type PlanWeek, type PlanWorkout } from '../../services/programs';
import { displayToKg, kgToDisplay, type WeightUnit } from '../../utils/units';
import { WeekdayPicker } from './WeekdayPicker';
import { byWeekday } from './PlanViewer';

export interface WeekEditorProps {
  week: PlanWeek;
  names: Record<string, string>;
  unit: WeightUnit;
  errors: Record<string, string>;
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

function ExerciseEditRow({
  exercise,
  name,
  index,
  count,
  unit,
  errors,
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
        {field('Sets', 'targetSets', { min: PLAN_LIMITS.targetSets.min, max: PLAN_LIMITS.targetSets.max })}
        {field('Min reps', 'repMin', { min: PLAN_LIMITS.reps.min, max: PLAN_LIMITS.reps.max })}
        {field('Max reps', 'repMax', { min: PLAN_LIMITS.reps.min, max: PLAN_LIMITS.reps.max })}
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
        {field('Rest (s)', 'restSeconds', { min: 0, max: PLAN_LIMITS.restSeconds.max, step: 15 })}
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
        {exercise.loadGuidance === 'fixed' && (
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
