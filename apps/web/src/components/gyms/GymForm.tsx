/**
 * Create or edit a gym (E3.3): name, type, description, notes and the
 * "temporary" switch, plus (E3.5, `showLocation`) the optional position. Used
 * by `/gyms/new` and by the edit dialog on the gym page; the gym page has its
 * own Location section, so its edit dialog hides the field. The bounds mirror the API's Zod schema so a problem is explained
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
  Typography,
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
import { GymLocationField } from './GymLocationField';

export interface GymFormValues {
  name: string;
  type: GymType;
  description: string;
  notes: string;
  isTemporary: boolean;
  latitude: number | null;
  longitude: number | null;
}

export interface GymFormProps {
  initial?: Partial<{
    name: string;
    type: GymType;
    description: string | null;
    notes: string | null;
    isTemporary: boolean;
    latitude: number | null;
    longitude: number | null;
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
  /**
   * Show the optional location field (E3.5). The pair set there is sent with
   * the gym; when hidden, the gym's position is left untouched.
   */
  showLocation?: boolean;
}

function toInput(values: GymFormValues, withLocation: boolean): GymInput {
  const description = values.description.trim();
  const notes = values.notes.trim();
  const input: GymInput = {
    name: values.name.trim(),
    type: values.type,
    description: description === '' ? null : description,
    notes: notes === '' ? null : notes,
    isTemporary: values.isTemporary,
  };
  if (withLocation && values.latitude !== null && values.longitude !== null) {
    input.latitude = values.latitude;
    input.longitude = values.longitude;
  }
  return input;
}

export function GymForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  formId,
  hideActions = false,
  onSubmittingChange,
  showLocation = false,
}: GymFormProps) {
  const generatedId = useId();
  const id = formId ?? `gym-form-${generatedId}`;
  const [values, setValues] = useState<GymFormValues>({
    name: initial?.name ?? '',
    type: initial?.type ?? 'home',
    description: initial?.description ?? '',
    notes: initial?.notes ?? '',
    isTemporary: initial?.isTemporary ?? false,
    latitude: initial?.latitude ?? null,
    longitude: initial?.longitude ?? null,
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
      await onSubmit(toInput(values, showLocation));
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
        {showLocation && (
          <Box component="fieldset" sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
            <Typography component="legend" variant="subtitle1" sx={{ mb: 1 }}>
              Location
            </Typography>
            <GymLocationField
              latitude={values.latitude}
              longitude={values.longitude}
              saveLabel="Set location"
              savedPrefix="Location"
              emptyLabel="No location set"
              onSave={async ({ latitude, longitude }) => {
                setValues((prev) => ({ ...prev, latitude, longitude }));
              }}
              onClear={async () => {
                setValues((prev) => ({ ...prev, latitude: null, longitude: null }));
              }}
            />
          </Box>
        )}
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
