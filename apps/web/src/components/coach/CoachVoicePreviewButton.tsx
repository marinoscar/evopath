/**
 * "Hear it": a spoken preview of a persona's static sample line (E7.3, #243).
 *
 * The route is E7.6's (`POST /api/coach/voice-preview`, rate-limited, static
 * lines only, never user data). Until it ships, `available` is false and the
 * button renders DISABLED with the tooltip "Voice preview arrives soon". The
 * call path is wired already: when available, a click asks the server for the
 * audio and plays it with `AiSpeechPlayer`, which always shows the
 * "AI-generated audio" disclosure.
 */
import { useState } from 'react';
import { Alert, Box, Button, Stack, Tooltip, Typography } from '@mui/material';
import RecordVoiceOverOutlinedIcon from '@mui/icons-material/RecordVoiceOverOutlined';
import { AiSpeechPlayer } from '../ai/AiSpeechPlayer';
import type { AiSpeechFormat, AiSpeechRunOutput } from '../../services/ai';
import {
  COACH_ERRORS,
  coachErrorOf,
  previewCoachVoice,
  type CoachVoicePreview,
  type CoachVoicePreviewRequest,
} from '../../services/coach';
import { useIsMounted } from '../../hooks/useIsMounted';

export const VOICE_PREVIEW_SOON = 'Voice preview arrives soon';

export interface CoachVoicePreviewButtonProps {
  available: boolean;
  request: CoachVoicePreviewRequest;
  /** Audio is off, or no voice can be spoken: the button is disabled whatever `available` says. */
  disabled?: boolean;
  disabledReason?: string;
}

function toSpeechOutput(preview: CoachVoicePreview): AiSpeechRunOutput {
  return {
    type: 'speech',
    provider: '',
    model: '',
    storageObjectId: preview.storageObjectId,
    mimeType: preview.mimeType ?? 'audio/mpeg',
    size: preview.size ?? 0,
    format: (preview.format ?? 'mp3') as AiSpeechFormat,
    voice: preview.voice,
    characters: preview.characters ?? 0,
    aiGenerated: true,
    usage: {},
  };
}

export function CoachVoicePreviewButton({
  available,
  request,
  disabled = false,
  disabledReason,
}: CoachVoicePreviewButtonProps) {
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<AiSpeechRunOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const blocked = !available || disabled;
  const tooltip = !available ? VOICE_PREVIEW_SOON : disabled ? (disabledReason ?? '') : '';

  const play = async () => {
    setBusy(true);
    setError(null);
    try {
      const preview = await previewCoachVoice(request);
      if (isMounted()) setOutput(toSpeechOutput(preview));
    } catch (err) {
      const info = coachErrorOf(err, 'Could not play the preview.');
      if (isMounted()) {
        setError(
          info.code === COACH_ERRORS.PREVIEW_RATE_LIMITED || info.status === 429
            ? 'Too many previews in a short time. Wait a moment and try again.'
            : info.status === 409
              ? 'No voice model is available. Ask an administrator to assign one to Coach voice.'
              : info.message,
        );
      }
    } finally {
      if (isMounted()) setBusy(false);
    }
  };

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
      {output && <AiSpeechPlayer output={output} />}
    </Stack>
  );
}
