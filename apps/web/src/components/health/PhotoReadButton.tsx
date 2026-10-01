/**
 * "Read from photo", issue #64 (E2.6): the entry point to the photo-read flow
 * (`PhotoReadDialog`), next to "Log measurement" on the Health page and at the
 * top of the quick-entry dialog.
 *
 * Rendered ONLY when `useCanReadFromPhoto()` holds (AI on, `ai:use`,
 * `intakes:write`, `storage:write`, `health_data:write`). Unlike
 * `LogMeasurementButton` it is never shown disabled by default: manual entry
 * is the path that must always exist, the photo path is an optional shortcut.
 *
 * `showUnavailable` (#204, the Health page's primary entry point only): when
 * the caller holds every permission but a deployment feature is known to be
 * off — AI (the shell's answer, never the fail-closed "unknown") or object
 * storage (`GET /api/storage/status` said `configured: false`; the photos and
 * any kept health document are storage objects) — the button stays visible,
 * disabled, with the reason written under it, like Scan gym and Prefill from
 * photo. An unknown answer shows nothing, as before.
 */
import { useContext, useId } from 'react';
import { Box, Button, Typography, type ButtonProps } from '@mui/material';
import PhotoCameraOutlinedIcon from '@mui/icons-material/PhotoCameraOutlined';
import { PHOTO_READ_PERMISSIONS, useCanReadFromPhoto } from '../../hooks/useCanReadFromPhoto';
import { AiConfigContext } from '../../hooks/useAiConfig';
import { usePermissions } from '../../hooks/usePermissions';
import { useStorageStatus } from '../../hooks/useStorageStatus';
import { featureUnavailableTitle } from '../common/FeatureUnavailableNotice';

export const READ_FROM_PHOTO_LABEL = 'Read from photo';

interface PhotoReadButtonProps extends Omit<ButtonProps, 'onClick' | 'children'> {
  onClick: () => void;
  /** Show the button disabled, with the reason, when AI or storage is known to be off (#204). */
  showUnavailable?: boolean;
}

function UnavailablePhotoRead({ reason, variant }: { reason: string; variant: ButtonProps['variant'] }) {
  const reasonId = useId();
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Button variant={variant} startIcon={<PhotoCameraOutlinedIcon />} disabled aria-describedby={reasonId}>
        {READ_FROM_PHOTO_LABEL}
      </Button>
      <Typography id={reasonId} variant="caption" color="text.secondary">
        {reason}.
      </Typography>
    </Box>
  );
}

/** The storage check, mounted only once AI is known on, so no other state requests it. */
function PhotoReadWithStorage({ onClick, variant, ...props }: PhotoReadButtonProps) {
  const { configured } = useStorageStatus();
  if (configured === false) return <UnavailablePhotoRead reason={featureUnavailableTitle('storage')} variant={variant} />;
  return (
    <Button variant={variant} startIcon={<PhotoCameraOutlinedIcon />} onClick={onClick} {...props}>
      {READ_FROM_PHOTO_LABEL}
    </Button>
  );
}

export function PhotoReadButton({ onClick, variant = 'outlined', showUnavailable = false, ...props }: PhotoReadButtonProps) {
  const available = useCanReadFromPhoto();
  const { hasPermission } = usePermissions();
  const shell = useContext(AiConfigContext);

  if (!available) {
    const aiKnownOff = shell !== null && !shell.isLoading && !shell.config.enabled;
    if (showUnavailable && aiKnownOff && PHOTO_READ_PERMISSIONS.every((p) => hasPermission(p))) {
      return <UnavailablePhotoRead reason={featureUnavailableTitle('ai')} variant={variant} />;
    }
    return null;
  }
  if (showUnavailable) return <PhotoReadWithStorage onClick={onClick} variant={variant} {...props} />;
  return (
    <Button variant={variant} startIcon={<PhotoCameraOutlinedIcon />} onClick={onClick} {...props}>
      {READ_FROM_PHOTO_LABEL}
    </Button>
  );
}

export default PhotoReadButton;
