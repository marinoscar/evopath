/**
 * Add equipment to a gym (E3.3). Search the catalog and the caller's custom
 * types (debounced, `GET /api/equipment-types?q=`), narrow by category, pick
 * one, set quantity/brand/model, Add. At the bottom, "Can't find it? Add
 * custom equipment" swaps to {@link CustomEquipmentForm}, which creates the
 * type and adds it in one go.
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { Search as SearchIcon } from '@mui/icons-material';
import {
  EQUIPMENT_BRAND_MAX,
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_CATEGORY_LABEL,
  EQUIPMENT_MODEL_MAX,
  categoryLabel,
  createEquipmentType,
  gymErrorMessage,
  type CustomEquipmentTypeInput,
  type EquipmentInput,
  type EquipmentType,
} from '../../services/gyms';
import { useEquipmentTypes } from '../../hooks/useEquipmentTypes';
import { QuantityStepper } from './QuantityStepper';
import { CustomEquipmentForm } from './CustomEquipmentForm';
import { useCompactDialog } from './useCompactDialog';

export interface EquipmentPickerDialogProps {
  open: boolean;
  onClose: () => void;
  /** Adds the chosen type to the gym; rejects to show the error. */
  onAdd: (input: EquipmentInput) => Promise<void>;
}

const orUndefined = (value: string) => (value.trim() === '' ? undefined : value.trim());

export function EquipmentPickerDialog({ open, onClose, onAdd }: EquipmentPickerDialogProps) {
  const fullScreen = useCompactDialog();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [selected, setSelected] = useState<EquipmentType | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<'search' | 'custom'>('search');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { types, isLoading, error: searchError, refresh } = useEquipmentTypes({
    q,
    category,
    enabled: open && mode === 'search',
  });

  useEffect(() => {
    if (open) {
      setQ('');
      setCategory(null);
      setSelected(null);
      setQuantity(1);
      setBrand('');
      setModel('');
      setMode('search');
      setError(null);
    }
  }, [open]);

  const tooLong = brand.trim().length > EQUIPMENT_BRAND_MAX || model.trim().length > EQUIPMENT_MODEL_MAX;

  const add = async () => {
    if (!selected || busy || tooLong) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd({
        equipmentTypeId: selected.id,
        quantity,
        brand: orUndefined(brand),
        model: orUndefined(model),
      });
      onClose();
    } catch (err) {
      setError(gymErrorMessage(err, 'Could not add the equipment'));
    } finally {
      setBusy(false);
    }
  };

  const addCustom = async (input: CustomEquipmentTypeInput) => {
    const created = await createEquipmentType(input);
    refresh();
    await onAdd({ equipmentTypeId: created.id, quantity: 1 });
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      aria-labelledby="equipment-picker-title"
    >
      <DialogTitle id="equipment-picker-title">Add equipment</DialogTitle>
      <DialogContent dividers>
        {mode === 'custom' ? (
          <CustomEquipmentForm initialName={q.trim()} onCancel={() => setMode('search')} onSubmit={addCustom} />
        ) : (
          <Stack spacing={2}>
            {error && <Alert severity="error">{error}</Alert>}
            <TextField
              label="Search equipment"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              fullWidth
              autoFocus
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                  endAdornment: isLoading ? (
                    <InputAdornment position="end">
                      <CircularProgress size={16} aria-label="Searching" />
                    </InputAdornment>
                  ) : undefined,
                },
              }}
            />
            <Box role="group" aria-label="Filter by category" sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              <Chip
                label="All"
                color={category === null ? 'primary' : 'default'}
                variant={category === null ? 'filled' : 'outlined'}
                onClick={() => setCategory(null)}
                aria-pressed={category === null}
              />
              {EQUIPMENT_CATEGORIES.map((c) => (
                <Chip
                  key={c}
                  label={EQUIPMENT_CATEGORY_LABEL[c]}
                  color={category === c ? 'primary' : 'default'}
                  variant={category === c ? 'filled' : 'outlined'}
                  onClick={() => setCategory(category === c ? null : c)}
                  aria-pressed={category === c}
                />
              ))}
            </Box>
            {searchError && <Alert severity="error">{searchError}</Alert>}
            {!isLoading && !searchError && types.length === 0 && (
              <Typography color="text.secondary">No equipment matches your search.</Typography>
            )}
            {types.length > 0 && (
              <List aria-label="Search results" dense sx={{ maxHeight: fullScreen ? 'none' : 320, overflowY: 'auto' }}>
                {types.map((type) => (
                  <ListItemButton
                    key={type.id}
                    selected={selected?.id === type.id}
                    onClick={() => setSelected(type)}
                    aria-pressed={selected?.id === type.id}
                    sx={{ alignItems: 'flex-start' }}
                  >
                    <ListItemText
                      primary={type.name}
                      secondary={
                        <Box component="span" sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                          <Typography component="span" variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
                            {categoryLabel(type.category)}
                            {type.isCustom && ' · custom'}
                          </Typography>
                          {type.capabilities.map((cap) => (
                            <Chip key={cap.slug} component="span" size="small" variant="outlined" label={cap.name} />
                          ))}
                        </Box>
                      }
                      slotProps={{ secondary: { component: 'span' } }}
                    />
                  </ListItemButton>
                ))}
              </List>
            )}
            {selected && (
              <Box component="section" aria-label={`Details for ${selected.name}`}>
                <Stack spacing={2}>
                  <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
                    {selected.name}
                  </Typography>
                  <QuantityStepper value={quantity} onChange={setQuantity} disabled={busy} />
                  <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
                    <TextField
                      label="Brand"
                      value={brand}
                      onChange={(e) => setBrand(e.target.value)}
                      error={brand.trim().length > EQUIPMENT_BRAND_MAX}
                      helperText={brand.trim().length > EQUIPMENT_BRAND_MAX ? `At most ${EQUIPMENT_BRAND_MAX} characters.` : undefined}
                    />
                    <TextField
                      label="Model"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      error={model.trim().length > EQUIPMENT_MODEL_MAX}
                      helperText={model.trim().length > EQUIPMENT_MODEL_MAX ? `At most ${EQUIPMENT_MODEL_MAX} characters.` : undefined}
                    />
                  </Box>
                </Stack>
              </Box>
            )}
            <Box sx={{ pt: 1 }}>
              <Button onClick={() => setMode('custom')} disabled={busy}>
                Can&apos;t find it? Add custom equipment
              </Button>
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {mode === 'search' && (
          <Button variant="contained" onClick={() => void add()} disabled={!selected || busy || tooLong}>
            Add
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

export default EquipmentPickerDialog;
