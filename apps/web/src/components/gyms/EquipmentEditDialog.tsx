/**
 * Edit one piece of a gym's equipment (E3.3): quantity, brand, model, notes.
 * Saving an AI-drafted row marks it verified (the API keeps the original
 * draft once).
 */
import { useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  EQUIPMENT_BRAND_MAX,
  EQUIPMENT_MODEL_MAX,
  EQUIPMENT_NOTES_MAX,
  gymErrorMessage,
  type EquipmentUpdate,
  type GymEquipment,
} from '../../services/gyms';
import { QuantityStepper } from './QuantityStepper';
import { useCompactDialog } from './useCompactDialog';

export interface EquipmentEditDialogProps {
  open: boolean;
  item: GymEquipment | null;
  onClose: () => void;
  onSave: (input: EquipmentUpdate) => Promise<void>;
}

const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

export function EquipmentEditDialog({ open, item, onClose, onSave }: EquipmentEditDialogProps) {
  const fullScreen = useCompactDialog();
  const [quantity, setQuantity] = useState(1);
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && item) {
      setQuantity(item.quantity);
      setBrand(item.brand ?? '');
      setModel(item.model ?? '');
      setNotes(item.notes ?? '');
      setError(null);
    }
  }, [open, item]);

  const tooLong =
    brand.trim().length > EQUIPMENT_BRAND_MAX ||
    model.trim().length > EQUIPMENT_MODEL_MAX ||
    notes.trim().length > EQUIPMENT_NOTES_MAX;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (tooLong || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ quantity, brand: orNull(brand), model: orNull(model), notes: orNull(notes) });
      onClose();
    } catch (err) {
      setError(gymErrorMessage(err, 'Could not save the equipment'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      aria-labelledby="equipment-edit-title"
    >
      <form onSubmit={submit} noValidate>
        <DialogTitle id="equipment-edit-title">Edit {item?.equipmentType.name ?? 'equipment'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {error && <Alert severity="error">{error}</Alert>}
            {item?.origin === 'ai' && !item.userVerified && (
              <Typography variant="body2" color="text.secondary">
                Saving confirms this item: it will show as verified by you.
              </Typography>
            )}
            <QuantityStepper value={quantity} onChange={setQuantity} disabled={busy} />
            <TextField
              label="Brand"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              error={brand.trim().length > EQUIPMENT_BRAND_MAX}
              helperText={brand.trim().length > EQUIPMENT_BRAND_MAX ? `At most ${EQUIPMENT_BRAND_MAX} characters.` : undefined}
              fullWidth
            />
            <TextField
              label="Model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              error={model.trim().length > EQUIPMENT_MODEL_MAX}
              helperText={model.trim().length > EQUIPMENT_MODEL_MAX ? `At most ${EQUIPMENT_MODEL_MAX} characters.` : undefined}
              fullWidth
            />
            <TextField
              label="Notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              error={notes.trim().length > EQUIPMENT_NOTES_MAX}
              helperText={notes.trim().length > EQUIPMENT_NOTES_MAX ? `At most ${EQUIPMENT_NOTES_MAX} characters.` : undefined}
              multiline
              minRows={2}
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={busy || tooLong}>
            Save
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export default EquipmentEditDialog;
