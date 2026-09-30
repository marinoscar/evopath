/**
 * Read a value from a photo, issue #64 (E2.6): a scale, smart scale or
 * blood-pressure cuff display becomes reviewed draft readings, then ONE
 * measurement entry.
 *
 * Everything generic is E3.1's kit (`components/intake/`): the photo picker
 * (`ImageIntake` + `useImageIntake`: downscale, EXIF dropped, "Take photo"
 * opens the OS camera), where the photos go (`AiVisionDisclosure`,
 * `NoVisionModelNotice`), the scan and its polling (`usePhotoIntake`) and the
 * review (`AiDraftReview`). This file only adds the `body_metric_reading`
 * kind's value view and editor (`ReadingDraftValue.tsx`) and the steps:
 *
 * 1. `useVisionAvailability('body_metric_reading')`: anything but `ready` shows the notice, whose
 *    "Continue manually" hands over to the quick-entry dialog.
 * 2. Resume the newest unfinished reading intake (`GET /intakes?kind=…&status=
 *    draft,scanning,ready`), or start one (`POST /intakes { kind }`).
 * 3. Up to four photos, the keep-or-delete choice (`RetainFilesControl`, #185:
 *    kept by default; sent on create, `PATCH { retainFiles }` when changed,
 *    and with every attach), the disclosure, and Read (`POST /intakes/:id/analyze`).
 * 4. An indeterminate progress bar while the scan runs. Closing the dialog
 *    does not stop it; reopening resumes the same intake.
 * 5. The review: nothing is written until every item is accepted or rejected
 *    and the user presses "Save to Health" (`POST /intakes/:id/apply`), which
 *    the API turns into one entry with provenance it derives itself.
 *
 * Every failure offers Try again and Enter manually. Full-screen below `sm`
 * through its OWN media query, which is not one of the five coupled shell
 * gates (docs/specs/settings-ui.md#breakpoint-gates).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Snackbar,
  Stack,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  AiDraftReview,
  AiVisionDisclosure,
  ImageIntake,
  NoVisionModelNotice,
  RetainFilesControl,
  useImageIntake,
  usePhotoIntake,
  useVisionAvailability,
  useRefreshOnFeatureRefusal,
  uploadAndAttach,
  detachFrom,
  type UseVisionAvailabilityReturn,
} from '../intake';
import { AiErrorAlert } from '../ai/AiErrorAlert';
import { toAiErrorInfo, type AiErrorInfo } from '../../services/aiErrors';
import { DEFAULT_RETAIN_FILES, applyIntake, createIntake, listIntakes } from '../../services/intake';
import {
  BODY_METRIC_READING_ITEM_KIND,
  BODY_METRIC_READING_KIND,
  BODY_METRIC_READING_MAX_PHOTOS,
  isUnreadableResult,
  validationIssues,
  type BodyMetricReadingApplyResult,
  type BodyMetricReadingValue,
  type HealthProfile,
  type MeasurementDto,
  type MetricCatalog,
  type UnitSystem,
} from '../../services/health';
import { useMeasurementCatalog } from '../../hooks/useMeasurementCatalog';
import { useIsMounted } from '../../hooks/useIsMounted';
import { ReadingEditor, ReadingValue, emptyReading } from './ReadingDraftValue';

export const PHOTO_READ_HELPER_TEXT = 'Photograph the display so every digit is sharp and in the frame';
export const UNREADABLE_MESSAGE =
  "We couldn't read a value from this photo. Add it by hand below, or try a clearer photo.";
export const ENTER_MANUALLY_LABEL = 'Enter manually';

/** The intakes this flow resumes instead of starting a duplicate. */
const RESUMABLE = ['draft', 'scanning', 'ready'] as const;

export interface PhotoReadDialogProps {
  open: boolean;
  onClose: () => void;
  /** Close this dialog and open the quick-entry dialog (what the user typed there is kept). */
  onEnterManually: () => void;
  /** The saved readings (canonical), after a successful Save to Health. */
  onSaved: (items: MeasurementDto[]) => void;
  /** The unit system "Add missing item" starts in. */
  profile?: HealthProfile | null;
  /** How often a running scan is polled; `usePhotoIntake`'s 2 s by default (tests shorten it). */
  pollIntervalMs?: number;
}

// -----------------------------------------------------------------------------
// One failure, in words, with Try again and Enter manually
// -----------------------------------------------------------------------------

function FailureNotice({
  error,
  onRetry,
  onManual,
  retryLabel = 'Try again',
}: {
  error: AiErrorInfo;
  onRetry?: () => void;
  onManual: () => void;
  retryLabel?: string;
}) {
  let alert;
  if (error.code) {
    // Every AI_* code (and storage unavailable) reads the same everywhere.
    alert = <AiErrorAlert error={error} />;
  } else if (error.status === undefined || error.status >= 500) {
    alert = (
      <Alert severity="error">
        <AlertTitle>Could not reach the server</AlertTitle>
        Check your connection and try again.
      </Alert>
    );
  } else {
    alert = <Alert severity="error">{error.message}</Alert>;
  }
  return (
    <Box data-testid="photo-read-failure">
      {alert}
      <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1, flexWrap: 'wrap' }}>
        {onRetry && (
          <Button size="small" variant="outlined" onClick={onRetry}>
            {retryLabel}
          </Button>
        )}
        <Button size="small" onClick={onManual}>
          {ENTER_MANUALLY_LABEL}
        </Button>
      </Stack>
    </Box>
  );
}

function Starting({ label }: { label: string }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
      <CircularProgress aria-label={label} />
    </Box>
  );
}

// -----------------------------------------------------------------------------
// The session over one intake
// -----------------------------------------------------------------------------

type ApplyFailure = { kind: 'issues'; messages: string[] } | { kind: 'error'; error: AiErrorInfo };

interface SessionProps {
  intakeId: string;
  pollIntervalMs?: number;
  vision: UseVisionAvailabilityReturn;
  catalog: MetricCatalog | null;
  unitSystem: UnitSystem;
  onClose: () => void;
  onEnterManually: () => void;
  onApplied: (result: BodyMetricReadingApplyResult) => void;
}

function PhotoReadSession({
  intakeId,
  pollIntervalMs,
  vision,
  catalog,
  unitSystem,
  onClose,
  onEnterManually,
  onApplied,
}: SessionProps) {
  const scan = usePhotoIntake<BodyMetricReadingValue>(intakeId, pollIntervalMs ? { intervalMs: pollIntervalMs } : {});
  const { intake } = scan;
  const isMounted = useIsMounted();

  // Photos already on a resumed intake, read once so a later poll never re-adds a removed one.
  const [initialPhotos, setInitialPhotos] = useState<{ storageObjectId: string; name: string }[] | undefined>();
  useEffect(() => {
    if (intake && initialPhotos === undefined) {
      setInitialPhotos(intake.photos.map(({ storageObjectId, name }) => ({ storageObjectId, name })));
    }
  }, [intake, initialPhotos]);

  // The keep-or-delete choice as the intake holds it (kept until the intake loads).
  const retainFiles = intake?.retainFiles ?? DEFAULT_RETAIN_FILES;
  const retainFilesRef = useRef(retainFiles);
  retainFilesRef.current = retainFiles;
  // Each attach carries the choice showing at that moment, so a file picked
  // while a change is still being saved is not filed under the old one.
  const uploadPhoto = useMemo(
    () => uploadAndAttach(intakeId, { retainFiles: () => retainFilesRef.current }),
    [intakeId],
  );
  const removePhoto = useMemo(() => detachFrom(intakeId), [intakeId]);
  const images = useImageIntake({
    maxPhotos: BODY_METRIC_READING_MAX_PHOTOS,
    uploadPhoto,
    removePhoto,
    initialPhotos,
  });

  const [applying, setApplying] = useState(false);
  const [applyFailure, setApplyFailure] = useState<ApplyFailure | null>(null);
  const applyingRef = useRef(false);

  const busy = scan.isMutating || applying;
  const status = intake?.status ?? null;
  const selected = vision.model;
  useRefreshOnFeatureRefusal(scan.error, vision.refresh);

  const read = async () => {
    if (!selected) return;
    setApplyFailure(null);
    await scan.analyze(selected);
  };

  const save = async () => {
    if (applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    setApplyFailure(null);
    scan.clearError();
    try {
      const result = await applyIntake<BodyMetricReadingApplyResult>(intakeId);
      if (isMounted()) onApplied(result);
    } catch (err) {
      if (!isMounted()) return;
      const issues = validationIssues(err);
      if (issues.length > 0) {
        setApplyFailure({ kind: 'issues', messages: [...new Set(issues.map((issue) => issue.message))] });
      } else {
        setApplyFailure({ kind: 'error', error: toAiErrorInfo(err, 'Could not save these readings') });
      }
      // A refused apply leaves the intake as it was (`ready`); show what the server holds.
      void scan.refresh();
    } finally {
      applyingRef.current = false;
      if (isMounted()) setApplying(false);
    }
  };

  const retainControl = intake && status !== 'applied' && (
    <RetainFilesControl
      kind={intake.kind}
      checked={retainFiles}
      onChange={(next) => void scan.setRetainFiles(next)}
      disabled={busy}
    />
  );

  const discard = async () => {
    if (await scan.discard()) onClose();
  };

  const retryFromError = () => {
    scan.clearError();
    if (status === 'draft' || status === 'failed') void read();
    else void scan.refresh();
  };

  const items = scan.items;
  const pending = items.filter((item) => item.status === 'pending').length;
  const accepted = items.filter((item) => item.status === 'accepted').length;
  const unreadable = status === 'ready' && isUnreadableResult(intake?.resultMeta);

  let body;
  if (!intake) {
    body = scan.error ? (
      <FailureNotice error={scan.error} onRetry={() => void scan.refresh()} onManual={onEnterManually} />
    ) : (
      <Starting label="Loading" />
    );
  } else if (status === 'scanning') {
    body = (
      <Stack spacing={2} data-testid="photo-read-scanning">
        <Typography>Reading the display…</Typography>
        <LinearProgress aria-label="Reading the photo" />
        <Typography variant="body2" color="text.secondary">
          You can close this window; the reading carries on and is here when you come back.
        </Typography>
        {scan.stale && !scan.error && (
          <Alert severity="info">Checking the reading is taking longer than usual. Still trying…</Alert>
        )}
        {scan.error && <FailureNotice error={scan.error} onRetry={retryFromError} onManual={onEnterManually} />}
      </Stack>
    );
  } else if (status === 'ready') {
    body = (
      <Stack spacing={2}>
        {unreadable && (
          <Alert severity="info" data-testid="photo-read-unreadable">
            {UNREADABLE_MESSAGE}
          </Alert>
        )}
        <AiDraftReview<BodyMetricReadingValue>
          items={items}
          photos={intake.photos}
          renderValue={(item) => <ReadingValue value={item.value} catalog={catalog} />}
          renderEditor={({ value, onChange }) => (
            <ReadingEditor value={value} onChange={onChange} catalog={catalog} unitSystem={unitSystem} />
          )}
          emptyValue={emptyReading(catalog, unitSystem)}
          busy={busy}
          onAcceptItem={(id) => void scan.acceptItem(id)}
          onRejectItem={(id) => void scan.rejectItem(id)}
          onRestoreItem={(id) => void scan.restoreItem(id)}
          onEditItem={(id, value) => void scan.editItem(id, value)}
          onAddItem={(value) => void scan.addItem(BODY_METRIC_READING_ITEM_KIND, value)}
          onAcceptAll={() => void scan.acceptAll()}
        />
        {scan.error && <FailureNotice error={scan.error} onRetry={retryFromError} onManual={onEnterManually} />}
        {retainControl}
        {applyFailure?.kind === 'issues' && (
          <Alert severity="error" data-testid="photo-read-apply-issues">
            <AlertTitle>Not saved yet</AlertTitle>
            {applyFailure.messages.map((message) => (
              <Box key={message}>{message}</Box>
            ))}
          </Alert>
        )}
        {applyFailure?.kind === 'error' && (
          <FailureNotice error={applyFailure.error} onRetry={() => void save()} onManual={onEnterManually} />
        )}
        <Typography variant="body2" color="text.secondary" id={`${intakeId}-save-hint`} aria-live="polite">
          {pending > 0
            ? `${pending} ${pending === 1 ? 'item needs' : 'items need'} a decision before saving`
            : accepted === 0
              ? 'Accept at least one reading to save, or discard this photo'
              : `${accepted} ${accepted === 1 ? 'reading' : 'readings'} will be saved`}
        </Typography>
      </Stack>
    );
  } else if (status === 'applied') {
    body = <Alert severity="success">These readings were already saved.</Alert>;
  } else {
    // `draft`, or `failed` (photos stay attached; Read again).
    body = (
      <Stack spacing={2}>
        {scan.scanError && (
          <FailureNotice error={scan.scanError} onRetry={() => void read()} onManual={onEnterManually} />
        )}
        {scan.error && <FailureNotice error={scan.error} onRetry={retryFromError} onManual={onEnterManually} />}
        <ImageIntake
          state={images}
          maxPhotos={BODY_METRIC_READING_MAX_PHOTOS}
          disabled={busy}
          helperText={PHOTO_READ_HELPER_TEXT}
        />
        {retainControl}
        <AiVisionDisclosure
          availability={vision}
          photoCount={images.readyIds.length}
          onManual={onEnterManually}
          disabled={busy}
        />
        <Typography variant="body2" color="text.secondary">
          Frame only the display; avoid including people.
        </Typography>
      </Stack>
    );
  }

  const canRead = (status === 'draft' || status === 'failed') && images.readyIds.length > 0 && !images.busy;

  return (
    <>
      <DialogContent dividers>{body}</DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1, '& > :not(style) ~ :not(style)': { ml: 0 } }}>
        {intake && status !== 'applied' && (
          <Button color="error" onClick={() => void discard()} disabled={busy}>
            Discard
          </Button>
        )}
        <Box sx={{ flex: '1 1 auto' }} />
        <Button onClick={onEnterManually}>{ENTER_MANUALLY_LABEL}</Button>
        <Button onClick={onClose}>Close</Button>
        {(status === 'draft' || status === 'failed') && (
          <Button variant="contained" onClick={() => void read()} disabled={!canRead || busy || !selected}>
            Read
          </Button>
        )}
        {status === 'ready' && (
          <Button
            variant="contained"
            onClick={() => void save()}
            disabled={busy || pending > 0 || accepted === 0}
            aria-describedby={`${intakeId}-save-hint`}
          >
            {applying ? 'Saving…' : pending > 0 ? `Save to Health (${pending} pending)` : 'Save to Health'}
          </Button>
        )}
      </DialogActions>
    </>
  );
}

// -----------------------------------------------------------------------------
// Availability, then resume or start
// -----------------------------------------------------------------------------

function PhotoReadFlow({
  pollIntervalMs,
  unitSystem,
  onClose,
  onEnterManually,
  onApplied,
}: Omit<SessionProps, 'intakeId' | 'vision' | 'catalog'>) {
  const vision = useVisionAvailability('body_metric_reading');
  const { catalog } = useMeasurementCatalog();
  const [intakeId, setIntakeId] = useState<string | null>(null);
  const [startError, setStartError] = useState<AiErrorInfo | null>(null);
  const [attempt, setAttempt] = useState(0);
  const ready = vision.status === 'ready';

  useEffect(() => {
    if (!ready || intakeId) return;
    let cancelled = false;
    setStartError(null);
    void (async () => {
      try {
        // Newest first: resume an unfinished reading rather than start a duplicate.
        const open = await listIntakes({ kind: BODY_METRIC_READING_KIND, status: [...RESUMABLE], limit: 1 });
        if (cancelled) return;
        const id = open[0]?.id ?? (await createIntake({ kind: BODY_METRIC_READING_KIND, retainFiles: DEFAULT_RETAIN_FILES })).id;
        if (!cancelled) setIntakeId(id);
      } catch (err) {
        if (!cancelled) setStartError(toAiErrorInfo(err, 'Could not start reading a photo'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, intakeId, attempt]);

  if (!ready) {
    return (
      <>
        <DialogContent dividers>
          <NoVisionModelNotice
            reason={vision.status === 'ready' ? 'loading' : vision.status}
            fix={vision.fix}
            onRetry={() => void vision.refresh()}
            onManual={onEnterManually}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </>
    );
  }

  if (!intakeId) {
    return (
      <>
        <DialogContent dividers>
          {startError ? (
            <FailureNotice error={startError} onRetry={() => setAttempt((n) => n + 1)} onManual={onEnterManually} />
          ) : (
            <Starting label="Starting" />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </>
    );
  }

  return (
    <PhotoReadSession
      intakeId={intakeId}
      pollIntervalMs={pollIntervalMs}
      vision={vision}
      catalog={catalog}
      unitSystem={unitSystem}
      onClose={onClose}
      onEnterManually={onEnterManually}
      onApplied={onApplied}
    />
  );
}

export function PhotoReadDialog({
  open,
  onClose,
  onEnterManually,
  onSaved,
  profile = null,
  pollIntervalMs,
}: PhotoReadDialogProps) {
  const theme = useTheme();
  // A local layout choice for this dialog, NOT one of the five coupled `sm` shell gates.
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const titleId = useId();
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const onApplied = (result: BodyMetricReadingApplyResult) => {
    onSaved(result.items);
    setSavedMessage(result.items.length > 0 ? 'Saved to Health' : 'Nothing was saved');
    onClose();
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} fullScreen={fullScreen} fullWidth maxWidth="sm" aria-labelledby={titleId}>
        <DialogTitle id={titleId}>Read from photo</DialogTitle>
        {open && (
          <PhotoReadFlow
            pollIntervalMs={pollIntervalMs}
            unitSystem={profile?.unitSystem ?? 'metric'}
            onClose={onClose}
            onEnterManually={onEnterManually}
            onApplied={onApplied}
          />
        )}
      </Dialog>
      <Snackbar
        open={savedMessage !== null}
        autoHideDuration={3000}
        onClose={() => setSavedMessage(null)}
        message={savedMessage ?? ''}
      />
    </>
  );
}

export default PhotoReadDialog;
