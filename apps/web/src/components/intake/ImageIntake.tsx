/**
 * Pick, capture or drop several photos; each shows its own stage — the view
 * over `useImageIntake` (which owns the queue, the downscale and the upload).
 *
 * - "Add photos" opens the file picker (`accept="image/*" multiple`).
 * - "Take photo" is a file input with `capture="environment"`: the OS opens
 *   the camera, so no `getUserMedia` and no Permissions-Policy change.
 * - Drag and drop works on the whole area (desktop).
 * - The grid is 2 columns below `sm` and 4 from `sm` up.
 * - Progress is a stage chip per tile and an aggregate "3 of 8 ready" —
 *   never a percentage (the transport has no upload progress).
 * - Stage changes are announced through an `aria-live="polite"` region.
 *
 * Uploading needs `storage:write`; without it (a viewer) the controls are
 * disabled with the reason instead of failing on click. The API enforces it.
 */
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { Alert, Box, Button, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import {
  AddPhotoAlternateOutlined as AddIcon,
  Close as CloseIcon,
  PhotoCameraOutlined as CameraIcon,
  Refresh as RetryIcon,
} from '@mui/icons-material';
import type { IntakePhotoStage, IntakePhotoState, UseImageIntakeReturn } from '../../hooks/useImageIntake';
import { usePermissions } from '../../hooks/usePermissions';
import { StoragePhotoThumb } from './StoragePhotoThumb';

export const STAGE_LABEL: Record<IntakePhotoStage, string> = {
  queued: 'Waiting',
  downscaling: 'Shrinking',
  uploading: 'Uploading',
  processing: 'Processing',
  ready: 'Ready',
  error: 'Failed',
};

const STAGE_COLOR: Record<IntakePhotoStage, 'default' | 'info' | 'success' | 'error'> = {
  queued: 'default',
  downscaling: 'info',
  uploading: 'info',
  processing: 'info',
  ready: 'success',
  error: 'error',
};

const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

export interface ImageIntakeProps {
  state: UseImageIntakeReturn;
  /** Defaults to the hook's own limit. */
  maxPhotos?: number;
  disabled?: boolean;
  helperText?: string;
}

function PhotoTile({
  item,
  disabled,
  onRemove,
  onRetry,
}: {
  item: IntakePhotoState;
  disabled: boolean;
  onRemove: () => void;
  onRetry: () => void;
}) {
  return (
    <Box
      data-testid="intake-photo-tile"
      data-stage={item.stage}
      sx={{
        position: 'relative',
        borderRadius: 1,
        overflow: 'hidden',
        border: 1,
        borderColor: item.stage === 'error' ? 'error.main' : 'divider',
        bgcolor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box sx={{ aspectRatio: '1 / 1', bgcolor: 'action.hover', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {item.previewUrl ? (
          <Box
            component="img"
            src={item.previewUrl}
            alt={item.name}
            sx={{ width: '100%', height: '100%', objectFit: 'cover', opacity: item.stage === 'ready' ? 1 : 0.7 }}
          />
        ) : item.storageObjectId ? (
          <StoragePhotoThumb storageObjectId={item.storageObjectId} name={item.name} size={120} />
        ) : null}
      </Box>
      <Tooltip title={`Remove ${item.name}`}>
        <span style={{ position: 'absolute', top: 4, right: 4 }}>
          <IconButton
            size="small"
            aria-label={`Remove ${item.name}`}
            onClick={onRemove}
            disabled={disabled}
            sx={{ bgcolor: 'background.paper', '&:hover': { bgcolor: 'background.paper' } }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Box sx={{ p: 1, display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 0 }}>
        <Typography variant="caption" noWrap title={item.name}>
          {item.name}
        </Typography>
        <Box>
          <Chip size="small" label={STAGE_LABEL[item.stage]} color={STAGE_COLOR[item.stage]} variant="outlined" />
        </Box>
        {item.stage === 'error' && (
          <>
            <Typography variant="caption" color="error" sx={{ wordBreak: 'break-word' }}>
              {item.error ?? 'Upload failed'}
            </Typography>
            <Button
              size="small"
              startIcon={<RetryIcon />}
              onClick={onRetry}
              disabled={disabled}
              aria-label={`Retry ${item.name}`}
              sx={{ alignSelf: 'flex-start' }}
            >
              Retry
            </Button>
          </>
        )}
      </Box>
    </Box>
  );
}

export function ImageIntake({ state, maxPhotos, disabled = false, helperText }: ImageIntakeProps) {
  const { hasPermission } = usePermissions();
  const canUpload = hasPermission('storage:write');
  const limit = maxPhotos ?? state.maxPhotos;
  const full = state.items.length >= limit;
  const addDisabled = disabled || !canUpload || full;
  const [dragging, setDragging] = useState(false);

  // Announce each tile's stage change once, politely.
  const [announcement, setAnnouncement] = useState('');
  const stages = useRef(new Map<string, IntakePhotoStage>());
  useEffect(() => {
    const changes: string[] = [];
    const seen = new Set<string>();
    for (const item of state.items) {
      seen.add(item.key);
      if (stages.current.get(item.key) !== item.stage) {
        stages.current.set(item.key, item.stage);
        changes.push(`${item.name}: ${STAGE_LABEL[item.stage]}`);
      }
    }
    for (const key of [...stages.current.keys()]) if (!seen.has(key)) stages.current.delete(key);
    if (changes.length) setAnnouncement(changes.join('. '));
  }, [state.items]);

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    // Let the same file be chosen again after it is removed.
    event.target.value = '';
    if (files.length) state.addFiles(files);
  };

  const onDragOver = (event: DragEvent) => {
    if (addDisabled) return;
    event.preventDefault();
    setDragging(true);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (addDisabled) return;
    const files = event.dataTransfer?.files;
    if (files && files.length) state.addFiles(files);
  };

  const total = state.items.length;

  return (
    <Box
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      data-testid="image-intake"
      sx={{
        border: 2,
        borderStyle: 'dashed',
        borderColor: dragging ? 'primary.main' : 'divider',
        borderRadius: 2,
        p: { xs: 1.5, sm: 2 },
        bgcolor: dragging ? 'action.hover' : 'transparent',
      }}
    >
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 1.5 }}>
        <Button component="label" variant="contained" startIcon={<AddIcon />} disabled={addDisabled}>
          Add photos
          <input hidden multiple type="file" accept="image/*" aria-label="Add photos" onChange={onChange} disabled={addDisabled} />
        </Button>
        <Button component="label" variant="outlined" startIcon={<CameraIcon />} disabled={addDisabled}>
          Take photo
          <input
            hidden
            type="file"
            accept="image/*"
            capture="environment"
            aria-label="Take photo"
            onChange={onChange}
            disabled={addDisabled}
          />
        </Button>
      </Stack>

      {!canUpload ? (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          Your role cannot upload photos. Ask an administrator for upload access.
        </Alert>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          {helperText ?? `Add up to ${limit} photos, or drop them here.`}
        </Typography>
      )}

      {state.notice && (
        <Alert severity="warning" onClose={state.clearNotice} sx={{ mb: 1.5 }}>
          {state.notice}
        </Alert>
      )}

      {total > 0 && (
        <Typography variant="body2" sx={{ mb: 1 }} data-testid="image-intake-progress">
          {state.readyCount} of {total} ready{full ? ` (limit ${limit})` : ''}
        </Typography>
      )}

      <Box
        role="list"
        aria-label="Photos"
        sx={{
          display: 'grid',
          gap: 1,
          gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' },
        }}
      >
        {state.items.map((item) => (
          <Box role="listitem" key={item.key}>
            <PhotoTile
              item={item}
              disabled={disabled}
              onRemove={() => void state.remove(item.key)}
              onRetry={() => state.retry(item.key)}
            />
          </Box>
        ))}
      </Box>

      <Box aria-live="polite" role="status" sx={visuallyHidden}>
        {announcement}
      </Box>
    </Box>
  );
}

export default ImageIntake;
