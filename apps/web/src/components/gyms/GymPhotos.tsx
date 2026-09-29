/**
 * A gym's photos (E3.3): a grid of thumbnails that open the lightbox, and
 * **Add photos**. Uploading needs `storage:write`: the bytes go to
 * `POST /api/storage/objects`, never through the gyms API. Without it the
 * button is not rendered and a note says why (the viewer role).
 *
 * Client-side, a non-image or a file over 20 MiB is refused with the reason;
 * a large image is downscaled first (which also strips EXIF, including GPS).
 */
import { useRef, useState, type ChangeEvent } from 'react';
import { Alert, Box, Button, ButtonBase, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import { AddPhotoAlternate as AddPhotoIcon, DeleteOutlined as DeleteIcon } from '@mui/icons-material';
import { StoragePhotoThumb } from '../intake/StoragePhotoThumb';
import { downscaleImage, UnsupportedImageError } from '../../utils/downscaleImage';
import {
  GYM_PHOTOS_MAX,
  PHOTOS_UNAVAILABLE,
  gymErrorMessage,
  gymPhotoRejection,
  gymPhotoTypeRejection,
  type GymPhoto,
} from '../../services/gyms';

export interface GymPhotosProps {
  photos: GymPhoto[];
  /** `gyms:write`: may attach, edit and remove. */
  canWrite: boolean;
  /** `storage:write`: may upload a file at all. */
  canUpload: boolean;
  onAdd: (file: File) => Promise<unknown>;
  onOpen: (photo: GymPhoto) => void;
  onRemove: (photo: GymPhoto) => void;
}

const THUMB_SIZE = 112;

/** Downscale when the browser can decode; otherwise upload the file as is. */
async function prepare(file: File): Promise<File> {
  if (typeof createImageBitmap !== 'function') return file;
  return downscaleImage(file);
}

export function GymPhotos({ photos, canWrite, canUpload, onAdd, onOpen, onRemove }: GymPhotosProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const uploading = progress !== null;
  const remaining = GYM_PHOTOS_MAX - photos.length;

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    const problems: string[] = [];
    const accepted: File[] = [];
    for (const file of files) {
      const reason = gymPhotoRejection(file);
      if (reason) problems.push(reason);
      else accepted.push(file);
    }
    if (accepted.length > remaining) {
      problems.push(`A gym holds at most ${GYM_PHOTOS_MAX} photos; ${accepted.length - remaining} were not added.`);
      accepted.splice(Math.max(0, remaining));
    }
    setErrors(problems);
    if (accepted.length === 0) return;
    setProgress({ done: 0, total: accepted.length });
    for (const [index, file] of accepted.entries()) {
      try {
        const prepared = await prepare(file);
        const typeProblem = gymPhotoTypeRejection(prepared);
        if (typeProblem) {
          problems.push(typeProblem);
          setErrors([...problems]);
        } else {
          await onAdd(prepared);
        }
      } catch (err) {
        problems.push(
          err instanceof UnsupportedImageError
            ? err.message
            : `${file.name}: ${gymErrorMessage(err, 'could not be added')}`,
        );
        setErrors([...problems]);
      }
      setProgress({ done: index + 1, total: accepted.length });
    }
    setProgress(null);
  };

  return (
    <Stack spacing={2}>
      {canWrite && canUpload && (
        <Box>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            data-testid="gym-photo-input"
            onChange={(e) => void handleFiles(e)}
          />
          <Button
            variant="outlined"
            startIcon={<AddPhotoIcon />}
            onClick={() => inputRef.current?.click()}
            disabled={uploading || remaining <= 0}
          >
            Add photos
          </Button>
        </Box>
      )}
      {canWrite && !canUpload && <Alert severity="info">{PHOTOS_UNAVAILABLE}</Alert>}
      {progress && (
        <Typography role="status" color="text.secondary">
          Uploading {Math.min(progress.done + 1, progress.total)} of {progress.total}…
        </Typography>
      )}
      {errors.map((message) => (
        <Alert key={message} severity="error" onClose={() => setErrors((prev) => prev.filter((m) => m !== message))}>
          {message}
        </Alert>
      ))}
      {photos.length === 0 ? (
        <Typography color="text.secondary">No photos yet.</Typography>
      ) : (
        <Box
          component="ul"
          aria-label="Gym photos"
          sx={{
            listStyle: 'none',
            p: 0,
            m: 0,
            display: 'grid',
            gap: 1.5,
            gridTemplateColumns: `repeat(auto-fill, minmax(${THUMB_SIZE}px, 1fr))`,
          }}
        >
          {photos.map((photo, index) => {
            const name = photo.caption || `Photo ${index + 1}`;
            return (
              <Box component="li" key={photo.id} sx={{ position: 'relative', width: THUMB_SIZE }}>
                <ButtonBase
                  onClick={() => onOpen(photo)}
                  aria-label={`Open ${name}`}
                  sx={{ borderRadius: 1, display: 'block' }}
                >
                  <StoragePhotoThumb storageObjectId={photo.storageObjectId} name={name} size={THUMB_SIZE} />
                </ButtonBase>
                {canWrite && (
                  <Tooltip title="Remove photo">
                    <IconButton
                      size="small"
                      aria-label={`Remove ${name}`}
                      onClick={() => onRemove(photo)}
                      sx={{
                        position: 'absolute',
                        top: 4,
                        right: 4,
                        bgcolor: 'background.paper',
                        '&:hover': { bgcolor: 'background.paper' },
                      }}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Stack>
  );
}

export default GymPhotos;
