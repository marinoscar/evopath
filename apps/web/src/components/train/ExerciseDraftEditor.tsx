/**
 * The inline editor of one `workout_prefill` draft item (E4.5), the
 * `renderEditor` the prefill page hands to `AiDraftReview` (also its "Add
 * missing item" form).
 *
 * - Exercise: an `Autocomplete` over `GET /exercises?q=` (the library plus
 *   the caller's custom exercises, debounced by `useExercises`), with a "New
 *   custom exercise" option for something the library does not have. A pick
 *   sets that exercise's slug and name; the custom option keeps the slug
 *   `null` with a typed name (on apply the server reuses the caller's custom
 *   exercise of that name, or creates one).
 * - Sets: a compact table with the same inputs and conversions as the
 *   logger's `SetRow` (weight in the display unit, reps, mm:ss, km/mi), the
 *   columns the exercise's tracking mode needs plus any that already hold a
 *   value, so nothing the AI read is hidden. Text that does not parse keeps
 *   the last valid value and says why.
 *
 * The server validates the whole value; the checks here only explain a
 * problem early.
 */
import { useMemo, useState } from 'react';
import {
  Autocomplete,
  Box,
  Button,
  CircularProgress,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { Add as AddIcon, DeleteOutlined as DeleteIcon } from '@mui/icons-material';
import { useExercises } from '../../hooks/useExercises';
import type { Exercise, TrackingMode } from '../../services/exercises';
import {
  EMPTY_SET,
  EXERCISE_DRAFT_NAME_MAX,
  EXERCISE_DRAFT_SETS_MAX,
  type ExerciseDraftSet,
  type ExerciseDraftValue,
} from '../../services/workoutPrefill';
import type { WeightUnit } from '../../utils/units';
import {
  distanceInputText,
  distanceUnitFor,
  formatClock,
  parseClock,
  parseDistance,
  parseReps,
  parseWeight,
  weightInputText,
} from '../../utils/workoutFormat';
import { fieldsFor, type SetField } from './SetRow';

export const CUSTOM_EXERCISE_LABEL = 'New custom exercise (type a name)';

type Option =
  | { kind: 'exercise'; key: string; label: string; slug: string; exercise: Exercise | null }
  | { kind: 'custom'; key: 'custom'; label: string };

const CUSTOM_OPTION: Option = { kind: 'custom', key: 'custom', label: CUSTOM_EXERCISE_LABEL };

function exerciseOption(exercise: Exercise): Option {
  return { kind: 'exercise', key: `ex:${exercise.id}`, label: exercise.name, slug: exercise.slug, exercise };
}

/** The server's rule for a new custom exercise's tracking mode, for choosing columns. */
function inferMode(sets: readonly ExerciseDraftSet[]): TrackingMode {
  if (sets.some((s) => s.distanceMeters !== null)) return 'distance_time';
  const hasDuration = sets.some((s) => s.durationSeconds !== null);
  const hasWeightOrReps = sets.some((s) => s.weightKg !== null || s.reps !== null);
  return hasDuration && !hasWeightOrReps ? 'time' : 'weight_reps';
}

const FIELD_ORDER: SetField[] = ['weight', 'reps', 'distance', 'duration'];

type SetTexts = Record<SetField, string>;
type SetErrors = Partial<Record<SetField, string>>;

function textsOf(set: ExerciseDraftSet, unit: WeightUnit): SetTexts {
  return {
    weight: weightInputText(set.weightKg, unit),
    reps: set.reps === null ? '' : String(set.reps),
    duration: formatClock(set.durationSeconds),
    distance: distanceInputText(set.distanceMeters, distanceUnitFor(unit)),
  };
}

export interface ExerciseDraftEditorProps {
  value: ExerciseDraftValue;
  onChange: (value: ExerciseDraftValue) => void;
  unit: WeightUnit;
}

export function ExerciseDraftEditor({ value, onChange, unit }: ExerciseDraftEditorProps) {
  const [customChosen, setCustomChosen] = useState(value.exerciseSlug === null && value.name !== '');
  const [query, setQuery] = useState('');
  const { exercises, isLoading } = useExercises({ q: query });
  const [texts, setTexts] = useState<SetTexts[]>(() => value.sets.map((set) => textsOf(set, unit)));
  const [errors, setErrors] = useState<SetErrors[]>(() => value.sets.map(() => ({})));
  const distanceUnit = distanceUnitFor(unit);

  const known = value.exerciseSlug !== null ? exercises.find((e) => e.slug === value.exerciseSlug) ?? null : null;

  const selected: Option | null = useMemo(() => {
    if (value.exerciseSlug !== null) {
      return known
        ? exerciseOption(known)
        : { kind: 'exercise', key: `slug:${value.exerciseSlug}`, label: value.name, slug: value.exerciseSlug, exercise: null };
    }
    return customChosen ? CUSTOM_OPTION : null;
  }, [value.exerciseSlug, value.name, known, customChosen]);

  const options = useMemo(() => {
    const list: Option[] = exercises.map(exerciseOption);
    if (selected && selected.kind === 'exercise' && !list.some((o) => o.kind === 'exercise' && o.slug === selected.slug)) {
      list.unshift(selected);
    }
    list.push(CUSTOM_OPTION);
    return list;
  }, [exercises, selected]);

  const fields = useMemo(() => {
    const mode = known?.trackingMode ?? inferMode(value.sets);
    const wanted = new Set<SetField>(fieldsFor(mode, true));
    for (const set of value.sets) {
      if (set.weightKg !== null) wanted.add('weight');
      if (set.reps !== null) wanted.add('reps');
      if (set.durationSeconds !== null) wanted.add('duration');
      if (set.distanceMeters !== null) wanted.add('distance');
    }
    return FIELD_ORDER.filter((field) => wanted.has(field));
  }, [known, value.sets]);

  const set = (patch: Partial<ExerciseDraftValue>) => onChange({ ...value, ...patch });

  const pick = (option: Option | null) => {
    if (!option) {
      setCustomChosen(false);
      set({ exerciseSlug: null, name: '' });
      return;
    }
    if (option.kind === 'custom') {
      setCustomChosen(true);
      // Keep a name the AI (or the user) already gave an unidentified exercise.
      set({ exerciseSlug: null, name: value.exerciseSlug === null ? value.name : '' });
      return;
    }
    setCustomChosen(false);
    set({ exerciseSlug: option.slug, name: option.label });
  };

  const changeField = (index: number, field: SetField, text: string) => {
    setTexts((prev) => prev.map((t, i) => (i === index ? { ...t, [field]: text } : t)));
    let result: { ok: true; value: number | null } | { ok: false; message: string };
    switch (field) {
      case 'weight': {
        const r = parseWeight(text, unit);
        result = r.ok ? { ok: true, value: r.kg } : r;
        break;
      }
      case 'reps':
        result = parseReps(text);
        break;
      case 'duration':
        result = parseClock(text);
        break;
      case 'distance':
        result = parseDistance(text, distanceUnit);
        break;
    }
    setErrors((prev) => prev.map((e, i) => (i === index ? { ...e, [field]: result.ok ? undefined : result.message } : e)));
    if (!result.ok) return;
    const key = { weight: 'weightKg', reps: 'reps', duration: 'durationSeconds', distance: 'distanceMeters' }[field] as keyof ExerciseDraftSet;
    set({ sets: value.sets.map((s, i) => (i === index ? { ...s, [key]: result.value } : s)) });
  };

  const addSet = () => {
    // A new set repeats the last one, the way sets are usually written.
    const last = value.sets[value.sets.length - 1];
    const next: ExerciseDraftSet = last ? { ...last } : { ...EMPTY_SET };
    setTexts((prev) => [...prev, textsOf(next, unit)]);
    setErrors((prev) => [...prev, {}]);
    set({ sets: [...value.sets, next] });
  };

  const removeSet = (index: number) => {
    setTexts((prev) => prev.filter((_, i) => i !== index));
    setErrors((prev) => prev.filter((_, i) => i !== index));
    set({ sets: value.sets.filter((_, i) => i !== index) });
  };

  const nameMissing = customChosen && value.exerciseSlug === null && value.name.trim() === '';

  const fieldMeta: Record<SetField, { label: string; suffix: string; mode: 'decimal' | 'numeric' | 'text' }> = {
    weight: { label: 'Weight', suffix: unit, mode: 'decimal' },
    reps: { label: 'Reps', suffix: 'reps', mode: 'numeric' },
    duration: { label: 'Time', suffix: 'mm:ss', mode: 'text' },
    distance: { label: 'Distance', suffix: distanceUnit, mode: 'decimal' },
  };

  return (
    <Stack spacing={1.5} data-testid="exercise-draft-editor">
      <Autocomplete<Option, false, false, false>
        options={options}
        value={selected}
        onChange={(_event, option) => pick(option)}
        onInputChange={(_event, text, reason) => {
          if (reason === 'input') setQuery(text);
          if (reason === 'clear') setQuery('');
        }}
        filterOptions={(list) => list}
        getOptionLabel={(option) => option.label}
        getOptionKey={(option) => option.key}
        isOptionEqualToValue={(a, b) =>
          a.kind === b.kind && (a.kind === 'custom' || (b.kind === 'exercise' && a.slug === b.slug))
        }
        groupBy={(option) => (option.kind === 'custom' ? 'Not listed' : 'Exercises')}
        loading={isLoading}
        renderOption={(props, option) => {
          const { key, ...rest } = props as typeof props & { key: string };
          return (
            <Box component="li" key={key} {...rest}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2">{option.label}</Typography>
                {option.kind === 'exercise' && option.exercise?.isCustom && (
                  <Typography variant="caption" color="text.secondary">
                    Your custom exercise
                  </Typography>
                )}
              </Box>
            </Box>
          );
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Exercise"
            size="small"
            slotProps={{
              ...params.slotProps,
              input: {
                ...params.slotProps.input,
                endAdornment: (
                  <>
                    {isLoading ? <CircularProgress color="inherit" size={16} /> : null}
                    {params.slotProps.input.endAdornment}
                  </>
                ),
              },
            }}
          />
        )}
      />

      {customChosen && value.exerciseSlug === null && (
        <TextField
          size="small"
          label="Exercise name"
          required
          value={value.name}
          error={nameMissing}
          helperText={nameMissing ? 'Give it a name.' : `${value.name.length}/${EXERCISE_DRAFT_NAME_MAX}`}
          onChange={(e) => set({ name: e.target.value.slice(0, EXERCISE_DRAFT_NAME_MAX) })}
        />
      )}

      <Box>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
          Sets (in {unit})
        </Typography>
        {value.sets.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            No sets. Add them here or later while you train.
          </Typography>
        )}
        <Stack spacing={1} role="list" aria-label="Sets">
          {value.sets.map((_, index) => {
            const n = index + 1;
            const rowTexts = texts[index] ?? textsOf(value.sets[index], unit);
            const rowErrors = errors[index] ?? {};
            return (
              <Box role="listitem" key={index} data-testid={`draft-set-${n}`}>
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
                  <Box sx={{ width: 24, flexShrink: 0, pt: 1.25, textAlign: 'center', fontWeight: 600, color: 'text.secondary' }}>
                    {n}
                  </Box>
                  {fields.map((field) => {
                    const meta = fieldMeta[field];
                    return (
                      <TextField
                        key={field}
                        size="small"
                        value={rowTexts[field]}
                        error={Boolean(rowErrors[field])}
                        helperText={rowErrors[field]}
                        onChange={(e) => changeField(index, field, e.target.value)}
                        sx={{ flex: 1, minWidth: 0, '& .MuiInputBase-root': { minHeight: 44 } }}
                        slotProps={{
                          htmlInput: {
                            'aria-label': `Set ${n} ${meta.label.toLowerCase()}`,
                            inputMode: meta.mode,
                            autoComplete: 'off',
                          },
                          input: {
                            endAdornment: (
                              <InputAdornment position="end" sx={{ ml: 0.25 }}>
                                <Typography variant="caption" color="text.secondary">
                                  {meta.suffix}
                                </Typography>
                              </InputAdornment>
                            ),
                          },
                        }}
                      />
                    );
                  })}
                  <IconButton aria-label={`Remove set ${n}`} onClick={() => removeSet(index)} sx={{ width: 44, height: 44 }}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Box>
              </Box>
            );
          })}
        </Stack>
        <Button
          size="small"
          startIcon={<AddIcon />}
          onClick={addSet}
          disabled={value.sets.length >= EXERCISE_DRAFT_SETS_MAX}
          sx={{ mt: 1 }}
        >
          Add set
        </Button>
      </Box>
    </Stack>
  );
}

export default ExerciseDraftEditor;
