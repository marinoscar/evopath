/**
 * Import a lab report, H4 (#188): a PDF from a patient portal or photos of
 * the printed pages become reviewed lab results, saved as ONE entry with full
 * provenance. Design: docs/specs/health-records.md §2.10.
 *
 * Everything generic is the intake kit (`components/intake/`): the file
 * picker (`ImageIntake` with PDFs), the keep-or-delete choice
 * (`RetainFilesControl`), where the files go (`AiVisionDisclosure`,
 * `NoVisionModelNotice`) and the scan and its polling (`usePhotoIntake`). This
 * file adds the steps and the lab review (`LabReportReview`):
 *
 * 1. `useVisionAvailability('lab_report')`: anything but `ready` shows the
 *    notice. There is no manual lab entry yet, so "Continue manually" closes.
 * 2. Resume the newest unfinished lab report intake, or start one.
 * 3. Up to ten files (a PDF counts as one, up to 20 pages), the keep-or-delete
 *    choice, the disclosure, and Read.
 * 4. The review: results grouped by date (#305: each result may carry its own
 *    collection date), then by panel; the report date and lab name (the
 *    intake's context) are editable; unmatched results must be mapped or
 *    rejected (Save is disabled, with the reason, until they are), and
 *    mapping one maps every result printed under the same name, and an edit
 *    of the analyte or unit is carried to them too (#307, the server decides
 *    which; the review says how many it changed). #308: a result already
 *    saved (`GET /measurements/lab-reports/:id/duplicates`: same analyte,
 *    day and value) is marked on its row with Skip (rejects it) or Save
 *    again (kept for this session); a short bar offers "Skip all" and "Save
 *    all again". Save is blocked, with the reason, until each has a decision.
 *
 * The server decides everything: matching, conversion, validation, whether
 * apply may run, and the provenance it writes. Full-screen below `sm` through
 * its OWN media query, not one of the five coupled shell gates
 * (docs/specs/settings-ui.md#breakpoint-gates).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
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
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
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
import {
  DEFAULT_RETAIN_FILES,
  addDraftItem,
  applyIntake,
  createIntake,
  listIntakes,
  updateDraftItem,
  updateIntakeContext,
} from '../../services/intake';
import { validationIssues, type MetricCatalog } from '../../services/health';
import {
  LAB_NAME_MAX,
  LAB_REPORT_ACCEPTS_PDF,
  LAB_REPORT_ITEM_KIND,
  LAB_REPORT_KIND,
  LAB_REPORT_MAX_PHOTOS,
  getLabReportDuplicates,
  isUnresolved,
  mapLabResult,
  sameNamedOthers,
  labApplyRefusal,
  labEditChange,
  labMappedMessage,
  labPropagatedMessage,
  labResultPayload,
  labSavedMessage,
  resultDate,
  type LabReportApplyResult,
  type LabReportContext,
  type LabReportDuplicate,
  type LabReportMapResult,
  type LabReportValue,
} from '../../services/labReport';
import { useMeasurementCatalog } from '../../hooks/useMeasurementCatalog';
import { useLabUnits } from '../../hooks/useLabUnits';
import type { LabUnits } from '../../utils/labUnits';
import { useIsMounted } from '../../hooks/useIsMounted';
import { LabReportReview } from './LabReportReview';

export const LAB_REPORT_TITLE = 'Import lab report';
export const LAB_REPORT_HELPER_TEXT =
  'Add the PDF from your patient portal, or a sharp photo of each page of the printed report';
export const SKIP_ALL_LABEL = 'Skip all';
export const SAVE_LABEL = 'Save to Health';

const RESUMABLE = ['draft', 'scanning', 'ready'] as const;

export interface LabReportDialogProps {
  open: boolean;
  onClose: () => void;
  /** After a successful save (refresh tiles and history). */
  onSaved: (result: LabReportApplyResult) => void;
  /** How often a running scan is polled; `usePhotoIntake`'s 2 s by default (tests shorten it). */
  pollIntervalMs?: number;
}

function FailureNotice({ error, onRetry }: { error: AiErrorInfo; onRetry?: () => void }) {
  let alert;
  if (error.code) {
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
    <Box data-testid="lab-report-failure">
      {alert}
      {onRetry && (
        <Button size="small" variant="outlined" onClick={onRetry} sx={{ mt: 1 }}>
          Try again
        </Button>
      )}
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
// The report's own fields: report date and lab name (the intake context)
// -----------------------------------------------------------------------------

function ReportDetails({
  context,
  allDated,
  disabled,
  onSave,
}: {
  context: LabReportContext | null;
  /** #305: every result carries its own date, so the report date is not used. */
  allDated: boolean;
  disabled: boolean;
  onSave: (next: LabReportContext) => void;
}) {
  const id = useId();
  const savedDate = context?.collectionDate ?? '';
  const savedLab = context?.labName ?? '';
  const [date, setDate] = useState(savedDate);
  const [lab, setLab] = useState(savedLab);
  useEffect(() => setDate(savedDate), [savedDate]);
  useEffect(() => setLab(savedLab), [savedLab]);

  const commit = (nextDate: string, nextLab: string) => {
    if (nextDate === savedDate && nextLab.trim() === savedLab) return;
    onSave({ collectionDate: nextDate === '' ? null : nextDate, labName: nextLab.trim() === '' ? null : nextLab.trim() });
  };

  return (
    <Box component="section" aria-labelledby={`${id}-title`} data-testid="lab-report-details">
      <Typography id={`${id}-title`} variant="subtitle1" component="h3" sx={{ fontWeight: 600, mb: 1 }}>
        Report details
      </Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
        <TextField
          id={`${id}-date`}
          type="date"
          size="small"
          label="Report date"
          value={date}
          disabled={disabled}
          onChange={(event) => setDate(event.target.value)}
          onBlur={() => commit(date, lab)}
          helperText={
            allDated
              ? 'Each result uses its own date'
              : date
                ? 'Used for results without their own date'
                : 'Not read: results without their own date are saved with today’s date'
          }
          slotProps={{ inputLabel: { shrink: true } }}
          sx={{ width: { xs: '100%', sm: 200 } }}
        />
        <TextField
          id={`${id}-lab`}
          size="small"
          label="Laboratory"
          value={lab}
          disabled={disabled}
          onChange={(event) => setLab(event.target.value)}
          onBlur={() => commit(date, lab)}
          slotProps={{ htmlInput: { maxLength: LAB_NAME_MAX } }}
          sx={{ flex: 1, minWidth: 0 }}
        />
      </Stack>
    </Box>
  );
}

// -----------------------------------------------------------------------------
// Already saved (#308): the compact bar over the per-row decisions
// -----------------------------------------------------------------------------

/** "12 skipped · 3 will be saved again"; `null` when nothing is decided. */
export function duplicateSummary(skipped: number, kept: number): string | null {
  const parts = [
    ...(skipped > 0 ? [`${skipped} skipped`] : []),
    ...(kept > 0 ? [`${kept} will be saved again`] : []),
  ];
  return parts.length > 0 ? parts.join(' · ') : null;
}

function DuplicateBar({
  open,
  undecided,
  summary,
  busy,
  onSkipAll,
  onSaveAllAgain,
}: {
  /** Duplicates not yet skipped (undecided or kept). */
  open: number;
  undecided: number;
  summary: string | null;
  busy: boolean;
  onSkipAll: () => void;
  onSaveAllAgain: () => void;
}) {
  if (undecided === 0) {
    return summary ? (
      <Typography variant="body2" color="text.secondary" data-testid="lab-report-duplicate-summary">
        Already saved: {summary}
      </Typography>
    ) : null;
  }
  return (
    <Alert
      severity="info"
      data-testid="lab-report-duplicates"
      sx={{ alignItems: 'center', '& .MuiAlert-message': { width: '100%' } }}
    >
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ alignItems: { sm: 'center' }, flexWrap: 'wrap' }}>
        <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {open} {open === 1 ? 'result is' : 'results are'} already saved
          </Typography>
          {summary && (
            <Typography variant="body2" data-testid="lab-report-duplicate-summary">
              {summary}
            </Typography>
          )}
        </Box>
        <Stack direction="row" spacing={1}>
          <Button size="small" variant="outlined" onClick={onSkipAll} disabled={busy}>
            {SKIP_ALL_LABEL} {open}
          </Button>
          <Button size="small" variant="outlined" onClick={onSaveAllAgain} disabled={busy}>
            {`Save all ${open} again`}
          </Button>
        </Stack>
      </Stack>
    </Alert>
  );
}

// -----------------------------------------------------------------------------
// The session over one intake
// -----------------------------------------------------------------------------

type ApplyFailure =
  | { kind: 'messages'; title: string; messages: string[] }
  | { kind: 'error'; error: AiErrorInfo };

interface SessionProps {
  intakeId: string;
  pollIntervalMs?: number;
  vision: UseVisionAvailabilityReturn;
  catalog: MetricCatalog | null;
  labUnits: LabUnits;
  onClose: () => void;
  onApplied: (result: LabReportApplyResult) => void;
}

function LabReportSession({ intakeId, pollIntervalMs, vision, catalog, labUnits, onClose, onApplied }: SessionProps) {
  const scan = usePhotoIntake<LabReportValue, LabReportContext>(intakeId, pollIntervalMs ? { intervalMs: pollIntervalMs } : {});
  const { intake } = scan;
  const isMounted = useIsMounted();

  const [initialPhotos, setInitialPhotos] = useState<{ storageObjectId: string; name: string }[] | undefined>();
  useEffect(() => {
    if (intake && initialPhotos === undefined) {
      setInitialPhotos(intake.photos.map(({ storageObjectId, name }) => ({ storageObjectId, name })));
    }
  }, [intake, initialPhotos]);

  const retainFiles = intake?.retainFiles ?? DEFAULT_RETAIN_FILES;
  const retainFilesRef = useRef(retainFiles);
  retainFilesRef.current = retainFiles;
  const uploadPhoto = useMemo(
    () => uploadAndAttach(intakeId, { retainFiles: () => retainFilesRef.current }),
    [intakeId],
  );
  const removePhoto = useMemo(() => detachFrom(intakeId), [intakeId]);
  const images = useImageIntake({
    maxPhotos: LAB_REPORT_MAX_PHOTOS,
    uploadPhoto,
    removePhoto,
    initialPhotos,
    acceptPdf: LAB_REPORT_ACCEPTS_PDF,
  });

  // Edits, adds and context changes go through the service directly so a 400
  // can show the server's field messages; the intake is then re-read.
  const [writing, setWriting] = useState(0);
  const [writeIssues, setWriteIssues] = useState<string[] | null>(null);
  /** #307: what the last map did, when it did more than the one row shows. */
  const [mapNotice, setMapNotice] = useState<{ message: string; severity: 'success' | 'warning'; reasons: string[] } | null>(
    null,
  );
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const [applyFailure, setApplyFailure] = useState<ApplyFailure | null>(null);
  const [refusedIds, setRefusedIds] = useState<string[]>([]);
  const [duplicates, setDuplicates] = useState<LabReportDuplicate[]>([]);
  /** #308: duplicates the user chose to save again, and the ones skipped here (both for this session). */
  const [keptIds, setKeptIds] = useState<ReadonlySet<string>>(() => new Set());
  const [skippedIds, setSkippedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [skippingAll, setSkippingAll] = useState(false);

  const busy = scan.isMutating || applying || writing > 0 || skippingAll;
  const status = intake?.status ?? null;
  const selected = vision.model;
  useRefreshOnFeatureRefusal(scan.error, vision.refresh);

  const write = useCallback(
    async (fallback: string, call: () => Promise<unknown>) => {
      setWriting((n) => n + 1);
      setWriteIssues(null);
      setMapNotice(null);
      try {
        await call();
      } catch (err) {
        if (!isMounted()) return;
        const issues = validationIssues(err);
        setWriteIssues(issues.length > 0 ? [...new Set(issues.map((issue) => issue.message))] : [toAiErrorInfo(err, fallback).message]);
      } finally {
        if (isMounted()) setWriting((n) => n - 1);
        await scan.refresh();
      }
    },
    [isMounted, scan],
  );

  const showMapNotice = (notice: { message: string; severity: 'success' | 'warning' } | null, result: LabReportMapResult) => {
    if (notice && isMounted()) setMapNotice({ ...notice, reasons: [...new Set(result.skipped.map((skip) => skip.message))] });
  };

  // #307: an edit that changes the analyte or the unit is carried to every
  // other result printed under the same name (the server picks which).
  const editItem = (itemId: string, value: LabReportValue) => {
    const previous = scan.items.find((item) => item.id === itemId);
    const change = previous ? labEditChange(previous.value, value) : null;
    const carry = previous && change && sameNamedOthers(scan.items, previous).length > 0 ? change : null;
    const printed = previous?.value.nameAsPrinted ?? null;
    void write('Could not save this result', async () => {
      await updateDraftItem(intakeId, itemId, { value: labResultPayload(value) as LabReportValue });
      if (!carry) return;
      try {
        const result = await mapLabResult(intakeId, itemId, carry);
        showMapNotice(labPropagatedMessage(result, itemId, printed), result);
      } catch {
        // The edit itself was saved; only carrying it over failed.
        if (isMounted()) {
          setMapNotice({
            message: `Saved. The other results${printed ? ` named “${printed}”` : ''} could not be updated`,
            severity: 'warning',
            reasons: [],
          });
        }
      }
    });
  };
  const mapItem = (itemId: string, analyteKey: string) => {
    const printed = scan.items.find((item) => item.id === itemId)?.value.nameAsPrinted ?? null;
    const label = catalog?.metrics.find((metric) => metric.key === analyteKey)?.label ?? analyteKey;
    void write('Could not map this result', async () => {
      const result = await mapLabResult(intakeId, itemId, { analyteKey });
      showMapNotice(labMappedMessage(result, printed, label), result);
    });
  };
  const addItem = (value: LabReportValue) =>
    void write('Could not add this result', () =>
      addDraftItem(intakeId, { kind: LAB_REPORT_ITEM_KIND, value: labResultPayload(value) }),
    );
  const saveContext = (context: LabReportContext) =>
    void write('Could not save the report details', () => updateIntakeContext(intakeId, context));

  // The duplicate warning: re-checked whenever what would be saved changes.
  const items = scan.items;
  const signature = useMemo(
    () =>
      JSON.stringify([
        intake?.context ?? null,
        items.map((item) => [
          item.id,
          item.status,
          item.value.analyteKey,
          item.value.value,
          item.value.unit,
          resultDate(item.value),
        ]),
      ]),
    [intake?.context, items],
  );
  const checkDuplicates = useCallback(async (): Promise<LabReportDuplicate[] | null> => {
    try {
      const result = await getLabReportDuplicates(intakeId);
      if (isMounted()) setDuplicates(result.duplicates);
      return result.duplicates;
    } catch {
      // A warning only: a failed check never blocks the review.
      return null;
    }
  }, [intakeId, isMounted]);
  useEffect(() => {
    if (status !== 'ready') return;
    void checkDuplicates();
  }, [status, signature, checkDuplicates]);

  // #308: a decision lasts while its item is still a duplicate (kept) or still rejected (skipped).
  const duplicateIds = useMemo(() => new Set(duplicates.map((duplicate) => duplicate.itemId)), [duplicates]);
  useEffect(() => {
    setKeptIds((current) => {
      const next = new Set([...current].filter((id) => duplicateIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [duplicateIds]);
  useEffect(() => {
    const rejected = new Set(items.filter((item) => item.status === 'rejected').map((item) => item.id));
    setSkippedIds((current) => {
      const next = new Set([...current].filter((id) => rejected.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [items]);
  const openDuplicates = items.filter((item) => item.status !== 'rejected' && duplicateIds.has(item.id));
  const undecidedDuplicates = openDuplicates.filter((item) => !keptIds.has(item.id));
  const keptCount = openDuplicates.length - undecidedDuplicates.length;
  const duplicateDates = useMemo(() => {
    const dates = new Map<string, string | null>();
    for (const duplicate of duplicates) {
      const item = items.find((entry) => entry.id === duplicate.itemId);
      const saved = duplicate.matches[0]?.measuredAt?.slice(0, 10) ?? null;
      dates.set(duplicate.itemId, (item && resultDate(item.value)) ?? intake?.context?.collectionDate ?? saved);
    }
    return dates;
  }, [duplicates, items, intake?.context?.collectionDate]);

  const markSkipped = (itemId: string) => {
    if (isMounted()) setSkippedIds((current) => new Set([...current, itemId]));
  };
  const skipDuplicate = (itemId: string) => {
    setKeptIds((current) => new Set([...current].filter((id) => id !== itemId)));
    void scan.rejectItem(itemId).then(() => markSkipped(itemId));
  };
  const keepDuplicate = (itemId: string) => setKeptIds((current) => new Set([...current, itemId]));
  const skipAllDuplicates = async () => {
    const ids = openDuplicates.map((item) => item.id);
    setKeptIds(new Set());
    setSkippingAll(true);
    try {
      // No bulk reject route: one PATCH each, in order.
      for (const id of ids) {
        if (!isMounted()) return;
        await scan.rejectItem(id);
        markSkipped(id);
      }
    } finally {
      if (isMounted()) setSkippingAll(false);
    }
  };
  const keepAllDuplicates = () => setKeptIds(new Set(openDuplicates.map((item) => item.id)));

  const apply = async () => {
    if (applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    setApplyFailure(null);
    setRefusedIds([]);
    scan.clearError();
    try {
      const result = await applyIntake<LabReportApplyResult>(intakeId);
      if (isMounted()) onApplied(result);
    } catch (err) {
      if (!isMounted()) return;
      const refusal = labApplyRefusal(err);
      if (refusal.kind === 'unresolved') {
        setRefusedIds(refusal.itemIds);
        setApplyFailure({
          kind: 'messages',
          title: 'Not saved yet',
          messages: ['Some results are not in the lab catalog. Map each one to an analyte or reject it.'],
        });
      } else if (refusal.kind === 'issues') {
        setApplyFailure({ kind: 'messages', title: 'Not saved yet', messages: refusal.messages });
      } else if (refusal.kind === 'pending') {
        setApplyFailure({ kind: 'messages', title: 'Not saved yet', messages: ['Accept or reject every result first.'] });
      } else {
        setApplyFailure({ kind: 'error', error: toAiErrorInfo(refusal.error, 'Could not save these results') });
      }
      void scan.refresh();
    } finally {
      applyingRef.current = false;
      if (isMounted()) setApplying(false);
    }
  };

  /** Save: re-check for duplicates first; a new one needs a decision (the hint says so). */
  const save = async () => {
    const found = await checkDuplicates();
    if (!isMounted()) return;
    if (found && found.some((duplicate) => !keptIds.has(duplicate.itemId))) return;
    await apply();
  };

  const read = async () => {
    if (!selected) return;
    setApplyFailure(null);
    await scan.analyze(selected);
  };

  const discard = async () => {
    if (await scan.discard()) onClose();
  };

  const retryFromError = () => {
    scan.clearError();
    if (status === 'draft' || status === 'failed') void read();
    else void scan.refresh();
  };

  const retainControl = intake && status !== 'applied' && (
    <RetainFilesControl
      kind={intake.kind}
      checked={retainFiles}
      onChange={(next) => void scan.setRetainFiles(next)}
      disabled={busy}
    />
  );

  const pending = items.filter((item) => item.status === 'pending').length;
  const accepted = items.filter((item) => item.status === 'accepted').length;
  const unresolved = items.filter(isUnresolved).length;
  const kept = items.filter((item) => item.status !== 'rejected');
  const allDated = kept.length > 0 && kept.every((item) => resultDate(item.value) !== null);
  const reportDate = intake?.context?.collectionDate ?? null;
  const hintId = `${intakeId}-save-hint`;

  let body;
  if (!intake) {
    body = scan.error ? <FailureNotice error={scan.error} onRetry={() => void scan.refresh()} /> : <Starting label="Loading" />;
  } else if (status === 'scanning') {
    body = (
      <Stack spacing={2} data-testid="lab-report-scanning">
        <Typography>Reading the report…</Typography>
        <LinearProgress aria-label="Reading the report" />
        <Typography variant="body2" color="text.secondary">
          A long report can take a minute. You can close this window; the reading carries on and is here when you come back.
        </Typography>
        {scan.stale && !scan.error && (
          <Alert severity="info">Checking the reading is taking longer than usual. Still trying…</Alert>
        )}
        {scan.error && <FailureNotice error={scan.error} onRetry={retryFromError} />}
      </Stack>
    );
  } else if (status === 'ready') {
    body = (
      <Stack spacing={2}>
        <ReportDetails context={intake.context} allDated={allDated} disabled={busy} onSave={saveContext} />
        <DuplicateBar
          open={openDuplicates.length}
          undecided={undecidedDuplicates.length}
          summary={duplicateSummary(
            items.filter((item) => item.status === 'rejected' && skippedIds.has(item.id)).length,
            keptCount,
          )}
          busy={busy}
          onSkipAll={() => void skipAllDuplicates()}
          onSaveAllAgain={keepAllDuplicates}
        />
        <LabReportReview
          items={items}
          photos={intake.photos}
          catalog={catalog}
          labUnits={labUnits}
          busy={busy}
          refusedIds={refusedIds}
          reportDate={reportDate}
          onAcceptItem={(id) => void scan.acceptItem(id)}
          onRejectItem={(id) => void scan.rejectItem(id)}
          onRestoreItem={(id) => void scan.restoreItem(id)}
          onEditItem={editItem}
          onMapItem={mapItem}
          onAddItem={addItem}
          onAcceptAll={() => void scan.acceptAll()}
          onAcceptHighConfidence={() => void scan.acceptAll({ only: 'high_confidence' })}
          duplicateDates={duplicateDates}
          keptDuplicateIds={keptIds}
          onSkipDuplicate={skipDuplicate}
          onKeepDuplicate={keepDuplicate}
        />
        {mapNotice && (
          <Alert
            severity={mapNotice.severity}
            data-testid="lab-report-map-notice"
            role="status"
            onClose={() => setMapNotice(null)}
          >
            {mapNotice.message}
            {mapNotice.reasons.map((reason) => (
              <Box key={reason}>{reason}</Box>
            ))}
          </Alert>
        )}
        {writeIssues && (
          <Alert severity="error" data-testid="lab-report-write-issues" onClose={() => setWriteIssues(null)}>
            <AlertTitle>Not changed</AlertTitle>
            {writeIssues.map((message) => (
              <Box key={message}>{message}</Box>
            ))}
          </Alert>
        )}
        {scan.error && <FailureNotice error={scan.error} onRetry={retryFromError} />}
        {retainControl}
        {applyFailure?.kind === 'messages' && (
          <Alert severity="error" data-testid="lab-report-apply-issues">
            <AlertTitle>{applyFailure.title}</AlertTitle>
            {applyFailure.messages.map((message) => (
              <Box key={message}>{message}</Box>
            ))}
          </Alert>
        )}
        {applyFailure?.kind === 'error' && <FailureNotice error={applyFailure.error} onRetry={() => void apply()} />}
        <Typography variant="body2" color="text.secondary" id={hintId} aria-live="polite" data-testid="lab-report-save-hint">
          {unresolved > 0
            ? `${unresolved} ${unresolved === 1 ? 'result is' : 'results are'} not in the lab catalog: map ${unresolved === 1 ? 'it' : 'each'} to an analyte or reject ${unresolved === 1 ? 'it' : 'them'} before saving`
            : undecidedDuplicates.length > 0
              ? `Decide on ${undecidedDuplicates.length} already-saved ${undecidedDuplicates.length === 1 ? 'result' : 'results'}: skip ${undecidedDuplicates.length === 1 ? 'it' : 'them'} or save ${undecidedDuplicates.length === 1 ? 'it' : 'them'} again`
              : pending > 0
              ? `${pending} ${pending === 1 ? 'result needs' : 'results need'} a decision before saving`
              : accepted === 0
                ? 'Accept at least one result to save, or discard this report'
                : `${accepted} ${accepted === 1 ? 'result' : 'results'} will be saved`}
        </Typography>
      </Stack>
    );
  } else if (status === 'applied') {
    body = <Alert severity="success">These results were already saved.</Alert>;
  } else {
    body = (
      <Stack spacing={2}>
        {scan.scanError && <FailureNotice error={scan.scanError} onRetry={() => void read()} />}
        {scan.error && <FailureNotice error={scan.error} onRetry={retryFromError} />}
        <ImageIntake state={images} maxPhotos={LAB_REPORT_MAX_PHOTOS} disabled={busy} helperText={LAB_REPORT_HELPER_TEXT} />
        {retainControl}
        <AiVisionDisclosure availability={vision} photoCount={images.readyIds.length} onManual={onClose} disabled={busy} />
        <Typography variant="body2" color="text.secondary">
          Up to {LAB_REPORT_MAX_PHOTOS} files; a PDF can have up to 20 pages. Every result is shown for you to check before
          anything is saved.
        </Typography>
      </Stack>
    );
  }

  const canRead = (status === 'draft' || status === 'failed') && images.readyIds.length > 0 && !images.busy;
  const blocked = busy || pending > 0 || accepted === 0 || unresolved > 0 || undecidedDuplicates.length > 0;

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
        <Button onClick={onClose}>Close</Button>
        {(status === 'draft' || status === 'failed') && (
          <Button variant="contained" onClick={() => void read()} disabled={!canRead || busy || !selected}>
            Read
          </Button>
        )}
        {status === 'ready' && (
          <Button variant="contained" onClick={() => void save()} disabled={blocked} aria-describedby={hintId}>
            {applying ? 'Saving…' : SAVE_LABEL}
          </Button>
        )}
      </DialogActions>
    </>
  );
}

// -----------------------------------------------------------------------------
// Availability, then resume or start
// -----------------------------------------------------------------------------

function LabReportFlow({
  pollIntervalMs,
  onClose,
  onApplied,
}: {
  pollIntervalMs?: number;
  onClose: () => void;
  onApplied: (result: LabReportApplyResult) => void;
}) {
  const vision = useVisionAvailability('lab_report');
  const { catalog } = useMeasurementCatalog();
  const { labUnits } = useLabUnits();
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
        const open = await listIntakes({ kind: LAB_REPORT_KIND, status: [...RESUMABLE], limit: 1 });
        if (cancelled) return;
        const id = open[0]?.id ?? (await createIntake({ kind: LAB_REPORT_KIND, retainFiles: DEFAULT_RETAIN_FILES })).id;
        if (!cancelled) setIntakeId(id);
      } catch (err) {
        if (!cancelled) setStartError(toAiErrorInfo(err, 'Could not start importing a lab report'));
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
            onManual={onClose}
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
            <FailureNotice error={startError} onRetry={() => setAttempt((n) => n + 1)} />
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
    <LabReportSession
      intakeId={intakeId}
      pollIntervalMs={pollIntervalMs}
      vision={vision}
      catalog={catalog}
      labUnits={labUnits}
      onClose={onClose}
      onApplied={onApplied}
    />
  );
}

export function LabReportDialog({ open, onClose, onSaved, pollIntervalMs }: LabReportDialogProps) {
  const theme = useTheme();
  // A local layout choice for this dialog, NOT one of the five coupled `sm` shell gates.
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const titleId = useId();
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const onApplied = (result: LabReportApplyResult) => {
    onSaved(result);
    setSavedMessage(labSavedMessage(result));
    onClose();
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} fullScreen={fullScreen} fullWidth maxWidth="md" aria-labelledby={titleId}>
        <DialogTitle id={titleId}>{LAB_REPORT_TITLE}</DialogTitle>
        {open && <LabReportFlow pollIntervalMs={pollIntervalMs} onClose={onClose} onApplied={onApplied} />}
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

export default LabReportDialog;
