/**
 * "Read from photo", issue #64 (E2.6): the entry point to the photo-read flow
 * (`PhotoReadDialog`), next to "Log measurement" on the Health page and at the
 * top of the quick-entry dialog.
 *
 * Rendered ONLY when `useCanReadFromPhoto()` holds (AI on, `ai:use`,
 * `intakes:write`, `storage:write`, `health_data:write`). Unlike
 * `LogMeasurementButton` it is never shown disabled: manual entry is the path
 * that must always exist, the photo path is an optional shortcut.
 */
import { Button, type ButtonProps } from '@mui/material';
import PhotoCameraOutlinedIcon from '@mui/icons-material/PhotoCameraOutlined';
import { useCanReadFromPhoto } from '../../hooks/useCanReadFromPhoto';

export const READ_FROM_PHOTO_LABEL = 'Read from photo';

interface PhotoReadButtonProps extends Omit<ButtonProps, 'onClick' | 'children'> {
  onClick: () => void;
}

export function PhotoReadButton({ onClick, variant = 'outlined', ...props }: PhotoReadButtonProps) {
  const available = useCanReadFromPhoto();
  if (!available) return null;
  return (
    <Button variant={variant} startIcon={<PhotoCameraOutlinedIcon />} onClick={onClick} {...props}>
      {READ_FROM_PHOTO_LABEL}
    </Button>
  );
}

export default PhotoReadButton;
