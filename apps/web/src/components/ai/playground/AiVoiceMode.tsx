/**
 * The Playground's Voice mode — issue #449, epic #421
 * (docs/specs/ai-platform.md §2.15).
 *
 * A live speech-to-speech call with a `realtime` model. The server mints a
 * short-lived, single-session secret with the user's key; the BROWSER then
 * connects to the provider directly over WebRTC with it. All of that lives in
 * `hooks/useAiRealtimeSession.ts` — this component is the controls, the
 * timer, the transcript and the failure copy.
 *
 * Shown only when `GET /ai/config` says `allowRealtime: true`
 * (`pages/AiPlaygroundPage.tsx`). Voices follow the selected model's own
 * `capabilities.voices`; none is hard-coded here.
 *
 * MICROPHONE PERMISSION (issue #508). Before a session starts, the
 * microphone permission is checked up front (`hooks/useMicrophonePermission`)
 * rather than discovered by a failed Start: while the browser will still ask,
 * an "Allow microphone" button requests it from a click (mobile browsers
 * ignore a gestureless request); once it is blocked, platform-specific steps
 * (Android, iOS, desktop) say where to unblock it and Start is disabled until
 * it is; on plain http:// the remedy is HTTPS. A Start that fails with
 * `mic-denied` shows the same platform steps in its own alert, suppresses the
 * permission panel so the two never repeat each other, and clears itself once
 * the permission turns `granted`.
 *
 * ACCESSIBILITY. The transcript is an `aria-live="polite"` log, so a screen
 * reader hears each finished line without the audio being interrupted; the
 * status line (connecting, timer) is a `role="status"` region.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, AlertTitle, Box, Button, Chip, Divider, MenuItem, Stack, TextField, Typography } from '@mui/material';
import {
  CallEnd as StopIcon,
  Refresh as RefreshIcon,
  Mic as MicIcon,
  MicOff as MicOffIcon,
  KeyboardVoice as StartIcon,
} from '@mui/icons-material';
import { AI_REALTIME_INSTRUCTIONS_MAX_CHARS, type AiRealtimeSessionRequest, type UsableAiModel } from '../../../services/ai';
import {
  formatRealtimeElapsed,
  useAiRealtimeSession,
  type AiRealtimeFailure,
} from '../../../hooks/useAiRealtimeSession';
import {
  detectMicPlatform,
  useMicrophonePermission,
  type MicPlatform,
} from '../../../hooks/useMicrophonePermission';
import { AiErrorAlert } from '../AiErrorAlert';
import { AiModelSelect } from '../AiModelSelect';
import { AiPlaygroundPanels } from './AiPlaygroundPanels';
import { usePlaygroundModel } from './usePlaygroundModel';

export interface AiVoiceModeProps {
  /** The usable models declaring `realtime`. */
  models: UsableAiModel[];
  preferredModel?: { provider: string; modelId: string } | null;
  ready?: boolean;
}

/** Where to unblock the microphone, per platform (issue #508). */
export function micUnblockSteps(platform: MicPlatform): string {
  switch (platform) {
    case 'android':
      return 'Tap the site-settings icon next to the address bar → Permissions → Microphone → Allow. If it is still blocked, open Android Settings → Apps → Chrome (your browser) → Permissions → Microphone and allow it.';
    case 'ios':
      return 'Open Settings → Safari (or your browser) → Microphone and allow this site, or tap ‘aA’ in the address bar → Website Settings → Microphone → Allow.';
    case 'desktop':
      return 'Click the site-settings icon (lock/tune) in the address bar → Microphone → Allow, then return here.';
  }
}

function currentMicPlatform(): MicPlatform {
  return detectMicPlatform(typeof navigator === 'undefined' ? '' : navigator.userAgent);
}

/** Copy for every failure except `api`, which `AiErrorAlert` renders. */
export function realtimeFailureCopy(
  failure: Exclude<AiRealtimeFailure, { kind: 'api' }>,
): { title: string; body: string; severity: 'error' | 'warning' } {
  switch (failure.kind) {
    case 'mic-denied':
      return {
        title: 'Microphone access was blocked',
        body: 'Allow this site to use your microphone in the site settings next to the browser’s address bar — and, on a phone, check the browser app itself is allowed the microphone in the system settings — then start again.',
        severity: 'warning',
      };
    case 'no-mic':
      return {
        title: 'No microphone found',
        body: 'Connect a microphone (or check it is not in use by another app), then start again.',
        severity: 'warning',
      };
    case 'mic-error':
      return { title: 'The microphone could not be opened', body: failure.message, severity: 'error' };
    case 'unsupported':
      return {
        title: 'Voice sessions are not supported in this browser',
        body: 'This browser cannot make WebRTC calls. Try a current version of Chrome, Edge, Firefox or Safari.',
        severity: 'warning',
      };
    case 'sdp':
      return {
        title: 'Could not connect to the provider',
        body: `The call could not be set up. Try again in a moment. (${failure.message})`,
        severity: 'error',
      };
    case 'connection-lost':
      return {
        title: 'The connection was lost',
        body: 'The call dropped — check your network and start a new session.',
        severity: 'error',
      };
    case 'expired':
      return {
        title: 'The session expired before it connected',
        body: 'Voice sessions must connect within about a minute. Start again.',
        severity: 'warning',
      };
    case 'provider':
      return { title: 'The provider reported an error', body: failure.message, severity: 'warning' };
  }
}

export function AiVoiceMode({ models, preferredModel, ready = true }: AiVoiceModeProps) {
  const { modelKey, setModelKey, selected } = usePlaygroundModel(models, preferredModel, ready);
  const call = useAiRealtimeSession();
  const mic = useMicrophonePermission();
  const [platform] = useState(currentMicPlatform);
  const micDeniedFailure = call.failure?.kind === 'mic-denied';
  const { refresh: refreshMic, permission: micPermission } = mic;
  const { clearFailure } = call;

  // A Start that failed on the microphone: re-read the permission so the
  // panel (and Start's disabled state) reflect what the browser now says.
  useEffect(() => {
    if (micDeniedFailure) refreshMic();
  }, [micDeniedFailure, refreshMic]);

  // …and once the user has allowed it, the "blocked" alert is stale.
  useEffect(() => {
    if (micDeniedFailure && micPermission === 'granted') clearFailure();
  }, [micDeniedFailure, micPermission, clearFailure]);

  const voices = selected?.capabilities.voices ?? [];
  const [voice, setVoice] = useState('');
  const [instructions, setInstructions] = useState('');

  // Keep the voice one the selected model speaks: its first, until the user picks another.
  useEffect(() => {
    if (voices.length === 0) {
      if (voice !== '') setVoice('');
    } else if (!voices.includes(voice)) {
      setVoice(voices[0]);
    }
  }, [voices, voice]);

  const active = call.status === 'starting' || call.status === 'connected';
  const tooLong = instructions.length > AI_REALTIME_INSTRUCTIONS_MAX_CHARS;
  const micBlocked = mic.permission === 'denied' || mic.permission === 'insecure';
  const canStart = !!selected && !active && !tooLong && !micBlocked;

  const start = () => {
    if (!canStart || !selected) return;
    const request: AiRealtimeSessionRequest = { provider: selected.provider, model: selected.modelId };
    if (voice) request.voice = voice;
    if (instructions.trim()) request.instructions = instructions.trim();
    void call.start(request);
  };

  if (!selected) return null;

  const settings = (
    <Stack spacing={2}>
      <AiModelSelect models={models} value={modelKey} onChange={setModelKey} disabled={active} capability="realtime" />
      {voices.length > 0 && (
        <TextField
          select
          size="small"
          label="Voice"
          value={voice}
          disabled={active}
          onChange={(event) => setVoice(event.target.value)}
        >
          {voices.map((name) => (
            <MenuItem key={name} value={name}>
              {name}
            </MenuItem>
          ))}
        </TextField>
      )}
      <TextField
        size="small"
        label="Instructions"
        placeholder="Optional system instructions"
        multiline
        minRows={2}
        maxRows={6}
        value={instructions}
        disabled={active}
        onChange={(event) => setInstructions(event.target.value)}
        error={tooLong}
        helperText={
          tooLong
            ? `At most ${AI_REALTIME_INSTRUCTIONS_MAX_CHARS.toLocaleString()} characters`
            : 'Applied when the session starts'
        }
      />
    </Stack>
  );

  let failureAlert: ReactNode = null;
  if (call.failure?.kind === 'api') {
    failureAlert = <AiErrorAlert error={call.failure.error} onClose={call.clearFailure} />;
  } else if (call.failure) {
    const copy = realtimeFailureCopy(call.failure);
    failureAlert = (
      <Alert severity={copy.severity} onClose={call.clearFailure} data-realtime-failure={call.failure.kind}>
        <AlertTitle>{copy.title}</AlertTitle>
        {copy.body}
        {call.failure.kind === 'mic-denied' && (
          <Typography variant="body2" sx={{ mt: 1 }} data-mic-steps={platform}>
            {micUnblockSteps(platform)}
          </Typography>
        )}
      </Alert>
    );
  }

  const requestMic = () => {
    void mic.request();
  };

  // The permission panel: before a session only, and never alongside a
  // mic-denied failure alert that already says the same thing.
  let micPanel: ReactNode = null;
  if (!active && !micDeniedFailure) {
    if (mic.permission === 'prompt') {
      micPanel = (
        <Alert severity="info" data-mic-permission="prompt">
          <AlertTitle>Microphone access needed</AlertTitle>
          Voice mode needs your microphone. Your browser will ask for permission.
          {/* In the body, not the `action` slot: at phone widths the slot squeezes the text column. */}
          <Box sx={{ mt: 1.5 }}>
            <Button
              variant="outlined"
              color="inherit"
              size="small"
              startIcon={<MicIcon />}
              onClick={requestMic}
              disabled={mic.requesting}
            >
              {mic.requesting ? 'Requesting…' : 'Allow microphone'}
            </Button>
          </Box>
        </Alert>
      );
    } else if (mic.permission === 'denied') {
      micPanel = (
        <Alert severity="warning" data-mic-permission="denied">
          <AlertTitle>Microphone access is blocked</AlertTitle>
          <span data-mic-steps={platform}>{micUnblockSteps(platform)}</span>
          <Box sx={{ mt: 1.5 }}>
            <Button
              variant="outlined"
              color="inherit"
              size="small"
              startIcon={<RefreshIcon />}
              onClick={requestMic}
              disabled={mic.requesting}
            >
              {mic.requesting ? 'Checking…' : 'Check again'}
            </Button>
          </Box>
        </Alert>
      );
    } else if (mic.permission === 'insecure') {
      micPanel = (
        <Alert severity="error" data-mic-permission="insecure">
          <AlertTitle>Microphone requires a secure connection</AlertTitle>
          Browsers only allow microphone access over HTTPS. Open this page using https://.
        </Alert>
      );
    }
  }

  const statusText =
    call.status === 'starting'
      ? 'Connecting…'
      : call.status === 'connected'
        ? `Live · ${formatRealtimeElapsed(call.elapsedSeconds)}${call.muted ? ' · Muted' : ''}`
        : call.status === 'ended'
          ? `Ended · ${formatRealtimeElapsed(call.elapsedSeconds)}`
          : null;

  return (
    <AiPlaygroundPanels settings={settings} label="Voice">
      {/* The assistant's voice. Hidden: there is nothing to show, only to hear. */}
      <audio ref={call.audioRef} autoPlay hidden data-testid="realtime-audio" />

      {failureAlert}
      {micPanel}

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        {active ? (
          <>
            <Button
              variant="outlined"
              color={call.muted ? 'warning' : 'inherit'}
              startIcon={call.muted ? <MicOffIcon /> : <MicIcon />}
              onClick={() => call.setMuted(!call.muted)}
              disabled={call.status !== 'connected'}
              aria-pressed={call.muted}
            >
              {call.muted ? 'Unmute' : 'Mute'}
            </Button>
            <Button variant="contained" color="error" startIcon={<StopIcon />} onClick={call.stop}>
              Stop
            </Button>
          </>
        ) : (
          <Button variant="contained" startIcon={<StartIcon />} onClick={start} disabled={!canStart}>
            Start
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Typography
          variant="body2"
          color="text.secondary"
          role="status"
          data-testid="realtime-status"
          sx={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {statusText}
        </Typography>
      </Box>

      <Divider />

      <Box
        role="log"
        aria-live="polite"
        aria-label="Voice transcript"
        sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minHeight: 120 }}
      >
        {call.transcript.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
            {active
              ? 'Listening — start speaking.'
              : 'Start a session and talk to the model. Your browser will ask to use the microphone. The replies are AI-generated audio.'}
          </Typography>
        ) : (
          call.transcript.map((line) => (
            <Box key={line.id} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', minWidth: 0 }}>
              <Chip
                size="small"
                label={line.role === 'user' ? 'You' : 'Assistant'}
                color={line.role === 'user' ? 'default' : 'primary'}
                variant={line.role === 'user' ? 'outlined' : 'filled'}
                sx={{ flexShrink: 0, minWidth: 80 }}
              />
              <Typography
                variant="body2"
                sx={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap', opacity: line.final ? 1 : 0.75 }}
              >
                {line.text}
              </Typography>
            </Box>
          ))
        )}
      </Box>
    </AiPlaygroundPanels>
  );
}

export default AiVoiceMode;
