/**
 * One realtime voice session over WebRTC — issue #449, epic #421
 * (docs/specs/ai-platform.md §2.15).
 *
 * THE FLOW. `start()`:
 *   1. asks for the microphone (`getUserMedia({ audio: true })`) FIRST, so a
 *      slow permission prompt cannot eat the secret's short connect window;
 *   2. mints a session (`POST /ai/realtime/sessions`) — the server resolves the
 *      user's key and trades it for the provider's EPHEMERAL client secret;
 *   3. builds an `RTCPeerConnection`, adds the mic track, opens the provider's
 *      `oai-events` data channel and creates an SDP offer;
 *   4. POSTs the offer straight to the provider's `connectUrl` with
 *      `Authorization: Bearer <clientSecret>` and applies the SDP answer.
 * Remote audio arrives on `ontrack` and plays through the `<audio>` element
 * the caller binds to {@link UseAiRealtimeSessionReturn.audioRef}.
 *
 * THE SECRET. `clientSecret` lives in one local variable inside `start()` for
 * exactly the SDP exchange it exists for. It is never put in state, a ref,
 * a log line or the DOM. The user's real key never reaches the browser at all.
 *
 * TRANSCRIPTS. Both sides are read off the data channel. On open the hook
 * turns on input transcription with a `session.update`; user lines come from
 * `conversation.item.input_audio_transcription.delta/.completed`, assistant
 * lines from `response.output_audio_transcript.delta/.done` (and the beta
 * `response.audio_transcript.*` names). Lines are keyed by `item_id`, and a
 * `conversation.item.created/added` reserves a line's place so a user line
 * whose transcription finishes after the assistant started answering still
 * reads first.
 *
 * CLEANUP. `stop()`, a failure, and unmount all run the same teardown: close
 * the data channel and the peer connection, stop every mic track, clear the
 * timer and detach the remote stream. A `stop()` during `start()` is honoured
 * too: every await is followed by a check that this attempt is still current.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createRealtimeSession, type AiRealtimeSessionRequest } from '../services/ai';
import { toAiErrorInfo, type AiErrorInfo } from '../services/aiErrors';

/** The data channel the provider reads client events from and writes server events to. */
export const AI_REALTIME_DATA_CHANNEL = 'oai-events';

/** The model the provider transcribes the user's speech with. */
export const AI_REALTIME_INPUT_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';

export type AiRealtimeStatus = 'idle' | 'starting' | 'connected' | 'ended' | 'error';

/**
 * Why a session could not start or stopped. `api` carries the mint's own
 * AI error (rendered by `AiErrorAlert`); `provider` is an `error` event the
 * provider sent mid-call, which does not end the session.
 */
export type AiRealtimeFailure =
  | { kind: 'mic-denied' }
  | { kind: 'no-mic' }
  | { kind: 'mic-error'; message: string }
  | { kind: 'unsupported' }
  | { kind: 'api'; error: AiErrorInfo }
  | { kind: 'sdp'; message: string }
  | { kind: 'connection-lost' }
  | { kind: 'expired' }
  | { kind: 'provider'; message: string };

export interface AiRealtimeTranscriptLine {
  /** The provider's `item_id` (or a local id when an event carries none). */
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** False while deltas are still arriving. */
  final: boolean;
}

/** What the session runs — never the secret. */
export interface AiRealtimeSessionInfo {
  provider: string;
  model: string;
  voice: string;
}

export interface UseAiRealtimeSessionReturn {
  status: AiRealtimeStatus;
  failure: AiRealtimeFailure | null;
  session: AiRealtimeSessionInfo | null;
  /** Only lines with text — a reserved, still-empty line is not listed. */
  transcript: AiRealtimeTranscriptLine[];
  muted: boolean;
  /** Whole seconds since the call connected. */
  elapsedSeconds: number;
  /** Bind to an `<audio autoPlay>` element: the assistant's voice plays through it. */
  audioRef: RefObject<HTMLAudioElement | null>;
  start: (request: AiRealtimeSessionRequest) => Promise<void>;
  stop: () => void;
  setMuted: (muted: boolean) => void;
  clearFailure: () => void;
}

export interface UseAiRealtimeSessionOptions {
  /** Clock, for tests. */
  now?: () => number;
}

/** `mm:ss` (or `h:mm:ss` past an hour). */
export function formatRealtimeElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Whether this browser can hold a realtime call at all. */
export function isRealtimeSupported(): boolean {
  return (
    typeof RTCPeerConnection !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

interface Resources {
  pc: RTCPeerConnection | null;
  channel: RTCDataChannel | null;
  stream: MediaStream | null;
}

/** A getUserMedia rejection → failure. */
function micFailure(err: unknown): AiRealtimeFailure {
  const name = err && typeof err === 'object' ? (err as { name?: unknown }).name : undefined;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return { kind: 'mic-denied' };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return { kind: 'no-mic' };
  }
  return { kind: 'mic-error', message: err instanceof Error && err.message ? err.message : 'The microphone could not be opened.' };
}

type ServerEvent = Record<string, unknown> & { type?: unknown };

const USER_DELTA = new Set(['conversation.item.input_audio_transcription.delta']);
const USER_DONE = new Set(['conversation.item.input_audio_transcription.completed']);
const ASSISTANT_DELTA = new Set(['response.output_audio_transcript.delta', 'response.audio_transcript.delta']);
const ASSISTANT_DONE = new Set(['response.output_audio_transcript.done', 'response.audio_transcript.done']);
const ITEM_CREATED = new Set(['conversation.item.created', 'conversation.item.added']);

export function useAiRealtimeSession(options: UseAiRealtimeSessionOptions = {}): UseAiRealtimeSessionReturn {
  const now = options.now ?? Date.now;
  const [status, setStatus] = useState<AiRealtimeStatus>('idle');
  const [failure, setFailure] = useState<AiRealtimeFailure | null>(null);
  const [session, setSession] = useState<AiRealtimeSessionInfo | null>(null);
  const [lines, setLines] = useState<AiRealtimeTranscriptLine[]>([]);
  const [muted, setMutedState] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const resources = useRef<Resources>({ pc: null, channel: null, stream: null });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Bumped by every start/stop: an older attempt's continuation sees it and bails. */
  const attempt = useRef(0);
  const mounted = useRef(true);
  const localId = useRef(0);

  const teardown = useCallback(() => {
    const { pc, channel, stream } = resources.current;
    resources.current = { pc: null, channel: null, stream: null };
    if (channel) {
      channel.onmessage = null;
      channel.onopen = null;
      try {
        channel.close();
      } catch {
        // Already closed.
      }
    }
    if (pc) {
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        // Already closed.
      }
    }
    stream?.getTracks().forEach((track) => track.stop());
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
    if (audioRef.current) audioRef.current.srcObject = null;
  }, []);

  /** End the attempt with `next` as the reason (unless it is already over). */
  const fail = useCallback(
    (forAttempt: number, next: AiRealtimeFailure) => {
      if (attempt.current !== forAttempt) return;
      attempt.current += 1;
      teardown();
      if (!mounted.current) return;
      setFailure(next);
      setStatus('error');
    },
    [teardown],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      attempt.current += 1;
      teardown();
    };
  }, [teardown]);

  const upsertLine = useCallback(
    (id: string, role: AiRealtimeTranscriptLine['role'], update: (text: string) => string, final: boolean) => {
      setLines((current) => {
        const index = current.findIndex((line) => line.id === id);
        if (index === -1) return [...current, { id, role, text: update(''), final }];
        const next = current.slice();
        next[index] = { ...next[index], role, text: update(next[index].text), final: final || next[index].final };
        return next;
      });
    },
    [],
  );

  const onServerEvent = useCallback(
    (event: ServerEvent) => {
      const type = typeof event.type === 'string' ? event.type : '';
      const itemId = typeof event.item_id === 'string' ? event.item_id : null;
      const id = () => itemId ?? `local-${(localId.current += 1)}`;

      if (ITEM_CREATED.has(type)) {
        const item = event.item as { id?: unknown; role?: unknown } | undefined;
        if (item && typeof item.id === 'string' && (item.role === 'user' || item.role === 'assistant')) {
          const reserved = item.id;
          const role = item.role;
          setLines((current) =>
            current.some((line) => line.id === reserved) ? current : [...current, { id: reserved, role, text: '', final: false }],
          );
        }
        return;
      }
      if (USER_DELTA.has(type) && typeof event.delta === 'string') {
        const delta = event.delta;
        upsertLine(id(), 'user', (text) => text + delta, false);
        return;
      }
      if (USER_DONE.has(type) && typeof event.transcript === 'string') {
        const transcript = event.transcript.trim();
        upsertLine(id(), 'user', () => transcript, true);
        return;
      }
      if (ASSISTANT_DELTA.has(type) && typeof event.delta === 'string') {
        const delta = event.delta;
        upsertLine(id(), 'assistant', (text) => text + delta, false);
        return;
      }
      if (ASSISTANT_DONE.has(type)) {
        const transcript = typeof event.transcript === 'string' ? event.transcript : null;
        upsertLine(id(), 'assistant', (text) => transcript ?? text, true);
        return;
      }
      if (type === 'error') {
        const error = event.error as { message?: unknown } | undefined;
        const message =
          error && typeof error.message === 'string' && error.message ? error.message : 'The provider reported an error.';
        setFailure({ kind: 'provider', message });
      }
    },
    [upsertLine],
  );

  const start = useCallback(
    async (request: AiRealtimeSessionRequest) => {
      teardown();
      const current = (attempt.current += 1);
      const live = () => attempt.current === current && mounted.current;
      setFailure(null);
      setSession(null);
      setLines([]);
      setElapsedSeconds(0);
      setMutedState(false);

      if (!isRealtimeSupported()) {
        fail(current, { kind: 'unsupported' });
        return;
      }
      setStatus('starting');

      // 1. The microphone, before the secret's clock starts.
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        fail(current, micFailure(err));
        return;
      }
      if (!live()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      resources.current.stream = stream;

      // 2. Mint. `minted.clientSecret` stays in this scope only.
      let minted: Awaited<ReturnType<typeof createRealtimeSession>>;
      try {
        minted = await createRealtimeSession(request);
      } catch (err) {
        fail(current, { kind: 'api', error: toAiErrorInfo(err, 'Could not start a voice session') });
        return;
      }
      if (!live()) return;
      setSession({ provider: minted.provider, model: minted.model, voice: minted.voice });

      // 3. The peer connection, the mic track and the events channel.
      let pc: RTCPeerConnection;
      try {
        pc = new RTCPeerConnection();
      } catch {
        fail(current, { kind: 'unsupported' });
        return;
      }
      resources.current.pc = pc;
      pc.ontrack = (event) => {
        if (audioRef.current) audioRef.current.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          fail(current, { kind: 'connection-lost' });
        }
      };
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

      const channel = pc.createDataChannel(AI_REALTIME_DATA_CHANNEL);
      resources.current.channel = channel;
      channel.onopen = () => {
        try {
          channel.send(
            JSON.stringify({
              type: 'session.update',
              session: {
                type: 'realtime',
                audio: { input: { transcription: { model: AI_REALTIME_INPUT_TRANSCRIPTION_MODEL } } },
              },
            }),
          );
        } catch {
          // The channel closed under us; the connection handler reports it.
        }
      };
      channel.onmessage = (message: MessageEvent) => {
        if (attempt.current !== current || typeof message.data !== 'string') return;
        try {
          const parsed: unknown = JSON.parse(message.data);
          if (parsed && typeof parsed === 'object') onServerEvent(parsed as ServerEvent);
        } catch {
          // Not JSON — not an event this hook reads.
        }
      };

      // 4. The SDP exchange, straight to the provider.
      let answerSdp: string;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (!live()) return;
        if (Date.parse(minted.expiresAt) <= now()) {
          fail(current, { kind: 'expired' });
          return;
        }
        const response = await fetch(minted.connectUrl, {
          method: 'POST',
          body: offer.sdp,
          credentials: 'omit',
          headers: { Authorization: `Bearer ${minted.clientSecret}`, 'Content-Type': 'application/sdp' },
        });
        if (!live()) return;
        if (!response.ok) {
          fail(current, { kind: 'sdp', message: `The provider refused the connection (HTTP ${response.status}).` });
          return;
        }
        answerSdp = await response.text();
        if (!live()) return;
        await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      } catch (err) {
        fail(current, {
          kind: 'sdp',
          message: err instanceof Error && err.message ? err.message : 'The connection could not be negotiated.',
        });
        return;
      }
      if (!live()) return;

      // Connected: start the clock.
      const startedAt = now();
      timer.current = setInterval(() => {
        if (mounted.current) setElapsedSeconds(Math.floor((now() - startedAt) / 1000));
      }, 1000);
      setStatus('connected');
    },
    [fail, now, onServerEvent, teardown],
  );

  const stop = useCallback(() => {
    attempt.current += 1;
    teardown();
    if (!mounted.current) return;
    setStatus((current) => (current === 'error' ? current : current === 'idle' ? 'idle' : 'ended'));
    setMutedState(false);
  }, [teardown]);

  const setMuted = useCallback((next: boolean) => {
    resources.current.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    setMutedState(next);
  }, []);

  const clearFailure = useCallback(() => {
    setFailure(null);
    setStatus((current) => (current === 'error' ? 'idle' : current));
  }, []);

  return {
    status,
    failure,
    session,
    transcript: lines.filter((line) => line.text !== ''),
    muted,
    elapsedSeconds,
    audioRef,
    start,
    stop,
    setMuted,
    clearFailure,
  };
}
