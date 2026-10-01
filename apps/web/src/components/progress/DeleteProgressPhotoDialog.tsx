/**
 * Confirm-then-delete for one progress photo (E7.9, #249). There is no undo:
 * `DELETE /api/progress-photos/:id` removes the row and the stored image.
 * Cancel and Escape change nothing. A `404` (already gone elsewhere) counts
 * as deleted.
 */
import { useEffect, useId, useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from '@mui/material';
import {
  PROGRESS_PHOTO_POSE_LABELS,
  deleteProgressPhoto,
  formatPhotoDate,
  progressPhotoErrorMessage,
  progressPhotoErrorReason,
  type ProgressPhoto,
} from '../../services/progressPhotos';
import { ApiError } from '../../services/api';

export interface DeleteProgressPhotoDialogProps {
  /** The photo to delete; null closes the dialog. */
  photo: ProgressPhoto | null;
  onClose: () => void;
  onDeleted: (photo: ProgressPhoto) => void;
}

export function DeleteProgressPhotoDialog({ photo, onClose, onDeleted }: DeleteProgressPhotoDialogProps) {
  const titleId = useId();
  const [deleting, setDeleting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (photo) setFailure(null);
  }, [photo]);

  const confirm = async () => {
    if (!photo || deleting) return;
    setDeleting(true);
    setFailure(null);
    try {
      await deleteProgressPhoto(photo.id);
      onDeleted(photo);
      onClose();
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 404 &&
        (progressPhotoErrorReason(err) ?? 'PROGRESS_PHOTO_NOT_FOUND') === 'PROGRESS_PHOTO_NOT_FOUND'
      ) {
        onDeleted(photo);
        onClose();
      } else {
        setFailure(progressPhotoErrorMessage(err, 'The photo could not be deleted'));
      }
    } finally {
      setDeleting(false);
    }
  };

  const what = photo
    ? `your ${PROGRESS_PHOTO_POSE_LABELS[photo.pose].toLowerCase()} photo from ${formatPhotoDate(photo.localDate)}`
    : 'this photo';

  return (
    <Dialog open={photo !== null} onClose={deleting ? undefined : onClose} aria-labelledby={titleId}>
      <DialogTitle id={titleId}>Delete photo?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          This permanently deletes {what}. It cannot be undone.
        </DialogContentText>
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
        <Button color="error" variant="contained" onClick={() => void confirm()} disabled={deleting}>
          Delete
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default DeleteProgressPhotoDialog;
