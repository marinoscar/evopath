/**
 * Rename a health document and set its document date (issue #190, H6).
 *
 * Sends only what changed, with `If-Match: <version>`. A `412` means the
 * document changed since the list loaded (another tab, the lab report's
 * collection date, a purge): the dialog closes and the page refreshes and says
 * so, rather than overwriting what changed. The API sanitises the name; the
 * checks here only explain an empty or over-long name before the round trip.
 */

import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
} from '@mui/material';
import { ApiError } from '../../../services/api';
import {
  isHealthDocumentStale,
  updateHealthDocument,
  type HealthDocument,
  type HealthDocumentUpdate,
} from '../../../services/healthDocuments';

/** The API's limit on `originalName`, after sanitising. */
export const HEALTH_DOCUMENT_NAME_MAX_LENGTH = 255;

export interface HealthDocumentEditDialogProps {
  document: HealthDocument | null;
  onClose: () => void;
  onSaved: (updated: HealthDocument) => void;
  /** The document changed since it was loaded (`412`). */
  onStale: () => void;
}

export function HealthDocumentEditDialog({
  document: doc,
  onClose,
  onSaved,
  onStale,
}: HealthDocumentEditDialogProps) {
  const titleId = useId();
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!doc) return;
    setName(doc.originalName);
    setDate(doc.documentDate ?? '');
    setError(null);
    setSaving(false);
  }, [doc]);

  const trimmed = name.trim();
  const nameProblem =
    trimmed.length === 0
      ? 'Enter a name.'
      : trimmed.length > HEALTH_DOCUMENT_NAME_MAX_LENGTH
        ? `Use at most ${HEALTH_DOCUMENT_NAME_MAX_LENGTH} characters.`
        : null;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!doc || nameProblem) return;
    const input: HealthDocumentUpdate = {};
    if (trimmed !== doc.originalName) input.originalName = trimmed;
    const nextDate = date === '' ? null : date;
    if (nextDate !== doc.documentDate) input.documentDate = nextDate;
    if (Object.keys(input).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await updateHealthDocument(doc.id, input, doc.version);
      onSaved(updated);
    } catch (err) {
      if (isHealthDocumentStale(err)) {
        onStale();
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not save the changes. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={doc !== null}
      onClose={saving ? undefined : onClose}
      fullWidth
      maxWidth="xs"
      aria-labelledby={titleId}
    >
      <form onSubmit={(event) => void handleSubmit(event)} noValidate>
        <DialogTitle id={titleId}>Rename or set date</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {error && <Alert severity="error">{error}</Alert>}
            <TextField
              label="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              autoFocus
              fullWidth
              error={nameProblem !== null}
              helperText={nameProblem ?? ' '}
              slotProps={{ htmlInput: { maxLength: HEALTH_DOCUMENT_NAME_MAX_LENGTH + 50 } }}
            />
            <TextField
              label="Document date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              fullWidth
              helperText="The date on the document, such as the day a lab sample was taken. Leave empty to clear it."
              slotProps={{ inputLabel: { shrink: true } }}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={saving || nameProblem !== null}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
