/**
 * "Memory updated" notices under the coach's reply (#325).
 *
 * The chat stream sends a `memory` frame when a turn added, updated or deleted
 * one of the caller's memories. Each one is shown here with a Manage link to
 * `/settings/memory` and, where the API can reverse it, an Undo:
 *
 *   - `added`   → Undo deletes the new memory (`DELETE /api/memories/:id`);
 *   - `deleted` → Undo restores it (`POST /api/memories/:id/restore`);
 *   - `updated` → no Undo (the previous wording is not on the client); Manage
 *                 is the way to change it back.
 *
 * The API decides whether an undo is allowed; a refusal is shown inline.
 */
import { useState } from 'react';
import { Alert, Box, Button, Snackbar, Stack } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import type { CoachChatMemoryFrame } from '../../services/coach';
import { deleteMemory, memoryErrorMessage, restoreMemory } from '../../services/memories';

export const MEMORY_SETTINGS_PATH = '/settings/memory';

function noticeText(update: CoachChatMemoryFrame): string {
  const content = update.content.trim();
  switch (update.op) {
    case 'added':
      return content ? `Memory updated: ${content}` : 'Memory updated';
    case 'deleted':
      return content ? `Memory removed: ${content}` : 'Memory removed';
    default:
      return content ? `Memory updated: ${content}` : 'Memory updated';
  }
}

interface CoachMemoryUpdatesProps {
  updates: CoachChatMemoryFrame[];
  onDismiss: (memoryId: string) => void;
}

export function CoachMemoryUpdates({ updates, onDismiss }: CoachMemoryUpdatesProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [undone, setUndone] = useState(false);

  if (updates.length === 0 && !undone) return null;

  const undo = async (update: CoachChatMemoryFrame) => {
    setBusy(update.memoryId);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[update.memoryId];
      return next;
    });
    try {
      if (update.op === 'added') await deleteMemory(update.memoryId);
      else if (update.op === 'deleted') await restoreMemory(update.memoryId);
      onDismiss(update.memoryId);
      setUndone(true);
    } catch (err) {
      setErrors((prev) => ({ ...prev, [update.memoryId]: memoryErrorMessage(err) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {updates.length > 0 && (
        <Stack spacing={1} sx={{ mb: 2 }} data-testid="coach-memory-updates">
          {updates.map((update) => (
            <Box key={update.memoryId}>
              <Alert
                severity="info"
                variant="outlined"
                role="status"
                onClose={() => onDismiss(update.memoryId)}
                sx={{ alignItems: 'center', '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' } }}
                action={
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                    {update.op !== 'updated' && (
                      <Button
                        color="inherit"
                        size="small"
                        disabled={busy === update.memoryId}
                        onClick={() => void undo(update)}
                      >
                        Undo
                      </Button>
                    )}
                    <Button color="inherit" size="small" component={RouterLink} to={MEMORY_SETTINGS_PATH}>
                      Manage
                    </Button>
                  </Stack>
                }
              >
                {noticeText(update)}
              </Alert>
              {errors[update.memoryId] && (
                <Alert severity="error" role="alert" sx={{ mt: 0.5 }}>
                  {errors[update.memoryId]}
                </Alert>
              )}
            </Box>
          ))}
        </Stack>
      )}
      <Snackbar open={undone} autoHideDuration={3000} onClose={() => setUndone(false)} message="Memory change undone" />
    </>
  );
}
