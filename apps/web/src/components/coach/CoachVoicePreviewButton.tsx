/**
 * "Hear it": a spoken preview of a persona's static sample line (E7.3 #243,
 * live since E7.6 #246).
 *
 * A click calls `POST /api/coach/voice-preview` (rate-limited, static lines
 * only, never user data), which answers 202 with a speech run. The run is
 * polled with the shared `useAiRun` (`GET /ai/runs/:id`) and, once it
 * succeeds, played with `AiSpeechPlayer`, which always shows the
 * "AI-generated audio" disclosure. `available` false keeps the button
 * disabled with the tooltip "Voice preview arrives soon" (a fork's switch).
 */
import { useState } from 'react';
import { Alert, Box, Button, Stack, Tooltip, Typography } from '@mui/material';
import RecordVoiceOverOutlinedIcon from '@mui/icons-material/RecordVoiceOverOutlined';
import { AiSpeechPlayer } from '../ai/AiSpeechPlayer';
import { isAiSpeechRunOutput } from '../../services/ai';
import {
  COACH_ERRORS,
  coachErrorOf,
  previewCoachVoice,
  type CoachVoicePreview,
  type CoachVoicePreviewRequest,
} from '../../services/coach';
import { useAiRun } from '../../hooks/useAiRun';
import { useIsMounted } from '../../hooks/useIsMounted';

export const VOICE_PREVIEW_SOON = 'Voice preview arrives soon';
export const VOICE_PREVIEW_RATE_LIMITED = 'Too many previews in a short time. Wait a moment and try again.';
export const VOICE_PREVIEW_NO_MODEL = 'No voice model is available. Ask an administrator to assign one to Coach voice.';
export const VOICE_PREVIEW_FAILED = 'The preview could not be generated. Try again later.';
export const VOICE_PREVIEW_CENSORED = 'Adult language is locked, so the clean line plays.';

export interface CoachVoicePreviewButtonProps {
  available: boolean;
  request: CoachVoicePreviewRequest;
  /** Audio is off, or no voice can be spoken: the button is disabled whatever `available` says. */
  disabled?: boolean;
  disabledReason?: string;
  /** Poll interval for the speech run (tests shorten it). */
  pollIntervalMs?: number;
}

export function CoachVoicePreviewButton({
  available,
  request,
  disabled = false,
  disabledReason,
  pollIntervalMs,
}: CoachVoicePreviewButtonProps) {
  const [requesting, setRequesting] = useState(false);
  const [preview, setPreview] = useState<CoachVoicePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const run = useAiRun(pollIntervalMs !== undefined ? { intervalMs: pollIntervalMs } : {});

  const blocked = !available || disabled;
  const tooltip = !available ? VOICE_PREVIEW_SOON : disabled ? (disabledReason ?? '') : '';
  const busy = requesting || run.isStarting || run.isActive;

  const play = async () => {
    setRequesting(true);
    setError(null);
    setPreview(null);
    run.clear();
    try {
      const started = await previewCoachVoice(request);
      if (!isMounted()) return;
      setPreview(started);
      await run.startWith(async () => ({ runId: started.runId, jobId: started.jobId }));
    } catch (err) {
      const info = coachErrorOf(err, 'Could not play the preview.');
      if (isMounted()) {
        setError(
          info.code === COACH_ERRORS.PREVIEW_RATE_LIMITED || info.status === 429
            ? VOICE_PREVIEW_RATE_LIMITED
            : info.status === 409
              ? VOICE_PREVIEW_NO_MODEL
              : info.message,
        );
      }
    } finally {
      if (isMounted()) setRequesting(false);
    }
  };

  const output = run.run?.status === 'succeeded' && isAiSpeechRunOutput(run.run.output) ? run.run.output : null;
  const runFailed =
    (run.run !== null && (run.run.status === 'failed' || run.run.status === 'cancelled')) || run.error !== null;

  const button = (
    <Button
      variant="outlined"
      size="small"
      startIcon={<RecordVoiceOverOutlinedIcon />}
      disabled={blocked || busy}
      onClick={() => void play()}
    >
      {busy ? 'Preparing…' : 'Hear it'}
    </Button>
  );

  return (
    <Stack spacing={1} sx={{ minWidth: 0 }}>
      <Box>
        {tooltip ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Tooltip title={tooltip} describeChild>
              {/* A disabled button fires no events; the span carries the tooltip. */}
              <Box component="span" sx={{ display: 'inline-block' }}>
                {button}
              </Box>
            </Tooltip>
            {/* The same reason as visible text, for touch and keyboard users. */}
            <Typography variant="caption" color="text.secondary">
              {tooltip}
            </Typography>
          </Stack>
        ) : (
          button
        )}
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      {!error && runFailed && <Alert severity="error">{VOICE_PREVIEW_FAILED}</Alert>}
      {preview?.censored && output && (
        <Typography variant="caption" color="text.secondary">
          {VOICE_PREVIEW_CENSORED}
        </Typography>
      )}
      {output && <AiSpeechPlayer output={output} />}
    </Stack>
  );
}
