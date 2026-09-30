/**
 * "Prefill from photo" (`/train/workouts/:workoutId/prefill`, E4.5):
 * photograph a machine placard, a notebook page or a whiteboard, let the AI
 * draft the exercises and their written sets, review every item, then add
 * the accepted ones to the workout. Built only from the photo-intake kit
 * (`components/intake`), with `/gyms/:gymId/scan` as the template; this page
 * supplies the `workout_prefill` renderers and the steps around them:
 *
 * 1. Photos: what the photo shows (a hint stored in the intake's context),
 *    `ImageIntake`, `AiVisionDisclosure` and **Analyze**.
 * 2. Scanning: the queued `ai.workout.prefill` job runs; the page polls and
 *    offers **Cancel** (discards the intake).
 * 3. Review: `AiDraftReview` (low-confidence and uncertain items included,
 *    never hidden), the title the AI read offered as the workout name on
 *    click only, **Add to workout** (disabled while items are pending).
 * 4. Apply: back to the workout with a summary; every drafted set arrives
 *    NOT done, so the user checks each off as they train.
 *
 * The manual path is never blocked: without AI, a key, a vision model or a
 * permission the page says why and offers **Continue manually**, which opens
 * the exercise picker on the workout. Every decision (ownership, the model
 * gate, the value schema, exercise resolution, the 30-exercise cap) is the
 * API's.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Container,
  FormControl,
  FormControlLabel,
  FormLabel,
  LinearProgress,
  Paper,
  Radio,
  RadioGroup,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material';
import { ArrowBack as BackIcon } from '@mui/icons-material';
import { usePermissions } from '../hooks/usePermissions';
import { useWorkout, type UseWorkoutReturn } from '../hooks/useWorkout';
import { useWeightUnit } from '../hooks/useWeightUnit';
import {
  useRefreshOnFeatureRefusal,
  useVisionAvailability,
  type UseVisionAvailabilityReturn,
} from '../hooks/useVisionAvailability';
import { useWorkoutPrefillIntake } from '../hooks/useWorkoutPrefillIntake';
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
import { ExerciseDraftValue } from '../components/train/ExerciseDraftValue';
import { ExerciseDraftEditor } from '../components/train/ExerciseDraftEditor';
import { prefillPermissionReason } from '../components/train/prefillAvailability';
import { updateIntakeContext } from '../services/intake';
import { toAiErrorInfo } from '../services/aiErrors';
import { failedChunkRange, formatElapsed } from '../services/gymScan';
import { WORKOUTS_UNAVAILABLE, workoutErrorMessage } from '../services/workouts';
import {
  EMPTY_EXERCISE_DRAFT_VALUE,
  EXERCISE_DRAFT_ITEM_KIND,
  SOURCE_LABEL,
  SOURCE_OPTIONS,
  WORKOUT_PREFILL_MAX_PHOTOS,
  contextFor,
  prefillApplySummary,
  prefillResultMeta,
  sourceOf,
  type ExerciseDraftValue as DraftValue,
  type WorkoutLocationState,
  type WorkoutPrefillApplyResult,
  type WorkoutPrefillContext,
  type WorkoutPrefillSource,
} from '../services/workoutPrefill';
import type { WeightUnit } from '../utils/units';

type PrefillIntake = UsePhotoIntakeReturn<DraftValue, WorkoutPrefillContext>;

export const PREFILL_PHOTOS_HELPER =
  'Photograph a machine placard, a notebook page or a whiteboard. Up to 16 photos per request; more are sent in batches.';
export const PREFILL_PRIVACY_NOTE = 'Notebook pages can contain personal notes. Only the photos you select are sent.';
export const NOTHING_RECOGNIZED = 'Nothing recognized. Add exercises manually or try clearer photos.';

function workoutPath(workoutId: string): string {
  return `/train/workouts/${encodeURIComponent(workoutId)}`;
}

function SourceSelector({
  value,
  onChange,
  disabled,
}: {
  value: WorkoutPrefillSource;
  onChange: (source: WorkoutPrefillSource) => void;
  disabled: boolean;
}) {
  return (
    <FormControl disabled={disabled}>
      <FormLabel id="prefill-source-label">What is in the photos?</FormLabel>
      <RadioGroup
        row
        aria-labelledby="prefill-source-label"
        value={value}
        onChange={(event) => onChange(event.target.value as WorkoutPrefillSource)}
      >
        {SOURCE_OPTIONS.map((option) => (
          <FormControlLabel key={option} value={option} control={<Radio />} label={SOURCE_LABEL[option]} />
        ))}
      </RadioGroup>
    </FormControl>
  );
}

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
    <Stack spacing={2} data-testid="prefill-scanning">
      <Typography variant="h6" component="h2">
        Reading your photos
      </Typography>
      <LinearProgress aria-label="Reading photos" />
      <Typography role="status" aria-live="polite">
        Analyzing {photoCount} {photoCount === 1 ? 'photo' : 'photos'} in {requests}{' '}
        {requests === 1 ? 'request' : 'requests'}.
      </Typography>
      <Typography variant="body2" color="text.secondary" data-testid="prefill-elapsed">
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

function SuggestedName({ name, w }: { name: string; w: UseWorkoutReturn }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = w.workout?.name ?? null;
  if (current === name) {
    return (
      <Typography variant="body2" color="text.secondary" data-testid="prefill-suggested-name">
        The workout is named “{name}”.
      </Typography>
    );
  }
  return (
    <Box data-testid="prefill-suggested-name">
      <Button
        variant="outlined"
        size="small"
        disabled={saving || !w.workout}
        onClick={() => {
          setSaving(true);
          setError(null);
          w.update({ name })
            .catch((err: unknown) => setError(workoutErrorMessage(err, 'Could not rename the workout')))
            .finally(() => setSaving(false));
        }}
      >
        Use “{name}” as workout name
      </Button>
      {error && (
        <Typography variant="body2" color="error" sx={{ mt: 0.5 }}>
          {error}
        </Typography>
      )}
    </Box>
  );
}

function ReviewStep({
  intake,
  unit,
  w,
  onApply,
  onScanAgain,
  onAddPhotos,
  onDiscard,
  onManual,
  canRescan,
}: {
  intake: PrefillIntake;
  unit: WeightUnit;
  w: UseWorkoutReturn;
  onApply: () => void;
  onScanAgain: () => void;
  onAddPhotos: () => void;
  onDiscard: () => void;
  onManual: () => void;
  canRescan: boolean;
}) {
  const meta = prefillResultMeta(intake.intake);
  const photoCount = meta.photoCount ?? intake.photos.length;
  const pending = intake.items.filter((item) => item.status === 'pending').length;
  const accepted = intake.items.filter((item) => item.status === 'accepted').length;
  const busy = intake.isMutating;
  const nothing = intake.items.length === 0;

  return (
    <Stack spacing={2} data-testid="prefill-review">
      <Typography variant="h6" component="h2">
        Review what the AI read
      </Typography>
      <Typography variant="body2" color="text.secondary">
        These are guesses. Accept, edit or reject each exercise, and add anything that is missing. Nothing is added
        to the workout until you apply, and no set is marked done.
      </Typography>

      {meta.failedChunks.map((chunk) => (
        <Alert
          key={chunk.index}
          severity="warning"
          data-testid="prefill-failed-chunk"
          action={
            <Button color="inherit" size="small" onClick={onScanAgain} disabled={busy || !canRescan}>
              Try again
            </Button>
          }
        >
          {failedChunkRange(chunk, photoCount)} could not be analyzed.
        </Alert>
      ))}

      {nothing && (
        <Alert
          severity="info"
          data-testid="prefill-nothing"
          action={
            <Button color="inherit" size="small" onClick={onManual}>
              Continue manually
            </Button>
          }
        >
          {NOTHING_RECOGNIZED}
        </Alert>
      )}

      {meta.suggestedName && <SuggestedName name={meta.suggestedName} w={w} />}

      <AiDraftReview<DraftValue>
        items={intake.items}
        photos={intake.photos}
        renderValue={(item) => <ExerciseDraftValue value={item.value} unit={unit} />}
        renderEditor={(props) => <ExerciseDraftEditor {...props} unit={unit} />}
        emptyValue={EMPTY_EXERCISE_DRAFT_VALUE}
        busy={busy}
        onAcceptItem={(id) => void intake.acceptItem(id)}
        onRejectItem={(id) => void intake.rejectItem(id)}
        onRestoreItem={(id) => void intake.restoreItem(id)}
        onEditItem={(id, value) => void intake.editItem(id, value)}
        onAddItem={(value) => void intake.addItem(EXERCISE_DRAFT_ITEM_KIND, value)}
        onAcceptAll={() => void intake.acceptAll()}
      />

      {meta.ignoredNotes.length > 0 && (
        <Typography variant="caption" color="text.secondary" component="p" data-testid="prefill-ignored">
          Not used: {meta.ignoredNotes.join(', ')}
        </Typography>
      )}

      <Box>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Button
            variant="contained"
            onClick={onApply}
            disabled={busy || pending > 0 || accepted === 0}
            aria-describedby={pending > 0 ? 'prefill-pending' : undefined}
          >
            Add to workout
          </Button>
          <Button variant="outlined" onClick={onScanAgain} disabled={busy || !canRescan}>
            Analyze again
          </Button>
          <Button onClick={onAddPhotos} disabled={busy}>
            Add photos
          </Button>
          <Button color="error" onClick={onDiscard} disabled={busy}>
            Discard
          </Button>
        </Stack>
        {pending > 0 && (
          <Typography id="prefill-pending" variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {pending} {pending === 1 ? 'item is' : 'items are'} still waiting for review. Accept or reject{' '}
            {pending === 1 ? 'it' : 'each'} before adding to the workout.
          </Typography>
        )}
      </Box>
    </Stack>
  );
}

/** The steps of one intake, once it is loaded. */
function PrefillSteps({
  workoutId,
  intakeId,
  intake,
  availability,
  w,
  onManual,
}: {
  workoutId: string;
  intakeId: string;
  intake: PrefillIntake;
  availability: UseVisionAvailabilityReturn;
  w: UseWorkoutReturn;
  onManual: () => void;
}) {
  const navigate = useNavigate();
  const unit = useWeightUnit();
  const [initialPhotos] = useState(() =>
    intake.photos.map((photo) => ({ storageObjectId: photo.storageObjectId, name: photo.name })),
  );
  const uploadPhoto = useMemo(() => uploadAndAttach(intakeId), [intakeId]);
  const removePhoto = useMemo(() => detachFrom(intakeId), [intakeId]);
  const photos = useImageIntake({ maxPhotos: WORKOUT_PREFILL_MAX_PHOTOS, uploadPhoto, removePhoto, initialPhotos });
  const [addingPhotos, setAddingPhotos] = useState(false);
  const [scanStartedAt, setScanStartedAt] = useState<number | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [source, setSource] = useState<WorkoutPrefillSource>(() => sourceOf(intake.intake?.context));
  const [savingSource, setSavingSource] = useState(false);
  const [sourceError, setSourceError] = useState<ReturnType<typeof toAiErrorInfo> | null>(null);

  const status = intake.intake?.status ?? 'draft';
  const selected = availability.model;
  const photoCount = Math.max(intake.photos.length, photos.readyCount);
  useRefreshOnFeatureRefusal(intake.error, availability.refresh);

  const changeSource = async (next: WorkoutPrefillSource) => {
    const previous = source;
    setSource(next);
    setSavingSource(true);
    setSourceError(null);
    try {
      await updateIntakeContext(intakeId, contextFor(workoutId, next));
      await intake.refresh();
    } catch (err) {
      setSource(previous);
      setSourceError(toAiErrorInfo(err, 'Could not save what the photos show'));
    } finally {
      setSavingSource(false);
    }
  };

  const analyze = async () => {
    if (!selected) return;
    setScanStartedAt(Date.now());
    const started = await intake.analyze(selected);
    if (started) setAddingPhotos(false);
  };

  const apply = async () => {
    const result = await intake.apply<WorkoutPrefillApplyResult>();
    if (!result) return;
    const state: WorkoutLocationState = { snack: prefillApplySummary(result) };
    navigate(workoutPath(result.workoutId || workoutId), { state });
  };

  const discard = async () => {
    const ok = await intake.discard();
    setConfirmDiscard(false);
    if (ok) navigate(workoutPath(workoutId));
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
      <Stack spacing={2} data-testid="prefill-failed">
        {intake.scanError && <AiErrorAlert error={intake.scanError} />}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button variant="contained" onClick={() => void analyze()} disabled={intake.isMutating || !selected}>
            Try again
          </Button>
          <Button variant="outlined" onClick={onManual}>
            Continue manually
          </Button>
          <Button color="error" onClick={() => setConfirmDiscard(true)} disabled={intake.isMutating}>
            Discard
          </Button>
        </Stack>
      </Stack>
    );
  } else if (status === 'ready' && !addingPhotos) {
    body = (
      <ReviewStep
        intake={intake}
        unit={unit}
        w={w}
        onApply={() => void apply()}
        onScanAgain={() => void analyze()}
        onAddPhotos={() => setAddingPhotos(true)}
        onDiscard={() => setConfirmDiscard(true)}
        onManual={onManual}
        canRescan={selected !== null}
      />
    );
  } else if (status === 'applied') {
    body = (
      <Alert
        severity="success"
        action={
          <Button color="inherit" size="small" component={RouterLink} to={workoutPath(workoutId)}>
            Open workout
          </Button>
        }
      >
        These photos were already added to the workout.
      </Alert>
    );
  } else {
    const canAnalyze =
      photos.readyCount > 0 && !photos.busy && selected !== null && !intake.isMutating && !savingSource;
    body = (
      <Stack spacing={2} data-testid="prefill-photos">
        <SourceSelector value={source} onChange={(next) => void changeSource(next)} disabled={savingSource || intake.isMutating} />
        {sourceError && <AiErrorAlert error={sourceError} onClose={() => setSourceError(null)} />}
        <ImageIntake state={photos} maxPhotos={WORKOUT_PREFILL_MAX_PHOTOS} helperText={PREFILL_PHOTOS_HELPER} />
        <AiVisionDisclosure availability={availability} photoCount={photos.readyCount} onManual={onManual} />
        <Typography variant="body2" color="text.secondary" data-testid="prefill-privacy">
          {PREFILL_PRIVACY_NOTE}
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button variant="contained" onClick={() => void analyze()} disabled={!canAnalyze}>
            Analyze
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
        title={status === 'scanning' ? 'Cancel reading the photos?' : 'Discard this prefill?'}
        message="The photos and the draft are discarded. Nothing is added to the workout."
        confirmLabel="Discard"
        onClose={() => setConfirmDiscard(false)}
        onConfirm={discard}
      />
    </>
  );
}

function PrefillIntakeLoader({
  workoutId,
  intakeId,
  availability,
  w,
  onManual,
  onRestart,
}: {
  workoutId: string;
  intakeId: string;
  availability: UseVisionAvailabilityReturn;
  w: UseWorkoutReturn;
  onManual: () => void;
  onRestart: () => void;
}) {
  const intake = usePhotoIntake<DraftValue, WorkoutPrefillContext>(intakeId);
  if (!intake.intake) {
    if (intake.error && !intake.isLoading) {
      return (
        <Stack spacing={2}>
          <AiErrorAlert error={intake.error} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Button variant="contained" onClick={onRestart}>
              Start again
            </Button>
            <Button variant="outlined" onClick={onManual}>
              Continue manually
            </Button>
          </Stack>
        </Stack>
      );
    }
    return <Skeleton variant="rounded" height={200} data-testid="prefill-loading" />;
  }
  return (
    <PrefillSteps
      workoutId={workoutId}
      intakeId={intakeId}
      intake={intake}
      availability={availability}
      w={w}
      onManual={onManual}
    />
  );
}

function PrefillWithIntake({
  workoutId,
  availability,
  w,
  onManual,
}: {
  workoutId: string;
  availability: UseVisionAvailabilityReturn;
  w: UseWorkoutReturn;
  onManual: () => void;
}) {
  const prefill = useWorkoutPrefillIntake(workoutId, true);
  if (prefill.error) {
    return (
      <Stack spacing={2}>
        <AiErrorAlert error={prefill.error} />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button variant="contained" onClick={prefill.retry}>
            Try again
          </Button>
          <Button variant="outlined" onClick={onManual}>
            Continue manually
          </Button>
        </Stack>
      </Stack>
    );
  }
  if (!prefill.intakeId) return <Skeleton variant="rounded" height={200} data-testid="prefill-loading" />;
  return (
    <PrefillIntakeLoader
      key={prefill.intakeId}
      workoutId={workoutId}
      intakeId={prefill.intakeId}
      availability={availability}
      w={w}
      onManual={onManual}
      onRestart={prefill.retry}
    />
  );
}

/** Gate on the AI being able to read photos; the manual path stays one click away. */
function PrefillGate({ workoutId, w, onManual }: { workoutId: string; w: UseWorkoutReturn; onManual: () => void }) {
  const availability = useVisionAvailability('workout_prefill');
  if (availability.status !== 'ready') {
    return (
      <NoVisionModelNotice
        reason={availability.status}
        fix={availability.fix}
        onRetry={() => void availability.refresh()}
        onManual={onManual}
      />
    );
  }
  return <PrefillWithIntake workoutId={workoutId} availability={availability} w={w} onManual={onManual} />;
}

function WorkoutPrefill({ workoutId }: { workoutId: string }) {
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const w = useWorkout(workoutId);
  const permissionReason = prefillPermissionReason(hasPermission);
  const canWrite = hasPermission('workouts:write');

  const onManual = () => {
    const state: WorkoutLocationState = { openPicker: canWrite };
    navigate(workoutPath(workoutId), { state });
  };

  if (w.notFound) {
    return (
      <Alert
        severity="warning"
        action={
          <Button color="inherit" size="small" component={RouterLink} to="/train">
            Train
          </Button>
        }
      >
        This workout does not exist or was deleted.
      </Alert>
    );
  }
  if (!w.workout) {
    if (w.error && !w.isLoading) {
      return (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void w.refresh()}>
              Retry
            </Button>
          }
        >
          Could not load this workout. {w.error}
        </Alert>
      );
    }
    return <Skeleton variant="rounded" height={200} data-testid="prefill-loading" />;
  }

  return (
    <>
      <Typography color="text.secondary" sx={{ mb: 3, overflowWrap: 'anywhere' }}>
        {w.workout.name}: photograph a machine placard, a notebook page or a whiteboard and let AI draft the exercises
        and sets. You review everything before it is added.
      </Typography>
      {permissionReason ? (
        <Alert severity="info" data-testid="prefill-permission">
          <Box sx={{ mb: canWrite ? 1 : 0 }}>{permissionReason}</Box>
          {canWrite && (
            <Button variant="contained" size="small" onClick={onManual}>
              Continue manually
            </Button>
          )}
        </Alert>
      ) : (
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
          <PrefillGate workoutId={workoutId} w={w} onManual={onManual} />
        </Paper>
      )}
    </>
  );
}

export default function WorkoutPrefillPage() {
  const { workoutId } = useParams<{ workoutId: string }>();
  const { hasPermission } = usePermissions();
  const canRead = hasPermission('workouts:read');

  return (
    <Container maxWidth="md">
      <Box sx={{ py: { xs: 2, sm: 4 } }}>
        <Button
          component={RouterLink}
          to={workoutId ? workoutPath(workoutId) : '/train'}
          startIcon={<BackIcon />}
          sx={{ mb: 2 }}
        >
          Back to workout
        </Button>
        <Typography variant="h4" component="h1" gutterBottom>
          Prefill from photo
        </Typography>
        {canRead && workoutId ? <WorkoutPrefill workoutId={workoutId} /> : <Alert severity="info">{WORKOUTS_UNAVAILABLE}</Alert>}
      </Box>
    </Container>
  );
}
