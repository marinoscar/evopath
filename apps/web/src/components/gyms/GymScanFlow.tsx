/**
 * The steps of one gym scan (E3.4), shared by the scan page
 * (`/gyms/:gymId/scan`) and the hotel-gym step of the adjust-workout sheet
 * (E6.2). Built only from the photo-intake kit (`components/intake`); this
 * component supplies the `gym_equipment` renderers and the steps around it:
 *
 * 1. Photos: `ImageIntake` uploading into the intake, `AiVisionDisclosure`
 *    naming the provider, model and key, and **Scan**.
 * 2. Scanning: the queued `ai.equipment.scan` job runs; the flow polls,
 *    shows how many photos in how many requests and the elapsed time, and
 *    offers **Cancel** (discards the intake).
 * 3. Review: `AiDraftReview` with every draft item (low-confidence and
 *    uncertain ones included, never hidden), **Apply to gym** (disabled while
 *    items are pending), **Scan again** (only untouched drafts are replaced).
 *
 * Where to go next is the caller's: `onApplied`, `onDiscarded` and
 * `onManual`. Every decision (ownership, the model gate, the value schema,
 * the merge into existing rows) is the API's.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, AlertTitle, Box, Button, LinearProgress, Skeleton, Stack, Typography } from '@mui/material';
import { useGymScanIntake } from '../../hooks/useGymScanIntake';
import type { UseVisionAvailabilityReturn } from '../../hooks/useVisionAvailability';
import {
  AiDraftReview,
  AiVisionDisclosure,
  ImageIntake,
  detachFrom,
  uploadAndAttach,
  useImageIntake,
  usePhotoIntake,
  visionRequestCount,
  type UsePhotoIntakeReturn,
} from '../intake';
import { AiErrorAlert } from '../ai/AiErrorAlert';
import { ConfirmDialog } from './ConfirmDialog';
import { EquipmentDraftValue } from './EquipmentDraftValue';
import { EquipmentDraftEditor } from './EquipmentDraftEditor';
import {
  EMPTY_EQUIPMENT_VALUE,
  EQUIPMENT_DRAFT_ITEM_KIND,
  GYM_SCAN_MAX_PHOTOS,
  SCAN_PHOTOS_HELPER,
  formatElapsed,
  failedChunkRange,
  scanResultMeta,
  type EquipmentValue,
  type GymEquipmentApplyResult,
  type GymScanContext,
} from '../../services/gymScan';

type ScanIntake = UsePhotoIntakeReturn<EquipmentValue, GymScanContext>;
type HeadingLevel = 'h2' | 'h3' | 'h4';

export const DEFAULT_SCAN_PRIVACY_NOTE = 'Photos are sent to your AI provider. Avoid capturing people.';

export interface GymScanFlowProps {
  gymId: string;
  /** A `ready` vision availability (the caller gates on it). */
  availability: UseVisionAvailabilityReturn;
  /** "Continue manually": the caller opens its manual equipment path. */
  onManual: () => void;
  /** The accepted items were written to the gym. */
  onApplied: (result: GymEquipmentApplyResult) => void;
  /** The scan was discarded (Cancel while scanning, or Discard scan). */
  onDiscarded: () => void;
  /** Photos this flow accepts; the kind's maximum by default. */
  maxPhotos?: number;
  photosHelper?: string;
  /** The "Includes people?" note; the page's wording by default. */
  privacyNote?: ReactNode;
  /** Heading level of the step titles: lower inside a dialog. */
  headingComponent?: HeadingLevel;
}

function ScanningStep({
  photoCount,
  startedAt,
  onCancel,
  busy,
  headingComponent,
}: {
  photoCount: number;
  startedAt: number;
  onCancel: () => void;
  busy: boolean;
  headingComponent: HeadingLevel;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const requests = visionRequestCount(photoCount);

  return (
    <Stack spacing={2} data-testid="gym-scan-scanning">
      <Typography variant="h6" component={headingComponent}>
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
  headingComponent,
}: {
  intake: ScanIntake;
  onApply: () => void;
  onScanAgain: () => void;
  onAddPhotos: () => void;
  onDiscard: () => void;
  canRescan: boolean;
  headingComponent: HeadingLevel;
}) {
  const meta = scanResultMeta(intake.intake);
  const photoCount = meta.photoCount ?? intake.photos.length;
  const pending = intake.items.filter((item) => item.status === 'pending').length;
  const busy = intake.isMutating;

  return (
    <Stack spacing={2} data-testid="gym-scan-review">
      <Typography variant="h6" component={headingComponent}>
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

type StepsProps = Required<Pick<GymScanFlowProps, 'maxPhotos' | 'photosHelper' | 'headingComponent'>> &
  Omit<GymScanFlowProps, 'maxPhotos' | 'photosHelper' | 'headingComponent'> & {
    intakeId: string;
    intake: ScanIntake;
  };

/** The steps of one intake, once it is loaded. */
function ScanSteps({
  gymId,
  intakeId,
  intake,
  availability,
  onManual,
  onApplied,
  onDiscarded,
  maxPhotos,
  photosHelper,
  privacyNote,
  headingComponent,
}: StepsProps) {
  const [initialPhotos] = useState(() =>
    intake.photos.map((photo) => ({ storageObjectId: photo.storageObjectId, name: photo.name })),
  );
  const uploadPhoto = useMemo(() => uploadAndAttach(intakeId), [intakeId]);
  const removePhoto = useMemo(() => detachFrom(intakeId), [intakeId]);
  const photos = useImageIntake({ maxPhotos, uploadPhoto, removePhoto, initialPhotos });
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
    onApplied({ ...result, gymId: result.gymId || gymId });
  };

  const discard = async () => {
    const ok = await intake.discard();
    setConfirmDiscard(false);
    if (ok) onDiscarded();
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
        headingComponent={headingComponent}
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
        headingComponent={headingComponent}
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
        <Typography variant="h6" component={headingComponent}>
          Photos
        </Typography>
        <ImageIntake state={photos} maxPhotos={maxPhotos} helperText={photosHelper} />
        <Alert severity="info">
          <AlertTitle>Includes people?</AlertTitle>
          {privacyNote ?? DEFAULT_SCAN_PRIVACY_NOTE}
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

type LoaderProps = Omit<StepsProps, 'intake'> & { onRestart: () => void };

function ScanIntakeLoader({ onRestart, ...props }: LoaderProps) {
  const { intakeId, onManual } = props;
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
  return <ScanSteps {...props} intake={intake} />;
}

/**
 * Resume the gym's unfinished scan or start one, then walk its steps.
 * Mount it only once vision is `ready` and the caller may scan.
 */
export function GymScanFlow({
  maxPhotos = GYM_SCAN_MAX_PHOTOS,
  photosHelper = SCAN_PHOTOS_HELPER,
  headingComponent = 'h2',
  ...rest
}: GymScanFlowProps) {
  const scan = useGymScanIntake(rest.gymId, true);
  if (scan.error) {
    return (
      <Stack spacing={2}>
        <AiErrorAlert error={scan.error} />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button variant="contained" onClick={scan.retry}>
            Try again
          </Button>
          <Button variant="outlined" onClick={rest.onManual}>
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
      {...rest}
      intakeId={scan.intakeId}
      maxPhotos={maxPhotos}
      photosHelper={photosHelper}
      headingComponent={headingComponent}
      onRestart={scan.retry}
    />
  );
}

export default GymScanFlow;
