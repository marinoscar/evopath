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
 *
 * #204: when object storage is known not to be configured (and the AI is
 * otherwise ready), "Storage isn't enabled yet" replaces the button: the
 * photo upload it leads to would fail. An unknown storage answer changes
 * nothing.
 */
import { Box, Button, Typography } from '@mui/material';
import { AddAPhotoOutlined as PhotoIcon } from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { useVisionAvailability } from '../../hooks/useVisionAvailability';
import { useStorageStatus } from '../../hooks/useStorageStatus';
import { FeatureUnavailableNotice } from '../common/FeatureUnavailableNotice';
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
  const availability = useVisionAvailability('workout_prefill');
  const storage = useStorageStatus();
  const reason = prefillAvailabilityReason(availability);
  if (reason === null && storage.configured === false) {
    return (
      <Box data-testid="prefill-from-photo">
        <FeatureUnavailableNotice feature="storage" />
      </Box>
    );
  }
  return <PrefillButtonView workoutId={workoutId} reason={reason} />;
}

export function PrefillButton({ workoutId }: { workoutId: string }) {
  const { hasPermission } = usePermissions();
  const permissionReason = prefillPermissionReason(hasPermission);
  if (permissionReason) return <PrefillButtonView workoutId={workoutId} reason={permissionReason} />;
  return <PrefillButtonWithAvailability workoutId={workoutId} />;
}

export default PrefillButton;
