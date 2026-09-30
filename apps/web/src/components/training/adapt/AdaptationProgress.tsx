/**
 * The adaptation run, live: the E5.6 run view (`useTrainingRun`, kind
 * `adapt`) bound to the adaptation's `runId`. Stages (Reading your plan,
 * Adapting, Checking limits, Reviewing), elapsed time, the provider's wait
 * after a rate limit (`run.deferred`) and Cancel. Reconnecting replays the
 * events without duplicates; leaving never cancels.
 *
 * When the stream ends (`event: end`) the parent refetches the adaptation,
 * which carries the proposal and the reports.
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Stack, Typography } from '@mui/material';
import { CheckCircle as DoneIcon, RadioButtonUnchecked as PendingIcon } from '@mui/icons-material';
import { useTrainingRun, type UseTrainingRunOptions } from '../../../hooks/useTrainingRun';
import type { RunStage, RunViewState } from '../../../utils/reduceRunEvents';

/** The stages an adaptation shows, in order, with their labels. */
export const ADAPT_STAGES: ReadonlyArray<{ stage: RunStage; label: string; sentence: string }> = [
  { stage: 'context', label: 'Reading your plan', sentence: 'Reading your plan, gym and readiness.' },
  { stage: 'plan', label: 'Adapting', sentence: 'Adapting the workout.' },
  { stage: 'guardrails', label: 'Checking limits', sentence: 'Checking the workout against the safety, time and equipment limits.' },
  { stage: 'critique', label: 'Reviewing', sentence: 'The critic is reviewing the workout.' },
];

/** What is happening now, in one sentence (the live region). */
export function adaptActivity(view: RunViewState): string {
  if (view.deferredRetryAfterMs !== null && view.status === 'queued') {
    const seconds = Math.max(1, Math.round(view.deferredRetryAfterMs / 1000));
    return `Waiting for the provider, about ${seconds} seconds.`;
  }
  if (view.current === 'ready') return 'Saving the adjusted workout.';
  const entry = ADAPT_STAGES.find((s) => s.stage === view.current);
  if (entry) {
    return entry.stage === 'plan' && view.stages.critique === 'done' ? 'Adapting the workout with the critic’s notes.' : entry.sentence;
  }
  if (view.status === 'queued' || view.status === null) return 'Waiting to start.';
  return '';
}

export interface AdaptationProgressProps {
  runId: string;
  /** When the adaptation was created: the elapsed clock's fallback start. */
  createdAt: string;
  /** The stream ended: refetch the adaptation. */
  onEnded: () => void;
  onCancel: () => Promise<void>;
  /** Tests inject a fake stream. */
  runOptions?: UseTrainingRunOptions;
}

/** "0:42", "3:05": a run takes seconds to a few minutes. */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function useElapsedSeconds(since: string, active: boolean): number {
  const start = new Date(since).getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return Number.isNaN(start) ? 0 : Math.max(0, (now - start) / 1000);
}

export function AdaptationProgress({ runId, createdAt, onEnded, onCancel, runOptions }: AdaptationProgressProps) {
  const { run, view, ended, connection, lost, error, reconnect } = useTrainingRun(runId, runOptions);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const endedOnce = useRef(false);
  const elapsed = useElapsedSeconds(run?.startedAt ?? createdAt, !ended);

  useEffect(() => {
    if (ended && !endedOnce.current) {
      endedOnce.current = true;
      onEnded();
    }
  }, [ended, onEnded]);

  const cancel = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await onCancel();
    } catch (err) {
      setCancelError(err instanceof Error && err.message ? err.message : 'Could not cancel');
      setCancelling(false);
    }
  };

  const sentence = ended ? '' : adaptActivity(view);

  return (
    <Box data-testid="adaptation-progress">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 1.5 }} useFlexGap>
        <Typography variant="h6" component="h2">
          Adjusting your workout
        </Typography>
        <Chip size="small" variant="outlined" label={`${formatElapsed(elapsed)} elapsed`} data-testid="adapt-elapsed" />
        {connection === 'reconnecting' && <Chip size="small" variant="outlined" label="Reconnecting…" />}
      </Stack>

      <Box component="ol" aria-label="Stages" sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, p: 0, m: 0, listStyle: 'none' }}>
        {ADAPT_STAGES.map(({ stage, label }) => {
          const state = view.stages[stage];
          const current = !ended && view.current === stage;
          return (
            <Box
              component="li"
              key={stage}
              data-testid={`adapt-stage-${stage}`}
              data-state={state}
              aria-current={current ? 'step' : undefined}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                px: 1,
                py: 0.5,
                borderRadius: 2,
                border: 1,
                borderColor: current ? 'primary.main' : 'divider',
                color: state === 'pending' ? 'text.secondary' : 'text.primary',
              }}
            >
              {state === 'done' ? (
                <DoneIcon fontSize="small" color="success" aria-hidden />
              ) : current ? (
                <CircularProgress
                  size={16}
                  aria-hidden
                  sx={{ '@media (prefers-reduced-motion: reduce)': { animation: 'none', '& circle': { animation: 'none' } } }}
                />
              ) : (
                <PendingIcon fontSize="small" aria-hidden />
              )}
              <Typography variant="body2">
                {label}
                <Box component="span" sx={visuallyHidden}>
                  {state === 'done' ? ', done' : current ? ', in progress' : ', not started'}
                </Box>
              </Typography>
            </Box>
          );
        })}
      </Box>
      <Typography aria-live="polite" role="status" sx={{ mt: 1, minHeight: 24 }} data-testid="adapt-activity">
        {sentence}
      </Typography>

      {lost && !ended && (
        <Alert
          severity="warning"
          sx={{ mt: 1 }}
          action={
            <Button color="inherit" size="small" onClick={reconnect}>
              Reconnect
            </Button>
          }
        >
          The live view stopped. The adjustment continues in the background.
        </Alert>
      )}
      {error && !run && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
      {cancelError && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {cancelError}
        </Alert>
      )}
      {!ended && (
        <Button sx={{ mt: 1.5, minHeight: 44 }} variant="outlined" onClick={() => void cancel()} disabled={cancelling}>
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </Button>
      )}
    </Box>
  );
}

const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

export default AdaptationProgress;
