/**
 * Automatic adjustments are paused (E5.8): why, in fixed copy, and
 * **Resume automatic adjustments** after the owner confirms they read it
 * (`POST /api/programs/:id/autonomy/resume`, `programs:write`).
 *
 * While paused the coach still reviews the plan but changes nothing, except
 * removing an exercise that keeps hurting. None of this copy tells anyone to
 * train through pain.
 */
import { useState } from 'react';
import { Alert, AlertTitle, Button, Typography } from '@mui/material';
import type { AutonomyPauseReason } from '../../services/programs';
import { ConfirmDialog } from '../gyms/ConfirmDialog';

export const PAUSE_REASON_COPY: Record<AutonomyPauseReason, string> = {
  safety_text:
    'A recent pain note mentioned a symptom that needs attention. If it is severe, sudden or getting worse, seek medical ' +
    'care. Talk to a doctor or physiotherapist before you train the affected area again.',
  pain_pattern:
    'Pain keeps coming back in your recent sessions. A qualified professional, such as a doctor or physiotherapist, can ' +
    'help find the cause. Until you resume, your coach will not increase loads or volume.',
  user_paused: 'You paused automatic adjustments. Your coach will review the plan but not change it.',
};

export const RESUME_CONFIRM_MESSAGE =
  'I have read the message above. Your coach will adjust the plan again within its safety limits, and will still ' +
  'remove exercises that keep causing pain.';

export interface AutomationPausedBannerProps {
  reason: AutonomyPauseReason | null;
  canWrite: boolean;
  onResume: () => Promise<unknown>;
}

export function AutomationPausedBanner({ reason, canWrite, onResume }: AutomationPausedBannerProps) {
  const [open, setOpen] = useState(false);
  const copy = PAUSE_REASON_COPY[reason ?? 'user_paused'] ?? PAUSE_REASON_COPY.user_paused;
  const safety = reason === 'safety_text' || reason === 'pain_pattern';
  return (
    <>
      <Alert severity={safety ? 'warning' : 'info'} role="status" data-testid="automation-paused" sx={{ '& .MuiAlert-message': { width: '100%' } }}>
        <AlertTitle>Automatic adjustments are paused</AlertTitle>
        <Typography variant="body2">{copy}</Typography>
        {canWrite && (
          <Button variant="outlined" color="inherit" size="small" onClick={() => setOpen(true)} sx={{ mt: 1, minHeight: 40 }}>
            Resume automatic adjustments
          </Button>
        )}
      </Alert>
      <ConfirmDialog
        open={open}
        title="Resume automatic adjustments?"
        message={RESUME_CONFIRM_MESSAGE}
        confirmLabel="Resume"
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          await onResume();
          setOpen(false);
        }}
      />
    </>
  );
}

export default AutomationPausedBanner;
