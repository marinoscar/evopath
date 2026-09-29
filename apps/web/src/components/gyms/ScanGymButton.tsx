/**
 * "Scan gym" on the gym page (E3.4): a secondary way to fill the equipment
 * list from photos, next to the manual "Add equipment".
 *
 * When the scan cannot run, the button stays visible but disabled, with the
 * reason written under it (AI off, no key, no vision model, or a missing
 * permission). The AI availability is only asked for when the caller holds
 * every permission the scan needs, so a viewer causes no AI request at all.
 */
import { Box, Button, Typography } from '@mui/material';
import { DocumentScannerOutlined as ScanIcon } from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { useVisionAvailability } from '../../hooks/useVisionAvailability';
import { scanAvailabilityReason, scanPermissionReason } from './scanAvailability';

const REASON_ID = 'scan-gym-reason';

function ScanButtonView({ gymId, reason }: { gymId: string; reason: string | null }) {
  const enabled = reason === null;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: { xs: 'stretch', sm: 'flex-end' }, gap: 0.5, maxWidth: { sm: 280 } }}>
      {enabled ? (
        <Button component={RouterLink} to={`/gyms/${encodeURIComponent(gymId)}/scan`} variant="outlined" startIcon={<ScanIcon />}>
          Scan gym
        </Button>
      ) : (
        <Button variant="outlined" startIcon={<ScanIcon />} disabled aria-describedby={REASON_ID}>
          Scan gym
        </Button>
      )}
      {reason && (
        <Typography id={REASON_ID} variant="caption" color="text.secondary" sx={{ textAlign: { xs: 'left', sm: 'right' } }}>
          {reason}
        </Typography>
      )}
    </Box>
  );
}

function ScanButtonWithAvailability({ gymId }: { gymId: string }) {
  const availability = useVisionAvailability();
  return <ScanButtonView gymId={gymId} reason={scanAvailabilityReason(availability.status)} />;
}

export function ScanGymButton({ gymId }: { gymId: string }) {
  const { hasPermission } = usePermissions();
  const permissionReason = scanPermissionReason(hasPermission);
  if (permissionReason) return <ScanButtonView gymId={gymId} reason={permissionReason} />;
  return <ScanButtonWithAvailability gymId={gymId} />;
}

export default ScanGymButton;
