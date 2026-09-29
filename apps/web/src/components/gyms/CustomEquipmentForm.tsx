/**
 * "Can't find it? Add custom equipment" (E3.3): a name, a category and,
 * optionally, what it can be used for (capabilities). The type is created for
 * the caller only (`POST /api/equipment-types`) and appears in their later
 * searches.
 */
import { useState, type FormEvent } from 'react';
import { Alert, Autocomplete, Box, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import {
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_CATEGORY_LABEL,
  EQUIPMENT_TYPE_CAPABILITIES_MAX,
  EQUIPMENT_TYPE_NAME_MAX,
  gymErrorMessage,
  type Capability,
  type CustomEquipmentTypeInput,
  type EquipmentCategory,
} from '../../services/gyms';
import { useCapabilities } from '../../hooks/useEquipmentTypes';

export interface CustomEquipmentFormProps {
  /** Prefills the name, e.g. with the search the user typed. */
  initialName?: string;
  onCancel: () => void;
  /** Creates the type and adds it to the gym; rejects to show the error. */
  onSubmit: (input: CustomEquipmentTypeInput) => Promise<void>;
}

export function CustomEquipmentForm({ initialName = '', onCancel, onSubmit }: CustomEquipmentFormProps) {
  const { capabilities, isLoading, error: capabilitiesError } = useCapabilities();
  const [name, setName] = useState(initialName);
  const [category, setCategory] = useState<EquipmentCategory>('accessories');
  const [selected, setSelected] = useState<Capability[]>([]);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const nameError =
    trimmed.length === 0
      ? 'Enter a name.'
      : trimmed.length > EQUIPMENT_TYPE_NAME_MAX
        ? `At most ${EQUIPMENT_TYPE_NAME_MAX} characters.`
        : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setTouched(true);
    if (nameError || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: trimmed,
        category,
        capabilityIds: selected.map((c) => c.id),
      });
    } catch (err) {
      setError(gymErrorMessage(err, 'Could not add the custom equipment'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box component="form" noValidate onSubmit={submit} aria-label="Custom equipment">
      <Stack spacing={2}>
        <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
          Add custom equipment
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField
          label="Equipment name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched(true)}
          required
          fullWidth
          autoFocus
          error={touched && Boolean(nameError)}
          helperText={touched && nameError ? nameError : undefined}
        />
        <TextField
          select
          label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value as EquipmentCategory)}
          fullWidth
        >
          {EQUIPMENT_CATEGORIES.map((c) => (
            <MenuItem key={c} value={c}>
              {EQUIPMENT_CATEGORY_LABEL[c]}
            </MenuItem>
          ))}
        </TextField>
        {capabilitiesError ? (
          <Typography variant="body2" color="text.secondary">
            Capabilities could not be loaded; you can add the equipment without them.
          </Typography>
        ) : (
          <Autocomplete
            multiple
            options={capabilities}
            loading={isLoading}
            value={selected}
            onChange={(_e, value) => setSelected(value.slice(0, EQUIPMENT_TYPE_CAPABILITIES_MAX))}
            getOptionLabel={(option) => option.name}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            getOptionDisabled={() => selected.length >= EQUIPMENT_TYPE_CAPABILITIES_MAX}
            renderInput={(params) => (
              <TextField
                {...params}
                label="What it is used for (optional)"
                helperText={`Up to ${EQUIPMENT_TYPE_CAPABILITIES_MAX}.`}
              />
            )}
          />
        )}
        <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <Button onClick={onCancel} disabled={busy}>
            Back to search
          </Button>
          <Button type="submit" variant="contained" disabled={busy || (touched && Boolean(nameError))}>
            Add custom equipment
          </Button>
        </Box>
      </Stack>
    </Box>
  );
}

export default CustomEquipmentForm;
