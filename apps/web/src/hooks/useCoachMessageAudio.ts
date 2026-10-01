/**
 * On-demand audio for one coach message (#259; docs/specs/ai-coach.md).
 *
 * Audio is generated ONLY when the reader asks: `listen()` posts
 * `POST /api/coach/messages/:id/audio`. A `200 ready` plays at once; a
 * `202 pending` is polled with `GET /api/coach/messages/:id/audio` every
 * `pollIntervalMs` until it is `ready` (play) or `failed`, for at most
 * `maxPollMs`. Audio the timeline already reports `ready` plays without a
 * request, and a second `listen()` once ready replays it (no request).
 *
 * `playRequest` counts the plays asked for; the bubble hands it to
 * `AiSpeechPlayer`, which plays each time it grows.
 *
 * STRICT MODE AND UNMOUNT. The poll loop checks `useIsMounted()` after every
 * wait, so a real unmount stops it, while React's simulated remount does not
 * strand a request that is already in flight.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  coachAudioFailureOf,
  getCoachMessageAudio,
  requestCoachMessageAudio,
  COACH_AUDIO_MESSAGES,
  type CoachAudioFailureKind,
  type CoachTimelineItem,
} from '../services/coach';
import { useIsMounted } from './useIsMounted';

export const COACH_AUDIO_POLL_INTERVAL_MS = 2000;
/** Give up polling after about two and a half minutes. */
export const COACH_AUDIO_MAX_POLL_MS = 150_000;

/**
 * The defaults the hook reads when no option overrides them. Mutable only so
 * component tests can shorten the wait; the app never changes it.
 */
export const coachAudioTiming = {
  pollIntervalMs: COACH_AUDIO_POLL_INTERVAL_MS,
  maxPollMs: COACH_AUDIO_MAX_POLL_MS,
};

export type CoachMessageAudioState =
  | { status: 'idle' }
  | { status: 'requesting' }
  | { status: 'pending' }
  | { status: 'ready'; storageObjectId: string; voice: string }
  | { status: 'error'; kind: CoachAudioFailureKind | 'failed'; message: string };

export interface UseCoachMessageAudioOptions {
  pollIntervalMs?: number;
  maxPollMs?: number;
  /** Called when the API says spoken messages are off (403). */
  onDisabled?: () => void;
}

export interface UseCoachMessageAudioReturn {
  state: CoachMessageAudioState;
  /** Grows by one for each play asked for. */
  playRequest: number;
  /** Request (or replay) this message's audio. A no-op while a request is under way. */
  listen: () => void;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function useCoachMessageAudio(
  message: Pick<CoachTimelineItem, 'id' | 'audioStatus' | 'audioStorageObjectId' | 'voice'>,
  options: UseCoachMessageAudioOptions = {},
): UseCoachMessageAudioReturn {
  const {
    pollIntervalMs = coachAudioTiming.pollIntervalMs,
    maxPollMs = coachAudioTiming.maxPollMs,
    onDisabled,
  } = options;
  const [state, setState] = useState<CoachMessageAudioState>({ status: 'idle' });
  const [playRequest, setPlayRequest] = useState(0);
  const busy = useRef(false);
  const isMounted = useIsMounted();
  const latest = useRef({ message, onDisabled });
  useEffect(() => {
    latest.current = { message, onDisabled };
  }, [message, onDisabled]);

  const ready = useCallback(
    (storageObjectId: string, voice: string | null | undefined) => {
      if (!isMounted()) return;
      setState({ status: 'ready', storageObjectId, voice: voice || latest.current.message.voice || 'default' });
      setPlayRequest((n) => n + 1);
    },
    [isMounted],
  );

  const failed = useCallback(
    (kind: CoachAudioFailureKind | 'failed', text: string) => {
      if (!isMounted()) return;
      setState({ status: 'error', kind, message: text });
      if (kind === 'disabled') latest.current.onDisabled?.();
    },
    [isMounted],
  );

  const run = useCallback(async () => {
    const { id } = latest.current.message;
    busy.current = true;
    setState({ status: 'requesting' });
    try {
      const answer = await requestCoachMessageAudio(id);
      if (!isMounted()) return;
      if (answer.status === 'ready') {
        ready(answer.storageObjectId, answer.voice);
        return;
      }
      setState({ status: 'pending' });
      const deadline = Date.now() + maxPollMs;
      for (;;) {
        await wait(pollIntervalMs);
        if (!isMounted()) return;
        if (Date.now() > deadline) {
          failed('failed', COACH_AUDIO_MESSAGES.failed);
          return;
        }
        let view;
        try {
          view = await getCoachMessageAudio(id);
        } catch (err) {
          if (!isMounted()) return;
          const failure = coachAudioFailureOf(err);
          // A transient read error keeps polling; a refusal ends it.
          if (failure.kind === 'other') continue;
          failed(failure.kind, failure.message);
          return;
        }
        if (!isMounted()) return;
        if (view.status === 'ready' && view.storageObjectId) {
          ready(view.storageObjectId, view.voice);
          return;
        }
        if (view.status === 'failed' || view.status === 'none') {
          failed('failed', COACH_AUDIO_MESSAGES.failed);
          return;
        }
      }
    } catch (err) {
      const failure = coachAudioFailureOf(err);
      failed(failure.kind, failure.message);
    } finally {
      busy.current = false;
    }
  }, [failed, isMounted, maxPollMs, pollIntervalMs, ready]);

  const listen = useCallback(() => {
    if (busy.current) return;
    if (state.status === 'ready') {
      setPlayRequest((n) => n + 1);
      return;
    }
    const { audioStatus, audioStorageObjectId, voice } = latest.current.message;
    if (audioStatus === 'ready' && audioStorageObjectId) {
      ready(audioStorageObjectId, voice);
      return;
    }
    void run();
  }, [ready, run, state.status]);

  return { state, playRequest, listen };
}
