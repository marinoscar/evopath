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
 * - #317: a row that would stop the save (not in the catalog, already saved
 *   with no decision, or what the server's issues route says apply would
 *   refuse) carries a "Needs attention" badge. Tapping it shows the reasons
 *   inline; a pointer that hovers also gets them in a tooltip. A filter bar
 *   searches the results (printed name, analyte, aliases, panel) and narrows
 *   them to one status. Filters only change what is shown: the bulk actions
 *   still act on every result. The dialog can ask the review to reveal a row
 *   or to apply a filter (`request`).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material';
import {
  Add as AddIcon,
  Check as SelectedIcon,
  Close as ClearIcon,
  ContentCopy as AlreadySavedIcon,
  DoneAll as AcceptAllIcon,
  ReportProblemOutlined as AttentionIcon,
  RemoveDone as RejectUnmatchedIcon,
  ExpandMore as ExpandIcon,
  Search as SearchIcon,
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
  attentionLabel,
  labAttentionReasons,
  labResultMatches,
  needsAttention,
  type LabAttentionReason,
  type LabReportIssue,
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

/**
 * "Nov 19, 2025 · 17 results", or the undated group's heading. With `total`
 * (a filter is on): "Nov 19, 2025 · 3 of 17 results".
 */
export function dateGroupHeading(date: string | null, count: number, total?: number): string {
  const shown = total === undefined ? count : total;
  const results = `${total === undefined ? '' : `${count} of `}${shown} ${shown === 1 ? 'result' : 'results'}`;
  return date ? `${formatLabDate(date)} · ${results}` : `No date · ${results}, saved with today’s date`;
}

export const SEARCH_PLACEHOLDER = 'Search results (e.g. RBC)';
export const CLEAR_FILTERS_LABEL = 'Clear filters';
export const NO_MATCH_TEXT = 'No results match';

/** #317: the one status filter the review applies at a time (with the search). */
export type LabReviewFilter = 'attention' | 'unmatched' | 'duplicate' | 'pending';

export const LAB_REVIEW_FILTER_LABELS: Record<LabReviewFilter, string> = {
  attention: 'Needs attention',
  unmatched: 'Unmatched',
  duplicate: 'Already saved',
  pending: 'Pending',
};

const LAB_REVIEW_FILTERS = Object.keys(LAB_REVIEW_FILTER_LABELS) as LabReviewFilter[];

/**
 * #317: what the dialog asks of the review: reveal one row (scroll to it,
 * highlight it briefly, show its reasons) or apply a status filter. A new
 * `seq` makes the same request again.
 */
export type LabReviewRequest = { seq: number } & ({ type: 'reveal'; itemId: string } | { type: 'filter'; filter: LabReviewFilter });

/** How long a revealed row stays highlighted. */
const HIGHLIGHT_MS = 2000;
/** The search waits this long after the last keystroke. */
const SEARCH_DEBOUNCE_MS = 150;

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
  /** #317: what the server says apply would refuse, by item id (`GET …/issues`). */
  issues?: ReadonlyMap<string, readonly LabReportIssue[]>;
  /** #317: reveal a row or apply a filter (from the dialog's save hint or error panel). */
  request?: LabReviewRequest | null;
}

/**
 * #317: the "Needs attention" badge. It is a button: a tap or a click shows
 * the reasons inline under it (touch has no hover); where the pointer can
 * hover, a tooltip shows them too while they are collapsed.
 */
function AttentionBadge({
  printed,
  reasons,
  expanded,
  canHover,
  onToggle,
}: {
  printed: string;
  reasons: LabAttentionReason[];
  expanded: boolean;
  canHover: boolean;
  onToggle: () => void;
}) {
  const listId = useId();
  const list = (
    <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
      {reasons.map((reason) => (
        <Typography component="li" variant="body2" key={`${reason.code}-${reason.message}`}>
          {reason.message}
        </Typography>
      ))}
    </Box>
  );
  return (
    <Box sx={{ mb: 1 }} data-testid="lab-result-attention">
      <Tooltip
        describeChild
        title={canHover && !expanded ? list : ''}
        disableFocusListener
        disableTouchListener
        placement="bottom-start"
      >
        <Chip
          icon={<AttentionIcon />}
          label={
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25 }}>
              {attentionLabel(reasons.length)}
              <ExpandIcon
                fontSize="small"
                sx={{ transition: 'transform 150ms', transform: expanded ? 'rotate(180deg)' : 'none', mr: -0.5 }}
              />
            </Box>
          }
          color="warning"
          variant="outlined"
          size="small"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={`${attentionLabel(reasons.length)}: ${printed}`}
          sx={{ maxWidth: '100%', fontWeight: 600 }}
          data-testid="lab-result-attention-badge"
        />
      </Tooltip>
      <Collapse in={expanded}>
        <Box
          id={listId}
          sx={{ mt: 0.75, px: 1.25, py: 0.75, borderLeft: 2, borderColor: 'warning.main', bgcolor: 'action.hover', borderRadius: 1 }}
          data-testid="lab-result-attention-reasons"
        >
          {list}
        </Box>
      </Collapse>
    </Box>
  );
}

function FilterBar({
  query,
  onQueryChange,
  filter,
  onFilterChange,
  counts,
  shown,
  total,
  active,
  onClear,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  filter: LabReviewFilter | null;
  onFilterChange: (filter: LabReviewFilter | null) => void;
  counts: Record<LabReviewFilter, number>;
  shown: number;
  total: number;
  active: boolean;
  onClear: () => void;
}) {
  return (
    <Box
      role="search"
      aria-label="Filter results"
      sx={{
        position: 'sticky',
        top: 0,
        zIndex: 2,
        bgcolor: 'background.paper',
        // The dialog's paper overlay in dark mode, so the bar matches what scrolls under it.
        backgroundImage: 'var(--Paper-overlay)',
        pt: 0.5,
        pb: 1,
        mb: 2,
        borderBottom: 1,
        borderColor: 'divider',
      }}
      data-testid="lab-review-filters"
    >
      <TextField
        size="small"
        fullWidth
        value={query}
        placeholder={SEARCH_PLACEHOLDER}
        onChange={(event) => onQueryChange(event.target.value)}
        slotProps={{
          htmlInput: { 'aria-label': 'Search results' },
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
            endAdornment: query ? (
              <InputAdornment position="end">
                <IconButton size="small" edge="end" aria-label="Clear search" onClick={() => onQueryChange('')}>
                  <ClearIcon fontSize="small" />
                </IconButton>
              </InputAdornment>
            ) : null,
          },
        }}
      />
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        role="group"
        aria-label="Show only"
        sx={{
          mt: 1,
          // One scrolling row on a phone; wrapped from `sm` up.
          flexWrap: { xs: 'nowrap', sm: 'wrap' },
          overflowX: { xs: 'auto', sm: 'visible' },
          pb: { xs: 0.5, sm: 0 },
          '& > *': { flexShrink: 0 },
        }}
      >
        {LAB_REVIEW_FILTERS.map((key) => {
          const selected = filter === key;
          return (
            <Chip
              key={key}
              size="small"
              label={`${LAB_REVIEW_FILTER_LABELS[key]} (${counts[key]})`}
              icon={selected ? <SelectedIcon /> : undefined}
              variant={selected ? 'filled' : 'outlined'}
              color={selected ? 'primary' : 'default'}
              onClick={() => onFilterChange(selected ? null : key)}
              disabled={!selected && counts[key] === 0}
              aria-pressed={selected}
              data-testid={`lab-review-filter-${key}`}
            />
          );
        })}
      </Stack>
      <Stack direction="row" spacing={1} sx={{ mt: 0.75, alignItems: 'center', justifyContent: 'space-between', minHeight: 30 }}>
        <Typography variant="body2" color="text.secondary" aria-live="polite" data-testid="lab-review-showing">
          Showing {shown} of {total} {total === 1 ? 'result' : 'results'}
        </Typography>
        {active && (
          <Button size="small" onClick={onClear} sx={{ flexShrink: 0 }}>
            {CLEAR_FILTERS_LABEL}
          </Button>
        )}
      </Stack>
    </Box>
  );
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
  issues,
  request = null,
}: LabReportReviewProps) {
  const idPrefix = useId();
  const [adding, setAdding] = useState(false);
  const [newValue, setNewValue] = useState<LabReportValue>(emptyLabResult);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rejectUnmatchedOpen, setRejectUnmatchedOpen] = useState(false);
  // #317: reasons are hidden until the badge is tapped; a hover pointer also gets a tooltip.
  const canHover = useMediaQuery('(hover: hover)');
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [scrollToId, setScrollToId] = useState<string | null>(null);
  const [rejectedOpen, setRejectedOpen] = useState(false);
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LabReviewFilter | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const filtersRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (queryInput === query) return;
    const timer = setTimeout(() => setQuery(queryInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [queryInput, query]);

  const clearFilters = () => {
    setQueryInput('');
    setQuery('');
    setFilter(null);
  };

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

  // #317: what each row needs before saving, and the filters over them.
  const isDuplicate = (item: DraftItemView<LabReportValue>) => item.status !== 'rejected' && (duplicateDates?.has(item.id) ?? false);
  const reasonsById = new Map(
    ordered.map((item) => [
      item.id,
      labAttentionReasons(item, {
        issues: issues?.get(item.id),
        undecidedDuplicate: isDuplicate(item) && !(keptDuplicateIds?.has(item.id) ?? false),
      }),
    ]),
  );
  const reasonsOf = (item: DraftItemView<LabReportValue>) => reasonsById.get(item.id) ?? [];
  const STATUS_TEST: Record<LabReviewFilter, (item: DraftItemView<LabReportValue>) => boolean> = {
    attention: (item) => reasonsOf(item).length > 0,
    unmatched: isUnresolved,
    duplicate: isDuplicate,
    pending: (item) => item.status === 'pending',
  };
  const counts = Object.fromEntries(
    LAB_REVIEW_FILTERS.map((key) => [key, active.filter(STATUS_TEST[key]).length]),
  ) as Record<LabReviewFilter, number>;
  const filtering = filter !== null || query.trim() !== '';
  const isShown = (item: DraftItemView<LabReportValue>) =>
    (filter === null || STATUS_TEST[filter](item)) && labResultMatches(item.value, query, catalog);
  const shownActive = active.filter(isShown);
  const shownRejected = rejected.filter(isShown);

  // #317: the dialog asks to reveal a row or to apply a filter. Read through a
  // ref so the request is handled once, not again whenever the items change.
  const latest = useRef({ ordered, isShown });
  latest.current = { ordered, isShown };
  useEffect(() => {
    if (!request) return;
    if (request.type === 'filter') {
      setQueryInput('');
      setQuery('');
      setFilter(request.filter);
      filtersRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    const item = latest.current.ordered.find((entry) => entry.id === request.itemId);
    if (!item) return;
    if (!latest.current.isShown(item)) {
      setQueryInput('');
      setQuery('');
      setFilter(null);
    }
    if (item.status === 'rejected') setRejectedOpen(true);
    setExpandedIds((current) => new Set([...current, item.id]));
    setHighlightId(item.id);
    setScrollToId(item.id);
    const timer = setTimeout(() => setHighlightId((current) => (current === item.id ? null : current)), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [request]);
  // After the render that shows the row (filters cleared): scroll to it and move focus there.
  useEffect(() => {
    if (!scrollToId) return;
    const target = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-testid="lab-result-row"]') ?? [])].find(
      (element) => element.getAttribute('data-item-id') === scrollToId,
    );
    target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    target?.focus({ preventScroll: true });
    setScrollToId(null);
  }, [scrollToId]);

  const toggleReasons = (id: string) =>
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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

  const row = (item: DraftItemView<LabReportValue>) => {
    const reasons = reasonsOf(item);
    // A closer look (unsure, low confidence, a suggested match) or something to fix before saving.
    const attention = needsAttention(item) || reasons.length > 0;
    const highlighted = highlightId === item.id;
    return (
      <Box
        role="listitem"
        key={item.id}
        tabIndex={-1}
        data-testid="lab-result-row"
        data-item-id={item.id}
        data-attention={attention ? 'true' : 'false'}
        data-blocking={reasons.length > 0 ? 'true' : 'false'}
        data-unresolved={isUnresolved(item) ? 'true' : 'false'}
        data-duplicate={isDuplicate(item) ? 'true' : 'false'}
        data-highlighted={highlighted ? 'true' : undefined}
        sx={{
          borderRadius: 1,
          outline: '2px solid transparent',
          outlineOffset: 2,
          transition: 'outline-color 300ms, background-color 300ms',
          '&:focus': { outline: '2px solid transparent' },
          ...(attention && item.status !== 'rejected' ? { borderLeft: 4, borderColor: 'warning.main', pl: 1 } : {}),
          ...(highlighted ? { outlineColor: (theme) => theme.palette.warning.main, bgcolor: 'action.hover' } : {}),
        }}
      >
        {reasons.length > 0 && (
          <AttentionBadge
            printed={item.value.nameAsPrinted ?? 'this result'}
            reasons={reasons}
            expanded={expandedIds.has(item.id)}
            canHover={canHover}
            onToggle={() => toggleReasons(item.id)}
          />
        )}
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
  };

  return (
    <Box data-testid="lab-report-review" ref={rootRef}>
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

      {ordered.length > 0 && (
        <Box ref={filtersRef}>
          <FilterBar
            query={queryInput}
            onQueryChange={(next) => {
              setQueryInput(next);
              if (next === '') setQuery('');
            }}
            filter={filter}
            onFilterChange={setFilter}
            counts={counts}
            shown={shownActive.length + shownRejected.length}
            total={ordered.length}
            active={filtering || queryInput !== ''}
            onClear={clearFilters}
          />
        </Box>
      )}

      {active.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {rejected.length > 0 ? 'Every result was rejected.' : 'No results were read.'} Add anything that is missing above.
        </Typography>
      ) : shownActive.length === 0 ? (
        <Box
          sx={{ textAlign: 'center', py: 3, mb: 2, border: 1, borderStyle: 'dashed', borderColor: 'divider', borderRadius: 1 }}
          data-testid="lab-review-no-match"
        >
          <Typography variant="body2" sx={{ mb: 1 }}>
            {NO_MATCH_TEXT}
          </Typography>
          <Button size="small" variant="outlined" onClick={clearFilters}>
            {CLEAR_FILTERS_LABEL}
          </Button>
        </Box>
      ) : (
        <Stack spacing={3} sx={{ mb: 2 }}>
          {dateGroups.map((dateGroup, dateIndex) => {
            const dateHeadingId = `${idPrefix}-date-${dateIndex}`;
            const shownInDate = dateGroup.items.filter(isShown);
            if (shownInDate.length === 0) return null;
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
                  {filtering
                    ? dateGroupHeading(dateGroup.date, shownInDate.length, dateGroup.items.length)
                    : dateGroupHeading(dateGroup.date, dateGroup.items.length)}
                </Typography>
                <Stack spacing={2}>
                  {groupByPanel(dateGroup.items).map((group) => {
                    const headingId = `${dateHeadingId}-panel-${group.panel}`;
                    const shownInPanel = group.items.filter(isShown);
                    if (shownInPanel.length === 0) return null;
                    return (
                      <Box
                        component="section"
                        key={group.panel}
                        aria-labelledby={headingId}
                        data-testid="lab-panel"
                        data-panel={group.panel}
                      >
                        <Typography id={headingId} variant="subtitle2" component="h4" sx={{ fontWeight: 600, mb: 1 }}>
                          {LAB_PANEL_LABELS[group.panel]} (
                          {filtering ? `${shownInPanel.length} of ${group.items.length}` : group.items.length})
                        </Typography>
                        <Stack spacing={1.5} role="list" aria-labelledby={headingId}>
                          {shownInPanel.map(row)}
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

      {shownRejected.length > 0 && (
        <Accordion disableGutters variant="outlined" expanded={rejectedOpen} onChange={(_, open) => setRejectedOpen(open)}>
          <AccordionSummary expandIcon={<ExpandIcon />}>
            <Typography variant="subtitle2">
              Rejected ({filtering ? `${shownRejected.length} of ${rejected.length}` : rejected.length})
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Stack spacing={1.5} role="list" aria-label="Rejected results">
              {shownRejected.map(row)}
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
