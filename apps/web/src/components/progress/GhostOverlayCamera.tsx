/**
 * Take or choose a progress photo, with a GHOST OVERLAY (E7.9, #249): the
 * newest earlier photo of the same pose, drawn at low opacity over the chosen
 * image (or on its own before one is chosen), so framing and distance stay
 * consistent from photo to photo.
 *
 * - "Take photo" opens a file input with `capture="environment"`, as the
 *   intake kit's `ImageIntake` does: the OS opens the camera, so there is no
 *   `getUserMedia`, no camera permission prompt and no Permissions-Policy
 *   change. Where the OS cannot open a camera, it falls back to its file
 *   picker. "Choose photo" is the plain picker.
 * - The ghost is computed client-side from the owner's own photo, through the
 *   same signed download every photo uses. With no earlier photo of the pose
 *   there is no overlay and no error.
 * - The overlay is decorative (hidden from assistive technology); a caption
 *   says what it is.
 */
import { useRef, type ChangeEvent } from 'react';
import { Box, Button, FormControlLabel, Stack, Switch, Typography } from '@mui/material';
import {
  AddPhotoAlternateOutlined as ChooseIcon,
  PhotoCameraOutlined as CameraIcon,
} from '@mui/icons-material';
import {
  PROGRESS_PHOTO_POSE_LABELS,
  formatPhotoDate,
  type ProgressPhoto,
  type ProgressPhotoPose,
} from '../../services/progressPhotos';
import { ProgressPhotoImage } from './ProgressPhotoImage';

/** Opacity of the ghost over a chosen image, and on its own before one is chosen. */
export const GHOST_OPACITY = 0.35;
export const GHOST_ALONE_OPACITY = 0.6;

export const TAKE_PHOTO_LABEL = 'Take photo';
export const CHOOSE_PHOTO_LABEL = 'Choose photo';

export interface GhostOverlayCameraProps {
  pose: ProgressPhotoPose;
  /** The newest earlier photo of `pose`, or null when there is none. */
  ghost: ProgressPhoto | null;
  /** An object URL of the chosen image, or null before one is chosen. */
  previewUrl: string | null;
  showGhost: boolean;
  onShowGhostChange: (show: boolean) => void;
  onFile: (file: File) => void;
  disabled?: boolean;
}

export function GhostOverlayCamera({
  pose,
  ghost,
  previewUrl,
  showGhost,
  onShowGhostChange,
  onFile,
  disabled = false,
}: GhostOverlayCameraProps) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const poseLabel = PROGRESS_PHOTO_POSE_LABELS[pose].toLowerCase();

  const handle = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) onFile(file);
  };

  const ghostVisible = ghost !== null && showGhost;
  const caption = ghost
    ? previewUrl
      ? `Ghost of your last ${poseLabel} photo (${formatPhotoDate(ghost.localDate)}) over your new one. Line them up to keep the framing the same.`
      : `Your last ${poseLabel} photo (${formatPhotoDate(ghost.localDate)}). Stand the same way and at the same distance.`
    : `No earlier ${poseLabel} photo yet. This one will be the reference for next time.`;

  return (
    <Stack spacing={1.5}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          data-testid="progress-photo-camera-input"
          onChange={handle}
        />
        <input
          ref={pickerRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/*"
          hidden
          data-testid="progress-photo-file-input"
          onChange={handle}
        />
        <Button
          variant="contained"
          startIcon={<CameraIcon />}
          disabled={disabled}
          onClick={() => cameraRef.current?.click()}
        >
          {TAKE_PHOTO_LABEL}
        </Button>
        <Button variant="outlined" startIcon={<ChooseIcon />} disabled={disabled} onClick={() => pickerRef.current?.click()}>
          {CHOOSE_PHOTO_LABEL}
        </Button>
      </Box>

      {(previewUrl || ghostVisible) && (
        <Box
          data-testid="ghost-overlay-frame"
          sx={{
            position: 'relative',
            width: '100%',
            maxWidth: 320,
            aspectRatio: '3 / 4',
            borderRadius: 1,
            overflow: 'hidden',
            bgcolor: 'action.hover',
          }}
        >
          {previewUrl && (
            <Box
              component="img"
              src={previewUrl}
              alt={`Your new ${poseLabel} photo`}
              sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
            />
          )}
          {ghostVisible && ghost && (
            <ProgressPhotoImage
              storageObjectId={ghost.storageObjectId}
              alt=""
              decorative
              testId="ghost-overlay"
              sx={{
                position: 'absolute',
                inset: 0,
                bgcolor: 'transparent',
                opacity: previewUrl ? GHOST_OPACITY : GHOST_ALONE_OPACITY,
                pointerEvents: 'none',
              }}
            />
          )}
        </Box>
      )}

      <Typography variant="body2" color="text.secondary">
        {caption}
      </Typography>
      {ghost && (
        <FormControlLabel
          control={<Switch checked={showGhost} onChange={(e) => onShowGhostChange(e.target.checked)} />}
          label="Show ghost overlay"
        />
      )}
    </Stack>
  );
}

export default GhostOverlayCamera;
