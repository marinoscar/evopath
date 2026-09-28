/**
 * A speech run's audio — issue #445 (API #439, docs/specs/ai-platform.md §2.14).
 *
 * The audio is a storage object the caller owns; it plays from a short-lived
 * signed URL (`GET /storage/objects/:id/download`, held in state only) in a
 * native, labelled `<audio controls>` player, with a download link. A media
 * load failure (a CSP block, an expired URL — issue #510) is explained with a
 * warning pointing at the download link, rather than leaving a dead 0:00 player.
 *
 * DISCLOSURE. Provider usage policies require telling listeners that a voice
 * is AI-generated, and every speech output carries `aiGenerated: true`. The
 * "AI-generated audio" label is therefore always visible beside the player
 * and part of the player's accessible name — not a tooltip, not optional.
 */
import { useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, Paper, Skeleton, Typography } from '@mui/material';
import { Download as DownloadIcon, SmartToy as AiIcon } from '@mui/icons-material';
import type { AiSpeechRunOutput } from '../../services/ai';
import { getStorageObjectDownloadUrl } from '../../services/storage';
import { ApiError } from '../../services/api';
import { useIsMounted } from '../../hooks/useIsMounted';

export const AI_GENERATED_AUDIO_LABEL = 'AI-generated audio';
export const AI_SPEECH_PLAYBACK_FAILED_MESSAGE =
  'This audio could not be played in the browser. Use Download audio to listen to it.';

export interface AiSpeechPlayerProps {
  output: AiSpeechRunOutput;
}

export function AiSpeechPlayer({ output }: AiSpeechPlayerProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const isMounted = useIsMounted();

  useEffect(() => {
    setUrl(null);
    setError(null);
    setPlaybackFailed(false);
    void (async () => {
      try {
        const signed = await getStorageObjectDownloadUrl(output.storageObjectId);
        if (isMounted()) setUrl(signed.url);
      } catch (err) {
        if (isMounted()) setError(err instanceof ApiError ? err.message : 'Could not load the audio');
      }
    })();
  }, [output.storageObjectId, isMounted]);

  const accessibleName = `${AI_GENERATED_AUDIO_LABEL}, voice ${output.voice}`;

  return (
    <Paper
      variant="outlined"
      component="figure"
      aria-label="Generated speech"
      sx={{ m: 0, p: 1.5, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}
    >
      <Box component="figcaption" sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Chip icon={<AiIcon />} color="secondary" size="small" label={AI_GENERATED_AUDIO_LABEL} />
        <Typography variant="caption" color="text.secondary">
          Voice {output.voice} · {output.format.toUpperCase()} · {output.characters.toLocaleString()} characters
        </Typography>
      </Box>
      {error ? (
        <Alert severity="error">{error}</Alert>
      ) : playbackFailed ? (
        <Alert severity="warning">{AI_SPEECH_PLAYBACK_FAILED_MESSAGE}</Alert>
      ) : url ? (
        <Box
          component="audio"
          controls
          src={url}
          aria-label={accessibleName}
          preload="metadata"
          onError={() => setPlaybackFailed(true)}
          sx={{ width: '100%' }}
        >
          Your browser cannot play this audio; use the download link.
        </Box>
      ) : (
        <Skeleton variant="rounded" height={40} aria-label="Loading audio" />
      )}
      <Box>
        <Button
          size="small"
          startIcon={<DownloadIcon />}
          component="a"
          href={url ?? undefined}
          download={`ai-speech.${output.format}`}
          target="_blank"
          rel="noopener noreferrer"
          disabled={!url}
        >
          Download audio
        </Button>
      </Box>
    </Paper>
  );
}

export default AiSpeechPlayer;
