/**
 * "Your plan was adjusted" (E5.8): the latest applied AI change the owner has
 * not seen yet, on the plan viewer and the Today card. Not modal; it never
 * blocks the workout flow.
 *
 * - **Review** goes to the plan history and marks the change seen.
 * - **Undo** reverts it in one tap (`POST /revert { changeLogId }`), then a
 *   snackbar says the coach will not suggest it again for 14 days.
 * - **Dismiss** marks it seen (`POST .../change-log/seen`).
 *
 * The API decides whether the change can still be undone (the latest applied
 * change only); a refusal is shown in place.
 */
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, AlertTitle, Button, Snackbar, Stack, Typography } from '@mui/material';
import type { UseChangeLogReturn } from '../../hooks/useChangeLog';
import { isUndoable } from '../../hooks/useChangeLog';
import { PROGRAM_REFUSALS, programRefusalOf, type Program } from '../../services/programs';
import { OperationLines } from './changeLogParts';

export const UNDONE_MESSAGE = 'Undone. Your coach will not suggest this again for 14 days.';

export function undoErrorMessage(err: unknown): string {
  const reason = programRefusalOf(err);
  if (reason === PROGRAM_REFUSALS.NOT_LATEST) {
    return 'A newer change came after this one. Restore an earlier version from the history instead.';
  }
  if (reason === PROGRAM_REFUSALS.STALE_PLAN) return 'The plan changed meanwhile. Reload and try again.';
  return err instanceof Error && err.message ? err.message : 'Could not undo the change';
}

export interface PlanAdjustedBannerProps {
  programId: string;
  changeLog: UseChangeLogReturn;
  /** `programs:write`: Undo and Dismiss are offered. */
  canWrite: boolean;
  /** Called with the plan's new version after an Undo. */
  onUndone?: (program: Program) => void;
  /** Show the operation lines too (the plan viewer); the Today card keeps it to the summary. */
  showOperations?: boolean;
}

export function PlanAdjustedBanner({ programId, changeLog, canWrite, onUndone, showOperations = false }: PlanAdjustedBannerProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snack, setSnack] = useState<string | null>(null);
  const entry = changeLog.unseenAiChange;

  const undo = async () => {
    if (!entry) return;
    setBusy(true);
    setError(null);
    try {
      const next = await changeLog.undo(entry);
      setSnack(UNDONE_MESSAGE);
      onUndone?.(next);
    } catch (err) {
      setError(undoErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    if (!entry) return;
    setBusy(true);
    setError(null);
    try {
      await changeLog.markSeen(entry);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not dismiss');
    } finally {
      setBusy(false);
    }
  };

  const snackbar = (
    <Snackbar open={snack !== null} autoHideDuration={6000} onClose={() => setSnack(null)} message={snack ?? ''} />
  );

  if (!entry) return snackbar;

  const historyPath = `/train/plans/${encodeURIComponent(programId)}/history`;
  const undoable = canWrite && isUndoable(entry, changeLog.latestApplied);

  return (
    <>
      <Alert severity="info" role="status" data-testid="plan-adjusted-banner" sx={{ '& .MuiAlert-message': { width: '100%' } }}>
        <AlertTitle>Your plan was adjusted</AlertTitle>
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          {entry.summary}
        </Typography>
        {showOperations && <OperationLines operations={entry.operations} label="What changed" />}
        {error && (
          <Typography variant="body2" color="error" role="alert" sx={{ mt: 0.5 }}>
            {error}
          </Typography>
        )}
        <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1, flexWrap: 'wrap' }}>
          <Button
            size="small"
            variant="outlined"
            color="inherit"
            component={RouterLink}
            to={historyPath}
            onClick={() => {
              if (canWrite) void changeLog.markSeen(entry).catch(() => undefined);
            }}
            sx={{ minHeight: 40 }}
          >
            Review
          </Button>
          {undoable && (
            <Button size="small" variant="outlined" color="inherit" onClick={() => void undo()} disabled={busy} sx={{ minHeight: 40 }}>
              Undo
            </Button>
          )}
          {canWrite && (
            <Button size="small" color="inherit" onClick={() => void dismiss()} disabled={busy} sx={{ minHeight: 40 }}>
              Dismiss
            </Button>
          )}
        </Stack>
      </Alert>
      {snackbar}
    </>
  );
}

export default PlanAdjustedBanner;
