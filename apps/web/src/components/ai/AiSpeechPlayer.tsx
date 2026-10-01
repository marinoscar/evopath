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
 *
 * AUTOPLAY (E7.8, #248). `autoPlay` starts playback once the signed URL has
 * loaded — used when the coach page is opened from a push action, which is a
 * user gesture. A browser may still refuse (`play()` rejects with
 * `NotAllowedError`); the rejection is caught, never left unhandled, and a
 * large "Play" button is offered instead.
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, Paper, Skeleton, Typography } from '@mui/material';
import { Download as DownloadIcon, PlayArrow as PlayIcon, SmartToy as AiIcon } from '@mui/icons-material';
import type { AiSpeechRunOutput } from '../../services/ai';
import { getStorageObjectDownloadUrl } from '../../services/storage';
import { ApiError } from '../../services/api';
import { useIsMounted } from '../../hooks/useIsMounted';

export const AI_GENERATED_AUDIO_LABEL = 'AI-generated audio';
export const AI_SPEECH_PLAYBACK_FAILED_MESSAGE =
  'This audio could not be played in the browser. Use Download audio to listen to it.';

/**
 * What the player needs from a speech output. A full `AiSpeechRunOutput`
 * satisfies it; a stored coach message (E7.8) knows only the object and the
 * voice, so the format and the character count are optional.
 */
export type AiSpeechPlayerOutput = Pick<AiSpeechRunOutput, 'storageObjectId' | 'voice'> &
  Partial<Pick<AiSpeechRunOutput, 'format' | 'characters'>>;

export const AI_SPEECH_AUTOPLAY_BLOCKED_LABEL = 'Play';

export interface AiSpeechPlayerProps {
  output: AiSpeechPlayerOutput;
  /** Start playback as soon as the audio has loaded; a refusal shows a Play button. */
  autoPlay?: boolean;
}

export function AiSpeechPlayer({ output, autoPlay = false }: AiSpeechPlayerProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
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

  // Try once per loaded URL. `play()` returns a promise in every current
  // browser (a refusal REJECTS it); older engines return nothing or throw.
  useEffect(() => {
    if (!autoPlay || !url) return;
    const audio = audioRef.current;
    if (!audio) return;
    const blocked = () => {
      if (isMounted()) setAutoplayBlocked(true);
    };
    try {
      const attempt = audio.play() as Promise<void> | undefined;
      if (attempt && typeof attempt.catch === 'function') attempt.catch(blocked);
    } catch {
      blocked();
    }
  }, [autoPlay, url, isMounted]);

  const playNow = () => {
    const audio = audioRef.current;
    if (!audio) return;
    setAutoplayBlocked(false);
    try {
      const attempt = audio.play() as Promise<void> | undefined;
      if (attempt && typeof attempt.catch === 'function') {
        attempt.catch(() => {
          if (isMounted()) setPlaybackFailed(true);
        });
      }
    } catch {
      setPlaybackFailed(true);
    }
  };

  const accessibleName = `${AI_GENERATED_AUDIO_LABEL}, voice ${output.voice}`;
  const details = [
    `Voice ${output.voice}`,
    output.format ? output.format.toUpperCase() : null,
    output.characters !== undefined ? `${output.characters.toLocaleString()} characters` : null,
  ].filter(Boolean);

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
          {details.join(' · ')}
        </Typography>
      </Box>
      {error ? (
        <Alert severity="error">{error}</Alert>
      ) : playbackFailed ? (
        <Alert severity="warning">{AI_SPEECH_PLAYBACK_FAILED_MESSAGE}</Alert>
      ) : url ? (
        <>
          {autoplayBlocked && (
            <Button
              variant="contained"
              size="large"
              startIcon={<PlayIcon />}
              onClick={playNow}
              aria-label={`${AI_SPEECH_AUTOPLAY_BLOCKED_LABEL} ${AI_GENERATED_AUDIO_LABEL.toLowerCase()}`}
              sx={{ minHeight: 56, alignSelf: 'flex-start' }}
            >
              {AI_SPEECH_AUTOPLAY_BLOCKED_LABEL}
            </Button>
          )}
          <Box
            ref={audioRef}
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
        </>
      ) : (
        <Skeleton variant="rounded" height={40} aria-label="Loading audio" />
      )}
      <Box>
        <Button
          size="small"
          startIcon={<DownloadIcon />}
          component="a"
          href={url ?? undefined}
          download={`ai-speech.${output.format ?? 'mp3'}`}
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
