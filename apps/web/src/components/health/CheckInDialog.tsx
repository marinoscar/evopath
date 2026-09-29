/**
 * The daily check-in dialog, issue #56 (E2.4): four optional 1-to-5 scores
 * (energy, sleep quality, muscle soreness, stress) and a note, for ONE local
 * day. It should take seconds: tap, tap, tap, tap, Save.
 *
 * - `date` is the day the dialog was opened for (the server's "today"). A save
 *   after midnight still goes to that day, and the dialog says which day it
 *   is; the API decides whether the day is still inside its 7-day window.
 * - Saving replaces the day's check-in; at least one score is required (Save
 *   stays disabled otherwise). Clearing a whole day is Delete, behind a
 *   confirmation.
 * - A `409` means another device saved the same day first: the dialog says
 *   so and the caller reloads it (`onConflict`); the new values are shown.
 *
 * The score bounds and end labels come from the measurement catalog. Nothing
 * entered here is logged or put in a URL.
 */

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Snackbar,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { ApiError } from '../../services/api';
import {
  CHECK_IN_NOTE_MAX_LENGTH,
  HEALTH_DATA_UNAVAILABLE,
  isCheckInConflict,
  isHealthDataForbidden,
  validationIssues,
  type CheckIn,
  type CheckInField,
  type CheckInInput,
} from '../../services/health';
import { useMeasurementCatalog } from '../../hooks/useMeasurementCatalog';
import { usePermissions } from '../../hooks/usePermissions';
import { formatLongDate } from '../../utils/localDates';
import { ScoreField } from './ScoreField';
import { checkInFieldDefs } from './CheckInSummary';

export const CHECK_IN_CONFLICT_MESSAGE =
  'This check-in was updated elsewhere. The latest version is shown; review it and save again.';

type Scores = Record<CheckInField, number | null>;

const EMPTY_SCORES: Scores = { energy: null, sleepQuality: null, soreness: null, stress: null };

type Failure =
  | { kind: 'forbidden' }
  | { kind: 'conflict' }
  | { kind: 'rejected'; message: string }
  | { kind: 'network' };

export interface CheckInDialogProps {
  open: boolean;
  /** `YYYY-MM-DD`: the day this saves to, fixed when the dialog opens. */
  date: string;
  /** That day's stored check-in (edit mode), or `null` (a new one). */
  checkIn: CheckIn | null;
  onClose: () => void;
  onSave: (date: string, input: CheckInInput) => Promise<unknown>;
  onDelete: (date: string) => Promise<unknown>;
  /** Called after a `409`, to reload the day; the dialog re-fills from the new `checkIn`. */
  onConflict?: () => void;
}

function scoresOf(checkIn: CheckIn | null): Scores {
  if (!checkIn) return EMPTY_SCORES;
  return {
    energy: checkIn.energy,
    sleepQuality: checkIn.sleepQuality,
    soreness: checkIn.soreness,
    stress: checkIn.stress,
  };
}

export function CheckInDialog({
  open,
  date,
  checkIn,
  onClose,
  onSave,
  onDelete,
  onConflict,
}: CheckInDialogProps) {
  const theme = useTheme();
  // A local layout choice for this dialog, NOT one of the five coupled `sm`
  // shell gates (docs/specs/settings-ui.md#breakpoint-gates).
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('health_data:write');
  const { catalog, isLoading: catalogLoading, error: catalogError } = useMeasurementCatalog({
    enabled: open && canWrite,
  });
  const defs = useMemo(() => checkInFieldDefs(catalog), [catalog]);

  const [scores, setScores] = useState<Scores>(EMPTY_SCORES);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'saving' | 'deleting' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string }>({ open: false, message: '' });
  const busyRef = useRef(false);
  const idBase = useId();

  // A fresh form on every opening.
  useEffect(() => {
    if (!open) return;
    setFailure(null);
    setConfirmDelete(false);
    setNoteError(null);
  }, [open]);

  // Prefill from the stored day; again when it is reloaded after a conflict.
  useEffect(() => {
    if (!open) return;
    setScores(scoresOf(checkIn));
    setNote(checkIn?.note ?? '');
    // Keyed on the stored version, not the object: a parent re-render must
    // not wipe what the user is tapping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, date, checkIn?.updatedAt]);

  const hasScore = Object.values(scores).some((value) => value !== null);
  const editing = checkIn !== null;
  const ready = !!catalog && defs.every((def) => def.scale !== null);

  const setScore = (field: CheckInField, value: number | null) => {
    setScores((prev) => ({ ...prev, [field]: value }));
    setFailure((prev) => (prev?.kind === 'conflict' ? prev : null));
  };

  const run = async (kind: 'saving' | 'deleting', action: () => Promise<unknown>, done: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(kind);
    setFailure(null);
    try {
      await action();
      setSnackbar({ open: true, message: done });
      onClose();
    } catch (err) {
      if (isHealthDataForbidden(err)) {
        setFailure({ kind: 'forbidden' });
      } else if (isCheckInConflict(err)) {
        setFailure({ kind: 'conflict' });
        setConfirmDelete(false);
        onConflict?.();
      } else if (validationIssues(err).length > 0) {
        const issues = validationIssues(err);
        const noteIssue = issues.find((issue) => issue.path === 'note');
        if (noteIssue) setNoteError(noteIssue.message);
        const other = issues.find((issue) => issue.path !== 'note');
        if (other) setFailure({ kind: 'rejected', message: other.message });
      } else if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        setFailure({ kind: 'rejected', message: err.message });
      } else {
        setFailure({ kind: 'network' });
      }
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!hasScore || !ready || confirmDelete) return;
    const trimmed = note.trim();
    if (trimmed.length > CHECK_IN_NOTE_MAX_LENGTH) {
      setNoteError(`Note must be at most ${CHECK_IN_NOTE_MAX_LENGTH} characters`);
      return;
    }
    const input: CheckInInput = { ...scores, note: trimmed === '' ? null : trimmed };
    void run('saving', () => onSave(date, input), 'Check-in saved');
  };

  const disabled = busy !== null;
  const titleId = `${idBase}-title`;
  const dateId = `${idBase}-date`;

  return (
    <>
      <Dialog
        open={open && canWrite}
        onClose={disabled ? undefined : onClose}
        fullScreen={fullScreen}
        fullWidth
        maxWidth="xs"
        aria-labelledby={titleId}
        aria-describedby={dateId}
      >
        <Box
          component="form"
          noValidate
          onSubmit={onSubmit}
          sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' }}
        >
          <DialogTitle id={titleId} sx={{ pb: 0.5 }}>
            Daily check-in
          </DialogTitle>
          <Typography id={dateId} color="text.secondary" sx={{ px: 3, pb: 1.5 }}>
            {formatLongDate(date, new Date().getFullYear())}
          </Typography>
          <DialogContent dividers>
            {catalogLoading && (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                <CircularProgress aria-label="Loading" />
              </Box>
            )}

            {/* No catalog, or one without the four wellness scales: nothing to tap. */}
            {!catalogLoading && ((catalogError && !catalog) || (catalog && !ready)) && (
              <Alert severity="error">
                Could not load the check-in scales. Close this dialog and try again later.
              </Alert>
            )}

            {ready && (
              <Stack spacing={2.5}>
                <Typography variant="body2" color="text.secondary">
                  Every score is optional. Tap a selected number again to clear it.
                </Typography>
                {defs.map(({ field, label, scale }) => (
                  <ScoreField
                    key={field}
                    id={`${idBase}-${field}`}
                    label={label}
                    scale={scale!}
                    value={scores[field]}
                    onChange={(value) => setScore(field, value)}
                    disabled={disabled}
                  />
                ))}
                <TextField
                  id={`${idBase}-note`}
                  label="Note"
                  value={note}
                  onChange={(event) => {
                    setNote(event.target.value);
                    setNoteError(null);
                  }}
                  error={!!noteError}
                  helperText={noteError ?? `${note.length}/${CHECK_IN_NOTE_MAX_LENGTH}`}
                  disabled={disabled}
                  multiline
                  minRows={2}
                  fullWidth
                  slotProps={{ htmlInput: { maxLength: CHECK_IN_NOTE_MAX_LENGTH } }}
                />
              </Stack>
            )}
          </DialogContent>

          {(failure || confirmDelete || (ready && !hasScore)) && (
            <Box sx={{ px: 3, pt: 2 }}>
              <Stack spacing={1}>
                {ready && !hasScore && !confirmDelete && (
                  <Typography variant="body2" color="text.secondary">
                    Choose at least one score to save.
                  </Typography>
                )}
                {confirmDelete && (
                  <Alert
                    severity="warning"
                    action={
                      <Stack direction="row" spacing={1} sx={{ alignSelf: 'center' }}>
                        <Button color="inherit" size="small" disabled={disabled} onClick={() => setConfirmDelete(false)}>
                          Keep
                        </Button>
                        <Button
                          color="inherit"
                          size="small"
                          disabled={disabled}
                          onClick={() => void run('deleting', () => onDelete(date), 'Check-in deleted')}
                        >
                          {busy === 'deleting' ? 'Deleting…' : 'Delete'}
                        </Button>
                      </Stack>
                    }
                  >
                    Delete this day&apos;s check-in?
                  </Alert>
                )}
                {failure?.kind === 'forbidden' && <Alert severity="error">{HEALTH_DATA_UNAVAILABLE}</Alert>}
                {failure?.kind === 'conflict' && <Alert severity="warning">{CHECK_IN_CONFLICT_MESSAGE}</Alert>}
                {failure?.kind === 'rejected' && <Alert severity="error">{failure.message}</Alert>}
                {failure?.kind === 'network' && (
                  <Alert severity="error">Could not save. Check your connection and try again.</Alert>
                )}
              </Stack>
            </Box>
          )}

          <DialogActions sx={{ flexWrap: 'wrap' }}>
            {editing && !confirmDelete && (
              <Button color="inherit" onClick={() => setConfirmDelete(true)} disabled={disabled} sx={{ mr: 'auto' }}>
                Delete check-in
              </Button>
            )}
            <Button onClick={onClose} disabled={disabled}>
              Cancel
            </Button>
            <Button type="submit" variant="contained" disabled={disabled || !ready || !hasScore || confirmDelete}>
              {busy === 'saving' ? 'Saving…' : 'Save'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
        message={snackbar.message}
      />
    </>
  );
}

export default CheckInDialog;
