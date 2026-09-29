/**
 * One draft item in `AiDraftReview`: its value, where it came from, how sure
 * the AI was, and Accept / Edit / Reject.
 *
 * Provenance is always visible, never implied:
 * - "AI guess" while an AI item is untouched (`origin === 'ai' && !userVerified`),
 * - "You verified" once the user accepted or edited it,
 * - "You added" for an item the user created,
 * - the confidence as TEXT (`ConfidenceBadge`), an "Unsure" flag with the AI's
 *   note when it said it was not sure, and "AI said: …" once an AI item was
 *   edited (`originalAiValue`).
 *
 * Source photo thumbnails load lazily through signed URLs; a photo that is no
 * longer attached shows "photo removed".
 */
import { useState, type ReactNode } from 'react';
import { Box, Button, Chip, Stack, Typography } from '@mui/material';
import {
  Check as AcceptIcon,
  Close as RejectIcon,
  EditOutlined as EditIcon,
  HelpOutlined as UnsureIcon,
  Undo as RestoreIcon,
} from '@mui/icons-material';
import type { DraftItemView } from '../../services/intake';
import { ConfidenceBadge } from './ConfidenceBadge';
import { StoragePhotoThumb } from './StoragePhotoThumb';

export interface DraftItemEditorProps<TValue> {
  value: TValue;
  onChange: (value: TValue) => void;
}

export interface DraftItemRowProps<TValue> {
  item: DraftItemView<TValue>;
  /** storageObjectId → file name, for the photos still attached. */
  photoNames: ReadonlyMap<string, string>;
  renderValue: (item: DraftItemView<TValue>) => ReactNode;
  renderEditor: (props: DraftItemEditorProps<TValue>) => ReactNode;
  busy?: boolean;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onRestore: (id: string) => void;
  onEdit: (id: string, value: TValue) => void;
}

/** The provenance tag of an item. */
export function provenanceLabel(item: Pick<DraftItemView, 'origin' | 'userVerified'>): string {
  if (item.origin === 'user') return 'You added';
  return item.userVerified ? 'You verified' : 'AI guess';
}

export function DraftItemRow<TValue>({
  item,
  photoNames,
  renderValue,
  renderEditor,
  busy = false,
  onAccept,
  onReject,
  onRestore,
  onEdit,
}: DraftItemRowProps<TValue>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TValue>(item.value);
  const rejected = item.status === 'rejected';
  const provenance = provenanceLabel(item);

  const startEdit = () => {
    setDraft(item.value);
    setEditing(true);
  };
  const save = () => {
    onEdit(item.id, draft);
    setEditing(false);
  };

  return (
    <Box
      data-testid="draft-item-row"
      data-item-id={item.id}
      data-status={item.status}
      sx={{
        border: 1,
        borderColor: item.confidence === 'low' || item.uncertain ? 'warning.main' : 'divider',
        borderRadius: 1,
        p: { xs: 1.5, sm: 2 },
        bgcolor: 'background.paper',
        opacity: rejected ? 0.75 : 1,
      }}
    >
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', mb: 1 }}>
        <Chip
          size="small"
          label={provenance}
          color={provenance === 'AI guess' ? 'secondary' : 'primary'}
          variant={provenance === 'AI guess' ? 'outlined' : 'filled'}
        />
        {item.origin === 'ai' && <ConfidenceBadge confidence={item.confidence} />}
        {item.uncertain && <Chip size="small" color="warning" icon={<UnsureIcon />} label="Unsure" variant="outlined" />}
        {item.status === 'accepted' && <Chip size="small" color="success" label="Accepted" variant="outlined" />}
        {rejected && <Chip size="small" label="Rejected" variant="outlined" />}
      </Stack>

      {editing ? (
        <Box sx={{ mb: 1 }}>
          {renderEditor({ value: draft, onChange: setDraft })}
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Button size="small" variant="contained" onClick={save} disabled={busy}>
              Save
            </Button>
            <Button size="small" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </Stack>
        </Box>
      ) : (
        <Box sx={{ mb: 1, minWidth: 0, wordBreak: 'break-word' }}>{renderValue(item)}</Box>
      )}

      {item.uncertain && (
        <Typography variant="body2" color="warning.main" sx={{ mb: 1 }} data-testid="draft-item-uncertainty">
          {item.uncertaintyNote ? `AI is unsure: ${item.uncertaintyNote}` : 'AI is unsure about this item.'}
        </Typography>
      )}

      {item.originalAiValue !== null && item.originalAiValue !== undefined && (
        <Box sx={{ mb: 1, color: 'text.secondary', typography: 'body2' }} data-testid="draft-item-ai-said">
          <Box component="span" sx={{ fontWeight: 600 }}>
            AI said:{' '}
          </Box>
          <Box component="span">{renderValue({ ...item, value: item.originalAiValue, originalAiValue: null })}</Box>
        </Box>
      )}

      {item.sourcePhotoIds.length > 0 && (
        <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', mb: 1 }} aria-label="Source photos">
          {item.sourcePhotoIds.map((id) => {
            const name = photoNames.get(id);
            return <StoragePhotoThumb key={id} storageObjectId={name !== undefined ? id : null} name={name ?? 'Source photo'} />;
          })}
        </Stack>
      )}

      {!editing && (
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {rejected ? (
            <Button size="small" startIcon={<RestoreIcon />} onClick={() => onRestore(item.id)} disabled={busy}>
              Restore
            </Button>
          ) : (
            <>
              {item.status !== 'accepted' && (
                <Button size="small" variant="contained" startIcon={<AcceptIcon />} onClick={() => onAccept(item.id)} disabled={busy}>
                  Accept
                </Button>
              )}
              <Button size="small" startIcon={<EditIcon />} onClick={startEdit} disabled={busy}>
                Edit
              </Button>
              <Button size="small" color="error" startIcon={<RejectIcon />} onClick={() => onReject(item.id)} disabled={busy}>
                Reject
              </Button>
            </>
          )}
        </Stack>
      )}
    </Box>
  );
}

export default DraftItemRow;
