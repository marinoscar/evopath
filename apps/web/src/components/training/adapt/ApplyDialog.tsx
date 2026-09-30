/**
 * Confirm what applying the adjusted workout does, then (for "Update my
 * plan") offer to start it. "Use for today only" creates today's workout and
 * leaves the plan alone; "Update my plan" saves a new plan version whose
 * today's session is the adjusted one (undo it from the plan's history).
 *
 * Full-screen on compact windows (the `useCompactDialog` idiom). The parent
 * makes the call and explains a refusal; this dialog only asks and reports.
 */
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';
import { useCompactDialog } from '../../gyms/useCompactDialog';

export type ApplyMode = 'workout' | 'plan';

export interface ApplyDialogProps {
  /** Which apply is being confirmed; null closes the dialog. */
  mode: ApplyMode | null;
  busy: boolean;
  /** Set after "Update my plan" succeeded: the new plan version. */
  planDone: { versionNumber: number } | null;
  /** `workouts:write`: Start is offered after the plan update. */
  canStart: boolean;
  starting?: boolean;
  startError?: string | null;
  onConfirm: () => void;
  onStart: () => void;
  onClose: () => void;
}

const COPY: Record<ApplyMode, { title: string; body: string; confirm: string }> = {
  workout: {
    title: 'Use for today only?',
    body: "This starts today's workout with the adjusted exercises. Your plan stays as it is. You can change sets and exercises in the logger.",
    confirm: 'Start adjusted workout',
  },
  plan: {
    title: 'Update my plan?',
    body: "This saves a new version of your plan in which today's session is the adjusted one. Nothing else in the plan changes, and you can undo it from the plan's history.",
    confirm: 'Update my plan',
  },
};

export function ApplyDialog({
  mode,
  busy,
  planDone,
  canStart,
  starting = false,
  startError = null,
  onConfirm,
  onStart,
  onClose,
}: ApplyDialogProps) {
  const fullScreen = useCompactDialog();
  const open = mode !== null;
  const copy = COPY[mode ?? 'workout'];
  const locked = busy || starting;

  return (
    <Dialog
      open={open}
      onClose={locked ? undefined : onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="xs"
      aria-labelledby="apply-dialog-title"
    >
      {planDone ? (
        <>
          <DialogTitle id="apply-dialog-title">Plan updated</DialogTitle>
          <DialogContent>
            <DialogContentText>
              Version {planDone.versionNumber} of your plan uses the adjusted workout today. You can undo it from the
              plan&apos;s history.
            </DialogContentText>
            {startError && (
              <Alert severity="warning" sx={{ mt: 2 }}>
                {startError}
              </Alert>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose} disabled={starting}>
              Not now
            </Button>
            {canStart && (
              <Button variant="contained" onClick={onStart} disabled={starting} autoFocus>
                {starting ? 'Starting…' : 'Start workout'}
              </Button>
            )}
          </DialogActions>
        </>
      ) : (
        <>
          <DialogTitle id="apply-dialog-title">{copy.title}</DialogTitle>
          <DialogContent>
            <DialogContentText>{copy.body}</DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="contained" onClick={onConfirm} disabled={busy} autoFocus>
              {busy ? 'Working…' : copy.confirm}
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}

export default ApplyDialog;
