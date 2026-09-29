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
 * The manual path is never blocked: without AI, a key, a vision model or a
 * permission the page says why and offers **Continue manually**, which opens
 * the equipment picker on the gym page. Every decision (ownership, the model
 * gate, the value schema, the merge into existing rows) is the API's.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Container,
  LinearProgress,
  Paper,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material';
import { ArrowBack as BackIcon } from '@mui/icons-material';
import { usePermissions } from '../hooks/usePermissions';
import { useGym } from '../hooks/useGym';
import { useVisionAvailability, type UseVisionAvailabilityReturn } from '../hooks/useVisionAvailability';
import { useGymScanIntake } from '../hooks/useGymScanIntake';
import {
  AiDraftReview,
  AiVisionDisclosure,
  ImageIntake,
  NoVisionModelNotice,
  detachFrom,
  uploadAndAttach,
  useImageIntake,
  usePhotoIntake,
  visionRequestCount,
  type UsePhotoIntakeReturn,
} from '../components/intake';
import { AiErrorAlert } from '../components/ai/AiErrorAlert';
import { ConfirmDialog } from '../components/gyms/ConfirmDialog';
import { EquipmentDraftValue } from '../components/gyms/EquipmentDraftValue';
import { EquipmentDraftEditor } from '../components/gyms/EquipmentDraftEditor';
import { scanPermissionReason } from '../components/gyms/scanAvailability';
import { GYMS_UNAVAILABLE } from '../services/gyms';
import {
  EMPTY_EQUIPMENT_VALUE,
  EQUIPMENT_DRAFT_ITEM_KIND,
  GYM_SCAN_MAX_PHOTOS,
  SCAN_PHOTOS_HELPER,
  applySummary,
  formatElapsed,
  failedChunkRange,
  scanResultMeta,
  type EquipmentValue,
  type GymDetailLocationState,
  type GymEquipmentApplyResult,
  type GymScanContext,
} from '../services/gymScan';

type ScanIntake = UsePhotoIntakeReturn<EquipmentValue, GymScanContext>;

function ScanningStep({
  photoCount,
  startedAt,
  onCancel,
  busy,
}: {
  photoCount: number;
  startedAt: number;
  onCancel: () => void;
  busy: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const requests = visionRequestCount(photoCount);

  return (
    <Stack spacing={2} data-testid="gym-scan-scanning">
      <Typography variant="h6" component="h2">
        Scanning
      </Typography>
      <LinearProgress aria-label="Scanning photos" />
      <Typography role="status" aria-live="polite">
        Analyzing {photoCount} {photoCount === 1 ? 'photo' : 'photos'} in {requests}{' '}
        {requests === 1 ? 'request' : 'requests'}.
      </Typography>
      <Typography variant="body2" color="text.secondary" data-testid="gym-scan-elapsed">
        Elapsed {formatElapsed(now - startedAt)}
      </Typography>
      <Box>
        <Button color="inherit" variant="outlined" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </Box>
    </Stack>
  );
}

function ReviewStep({
  intake,
  onApply,
  onScanAgain,
  onAddPhotos,
  onDiscard,
  canRescan,
}: {
  intake: ScanIntake;
  onApply: () => void;
  onScanAgain: () => void;
  onAddPhotos: () => void;
  onDiscard: () => void;
  canRescan: boolean;
}) {
  const meta = scanResultMeta(intake.intake);
  const photoCount = meta.photoCount ?? intake.photos.length;
  const pending = intake.items.filter((item) => item.status === 'pending').length;
  const busy = intake.isMutating;

  return (
    <Stack spacing={2} data-testid="gym-scan-review">
      <Typography variant="h6" component="h2">
        Review what the AI found
      </Typography>
      <Typography variant="body2" color="text.secondary">
        These are guesses. Accept, edit or reject each item, and add anything that is missing. Nothing is saved to
        the gym until you apply.
      </Typography>

      {(meta.failedChunks ?? []).map((chunk) => (
        <Alert
          key={chunk.index}
          severity="warning"
          data-testid="gym-scan-failed-chunk"
          action={
            <Button color="inherit" size="small" onClick={onScanAgain} disabled={busy || !canRescan}>
              Try again
            </Button>
          }
        >
          {failedChunkRange(chunk, photoCount)} could not be analyzed.
        </Alert>
      ))}

      <AiDraftReview<EquipmentValue>
        items={intake.items}
        photos={intake.photos}
        renderValue={(item) => <EquipmentDraftValue value={item.value} />}
        renderEditor={(props) => <EquipmentDraftEditor {...props} />}
        emptyValue={EMPTY_EQUIPMENT_VALUE}
        busy={busy}
        onAcceptItem={(id) => void intake.acceptItem(id)}
        onRejectItem={(id) => void intake.rejectItem(id)}
        onRestoreItem={(id) => void intake.restoreItem(id)}
        onEditItem={(id, value) => void intake.editItem(id, value)}
        onAddItem={(value) => void intake.addItem(EQUIPMENT_DRAFT_ITEM_KIND, value)}
        onAcceptAll={() => void intake.acceptAll()}
      />

      <Box>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Button
            variant="contained"
            onClick={onApply}
            disabled={busy || pending > 0}
            aria-describedby={pending > 0 ? 'gym-scan-pending' : undefined}
          >
            Apply to gym
          </Button>
          <Button variant="outlined" onClick={onScanAgain} disabled={busy || !canRescan}>
            Scan again
          </Button>
          <Button onClick={onAddPhotos} disabled={busy}>
            Add photos
          </Button>
          <Button color="error" onClick={onDiscard} disabled={busy}>
            Discard scan
          </Button>
        </Stack>
        {pending > 0 && (
          <Typography id="gym-scan-pending" variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {pending} {pending === 1 ? 'item is' : 'items are'} still waiting for review. Accept or reject{' '}
            {pending === 1 ? 'it' : 'each'} before applying.
          </Typography>
        )}
      </Box>
    </Stack>
  );
}

/** The steps of one intake, once it is loaded. */
function ScanSteps({
  gymId,
  intakeId,
  intake,
  availability,
  onManual,
}: {
  gymId: string;
  intakeId: string;
  intake: ScanIntake;
  availability: UseVisionAvailabilityReturn;
  onManual: () => void;
}) {
  const navigate = useNavigate();
  const [initialPhotos] = useState(() =>
    intake.photos.map((photo) => ({ storageObjectId: photo.storageObjectId, name: photo.name })),
  );
  const uploadPhoto = useMemo(() => uploadAndAttach(intakeId), [intakeId]);
  const removePhoto = useMemo(() => detachFrom(intakeId), [intakeId]);
  const photos = useImageIntake({ maxPhotos: GYM_SCAN_MAX_PHOTOS, uploadPhoto, removePhoto, initialPhotos });
  const [addingPhotos, setAddingPhotos] = useState(false);
  const [scanStartedAt, setScanStartedAt] = useState<number | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const status = intake.intake?.status ?? 'draft';
  const selected = availability.selected;
  const photoCount = Math.max(intake.photos.length, photos.readyCount);

  const scan = async () => {
    if (!selected) return;
    setScanStartedAt(Date.now());
    const started = await intake.analyze({ provider: selected.provider, modelId: selected.modelId });
    if (started) setAddingPhotos(false);
  };

  const apply = async () => {
    const result = await intake.apply<GymEquipmentApplyResult>();
    if (!result) return;
    const state: GymDetailLocationState = { flash: applySummary(result) };
    navigate(`/gyms/${encodeURIComponent(result.gymId || gymId)}`, { state });
  };

  const discard = async () => {
    const ok = await intake.discard();
    setConfirmDiscard(false);
    if (ok) navigate(`/gyms/${encodeURIComponent(gymId)}`);
  };

  let body;
  if (status === 'scanning') {
    const startedAt = scanStartedAt ?? (intake.intake ? Date.parse(intake.intake.updatedAt) : Date.now());
    body = (
      <ScanningStep
        photoCount={photoCount}
        startedAt={Number.isFinite(startedAt) ? startedAt : Date.now()}
        onCancel={() => setConfirmDiscard(true)}
        busy={intake.isMutating}
      />
    );
  } else if (status === 'failed') {
    body = (
      <Stack spacing={2} data-testid="gym-scan-failed">
        {intake.scanError && <AiErrorAlert error={intake.scanError} />}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button variant="contained" onClick={() => void scan()} disabled={intake.isMutating || !selected}>
            Try again
          </Button>
          <Button variant="outlined" onClick={onManual}>
            Continue manually
          </Button>
          <Button color="error" onClick={() => setConfirmDiscard(true)} disabled={intake.isMutating}>
            Discard scan
          </Button>
        </Stack>
      </Stack>
    );
  } else if (status === 'ready' && !addingPhotos) {
    body = (
      <ReviewStep
        intake={intake}
        onApply={() => void apply()}
        onScanAgain={() => void scan()}
        onAddPhotos={() => setAddingPhotos(true)}
        onDiscard={() => setConfirmDiscard(true)}
        canRescan={selected !== null}
      />
    );
  } else if (status === 'applied') {
    body = (
      <Alert
        severity="success"
        action={
          <Button color="inherit" size="small" component={RouterLink} to={`/gyms/${encodeURIComponent(gymId)}`}>
            Open gym
          </Button>
        }
      >
        This scan was already applied to the gym.
      </Alert>
    );
  } else {
    const canScan = photos.readyCount > 0 && !photos.busy && selected !== null && !intake.isMutating;
    body = (
      <Stack spacing={2} data-testid="gym-scan-photos">
        <Typography variant="h6" component="h2">
          Photos
        </Typography>
        <ImageIntake state={photos} maxPhotos={GYM_SCAN_MAX_PHOTOS} helperText={SCAN_PHOTOS_HELPER} />
        <Alert severity="info">
          <AlertTitle>Includes people?</AlertTitle>
          Photos are sent to your AI provider. Avoid capturing people.
        </Alert>
        <AiVisionDisclosure availability={availability} photoCount={photos.readyCount} onManual={onManual} />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button variant="contained" onClick={() => void scan()} disabled={!canScan}>
            Scan
          </Button>
          {status === 'ready' && (
            <Button onClick={() => setAddingPhotos(false)} disabled={photos.busy}>
              Back to review
            </Button>
          )}
          <Button onClick={onManual}>Continue manually</Button>
        </Stack>
      </Stack>
    );
  }

  return (
    <>
      {intake.error && (
        <Box sx={{ mb: 2 }}>
          <AiErrorAlert error={intake.error} onClose={intake.clearError} />
        </Box>
      )}
      {body}
      <ConfirmDialog
        open={confirmDiscard}
        title={status === 'scanning' ? 'Cancel the scan?' : 'Discard this scan?'}
        message="The photos and the draft are discarded. Nothing is added to the gym."
        confirmLabel="Discard"
        onClose={() => setConfirmDiscard(false)}
        onConfirm={discard}
      />
    </>
  );
}

function ScanIntakeLoader({
  gymId,
  intakeId,
  availability,
  onManual,
  onRestart,
}: {
  gymId: string;
  intakeId: string;
  availability: UseVisionAvailabilityReturn;
  onManual: () => void;
  onRestart: () => void;
}) {
  const intake = usePhotoIntake<EquipmentValue, GymScanContext>(intakeId);
  if (!intake.intake) {
    if (intake.error && !intake.isLoading) {
      return (
        <Stack spacing={2}>
          <AiErrorAlert error={intake.error} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Button variant="contained" onClick={onRestart}>
              Start a new scan
            </Button>
            <Button variant="outlined" onClick={onManual}>
              Continue manually
            </Button>
          </Stack>
        </Stack>
      );
    }
    return <Skeleton variant="rounded" height={200} data-testid="gym-scan-loading" />;
  }
  return <ScanSteps gymId={gymId} intakeId={intakeId} intake={intake} availability={availability} onManual={onManual} />;
}

function ScanWithIntake({
  gymId,
  availability,
  onManual,
}: {
  gymId: string;
  availability: UseVisionAvailabilityReturn;
  onManual: () => void;
}) {
  const scan = useGymScanIntake(gymId, true);
  if (scan.error) {
    return (
      <Stack spacing={2}>
        <AiErrorAlert error={scan.error} />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button variant="contained" onClick={scan.retry}>
            Try again
          </Button>
          <Button variant="outlined" onClick={onManual}>
            Continue manually
          </Button>
        </Stack>
      </Stack>
    );
  }
  if (!scan.intakeId) return <Skeleton variant="rounded" height={200} data-testid="gym-scan-loading" />;
  return (
    <ScanIntakeLoader
      key={scan.intakeId}
      gymId={gymId}
      intakeId={scan.intakeId}
      availability={availability}
      onManual={onManual}
      onRestart={scan.retry}
    />
  );
}

/** Gate on the AI being able to read photos; the manual path stays one click away. */
function ScanGate({ gymId, onManual }: { gymId: string; onManual: () => void }) {
  const availability = useVisionAvailability();
  if (availability.status !== 'ready') {
    return <NoVisionModelNotice reason={availability.status} onManual={onManual} />;
  }
  return <ScanWithIntake gymId={gymId} availability={availability} onManual={onManual} />;
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
