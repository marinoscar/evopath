/**
 * Add a progress photo (E7.9, #249): pick the pose, the day (today in the
 * browser's time zone by default) and an optional note, then take or choose
 * the photo, with the ghost of the last photo of that pose over it.
 *
 * Saving is three calls, in this order: the image is downscaled in the
 * browser with the intake kit's `downscaleImage` (which also drops EXIF,
 * GPS included), uploaded to `POST /api/storage/objects` and waited on until
 * `ready`, then added with `POST /api/progress-photos`. The API decides every
 * rule; the checks here only explain a problem before the round trip.
 *
 * Uploading needs `storage:write`; without it (or with object storage not
 * configured) the controls are disabled with the reason instead of failing.
 */
import { useEffect, useId, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { LockOutlined as LockIcon } from '@mui/icons-material';
import { FeatureUnavailableNotice } from '../common/FeatureUnavailableNotice';
import { downscaleImage, UnsupportedImageError } from '../../utils/downscaleImage';
import { localDateIn } from '../../utils/localDates';
import { useLatestProgressPhoto } from '../../hooks/useProgressPhotos';
import { PHOTOS_UNAVAILABLE } from '../../services/gyms';
import {
  PROGRESS_PHOTO_NOTE_MAX,
  PROGRESS_PHOTO_POSES,
  PROGRESS_PHOTO_POSE_LABELS,
  PROGRESS_PHOTOS_PRIVACY_COPY,
  progressPhotoErrorMessage,
  progressPhotoPreparedRejection,
  progressPhotoRejection,
  uploadProgressPhoto,
  type ProgressPhoto,
  type ProgressPhotoPose,
} from '../../services/progressPhotos';
import type { WaitForReadyOptions } from '../../services/storage';
import { GhostOverlayCamera } from './GhostOverlayCamera';

export const ADD_PROGRESS_PHOTO_TITLE = 'Add progress photo';

export interface AddProgressPhotoDialogProps {
  open: boolean;
  onClose: () => void;
  /** After the `201`. The caller refreshes the gallery. */
  onAdded: (photo: ProgressPhoto) => void;
  initialPose?: ProgressPhotoPose;
  /** `storage:write`: may upload a file at all. */
  canUpload: boolean;
  /** `false` only when `GET /api/storage/status` said so. */
  storageConfigured?: boolean;
  /** Test seam for the ready-polling cadence. */
  uploadWaitOptions?: WaitForReadyOptions;
}

/** Downscale when the browser can decode; otherwise upload the file as is. */
async function prepare(file: File): Promise<File> {
  if (typeof createImageBitmap !== 'function') return file;
  return downscaleImage(file);
}

function objectUrlFor(file: File): string | null {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  return URL.createObjectURL(file);
}

export function AddProgressPhotoDialog({
  open,
  onClose,
  onAdded,
  initialPose = 'front',
  canUpload,
  storageConfigured = true,
  uploadWaitOptions,
}: AddProgressPhotoDialogProps) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const titleId = useId();
  const poseLabelId = useId();
  const [pose, setPose] = useState<ProgressPhotoPose>(initialPose);
  const [localDate, setLocalDate] = useState(() => localDateIn(null));
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showGhost, setShowGhost] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = localDateIn(null);

  const { photo: ghost } = useLatestProgressPhoto(open ? pose : null);

  // A fresh form every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setPose(initialPose);
    setLocalDate(localDateIn(null));
    setNote('');
    setFile(null);
    setShowGhost(true);
    setSaving(false);
    setError(null);
  }, [open, initialPose]);

  // The chosen image's preview URL lives exactly as long as the file.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = objectUrlFor(file);
    setPreviewUrl(url);
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);

  const uploadBlocked = !canUpload || !storageConfigured;
  const dateProblem = !localDate
    ? 'Choose the day of the photo'
    : localDate > today
      ? 'The date cannot be in the future'
      : null;

  const chooseFile = (picked: File) => {
    const reason = progressPhotoRejection(picked);
    if (reason) {
      setError(reason);
      return;
    }
    setError(null);
    setFile(picked);
  };

  const save = async () => {
    if (saving) return;
    if (!file) {
      setError('Take or choose a photo first');
      return;
    }
    if (dateProblem) {
      setError(dateProblem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const prepared = await prepare(file);
      const typeProblem = progressPhotoPreparedRejection(prepared);
      if (typeProblem) {
        setError(typeProblem);
        return;
      }
      const photo = await uploadProgressPhoto(prepared, { localDate, pose, note }, uploadWaitOptions);
      onAdded(photo);
      onClose();
    } catch (err) {
      setError(
        err instanceof UnsupportedImageError ? err.message : progressPhotoErrorMessage(err, 'The photo could not be added'),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      aria-labelledby={titleId}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle id={titleId}>{ADD_PROGRESS_PHOTO_TITLE}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 0.5 }}>
          <Typography variant="body2" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <LockIcon fontSize="small" aria-hidden />
            {PROGRESS_PHOTOS_PRIVACY_COPY}
          </Typography>

          <FormControl>
            <FormLabel id={poseLabelId}>Pose</FormLabel>
            <RadioGroup
              row
              aria-labelledby={poseLabelId}
              value={pose}
              onChange={(e) => setPose(e.target.value as ProgressPhotoPose)}
            >
              {PROGRESS_PHOTO_POSES.map((value) => (
                <FormControlLabel
                  key={value}
                  value={value}
                  control={<Radio />}
                  label={PROGRESS_PHOTO_POSE_LABELS[value]}
                  disabled={saving}
                />
              ))}
            </RadioGroup>
          </FormControl>

          {!canUpload ? (
            <Alert severity="info">{PHOTOS_UNAVAILABLE}</Alert>
          ) : !storageConfigured ? (
            <FeatureUnavailableNotice feature="storage" />
          ) : null}

          <GhostOverlayCamera
            pose={pose}
            ghost={ghost}
            previewUrl={previewUrl}
            showGhost={showGhost}
            onShowGhostChange={setShowGhost}
            onFile={chooseFile}
            disabled={saving || uploadBlocked}
          />
          {file && (
            <Typography variant="body2" data-testid="progress-photo-chosen">
              Chosen: {file.name}
            </Typography>
          )}

          <TextField
            label="Date"
            type="date"
            value={localDate}
            onChange={(e) => setLocalDate(e.target.value)}
            disabled={saving}
            error={localDate !== '' && localDate > today}
            helperText={localDate !== '' && localDate > today ? 'The date cannot be in the future' : ' '}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { max: today } }}
            sx={{ maxWidth: 240 }}
          />

          <TextField
            label="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, PROGRESS_PHOTO_NOTE_MAX))}
            disabled={saving}
            multiline
            minRows={2}
            helperText={`${note.length}/${PROGRESS_PHOTO_NOTE_MAX}`}
            slotProps={{ htmlInput: { maxLength: PROGRESS_PHOTO_NOTE_MAX } }}
          />

          {error && (
            <Alert severity="error" role="alert">
              {error}
            </Alert>
          )}
          {saving && (
            <Typography role="status" color="text.secondary">
              Uploading your photo…
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void save()} disabled={saving || uploadBlocked || !file}>
          Save photo
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default AddProgressPhotoDialog;
