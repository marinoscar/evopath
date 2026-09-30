/**
 * **Re-evaluate now** (E5.8): asks the coach to review the plan
 * (`POST /api/ai/training/runs { kind: 'evaluate', programId, trigger: 'manual' }`).
 *
 * The host renders it only with AI on and `ai:use`. It is disabled with the
 * reason when the coach cannot run (`blocker`), while automation is paused,
 * and during the 30-minute cooldown the API answers with
 * `409 TRAINING_EVALUATION_COOLDOWN` (`details.retryAfterSeconds`).
 */
import { useEffect, useId, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, Box, Button, Link, Typography } from '@mui/material';
import { Refresh as RefreshIcon } from '@mui/icons-material';
import type { TrainingBlocker } from '../../hooks/useTrainingAvailability';
import { startTrainingRun, trainingRefusalOf, TRAINING_REFUSALS } from '../../services/trainingAgents';

export const EVALUATION_QUEUED_MESSAGE = 'Your coach is reviewing your plan. Any change will show up here and in your history.';

export function cooldownMessage(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `You can ask again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

export interface ReEvaluateButtonProps {
  programId: string;
  /** Why the coach cannot run, when it cannot (from `useTrainingAvailability().blocker('evaluate')`). */
  blocker: TrainingBlocker | null;
  /** A reason to disable it that the host knows (automation paused, a proposal waiting). */
  disabledReason?: string | null;
  /** Called once the run was queued. */
  onStarted?: (runId: string) => void;
}

export function ReEvaluateButton({ programId, blocker, disabledReason = null, onStarted }: ReEvaluateButtonProps) {
  const reasonId = useId();
  const [busy, setBusy] = useState(false);
  const [until, setUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [notice, setNotice] = useState<{ severity: 'success' | 'info' | 'warning' | 'error'; text: string } | null>(null);

  // Tick once a minute while a cooldown applies so the button re-enables itself.
  useEffect(() => {
    if (until === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [until]);

  const coolingDown = until !== null && until > now;
  const reason = blocker?.message ?? disabledReason ?? (coolingDown ? cooldownMessage((until - now) / 1000) : null);

  const start = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const started = await startTrainingRun({ kind: 'evaluate', programId, trigger: 'manual' });
      if (started.status === 'blocked_safety') {
        setNotice({ severity: 'warning', text: started.guidance ?? 'Your coach stopped for safety. Check your plan.' });
      } else {
        setNotice({ severity: 'success', text: EVALUATION_QUEUED_MESSAGE });
        onStarted?.(started.runId);
      }
    } catch (err) {
      const refusal = trainingRefusalOf(err);
      if (refusal?.reason === TRAINING_REFUSALS.EVALUATION_COOLDOWN) {
        const seconds = Number(refusal.details.retryAfterSeconds);
        const wait = Number.isFinite(seconds) && seconds > 0 ? seconds : 30 * 60;
        const at = Date.now();
        setNow(at);
        setUntil(at + wait * 1000);
      } else if (refusal?.reason === TRAINING_REFUSALS.RUN_ACTIVE) {
        setNotice({ severity: 'info', text: 'Your coach is already working on your plan. Try again when it is done.' });
      } else {
        setNotice({ severity: 'error', text: err instanceof Error && err.message ? err.message : 'Could not start the review' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box data-testid="re-evaluate">
      <Button
        variant="outlined"
        startIcon={<RefreshIcon />}
        onClick={() => void start()}
        disabled={busy || reason !== null}
        aria-describedby={reason ? reasonId : undefined}
        sx={{ minHeight: 44 }}
      >
        Re-evaluate now
      </Button>
      {reason && (
        <Typography id={reasonId} variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {reason}
          {blocker?.fix && (
            <>
              {' '}
              <Link component={RouterLink} to={blocker.fix.to}>
                {blocker.fix.label}
              </Link>
            </>
          )}
        </Typography>
      )}
      {notice && (
        <Alert severity={notice.severity} sx={{ mt: 1 }} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}
    </Box>
  );
}

export default ReEvaluateButton;
