/**
 * The "you are about to strand everything already stored" confirmation for
 * `/admin/settings/storage` (issue #376, epic #372).
 *
 * Opened only when the API has ALREADY refused the save with
 * `409 STORAGE_LOCATION_IN_USE` — never speculatively. That ordering matters:
 * the server counted the rows (`storage_objects` and `database_backup_runs`)
 * that still point at the old location, and only it can. A dialog that guessed
 * client-side would either nag about a first-time configuration that can strand
 * nothing, or stay silent about the save that strands a thousand objects.
 *
 * THE TYPED LITERAL COMES FROM `STORAGE_SWITCH_CONFIRMATION`
 * (`services/storageConfig.ts`), which mirrors the API's own Zod literal —
 * the same rule `DbBackupRestoreDialog` and `PushConfigConfirmDialog` follow.
 * It is never re-typed here as a string a refactor could drift.
 *
 * ⚠ THE CONSEQUENCE IS NOT "DATA LOSS", AND SAYING SO WOULD BE WRONG. Nothing
 * is deleted: the objects stay exactly where they are, in the old bucket, and
 * this deployment simply stops being able to read them. That distinction is
 * what an administrator needs in order to decide — the way back is to point
 * the configuration at the old location again, or to copy the objects across
 * out of band. Copy is a thing this app deliberately does not do (see the API's
 * `assertSwitchAcknowledged`), so the dialog must not imply it might.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { STORAGE_SWITCH_CONFIRMATION } from '../../services/storageConfig';
import type { StorageLocationInUseDetails } from '../../services/storageConfig';

export interface StorageSwitchConfirmDialogProps {
  open: boolean;
  /** The API's own message — rendered verbatim; it carries the real counts. */
  message: string;
  /** The structured `details`, when the API sent them. `null` is tolerated. */
  details: StorageLocationInUseDetails | null;
  isWorking: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** `provider / bucket @ endpoint` for one side of the move, endpoint omitted when there is none. */
function describeLocation(
  location: StorageLocationInUseDetails['from'] | undefined,
): string | null {
  if (!location) return null;
  const where = location.endpoint ? ` at ${location.endpoint}` : '';
  return `${location.provider} · ${location.bucket}${where}`;
}

export function StorageSwitchConfirmDialog({
  open,
  message,
  details,
  isWorking,
  onConfirm,
  onClose,
}: StorageSwitchConfirmDialogProps) {
  const [typed, setTyped] = useState('');

  // Every opening starts from nothing, so a literal typed for an earlier,
  // abandoned switch can never confirm a later one. Mirrors
  // `PushConfigConfirmDialog` and `DbBackupRestoreDialog`.
  useEffect(() => {
    if (!open) return;
    setTyped('');
  }, [open]);

  if (!open) return null;

  const typedMatches = typed.trim() === STORAGE_SWITCH_CONFIRMATION;
  const from = describeLocation(details?.from);
  const to = describeLocation(details?.to);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Move this deployment to a different storage location?</DialogTitle>
      <DialogContent dividers>
        <Alert severity="warning">
          <AlertTitle>Existing objects are not copied</AlertTitle>
          {/* The API's message, verbatim: it is the only thing that knows how
              many rows point at the old location. */}
          {message}
        </Alert>

        {(from || to) && (
          <Stack spacing={1} sx={{ mt: 2 }} data-testid="storage-switch-locations">
            {from && (
              <Typography variant="body2">
                <strong>From:</strong> {from}
              </Typography>
            )}
            {to && (
              <Typography variant="body2">
                <strong>To:</strong> {to}
              </Typography>
            )}
            {details && (
              <Typography variant="body2" color="text.secondary">
                {details.storageObjects} stored object(s) and {details.databaseBackupRuns}{' '}
                database backup(s) stay behind, readable only by pointing this deployment
                back at the old location or by copying them across yourself.
              </Typography>
            )}
          </Stack>
        )}

        <Box sx={{ mt: 3 }}>
          <TextField
            fullWidth
            label={`Type ${STORAGE_SWITCH_CONFIRMATION} to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            slotProps={{
              htmlInput: { 'aria-label': `Type ${STORAGE_SWITCH_CONFIRMATION} to confirm` },
            }}
            helperText="This must be typed exactly, in capitals. Nothing happens until it matches."
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={isWorking}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="warning"
          disabled={!typedMatches || isWorking}
          onClick={onConfirm}
        >
          {isWorking ? 'Saving…' : 'Save and switch'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
