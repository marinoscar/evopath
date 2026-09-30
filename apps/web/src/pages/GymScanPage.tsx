/**
 * "Scan gym" (`/gyms/:gymId/scan`, E3.4): photograph the room, let the AI
 * draft the equipment, review every item, then apply the accepted ones to the
 * gym. Built only from the photo-intake kit (`components/intake`); this page
 * supplies the `gym_equipment` renderers and the steps around it:
 *
 * 1. Photos: `ImageIntake` uploading into the intake, `AiVisionDisclosure`
 *    naming the provider, model and key, and **Scan**.
 * 2. Scanning: the queued `ai.equipment.scan` job runs; the page polls,
 *    shows how many photos in how many requests and the elapsed time, and
 *    offers **Cancel** (discards the intake).
 * 3. Review: `AiDraftReview` with every draft item (low-confidence and
 *    uncertain ones included, never hidden), **Apply to gym** (disabled while
 *    items are pending), **Scan again** (only untouched drafts are replaced).
 * 4. Apply: back to the gym with a summary.
 *
 * The steps themselves live in `components/gyms/GymScanFlow.tsx` (shared
 * with the hotel-gym step of the adjust-workout sheet, E6.2); this page
 * supplies the gates and where each outcome navigates to.
 *
 * The manual path is never blocked: without AI, a key, a vision model or a
 * permission the page says why and offers **Continue manually**, which opens
 * the equipment picker on the gym page. Every decision (ownership, the model
 * gate, the value schema, the merge into existing rows) is the API's.
 */
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { Alert, Box, Button, Container, Paper, Skeleton, Typography } from '@mui/material';
import { ArrowBack as BackIcon } from '@mui/icons-material';
import { usePermissions } from '../hooks/usePermissions';
import { useGym } from '../hooks/useGym';
import { useVisionAvailability } from '../hooks/useVisionAvailability';
import { NoVisionModelNotice } from '../components/intake';
import { GymScanFlow } from '../components/gyms/GymScanFlow';
import { scanPermissionReason } from '../components/gyms/scanAvailability';
import { GYMS_UNAVAILABLE } from '../services/gyms';
import { applySummary, type GymDetailLocationState } from '../services/gymScan';

/** Gate on the AI being able to read photos; the manual path stays one click away. */
function ScanGate({ gymId, onManual }: { gymId: string; onManual: () => void }) {
  const navigate = useNavigate();
  const availability = useVisionAvailability();
  if (availability.status !== 'ready') {
    return <NoVisionModelNotice reason={availability.status} onManual={onManual} />;
  }
  return (
    <GymScanFlow
      gymId={gymId}
      availability={availability}
      onManual={onManual}
      onApplied={(result) => {
        const state: GymDetailLocationState = { flash: applySummary(result) };
        navigate(`/gyms/${encodeURIComponent(result.gymId)}`, { state });
      }}
      onDiscarded={() => navigate(`/gyms/${encodeURIComponent(gymId)}`)}
    />
  );
}

function GymScan({ gymId }: { gymId: string }) {
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const g = useGym(gymId);
  const permissionReason = scanPermissionReason(hasPermission);
  const canWrite = hasPermission('gyms:write');

  const onManual = () => {
    const state: GymDetailLocationState = { openPicker: true };
    navigate(`/gyms/${encodeURIComponent(gymId)}`, { state });
  };

  if (g.notFound) {
    return (
      <Alert
        severity="warning"
        action={
          <Button color="inherit" size="small" component={RouterLink} to="/gyms">
            All gyms
          </Button>
        }
      >
        This gym does not exist or was deleted.
      </Alert>
    );
  }
  if (!g.gym) {
    if (g.error && !g.isLoading) {
      return (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void g.refresh()}>
              Retry
            </Button>
          }
        >
          Could not load this gym. {g.error}
        </Alert>
      );
    }
    return <Skeleton variant="rounded" height={200} data-testid="gym-scan-loading" />;
  }

  return (
    <>
      <Typography color="text.secondary" sx={{ mb: 3, overflowWrap: 'anywhere' }}>
        {g.gym.name}: photograph the room and let AI draft the equipment list. You review everything before it is
        saved.
      </Typography>
      {permissionReason ? (
        <Alert severity="info" data-testid="gym-scan-permission">
          <Box sx={{ mb: canWrite ? 1 : 0 }}>{permissionReason}</Box>
          {canWrite && (
            <Button variant="contained" size="small" onClick={onManual}>
              Continue manually
            </Button>
          )}
        </Alert>
      ) : (
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
          <ScanGate gymId={gymId} onManual={onManual} />
        </Paper>
      )}
    </>
  );
}

export default function GymScanPage() {
  const { gymId } = useParams<{ gymId: string }>();
  const { hasPermission } = usePermissions();
  const canRead = hasPermission('gyms:read');

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Button
          component={RouterLink}
          to={gymId ? `/gyms/${encodeURIComponent(gymId)}` : '/gyms'}
          startIcon={<BackIcon />}
          sx={{ mb: 2 }}
        >
          Back to gym
        </Button>
        <Typography variant="h4" component="h1" gutterBottom>
          Scan gym
        </Typography>
        {canRead && gymId ? <GymScan gymId={gymId} /> : <Alert severity="info">{GYMS_UNAVAILABLE}</Alert>}
      </Box>
    </Container>
  );
}
