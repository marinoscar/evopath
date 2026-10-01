/**
 * Pick two progress photos of one pose and compare them (E7.9, #249).
 *
 * Defaults to the OLDEST photo of the pose as "Before" and the NEWEST as
 * "After", the comparison most people want. With fewer than two photos of
 * the pose, compare is disabled with guidance instead of an empty view.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useAllProgressPhotos } from '../../hooks/useProgressPhotos';
import {
  PROGRESS_PHOTO_POSES,
  PROGRESS_PHOTO_POSE_LABELS,
  formatPhotoDate,
  type ProgressPhoto,
  type ProgressPhotoPose,
} from '../../services/progressPhotos';
import { PhotoCompare } from './PhotoCompare';

export const COMPARE_TITLE = 'Compare photos';

export interface CompareProgressPhotosDialogProps {
  open: boolean;
  onClose: () => void;
  initialPose?: ProgressPhotoPose;
}

function optionLabel(photo: ProgressPhoto): string {
  return photo.note ? `${formatPhotoDate(photo.localDate)} · ${photo.note}` : formatPhotoDate(photo.localDate);
}

export function CompareProgressPhotosDialog({ open, onClose, initialPose = 'front' }: CompareProgressPhotosDialogProps) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const titleId = useId();
  const [pose, setPose] = useState<ProgressPhotoPose>(initialPose);
  const { photos, isLoading, error } = useAllProgressPhotos(pose, open);
  const [beforeId, setBeforeId] = useState<string>('');
  const [afterId, setAfterId] = useState<string>('');

  useEffect(() => {
    if (open) setPose(initialPose);
  }, [open, initialPose]);

  // Oldest vs newest whenever the list for a pose arrives.
  useEffect(() => {
    if (photos.length >= 2) {
      setBeforeId(photos[photos.length - 1].id);
      setAfterId(photos[0].id);
    } else {
      setBeforeId('');
      setAfterId('');
    }
  }, [photos]);

  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);
  const before = byId.get(beforeId) ?? null;
  const after = byId.get(afterId) ?? null;
  const tooFew = !isLoading && !error && photos.length < 2;
  const poseLabel = PROGRESS_PHOTO_POSE_LABELS[pose].toLowerCase();

  return (
    <Dialog open={open} onClose={onClose} aria-labelledby={titleId} fullScreen={fullScreen} fullWidth maxWidth="md">
      <DialogTitle id={titleId}>{COMPARE_TITLE}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' } }}>
            <TextField select label="Pose" value={pose} onChange={(e) => setPose(e.target.value as ProgressPhotoPose)}>
              {PROGRESS_PHOTO_POSES.map((value) => (
                <MenuItem key={value} value={value}>
                  {PROGRESS_PHOTO_POSE_LABELS[value]}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="Before"
              value={beforeId}
              disabled={photos.length < 2}
              onChange={(e) => setBeforeId(e.target.value)}
            >
              {photos.map((photo) => (
                <MenuItem key={photo.id} value={photo.id}>
                  {optionLabel(photo)}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="After"
              value={afterId}
              disabled={photos.length < 2}
              onChange={(e) => setAfterId(e.target.value)}
            >
              {photos.map((photo) => (
                <MenuItem key={photo.id} value={photo.id}>
                  {optionLabel(photo)}
                </MenuItem>
              ))}
            </TextField>
          </Box>

          {isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress aria-label="Loading photos" />
            </Box>
          ) : error ? (
            <Alert severity="error">{error}</Alert>
          ) : tooFew ? (
            <Alert severity="info">
              {photos.length === 0
                ? `You have no ${poseLabel} photos yet. Add at least two ${poseLabel} photos to compare them.`
                : `You have one ${poseLabel} photo. Add another ${poseLabel} photo to compare them.`}
            </Alert>
          ) : before && after && before.id === after.id ? (
            <Alert severity="info">Pick two different photos to compare.</Alert>
          ) : before && after ? (
            <PhotoCompare before={before} after={after} />
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

export default CompareProgressPhotosDialog;
