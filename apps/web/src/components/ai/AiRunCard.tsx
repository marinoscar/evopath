/**
 * A background run's status card — issue #434, epic #419.
 *
 * Shows the prompt, the run's status as it is polled, and a Cancel button
 * while the run can still be stopped. A successful run's answer is appended to
 * the conversation by the page; this card only says so. A failed run renders
 * its `errorCode` through the shared {@link AiErrorAlert} mapping.
 *
 * A `stale` run (#509) — its latest status read failed — is shown as the last
 * KNOWN status, not the current one: the chip is outlined and labelled
 * "(last known)", and while the hook is still retrying a quiet "Reconnecting…"
 * line replaces any error banner. Only when the hook gives up does `error`
 * render, still beside the stale chip rather than a live-looking badge.
 *
 * Every run-backed Playground mode reuses it (#445): `title` names the run
 * ("Image run") and `successMessage` says where its result went.
 */
import type { ReactNode } from 'react';
import { Box, Button, Chip, CircularProgress, Paper, Typography } from '@mui/material';
import type { AiRun, AiRunStatus } from '../../services/ai';
import type { AiErrorInfo } from '../../services/aiErrors';
import { isAiRunTerminal } from '../../hooks/useAiRun';
import { AiErrorAlert } from './AiErrorAlert';

const STATUS: Record<AiRunStatus, { label: string; color: 'default' | 'info' | 'success' | 'error' | 'warning' }> = {
  pending: { label: 'Queued', color: 'default' },
  running: { label: 'Running', color: 'info' },
  succeeded: { label: 'Succeeded', color: 'success' },
  failed: { label: 'Failed', color: 'error' },
  cancelled: { label: 'Cancelled', color: 'warning' },
};

export interface AiRunCardProps {
  prompt: string;
  run: AiRun | null;
  error: AiErrorInfo | null;
  isStarting: boolean;
  isCancelling: boolean;
  onCancel: () => void;
  onDismiss: () => void;
  /** The card's heading and accessible name. Defaults to "Background run". */
  title?: string;
  /** The latest status read failed; `run` is the last known state (#509). */
  stale?: boolean;
  /** Shown once the run succeeds; `null` shows nothing. */
  successMessage?: ReactNode;
}

export function AiRunCard({
  prompt,
  run,
  error,
  isStarting,
  isCancelling,
  onCancel,
  onDismiss,
  stale = false,
  title = 'Background run',
  successMessage = 'The answer was added to the conversation.',
}: AiRunCardProps) {
  const status: AiRunStatus = run?.status ?? 'pending';
  const terminal = run ? isAiRunTerminal(run.status) : false;
  const settledOrBroken = terminal || (error !== null && !isStarting);
  const meta = STATUS[status];
  const reconnecting = stale && !error && !terminal;

  return (
    <Paper variant="outlined" sx={{ p: 1.5, minWidth: 0 }} aria-label={title} role="region">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="subtitle2" component="h2">
          {title}
        </Typography>
        {!error || run ? (
          <Chip
            size="small"
            label={isStarting ? 'Starting' : stale ? `${meta.label} (last known)` : meta.label}
            color={stale ? 'default' : meta.color}
            variant={stale ? 'outlined' : 'filled'}
            data-testid="run-status"
          />
        ) : null}
        {!settledOrBroken && <CircularProgress size={14} aria-label="Waiting for the run" />}
        <Box sx={{ flex: 1 }} />
        {!settledOrBroken && !isStarting && (
          <Button size="small" color="inherit" onClick={onCancel} disabled={isCancelling}>
            {isCancelling ? 'Cancelling…' : 'Cancel run'}
          </Button>
        )}
        {settledOrBroken && (
          <Button size="small" color="inherit" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </Box>
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ mt: 0.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
      >
        {prompt}
      </Typography>
      {reconnecting && (
        <Typography variant="caption" color="text.secondary" role="status" sx={{ display: 'block', mt: 0.5 }}>
          Reconnecting… the status shown may be out of date.
        </Typography>
      )}
      {status === 'succeeded' && successMessage !== null && (
        <Typography variant="body2" sx={{ mt: 1 }}>
          {successMessage}
        </Typography>
      )}
      {status === 'failed' && run && (
        <Box sx={{ mt: 1 }}>
          <AiErrorAlert error={{ code: run.errorCode, message: run.errorMessage ?? 'The run failed.' }} />
        </Box>
      )}
      {error && (
        <Box sx={{ mt: 1 }}>
          <AiErrorAlert error={error} />
        </Box>
      )}
    </Paper>
  );
}

export default AiRunCard;
