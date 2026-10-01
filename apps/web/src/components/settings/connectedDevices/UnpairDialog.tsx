/**
 * Confirm unpairing a phone (#283). Unpairing revokes the device and the token
 * it synced with; the checkbox also deletes the activity it imported. The API
 * does both — this dialog only asks.
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
} from '@mui/material';
import { unpairDevice, type Device } from '../../../services/healthSync';
import { healthSyncErrorMessage } from '../../../hooks/useHealthSync';

export const DELETE_ENTRIES_LABEL = 'Also delete the activity imported from this phone';

interface UnpairDialogProps {
  device: Device | null;
  onClose: () => void;
  onUnpaired: (device: Device, deletedEntries: boolean) => void;
}

export function UnpairDialog({ device, onClose, onUnpaired }: UnpairDialogProps) {
  const [deleteEntries, setDeleteEntries] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (device) {
      setDeleteEntries(false);
      setError(null);
    }
  }, [device]);

  const confirm = async () => {
    if (!device) return;
    setBusy(true);
    setError(null);
    try {
      await unpairDevice(device.id, deleteEntries);
      onUnpaired(device, deleteEntries);
    } catch (err) {
      setError(healthSyncErrorMessage(err, 'Failed to unpair the device'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={device !== null} onClose={busy ? undefined : onClose} aria-labelledby="unpair-title">
      <DialogTitle id="unpair-title">Unpair {device?.name}?</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 1 }}>
          The phone stops syncing and its access token is revoked. To sync again, pair it from the app.
        </DialogContentText>
        <FormControlLabel
          control={
            <Checkbox checked={deleteEntries} onChange={(event) => setDeleteEntries(event.target.checked)} />
          }
          label={DELETE_ENTRIES_LABEL}
        />
        {error && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button color="error" variant="contained" onClick={() => void confirm()} disabled={busy}>
          Unpair
        </Button>
      </DialogActions>
    </Dialog>
  );
}
