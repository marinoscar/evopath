/**
 * The lab report review, H4 (#188): every printed result grouped by the date
 * it is saved on (#305: a trend report prints one column per collection date),
 * newest first, then by panel, each with Accept / Edit / Reject. The bulk
 * actions sit above the list: "Accept all", "Accept high confidence" (#305)
 * and "Add missing value".
 *
 * Why not `AiDraftReview`: it lists items in one flat `sortOrder` list, and a
 * 30-row blood panel reads by panel. This component keeps the kit's row
 * (`DraftItemRow`: provenance, confidence as text, the AI's uncertainty note,
 * "AI said: …", source thumbnails, Accept / Edit / Reject / Restore) and only
 * adds the grouping, the mapping strip and the lab-specific counts.
 *
 * - Rows that need a closer look (unsure, low confidence, a suggested match,
 *   or unmatched) are highlighted (`data-attention`), never hidden.
 * - An UNMATCHED row carries a "Map to an analyte" picker: picking one calls
 *   `onMapItem` (#307: the server maps every same-named result of the report
 *   with it, re-matching and converting each), or, without it, sends the edit
 *   (`value.analyteKey`). The alternative is Reject. Unknown analytes are
 *   never silently dropped.
 * - Rejected rows move into "Rejected (n)" with Restore.
 * - #311: "Reject unmatched (n)" rejects every result not mapped to an
 *   analyte at once, after a confirmation (`RejectUnmatchedConfirm`, shared
 *   with the dialog's save hint).
 * - #308: a result the server reports as ALREADY SAVED (same analyte, day and
 *   value) carries an "Already saved · <date>" badge (text and an icon, never
 *   colour alone) with Skip (rejects it, persisted) and Save again (a choice
 *   the dialog keeps for the session). The dialog owns the decisions.
 */
import { useId, useMemo, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  ContentCopy as AlreadySavedIcon,
  DoneAll as AcceptAllIcon,
  RemoveDone as RejectUnmatchedIcon,
  ExpandMore as ExpandIcon,
  Verified as HighConfidenceIcon,
} from '@mui/icons-material';
import { DraftItemRow } from '../intake';
import type { DraftItemView } from '../../services/intake';
import type { MetricCatalog } from '../../services/health';
import {
  LAB_PANEL_LABELS,
  emptyLabResult,
  formatLabDate,
  groupByDate,
  groupByPanel,
  isHighConfidencePending,
  isUnresolved,
  needsAttention,
  type LabReportValue,
} from '../../services/labReport';
import { AnalytePicker, LabResultEditor, LabResultView } from './LabResultValue';
import { DEFAULT_LAB_UNITS, labUnitsNote, type LabUnits } from '../../utils/labUnits';

export const ADD_MISSING_VALUE_LABEL = 'Add missing value';
export const REJECT_UNMATCHED_LABEL = 'Reject unmatched';
export const SKIP_DUPLICATE_LABEL = 'Skip';

/**
 * #311: the confirmation before rejecting every unmatched result. It keeps
 * the count it opened with: once confirmed, the count drops to 0 while the
 * dialog fades out, and the title must not flash "Reject 0 results…".
 */
export function RejectUnmatchedConfirm({
  open,
  count,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  // Follows `count` only while open (state adjusted during render, not in an effect).
  const [shown, setShown] = useState(count);
  if (open && shown !== count) setShown(count);
  return (
    <Dialog open={open} onClose={onCancel} aria-labelledby={titleId}>
      <DialogTitle id={titleId}>
        Reject {shown} {shown === 1 ? 'result that is' : 'results that are'} not in the lab catalog?
      </DialogTitle>
      <DialogContent>
        <DialogContentText>
          {shown === 1 ? 'It can be restored from Rejected.' : 'They can be restored one by one from Rejected.'}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="contained" color="error" onClick={onConfirm}>
          {REJECT_UNMATCHED_LABEL}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
export const SAVE_AGAIN_LABEL = 'Save again';

/** "Already saved · Nov 19, 2025", or without the date when it is not known. */
export function alreadySavedLabel(date: string | null): string {
  return date ? `Already saved · ${formatLabDate(date)}` : 'Already saved';
}
export const ACCEPT_HIGH_CONFIDENCE_LABEL = 'Accept high confidence';

/** "Nov 19, 2025 · 17 results", or the undated group's heading. */
export function dateGroupHeading(date: string | null, count: number): string {
  const results = `${count} ${count === 1 ? 'result' : 'results'}`;
  return date ? `${formatLabDate(date)} · ${results}` : `No date · ${results}, saved with today’s date`;
}

export interface LabReportReviewProps {
  items: DraftItemView<LabReportValue>[];
  photos: { storageObjectId: string; name: string }[];
  catalog: MetricCatalog | null;
  /** #234: the unit system values are shown in (and new analytes default to). */
  labUnits?: LabUnits;
  busy?: boolean;
  /** Item ids the server last refused as unresolved (shown with an error border). */
  refusedIds?: readonly string[];
  /** #305: the report date (the intake context); a result without its own date is saved on it. */
  reportDate?: string | null;
  onAcceptItem: (id: string) => void;
  onRejectItem: (id: string) => void;
  onRestoreItem: (id: string) => void;
  onEditItem: (id: string, value: LabReportValue) => void;
  /**
   * #307: map an unmatched result to an analyte; the server applies it to
   * every result printed under the same name. Absent: the map is an edit.
   */
  onMapItem?: (id: string, analyteKey: string) => void;
  onAddItem: (value: LabReportValue) => void;
  onAcceptAll: () => void;
  /** #305: accept every pending, high-confidence, not-uncertain result (`{ only: 'high_confidence' }`). */
  onAcceptHighConfidence: () => void;
  /**
   * #308: the results already saved (the duplicate check), by item id, with
   * the day they were saved on (`YYYY-MM-DD`, `null` when unknown).
   */
  duplicateDates?: ReadonlyMap<string, string | null>;
  /** #308: duplicates the user chose to save again this session. */
  keptDuplicateIds?: ReadonlySet<string>;
  /** #308: Skip a duplicate (the dialog rejects it). */
  onSkipDuplicate?: (id: string) => void;
  /** #308: Save a duplicate again. */
  onKeepDuplicate?: (id: string) => void;
  /** #311: reject every result not mapped to an analyte (the toolbar button is shown only with it). */
  onRejectUnmatched?: () => void;
}

function DuplicateStrip({
  item,
  date,
  kept,
  busy,
  onSkip,
  onKeep,
}: {
  item: DraftItemView<LabReportValue>;
  date: string | null;
  kept: boolean;
  busy: boolean;
  onSkip?: () => void;
  onKeep?: () => void;
}) {
  const badgeId = useId();
  const printed = item.value.nameAsPrinted ?? 'this result';
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1}
      useFlexGap
      sx={{ mt: 1, alignItems: { xs: 'stretch', sm: 'center' }, flexWrap: 'wrap' }}
      data-testid="lab-result-duplicate"
      data-decision={kept ? 'keep' : 'undecided'}
    >
      <Chip
        id={badgeId}
        icon={<AlreadySavedIcon />}
        label={kept ? `${alreadySavedLabel(date)} · will be saved again` : alreadySavedLabel(date)}
        color="info"
        variant="outlined"
        size="small"
        sx={{ alignSelf: { xs: 'flex-start', sm: 'center' }, maxWidth: '100%' }}
        data-testid="lab-result-already-saved"
      />
      <Stack direction="row" spacing={1}>
        <Button
          size="small"
          variant="outlined"
          onClick={onSkip}
          disabled={busy || !onSkip}
          aria-label={`${SKIP_DUPLICATE_LABEL} ${printed}`}
          aria-describedby={badgeId}
        >
          {SKIP_DUPLICATE_LABEL}
        </Button>
        <Button
          size="small"
          variant={kept ? 'contained' : 'outlined'}
          onClick={onKeep}
          disabled={busy || !onKeep}
          aria-pressed={kept}
          aria-label={`${SAVE_AGAIN_LABEL} ${printed}`}
          aria-describedby={badgeId}
        >
          {SAVE_AGAIN_LABEL}
        </Button>
      </Stack>
    </Stack>
  );
}

function MapStrip({
  item,
  catalog,
  busy,
  refused,
  onMap,
}: {
  item: DraftItemView<LabReportValue>;
  catalog: MetricCatalog | null;
  busy: boolean;
  refused: boolean;
  onMap: (analyteKey: string) => void;
}) {
  const printed = item.value.nameAsPrinted ?? 'this result';
  return (
    <Alert
      severity={refused ? 'error' : 'warning'}
      sx={{ mt: 1, '& .MuiAlert-message': { width: '100%' } }}
      data-testid="lab-result-map"
    >
      <Typography variant="body2" sx={{ mb: 1 }}>
        “{printed}” is not in the lab catalog. Map it to an analyte below, or reject it, before saving.
      </Typography>
      <AnalytePicker
        id={`map-${item.id}`}
        catalog={catalog}
        value={null}
        label={`Map “${printed}” to an analyte`}
        disabled={busy}
        onChange={(key) => {
          if (key) onMap(key);
        }}
      />
    </Alert>
  );
}

export function LabReportReview({
  items,
  photos,
  catalog,
  labUnits = DEFAULT_LAB_UNITS,
  busy = false,
  refusedIds = [],
  reportDate = null,
  onAcceptItem,
  onRejectItem,
  onRestoreItem,
  onEditItem,
  onMapItem,
  onAddItem,
  onAcceptAll,
  onAcceptHighConfidence,
  duplicateDates,
  keptDuplicateIds,
  onSkipDuplicate,
  onKeepDuplicate,
  onRejectUnmatched,
}: LabReportReviewProps) {
  const idPrefix = useId();
  const [adding, setAdding] = useState(false);
  const [newValue, setNewValue] = useState<LabReportValue>(emptyLabResult);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rejectUnmatchedOpen, setRejectUnmatchedOpen] = useState(false);

  const photoNames = useMemo(
    () => new Map(photos.map((photo) => [photo.storageObjectId, photo.name] as const)),
    [photos],
  );
  const ordered = useMemo(() => [...items].sort((a, b) => a.sortOrder - b.sortOrder), [items]);
  const active = ordered.filter((item) => item.status !== 'rejected');
  const rejected = ordered.filter((item) => item.status === 'rejected');
  const pending = active.filter((item) => item.status === 'pending');
  const lowPending = pending.filter((item) => item.confidence === 'low').length;
  const highPending = pending.filter(isHighConfidencePending).length;
  const unmatched = ordered.filter(isUnresolved).length;
  const dateGroups = groupByDate(active, reportDate);
  const refused = new Set(refusedIds);

  const renderValue = (item: DraftItemView<LabReportValue>) => (
    <LabResultView value={item.value} catalog={catalog} labUnits={labUnits} reportDate={reportDate} />
  );
  const renderEditor = ({ value, onChange }: { value: LabReportValue; onChange: (value: LabReportValue) => void }) => (
    <LabResultEditor value={value} onChange={onChange} catalog={catalog} labUnits={labUnits} />
  );

  const rowProps = {
    photoNames,
    renderValue,
    renderEditor,
    busy,
    onAccept: onAcceptItem,
    onReject: onRejectItem,
    onRestore: onRestoreItem,
    onEdit: onEditItem,
  };

  const acceptAll = () => {
    if (lowPending > 0) setConfirmOpen(true);
    else onAcceptAll();
  };

  const row = (item: DraftItemView<LabReportValue>) => (
    <Box
      role="listitem"
      key={item.id}
      data-testid="lab-result-row"
      data-item-id={item.id}
      data-attention={needsAttention(item) ? 'true' : 'false'}
      data-unresolved={isUnresolved(item) ? 'true' : 'false'}
      data-duplicate={duplicateDates?.has(item.id) && item.status !== 'rejected' ? 'true' : 'false'}
      sx={needsAttention(item) && item.status !== 'rejected' ? { borderLeft: 4, borderColor: 'warning.main', pl: 1 } : undefined}
    >
      <DraftItemRow<LabReportValue> item={item} {...rowProps} />
      {isUnresolved(item) && (
        <MapStrip
          item={item}
          catalog={catalog}
          busy={busy}
          refused={refused.has(item.id)}
          onMap={(analyteKey) =>
            onMapItem ? onMapItem(item.id, analyteKey) : onEditItem(item.id, { ...item.value, analyteKey })
          }
        />
      )}
      {duplicateDates?.has(item.id) && item.status !== 'rejected' && (
        <DuplicateStrip
          item={item}
          date={duplicateDates.get(item.id) ?? null}
          kept={keptDuplicateIds?.has(item.id) ?? false}
          busy={busy}
          onSkip={onSkipDuplicate ? () => onSkipDuplicate(item.id) : undefined}
          onKeep={onKeepDuplicate ? () => onKeepDuplicate(item.id) : undefined}
        />
      )}
    </Box>
  );

  return (
    <Box data-testid="lab-report-review">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }} data-testid="lab-units-note">
        {labUnitsNote(labUnits)}. Edits are saved in the unit you pick.
      </Typography>

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        useFlexGap
        sx={{ mb: 2, flexWrap: { sm: 'wrap' } }}
        data-testid="lab-review-toolbar"
      >
        <Button variant="contained" startIcon={<AcceptAllIcon />} onClick={acceptAll} disabled={busy || pending.length === 0}>
          Accept all ({pending.length})
        </Button>
        <Button
          variant="outlined"
          startIcon={<HighConfidenceIcon />}
          onClick={onAcceptHighConfidence}
          disabled={busy || highPending === 0}
        >
          {ACCEPT_HIGH_CONFIDENCE_LABEL} ({highPending})
        </Button>
        {onRejectUnmatched && unmatched > 0 && (
          <Button
            variant="outlined"
            color="error"
            startIcon={<RejectUnmatchedIcon />}
            onClick={() => setRejectUnmatchedOpen(true)}
            disabled={busy}
          >
            {REJECT_UNMATCHED_LABEL} ({unmatched})
          </Button>
        )}
        <Button
          variant="outlined"
          startIcon={<AddIcon />}
          onClick={() => {
            setNewValue(emptyLabResult());
            setAdding(true);
          }}
          disabled={busy || adding}
        >
          {ADD_MISSING_VALUE_LABEL}
        </Button>
      </Stack>

      {adding && (
        <Box
          sx={{ border: 1, borderColor: 'primary.main', borderRadius: 1, p: { xs: 1.5, sm: 2 }, mb: 2 }}
          data-testid="lab-result-add"
        >
          <Typography variant="subtitle2" component="h3" sx={{ mb: 1 }}>
            {ADD_MISSING_VALUE_LABEL}
          </Typography>
          <LabResultEditor value={newValue} onChange={setNewValue} catalog={catalog} labUnits={labUnits} />
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Button
              size="small"
              variant="contained"
              onClick={() => {
                onAddItem(newValue);
                setAdding(false);
              }}
              disabled={busy || !newValue.analyteKey || newValue.value === null}
            >
              Add
            </Button>
            <Button size="small" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </Stack>
        </Box>
      )}

      {active.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {rejected.length > 0 ? 'Every result was rejected.' : 'No results were read.'} Add anything that is missing above.
        </Typography>
      ) : (
        <Stack spacing={3} sx={{ mb: 2 }}>
          {dateGroups.map((dateGroup, dateIndex) => {
            const dateHeadingId = `${idPrefix}-date-${dateIndex}`;
            return (
              <Box
                component="section"
                key={dateGroup.date ?? 'undated'}
                aria-labelledby={dateHeadingId}
                data-testid="lab-date-group"
                data-date={dateGroup.date ?? ''}
              >
                <Typography
                  id={dateHeadingId}
                  variant="subtitle1"
                  component="h3"
                  sx={{ fontWeight: 700, mb: 1.5, pb: 0.5, borderBottom: 1, borderColor: 'divider' }}
                >
                  {dateGroupHeading(dateGroup.date, dateGroup.items.length)}
                </Typography>
                <Stack spacing={2}>
                  {groupByPanel(dateGroup.items).map((group) => {
                    const headingId = `${dateHeadingId}-panel-${group.panel}`;
                    return (
                      <Box
                        component="section"
                        key={group.panel}
                        aria-labelledby={headingId}
                        data-testid="lab-panel"
                        data-panel={group.panel}
                      >
                        <Typography id={headingId} variant="subtitle2" component="h4" sx={{ fontWeight: 600, mb: 1 }}>
                          {LAB_PANEL_LABELS[group.panel]} ({group.items.length})
                        </Typography>
                        <Stack spacing={1.5} role="list" aria-labelledby={headingId}>
                          {group.items.map(row)}
                        </Stack>
                      </Box>
                    );
                  })}
                </Stack>
              </Box>
            );
          })}
        </Stack>
      )}

      {rejected.length > 0 && (
        <Accordion disableGutters variant="outlined">
          <AccordionSummary expandIcon={<ExpandIcon />}>
            <Typography variant="subtitle2">Rejected ({rejected.length})</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Stack spacing={1.5} role="list" aria-label="Rejected results">
              {rejected.map(row)}
            </Stack>
          </AccordionDetails>
        </Accordion>
      )}

      <RejectUnmatchedConfirm
        open={rejectUnmatchedOpen}
        count={unmatched}
        onCancel={() => setRejectUnmatchedOpen(false)}
        onConfirm={() => {
          setRejectUnmatchedOpen(false);
          onRejectUnmatched?.();
        }}
      />

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} aria-labelledby="lab-accept-all-title">
        <DialogTitle id="lab-accept-all-title">Accept all {pending.length} results?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {lowPending} {lowPending === 1 ? 'result has' : 'results have'} low confidence. The AI may have misread{' '}
            {lowPending === 1 ? 'it' : 'them'}; check before accepting.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Review first</Button>
          <Button
            variant="contained"
            onClick={() => {
              setConfirmOpen(false);
              onAcceptAll();
            }}
          >
            Accept all
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default LabReportReview;
