/**
 * Create or edit a gym (E3.3): name, type, description, notes and the
 * "temporary" switch. Used by `/gyms/new` and by the edit dialog on the gym
 * page. The bounds mirror the API's Zod schema so a problem is explained
 * before the round trip; the API decides, and its message is shown verbatim.
 */
import { useId, useState, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
} from '@mui/material';
import {
  GYM_DESCRIPTION_MAX,
  GYM_NAME_MAX,
  GYM_NOTES_MAX,
  GYM_TYPES,
  GYM_TYPE_LABEL,
  gymErrorMessage,
  type GymInput,
  type GymType,
} from '../../services/gyms';

export interface GymFormValues {
  name: string;
  type: GymType;
  description: string;
  notes: string;
  isTemporary: boolean;
}

export interface GymFormProps {
  initial?: Partial<{
    name: string;
    type: GymType;
    description: string | null;
    notes: string | null;
    isTemporary: boolean;
  }>;
  submitLabel: string;
  /** Rejects with the API error to show it. */
  onSubmit: (input: GymInput) => Promise<void>;
  onCancel?: () => void;
  /** Id of the `<form>`, so a dialog can host the buttons elsewhere. */
  formId?: string;
  /** Hide the built-in buttons (the host renders its own submit for `formId`). */
  hideActions?: boolean;
  onSubmittingChange?: (submitting: boolean) => void;
}

function toInput(values: GymFormValues): GymInput {
  const description = values.description.trim();
  const notes = values.notes.trim();
  return {
    name: values.name.trim(),
    type: values.type,
    description: description === '' ? null : description,
    notes: notes === '' ? null : notes,
    isTemporary: values.isTemporary,
  };
}

export function GymForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  formId,
  hideActions = false,
  onSubmittingChange,
}: GymFormProps) {
  const generatedId = useId();
  const id = formId ?? `gym-form-${generatedId}`;
  const [values, setValues] = useState<GymFormValues>({
    name: initial?.name ?? '',
    type: initial?.type ?? 'home',
    description: initial?.description ?? '',
    notes: initial?.notes ?? '',
    isTemporary: initial?.isTemporary ?? false,
  });
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = values.name.trim();
  const nameError =
    trimmedName.length === 0
      ? 'Enter a name.'
      : trimmedName.length > GYM_NAME_MAX
        ? `At most ${GYM_NAME_MAX} characters.`
        : null;
  const descriptionError =
    values.description.trim().length > GYM_DESCRIPTION_MAX ? `At most ${GYM_DESCRIPTION_MAX} characters.` : null;
  const notesError = values.notes.trim().length > GYM_NOTES_MAX ? `At most ${GYM_NOTES_MAX} characters.` : null;
  const invalid = Boolean(nameError || descriptionError || notesError);

  const setField = <K extends keyof GymFormValues>(key: K, value: GymFormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (invalid || submitting) return;
    setSubmitting(true);
    onSubmittingChange?.(true);
    setError(null);
    try {
      await onSubmit(toInput(values));
    } catch (err) {
      setError(gymErrorMessage(err, 'Could not save the gym'));
    } finally {
      setSubmitting(false);
      onSubmittingChange?.(false);
    }
  };

  return (
    <Box component="form" id={id} noValidate onSubmit={handleSubmit}>
      <Stack spacing={2}>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField
          label="Name"
          value={values.name}
          onChange={(e) => setField('name', e.target.value)}
          onBlur={() => setTouched(true)}
          required
          fullWidth
          autoFocus
          error={touched && Boolean(nameError)}
          helperText={touched && nameError ? nameError : undefined}
          slotProps={{ htmlInput: { maxLength: GYM_NAME_MAX + 20 } }}
        />
        <TextField
          select
          label="Type"
          value={values.type}
          onChange={(e) => setField('type', e.target.value as GymType)}
          fullWidth
        >
          {GYM_TYPES.map((type) => (
            <MenuItem key={type} value={type}>
              {GYM_TYPE_LABEL[type]}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          label="Description"
          value={values.description}
          onChange={(e) => setField('description', e.target.value)}
          fullWidth
          multiline
          minRows={2}
          error={Boolean(descriptionError)}
          helperText={descriptionError ?? undefined}
        />
        <TextField
          label="Notes"
          value={values.notes}
          onChange={(e) => setField('notes', e.target.value)}
          fullWidth
          multiline
          minRows={2}
          error={Boolean(notesError)}
          helperText={notesError ?? 'Opening hours, access codes, anything worth remembering.'}
        />
        <FormControlLabel
          control={
            <Switch
              checked={values.isTemporary}
              onChange={(e) => setField('isTemporary', e.target.checked)}
            />
          }
          label="Temporary (a hotel or a trip)"
        />
        {!hideActions && (
          <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            {onCancel && (
              <Button onClick={onCancel} disabled={submitting}>
                Cancel
              </Button>
            )}
            <Button type="submit" variant="contained" disabled={submitting || (touched && invalid)}>
              {submitLabel}
            </Button>
          </Box>
        )}
      </Stack>
    </Box>
  );
}

export default GymForm;
