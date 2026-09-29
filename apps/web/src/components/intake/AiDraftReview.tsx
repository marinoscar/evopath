/**
 * Review an AI draft before anything real is written — the reusable review
 * list every photo-first flow renders.
 *
 * Kind-agnostic: the caller supplies `renderValue` (the read view of one
 * value) and `renderEditor` (its inline editor, also used for "Add missing
 * item") plus the callbacks, usually `usePhotoIntake`'s mutation helpers.
 *
 * - Items keep the server's `sortOrder`. Low-confidence and uncertain items
 *   are NEVER hidden or collapsed by default.
 * - Rejected items move into a "Rejected (n)" section with Restore; they are
 *   kept, never deleted, so provenance survives.
 * - "Accept all (n)" accepts every pending item; when any of them is
 *   low-confidence it asks first and says how many.
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
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
import type { DraftItemView } from '../../services/intake';
import { DraftItemRow, type DraftItemEditorProps } from './DraftItemRow';

export interface AiDraftReviewProps<TValue> {
  items: DraftItemView<TValue>[];
  photos: { storageObjectId: string; name: string }[];
  renderValue: (item: DraftItemView<TValue>) => ReactNode;
  renderEditor: (props: DraftItemEditorProps<TValue>) => ReactNode;
  /** Starting value for "Add missing item". */
  emptyValue: TValue;
  busy?: boolean;
  onAcceptItem: (id: string) => void;
  onRejectItem: (id: string) => void;
  onRestoreItem: (id: string) => void;
  onEditItem: (id: string, value: TValue) => void;
  onAddItem: (value: TValue) => void;
  onAcceptAll: () => void;
}

export function AiDraftReview<TValue>({
  items,
  photos,
  renderValue,
  renderEditor,
  emptyValue,
  busy = false,
  onAcceptItem,
  onRejectItem,
  onRestoreItem,
  onEditItem,
  onAddItem,
  onAcceptAll,
}: AiDraftReviewProps<TValue>) {
  const [adding, setAdding] = useState(false);
  const [newValue, setNewValue] = useState<TValue>(emptyValue);
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

  const startAdd = () => {
    setNewValue(emptyValue);
    setAdding(true);
  };
  const saveAdd = () => {
    onAddItem(newValue);
    setAdding(false);
  };

  return (
    <Box data-testid="ai-draft-review">
      {active.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {rejected.length > 0 ? 'Every item was rejected.' : 'No items yet.'} Add anything that is missing below.
        </Typography>
      ) : (
        <Stack spacing={1.5} sx={{ mb: 2 }} role="list" aria-label="Draft items">
          {active.map((item) => (
            <Box role="listitem" key={item.id}>
              <DraftItemRow<TValue> item={item} {...rowProps} />
            </Box>
          ))}
        </Stack>
      )}

      {adding && (
        <Box sx={{ border: 1, borderColor: 'primary.main', borderRadius: 1, p: { xs: 1.5, sm: 2 }, mb: 2 }} data-testid="draft-item-add">
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Add missing item
          </Typography>
          {renderEditor({ value: newValue, onChange: setNewValue })}
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Button size="small" variant="contained" onClick={saveAdd} disabled={busy}>
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
        <Button variant="outlined" startIcon={<AddIcon />} onClick={startAdd} disabled={busy || adding}>
          Add missing item
        </Button>
      </Stack>

      {rejected.length > 0 && (
        <Accordion disableGutters variant="outlined">
          <AccordionSummary expandIcon={<ExpandIcon />}>
            <Typography variant="subtitle2">Rejected ({rejected.length})</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Stack spacing={1.5} role="list" aria-label="Rejected items">
              {rejected.map((item) => (
                <Box role="listitem" key={item.id}>
                  <DraftItemRow<TValue> item={item} {...rowProps} />
                </Box>
              ))}
            </Stack>
          </AccordionDetails>
        </Accordion>
      )}

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} aria-labelledby="accept-all-title">
        <DialogTitle id="accept-all-title">Accept all {pending.length} items?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {lowPending} {lowPending === 1 ? 'item has' : 'items have'} low confidence. The AI may have misread{' '}
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

export default AiDraftReview;
