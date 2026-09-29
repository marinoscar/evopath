/**
 * "Prefill from photo" on the workout page (E4.5): a secondary way to add
 * exercises and their written sets from a photo (machine placard, notebook,
 * whiteboard), next to the manual "Add exercise".
 *
 * When the prefill cannot run, the button stays visible but disabled, with
 * the reason written under it (AI off, no key, no vision model, or a missing
 * permission). The AI availability is only asked for when the caller holds
 * every permission the prefill needs, so a viewer causes no AI request at
 * all. Manual logging never depends on this button.
 */
import { Box, Button, Typography } from '@mui/material';
import { AddAPhotoOutlined as PhotoIcon } from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { useVisionAvailability } from '../../hooks/useVisionAvailability';
import { prefillAvailabilityReason, prefillPermissionReason } from './prefillAvailability';

const REASON_ID = 'prefill-from-photo-reason';

export const PREFILL_BUTTON_LABEL = 'Prefill from photo';

export function prefillPath(workoutId: string): string {
  return `/train/workouts/${encodeURIComponent(workoutId)}/prefill`;
}

function PrefillButtonView({ workoutId, reason }: { workoutId: string; reason: string | null }) {
  const enabled = reason === null;
  const sx = { minHeight: 44 };
  return (
    <Box
      data-testid="prefill-from-photo"
      sx={{ display: 'flex', flexDirection: 'column', alignItems: { xs: 'stretch', sm: 'flex-start' }, gap: 0.5 }}
    >
      {enabled ? (
        <Button component={RouterLink} to={prefillPath(workoutId)} variant="text" startIcon={<PhotoIcon />} sx={sx}>
          {PREFILL_BUTTON_LABEL}
        </Button>
      ) : (
        <Button variant="text" startIcon={<PhotoIcon />} disabled aria-describedby={REASON_ID} sx={sx}>
          {PREFILL_BUTTON_LABEL}
        </Button>
      )}
      {reason && (
        <Typography id={REASON_ID} variant="caption" color="text.secondary">
          {reason}
        </Typography>
      )}
    </Box>
  );
}

function PrefillButtonWithAvailability({ workoutId }: { workoutId: string }) {
  const availability = useVisionAvailability();
  return <PrefillButtonView workoutId={workoutId} reason={prefillAvailabilityReason(availability.status)} />;
}

export function PrefillButton({ workoutId }: { workoutId: string }) {
  const { hasPermission } = usePermissions();
  const permissionReason = prefillPermissionReason(hasPermission);
  if (permissionReason) return <PrefillButtonView workoutId={workoutId} reason={permissionReason} />;
  return <PrefillButtonWithAvailability workoutId={workoutId} />;
}

export default PrefillButton;
