/**
 * One gym photo, full size (E3.3). The signed URL is fetched when the dialog
 * opens (`GET /api/storage/objects/:id/download`) and held in memory only; it
 * is a bearer credential for its lifetime. A photo whose object is gone shows
 * "This photo is missing" and can be removed. With `gyms:write` the caption
 * and the equipment it shows can be edited.
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { getStorageObjectDownloadUrl } from '../../services/storage';
import {
  PHOTO_CAPTION_MAX,
  gymErrorMessage,
  type GymEquipment,
  type GymPhoto,
  type PhotoUpdate,
} from '../../services/gyms';
import { useCompactDialog } from './useCompactDialog';

export interface GymPhotoLightboxProps {
  photo: GymPhoto | null;
  equipment: GymEquipment[];
  canWrite: boolean;
  onClose: () => void;
  onSave: (photoId: string, input: PhotoUpdate) => Promise<void>;
  onRemove: (photo: GymPhoto) => void;
}

export function GymPhotoLightbox({ photo, equipment, canWrite, onClose, onSave, onRemove }: GymPhotoLightboxProps) {
  const fullScreen = useCompactDialog();
  const open = photo !== null;
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [caption, setCaption] = useState('');
  const [linked, setLinked] = useState<GymEquipment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const storageObjectId = photo?.storageObjectId ?? null;

  useEffect(() => {
    setUrl(null);
    setMissing(false);
    if (!storageObjectId) return undefined;
    let cancelled = false;
    getStorageObjectDownloadUrl(storageObjectId)
      .then(({ url: signed }) => {
        if (!cancelled) setUrl(signed);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [storageObjectId]);

  useEffect(() => {
    if (!photo) return;
    setCaption(photo.caption ?? '');
    setLinked(equipment.filter((e) => photo.equipmentIds.includes(e.id)));
    setError(null);
  }, [photo, equipment]);

  const title = photo?.caption || 'Gym photo';
  const captionTooLong = caption.trim().length > PHOTO_CAPTION_MAX;

  const save = async () => {
    if (!photo || busy || captionTooLong) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(photo.id, {
        caption: caption.trim() === '' ? null : caption.trim(),
        equipmentIds: linked.map((e) => e.id),
      });
    } catch (err) {
      setError(gymErrorMessage(err, 'Could not save the photo'));
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
      maxWidth="md"
      aria-labelledby="gym-photo-title"
    >
      <DialogTitle id="gym-photo-title">{title}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {missing ? (
            <Alert severity="warning">This photo is missing. It may have been deleted elsewhere.</Alert>
          ) : url ? (
            <Box
              component="img"
              src={url}
              alt={title}
              onError={() => setMissing(true)}
              sx={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain', alignSelf: 'center' }}
            />
          ) : (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress aria-label="Loading photo" />
            </Box>
          )}
          {error && <Alert severity="error">{error}</Alert>}
          {canWrite ? (
            <>
              <TextField
                label="Caption"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                error={captionTooLong}
                helperText={captionTooLong ? `At most ${PHOTO_CAPTION_MAX} characters.` : undefined}
                fullWidth
              />
              {equipment.length > 0 && (
                <Autocomplete
                  multiple
                  options={equipment}
                  value={linked}
                  onChange={(_e, value) => setLinked(value)}
                  getOptionLabel={(option) => option.equipmentType.name}
                  isOptionEqualToValue={(a, b) => a.id === b.id}
                  renderInput={(params) => <TextField {...params} label="Equipment in this photo" />}
                />
              )}
            </>
          ) : (
            photo &&
            photo.equipmentIds.length > 0 && (
              <Typography variant="body2" color="text.secondary">
                Shows:{' '}
                {equipment
                  .filter((e) => photo.equipmentIds.includes(e.id))
                  .map((e) => e.equipmentType.name)
                  .join(', ')}
              </Typography>
            )
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        {canWrite && photo && (
          <Button color="error" onClick={() => onRemove(photo)} disabled={busy} sx={{ mr: 'auto' }}>
            Remove photo
          </Button>
        )}
        <Button onClick={onClose} disabled={busy}>
          Close
        </Button>
        {canWrite && (
          <Button variant="contained" onClick={() => void save()} disabled={busy || captionTooLong || missing}>
            Save
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

export default GymPhotoLightbox;
