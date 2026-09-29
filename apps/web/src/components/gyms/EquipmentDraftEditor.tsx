/**
 * The inline editor of one `gym_equipment` draft item (E3.4), the
 * `renderEditor` the scan page hands to `AiDraftReview` (also its "Add
 * missing item" form).
 *
 * - Equipment: an `Autocomplete` over `GET /equipment-types?q=` (the catalog
 *   plus the caller's custom types, debounced by `useEquipmentTypes`), with an
 *   "Other (type a name)" option for something the catalog does not have.
 *   A catalog or custom-type pick sets that type's slug and name; "Other"
 *   leaves the slug `null` with a typed name (on apply the server reuses the
 *   caller's custom type of that name, or creates one).
 * - Quantity 1..99 (changing it clears "count uncertain": the user counted),
 *   brand (changing it drops the AI's brand evidence), model, configuration
 *   and notes.
 *
 * The server recomputes the derived fields and validates the whole value; the
 * bounds here only explain a problem early.
 */
import { useMemo, useState } from 'react';
import { Autocomplete, Box, CircularProgress, Stack, TextField, Typography } from '@mui/material';
import { useEquipmentTypes } from '../../hooks/useEquipmentTypes';
import { categoryLabel, type EquipmentType } from '../../services/gyms';
import {
  EQUIPMENT_DRAFT_BRAND_MAX,
  EQUIPMENT_DRAFT_CONFIGURATION_MAX,
  EQUIPMENT_DRAFT_MODEL_MAX,
  EQUIPMENT_DRAFT_NAME_MAX,
  EQUIPMENT_DRAFT_NOTES_MAX,
  type EquipmentValue,
} from '../../services/gymScan';
import { QuantityStepper } from './QuantityStepper';

export const OTHER_EQUIPMENT_LABEL = 'Other (type a name)';

type Option =
  | { kind: 'type'; key: string; label: string; slug: string; category: string | null; type: EquipmentType | null }
  | { kind: 'other'; key: 'other'; label: string };

const OTHER_OPTION: Option = { kind: 'other', key: 'other', label: OTHER_EQUIPMENT_LABEL };

function typeOption(type: EquipmentType): Option {
  return { kind: 'type', key: `type:${type.id}`, label: type.name, slug: type.slug, category: type.category, type };
}

export interface EquipmentDraftEditorProps {
  value: EquipmentValue;
  onChange: (value: EquipmentValue) => void;
}

/** A text field's value, or `null` when blank. */
const orNull = (text: string): string | null => (text.trim() === '' ? null : text);

export function EquipmentDraftEditor({ value, onChange }: EquipmentDraftEditorProps) {
  const [otherChosen, setOtherChosen] = useState(value.equipmentTypeSlug === null && value.name !== '');
  const [query, setQuery] = useState('');
  const { types, isLoading } = useEquipmentTypes({ q: query });

  const selected: Option | null = useMemo(() => {
    if (value.equipmentTypeSlug !== null) {
      const known = types.find((t) => t.slug === value.equipmentTypeSlug);
      return known
        ? typeOption(known)
        : {
            kind: 'type',
            key: `slug:${value.equipmentTypeSlug}`,
            label: value.name,
            slug: value.equipmentTypeSlug,
            category: null,
            type: null,
          };
    }
    return otherChosen ? OTHER_OPTION : null;
  }, [value.equipmentTypeSlug, value.name, types, otherChosen]);

  const options = useMemo(() => {
    const list: Option[] = types.map(typeOption);
    if (selected && selected.kind === 'type' && !list.some((o) => o.key === selected.key || (o.kind === 'type' && o.slug === selected.slug))) {
      list.unshift(selected);
    }
    list.push(OTHER_OPTION);
    return list;
  }, [types, selected]);

  const set = (patch: Partial<EquipmentValue>) => onChange({ ...value, ...patch });

  const pick = (option: Option | null) => {
    if (!option) {
      setOtherChosen(false);
      set({ equipmentTypeSlug: null, name: '', capabilitySlugs: [], targetMuscles: [] });
      return;
    }
    if (option.kind === 'other') {
      setOtherChosen(true);
      // Keep a name the user or the AI already gave an unidentified item.
      set({ equipmentTypeSlug: null, name: value.equipmentTypeSlug === null ? value.name : '', capabilitySlugs: [], targetMuscles: [] });
      return;
    }
    const type = option.type;
    setOtherChosen(false);
    set({
      equipmentTypeSlug: option.slug,
      name: option.label,
      capabilitySlugs: type ? type.capabilities.map((c) => c.slug) : value.capabilitySlugs,
      targetMuscles: [],
    });
  };

  const nameMissing = otherChosen && value.equipmentTypeSlug === null && value.name.trim() === '';

  return (
    <Stack spacing={1.5} data-testid="equipment-draft-editor">
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
          a.kind === b.kind && (a.kind === 'other' || (b.kind === 'type' && a.slug === b.slug))
        }
        groupBy={(option) => (option.kind === 'other' ? 'Not listed' : option.category ? categoryLabel(option.category) : 'Current')}
        loading={isLoading}
        renderOption={(props, option) => {
          const { key, ...rest } = props as typeof props & { key: string };
          return (
            <Box component="li" key={key} {...rest}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2">{option.label}</Typography>
                {option.kind === 'type' && option.type?.isCustom && (
                  <Typography variant="caption" color="text.secondary">
                    Your custom equipment
                  </Typography>
                )}
              </Box>
            </Box>
          );
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Equipment"
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

      {otherChosen && value.equipmentTypeSlug === null && (
        <TextField
          size="small"
          label="Equipment name"
          required
          value={value.name}
          error={nameMissing}
          helperText={nameMissing ? 'Give it a name.' : `${value.name.length}/${EQUIPMENT_DRAFT_NAME_MAX}`}
          onChange={(e) => set({ name: e.target.value.slice(0, EQUIPMENT_DRAFT_NAME_MAX) })}
        />
      )}

      <Box>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
          Quantity
        </Typography>
        <QuantityStepper
          value={value.quantity}
          label="Quantity"
          onChange={(quantity) => set({ quantity, quantityUncertain: false })}
        />
      </Box>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
        <TextField
          size="small"
          fullWidth
          label="Brand"
          value={value.brand ?? ''}
          slotProps={{ htmlInput: { maxLength: EQUIPMENT_DRAFT_BRAND_MAX } }}
          onChange={(e) => set({ brand: orNull(e.target.value), brandEvidence: null })}
        />
        <TextField
          size="small"
          fullWidth
          label="Model"
          value={value.model ?? ''}
          slotProps={{ htmlInput: { maxLength: EQUIPMENT_DRAFT_MODEL_MAX } }}
          onChange={(e) => set({ model: orNull(e.target.value) })}
        />
      </Stack>
      <TextField
        size="small"
        label="Configuration"
        placeholder="e.g. seated, selectorized"
        value={value.configuration ?? ''}
        slotProps={{ htmlInput: { maxLength: EQUIPMENT_DRAFT_CONFIGURATION_MAX } }}
        onChange={(e) => set({ configuration: orNull(e.target.value) })}
      />
      <TextField
        size="small"
        label="Notes"
        multiline
        minRows={2}
        value={value.notes ?? ''}
        slotProps={{ htmlInput: { maxLength: EQUIPMENT_DRAFT_NOTES_MAX } }}
        onChange={(e) => set({ notes: orNull(e.target.value) })}
      />
    </Stack>
  );
}

export default EquipmentDraftEditor;
