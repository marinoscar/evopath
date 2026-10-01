/**
 * Delete a health document (issue #190, H6).
 *
 * Two shapes, decided by the API from the row, and explained here before the
 * user confirms:
 *  - the file still exists: it is erased, and the row stays listed as "file
 *    deleted on …" so the values' provenance stays explainable;
 *  - the file is already gone: the record itself is removed.
 *
 * The values extracted from the document are kept unless the user ticks
 * "Also delete the N values extracted from this document" (hidden when there
 * are none). `If-Match: <version>`; a `412` closes the dialog and the page
 * refreshes and says the document changed.
 */

import { useEffect, useId, useState } from 'react';
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
  Stack,
} from '@mui/material';
import { ApiError } from '../../../services/api';
import {
  deleteHealthDocument,
  isHealthDocumentStale,
  type HealthDocument,
  type HealthDocumentDeleteResult,
} from '../../../services/healthDocuments';

export interface HealthDocumentDeleteDialogProps {
  document: HealthDocument | null;
  onClose: () => void;
  onDeleted: (result: HealthDocumentDeleteResult) => void;
  onStale: () => void;
}

export function valuesCheckboxLabel(count: number): string {
  return count === 1
    ? 'Also delete the 1 value extracted from this document'
    : `Also delete the ${count} values extracted from this document`;
}

export function HealthDocumentDeleteDialog({
  document: doc,
  onClose,
  onDeleted,
  onStale,
}: HealthDocumentDeleteDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [deleteValues, setDeleteValues] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setDeleteValues(false);
    setError(null);
    setDeleting(false);
  }, [doc]);

  const fileExists = doc ? doc.fileDeletedAt === null : false;
  const valueCount = doc?.valueCount ?? 0;

  const handleDelete = async () => {
    if (!doc) return;
    setDeleting(true);
    setError(null);
    try {
      const result = await deleteHealthDocument(doc.id, {
        deleteValues: valueCount > 0 && deleteValues,
        expectedVersion: doc.version,
      });
      onDeleted(result);
    } catch (err) {
      if (isHealthDocumentStale(err)) {
        onStale();
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not delete the document. Try again.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog
      open={doc !== null}
      onClose={deleting ? undefined : onClose}
      fullWidth
      maxWidth="xs"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <DialogTitle id={titleId}>
        {fileExists ? 'Delete this file?' : 'Remove this record?'}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {error && <Alert severity="error">{error}</Alert>}
          <DialogContentText id={descriptionId} sx={{ overflowWrap: 'anywhere' }}>
            {fileExists
              ? `"${doc?.originalName}" will be permanently deleted. It stays in this list as a deleted file, so your history stays explainable. This cannot be undone.`
              : `The file "${doc?.originalName}" was already deleted. This removes its record from the list. This cannot be undone.`}
          </DialogContentText>
          {valueCount > 0 && (
            <FormControlLabel
              control={
                <Checkbox
                  checked={deleteValues}
                  onChange={(event) => setDeleteValues(event.target.checked)}
                />
              }
              label={valuesCheckboxLabel(valueCount)}
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={deleting}>
          Cancel
        </Button>
        <Button
          color="error"
          variant="contained"
          onClick={() => void handleDelete()}
          disabled={deleting}
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
