/**
 * The lab report review, H4 (#188): every printed result grouped by panel,
 * each with Accept / Edit / Reject, plus "Accept all" and "Add missing value".
 *
 * Why not `AiDraftReview`: it lists items in one flat `sortOrder` list, and a
 * 30-row blood panel reads by panel. This component keeps the kit's row
 * (`DraftItemRow`: provenance, confidence as text, the AI's uncertainty note,
 * "AI said: …", source thumbnails, Accept / Edit / Reject / Restore) and only
 * adds the grouping, the mapping strip and the lab-specific counts.
 *
 * - Rows that need a closer look (unsure, low confidence, a suggested match,
 *   or unmatched) are highlighted (`data-attention`), never hidden.
 * - An UNMATCHED row carries a "Map to an analyte" picker: picking one sends
 *   the edit (`value.analyteKey`); the server re-matches and converts. The
 *   alternative is Reject. Unknown analytes are never silently dropped.
 * - Rejected rows move into "Rejected (n)" with Restore.
 */
import { useMemo, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import { Add as AddIcon, DoneAll as AcceptAllIcon, ExpandMore as ExpandIcon } from '@mui/icons-material';
import { DraftItemRow } from '../intake';
import type { DraftItemView } from '../../services/intake';
import type { MetricCatalog } from '../../services/health';
import {
  LAB_PANEL_LABELS,
  emptyLabResult,
  groupByPanel,
  isUnresolved,
  needsAttention,
  type LabReportValue,
} from '../../services/labReport';
import { AnalytePicker, LabResultEditor, LabResultView } from './LabResultValue';
import { DEFAULT_LAB_UNITS, labUnitsNote, type LabUnits } from '../../utils/labUnits';

export const ADD_MISSING_VALUE_LABEL = 'Add missing value';

export interface LabReportReviewProps {
  items: DraftItemView<LabReportValue>[];
  photos: { storageObjectId: string; name: string }[];
  catalog: MetricCatalog | null;
  /** #234: the unit system values are shown in (and new analytes default to). */
  labUnits?: LabUnits;
  busy?: boolean;
  /** Item ids the server last refused as unresolved (shown with an error border). */
  refusedIds?: readonly string[];
  onAcceptItem: (id: string) => void;
  onRejectItem: (id: string) => void;
  onRestoreItem: (id: string) => void;
  onEditItem: (id: string, value: LabReportValue) => void;
  onAddItem: (value: LabReportValue) => void;
  onAcceptAll: () => void;
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
  onAcceptItem,
  onRejectItem,
  onRestoreItem,
  onEditItem,
  onAddItem,
  onAcceptAll,
}: LabReportReviewProps) {
  const [adding, setAdding] = useState(false);
  const [newValue, setNewValue] = useState<LabReportValue>(emptyLabResult);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const photoNames = useMemo(
    () => new Map(photos.map((photo) => [photo.storageObjectId, photo.name] as const)),
    [photos],
  );
  const ordered = useMemo(() => [...items].sort((a, b) => a.sortOrder - b.sortOrder), [items]);
  const active = ordered.filter((item) => item.status !== 'rejected');
  const rejected = ordered.filter((item) => item.status === 'rejected');
  const pending = active.filter((item) => item.status === 'pending');
  const lowPending = pending.filter((item) => item.confidence === 'low').length;
  const groups = groupByPanel(active);
  const refused = new Set(refusedIds);

  const renderValue = (item: DraftItemView<LabReportValue>) => (
    <LabResultView value={item.value} catalog={catalog} labUnits={labUnits} />
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
      sx={needsAttention(item) && item.status !== 'rejected' ? { borderLeft: 4, borderColor: 'warning.main', pl: 1 } : undefined}
    >
      <DraftItemRow<LabReportValue> item={item} {...rowProps} />
      {isUnresolved(item) && (
        <MapStrip
          item={item}
          catalog={catalog}
          busy={busy}
          refused={refused.has(item.id)}
          onMap={(analyteKey) => onEditItem(item.id, { ...item.value, analyteKey })}
        />
      )}
    </Box>
  );

  return (
    <Box data-testid="lab-report-review">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }} data-testid="lab-units-note">
        {labUnitsNote(labUnits)}. Edits are saved in the unit you pick.
      </Typography>
      {active.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {rejected.length > 0 ? 'Every result was rejected.' : 'No results were read.'} Add anything that is missing below.
        </Typography>
      ) : (
        <Stack spacing={3} sx={{ mb: 2 }}>
          {groups.map((group) => {
            const headingId = `lab-panel-${group.panel}`;
            return (
              <Box component="section" key={group.panel} aria-labelledby={headingId} data-testid="lab-panel" data-panel={group.panel}>
                <Typography id={headingId} variant="subtitle1" component="h3" sx={{ fontWeight: 600, mb: 1 }}>
                  {LAB_PANEL_LABELS[group.panel]} ({group.items.length})
                </Typography>
                <Stack spacing={1.5} role="list" aria-labelledby={headingId}>
                  {group.items.map(row)}
                </Stack>
              </Box>
            );
          })}
        </Stack>
      )}

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

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 2 }}>
        <Button variant="contained" startIcon={<AcceptAllIcon />} onClick={acceptAll} disabled={busy || pending.length === 0}>
          Accept all ({pending.length})
        </Button>
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
