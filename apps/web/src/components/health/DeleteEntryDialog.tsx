/**
 * Confirm-then-delete for one measurement entry, issue #60 (E2.5).
 *
 * Names exactly what goes ("Weight 208.4 lb from Sep 29"), because there is no
 * undo: `DELETE /api/measurements/entries/:entryId` soft-deletes every reading
 * of the entry and there is no restore endpoint (an operator can recover the
 * rows). Cancel and Escape change nothing.
 */

import { useEffect, useId, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';
import { ApiError } from '../../services/api';
import {
  deleteMeasurementEntry,
  HEALTH_DATA_UNAVAILABLE,
  isEntryGone,
  isHealthDataForbidden,
  type MetricDef,
  type UnitSystem,
} from '../../services/health';
import { describeEntry, type HistoryEntry } from '../../utils/measurementSeries';
import { formatShortDate } from '../../utils/measurementDates';

export interface DeleteEntryDialogProps {
  open: boolean;
  /** The entry to delete; kept by the caller while the dialog closes. */
  entry: HistoryEntry | null;
  metricsByKey: ReadonlyMap<string, MetricDef>;
  unitSystem: UnitSystem;
  onClose: () => void;
  /** After the `204`. The caller refreshes what shows the entry. */
  onDeleted: () => void;
  /** The API answered `404`: the entry was already removed elsewhere. */
  onMissing: () => void;
}

/** `Weight 208.4 lb and Body fat 27.8% from Sep 29`. */
export function entrySummary(
  entry: HistoryEntry,
  metricsByKey: ReadonlyMap<string, MetricDef>,
  unitSystem: UnitSystem,
): string {
  const parts = describeEntry(entry, metricsByKey, unitSystem).map((view) => `${view.label} ${view.text}`);
  const readings =
    parts.length <= 1 ? (parts[0] ?? 'Entry') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${readings} from ${formatShortDate(entry.measuredAt)}`;
}

export function DeleteEntryDialog({
  open,
  entry,
  metricsByKey,
  unitSystem,
  onClose,
  onDeleted,
  onMissing,
}: DeleteEntryDialogProps) {
  const titleId = useId();
  const [deleting, setDeleting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (open) setFailure(null);
  }, [open]);

  const confirm = async () => {
    if (!entry || deleting) return;
    setDeleting(true);
    setFailure(null);
    try {
      await deleteMeasurementEntry(entry.entryId);
      onDeleted();
      onClose();
    } catch (err) {
      if (isEntryGone(err)) {
        onMissing();
        onClose();
      } else if (isHealthDataForbidden(err)) {
        setFailure(HEALTH_DATA_UNAVAILABLE);
      } else if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        setFailure(err.message);
      } else {
        setFailure('Could not delete. Check your connection and try again.');
      }
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onClose={deleting ? undefined : onClose} aria-labelledby={titleId} maxWidth="xs" fullWidth>
      <DialogTitle id={titleId}>Delete entry?</DialogTitle>
      <DialogContent>
        {entry && (
          <DialogContentText sx={{ overflowWrap: 'anywhere' }}>
            {entrySummary(entry, metricsByKey, unitSystem)} will be deleted, with every reading saved in
            this entry. This cannot be undone here.
          </DialogContentText>
        )}
        {failure && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {failure}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={deleting}>
          Cancel
        </Button>
        <Button color="error" variant="contained" onClick={() => void confirm()} disabled={deleting || !entry}>
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default DeleteEntryDialog;
