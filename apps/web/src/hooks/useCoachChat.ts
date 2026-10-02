/**
 * One coach chat turn at a time (E7.8, #248; docs/specs/ai-coach.md §2.9).
 *
 * `send(text)` shows the user's bubble immediately (the pending turn), then
 * streams `POST /api/coach/chat/stream`: `safety`, `tool`, `delta`, `done` or
 * `error` frames. On `done` the turn becomes two ordinary timeline items (the
 * ids are the server's) and `onComplete` hands them to the timeline.
 *
 * FAILURE AND RETRY. A refusal before the stream (`403 COACH_DISABLED`,
 * `409 AI_FEATURE_UNAVAILABLE`, `429`) stored nothing, so `retry()` re-sends
 * the same text and re-uses the same pending bubble: the user never sees the
 * turn twice. The text stays in the failed turn, so nothing typed is lost.
 *
 * A failure AFTER the stream began may have stored the user's turn already:
 * an `error` frame says so (`userMessageId`), and a stream cut off without
 * `done` or `error` after any frame (a network drop) is checked against the
 * latest timeline page (`findStoredTurn`). A stored turn is remembered in
 * `storedUserMessageId`, and `retry()` then sends `retryOf` so the server
 * answers that row again instead of storing the text a second time.
 *
 * MEMORY (#325). A `memory` frame (the turn added, updated or deleted a
 * memory) is collected in `memoryUpdates`, which outlives the turn so the page
 * can offer Undo under the reply; it is cleared when the next turn is sent.
 *
 * PROFILE (#327). A `done` frame with `profileUpdated: true` (the coach changed
 * the user's display name) calls `onProfileUpdated`, so the page can re-read
 * the cached current user.
 *
 * Unmounting aborts the stream; the server then discards the partial reply.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  coachChatFailureOf,
  streamCoachChat,
  type CoachChatDone,
  type CoachChatFailure,
  type CoachChatMemoryFrame,
  type CoachSafetyLevel,
  type CoachTimelineItem,
} from '../services/coach';
import { useIsMounted } from './useIsMounted';

export interface CoachPendingTurn {
  localId: string;
  text: string;
  createdAt: string;
  status: 'streaming' | 'failed';
  reply: string;
  tools: Array<{ name: string; status: string }>;
  safety: { level: CoachSafetyLevel; screen: string } | null;
  failure: CoachChatFailure | null;
  /**
   * The server's row for this user turn when it was stored but not answered:
   * a retry sends it as `retryOf`. `null` when nothing is known to be stored.
   */
  storedUserMessageId: string | null;
}

export interface UseCoachChatOptions {
  /** The persona the reply is attributed to (dropped for a safety reply). */
  personaId?: string | null;
  onComplete: (items: CoachTimelineItem[], done: CoachChatDone) => void;
  /**
   * After a stream was cut off mid-way (no `done`, no `error`): look the turn
   * up on the latest timeline page and return its stored user row's id, or
   * `null`. Without it a cut-off turn is treated as not stored.
   */
  findStoredTurn?: (text: string) => Promise<string | null>;
  /**
   * The finished turn changed the user's profile (`done.profileUpdated`,
   * #327): re-read whatever caches the current user.
   */
  onProfileUpdated?: () => void;
}

export interface UseCoachChatReturn {
  pending: CoachPendingTurn | null;
  isStreaming: boolean;
  send: (text: string) => void;
  retry: () => void;
  dismiss: () => void;
  /**
   * What the latest turn changed in memory (#325), in arrival order, one entry
   * per memory (a later frame for the same memory replaces the earlier one).
   * Kept after the turn completes, cleared when the next turn is sent.
   */
  memoryUpdates: CoachChatMemoryFrame[];
  /** Hide one memory update (after Undo, or when the user closes it). */
  dismissMemoryUpdate: (memoryId: string) => void;
}

let localCounter = 0;

export function useCoachChat({
  personaId = null,
  onComplete,
  findStoredTurn,
  onProfileUpdated,
}: UseCoachChatOptions): UseCoachChatReturn {
  const [pending, setPending] = useState<CoachPendingTurn | null>(null);
  const [memoryUpdates, setMemoryUpdates] = useState<CoachChatMemoryFrame[]>([]);
  const controller = useRef<AbortController | null>(null);
  const onCompleteRef = useRef(onComplete);
  const findStoredTurnRef = useRef(findStoredTurn);
  const onProfileUpdatedRef = useRef(onProfileUpdated);
  const isMounted = useIsMounted();

  useEffect(() => {
    onCompleteRef.current = onComplete;
    findStoredTurnRef.current = findStoredTurn;
    onProfileUpdatedRef.current = onProfileUpdated;
  }, [onComplete, findStoredTurn, onProfileUpdated]);

  useEffect(() => () => controller.current?.abort(), []);

  const run = useCallback(
    (turn: CoachPendingTurn) => {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      setPending(turn);

      let reply = '';
      let safety: CoachPendingTurn['safety'] = null;
      let finished = false;
      let sawFrame = false;

      const fail = (failure: CoachChatFailure, storedUserMessageId: string | null = turn.storedUserMessageId) => {
        finished = true;
        if (abort.signal.aborted || !isMounted()) return;
        setPending((current) =>
          current && current.localId === turn.localId
            ? { ...current, status: 'failed', failure, storedUserMessageId }
            : current,
        );
      };

      // The stream started and then broke without `done` or `error`: the
      // server may have stored the turn. Look before offering Retry.
      const failCutOff = async (failure: CoachChatFailure) => {
        finished = true;
        let stored = turn.storedUserMessageId;
        const find = findStoredTurnRef.current;
        if (!stored && find) {
          try {
            stored = await find(turn.text);
          } catch {
            stored = null;
          }
        }
        fail(failure, stored);
      };

      void streamCoachChat(
        turn.text,
        {
          onAnyFrame: () => {
            sawFrame = true;
          },
          onSafety: (frame) => {
            safety = frame;
            if (isMounted()) setPending((current) => (current ? { ...current, safety: frame } : current));
          },
          onMemory: (frame) => {
            if (abort.signal.aborted || !isMounted()) return;
            setMemoryUpdates((current) => [...current.filter((m) => m.memoryId !== frame.memoryId), frame]);
          },
          onTool: (frame) => {
            if (isMounted()) {
              setPending((current) => (current ? { ...current, tools: [...current.tools, frame] } : current));
            }
          },
          onDelta: (text) => {
            reply += text;
            if (isMounted()) setPending((current) => (current ? { ...current, reply } : current));
          },
          onDone: (done) => {
            finished = true;
            if (!isMounted()) return;
            const now = new Date().toISOString();
            const items: CoachTimelineItem[] = [
              {
                id: done.userMessageId || turn.storedUserMessageId || `${turn.localId}-user`,
                role: 'user',
                kind: 'chat',
                moment: null,
                personaId: null,
                intensity: null,
                title: '',
                body: turn.text,
                audioStatus: 'none',
                audioStorageObjectId: null,
                voice: null,
                feedback: null,
                openedAt: now,
                data: null,
                createdAt: turn.createdAt,
              },
              {
                id: done.messageId || `${turn.localId}-coach`,
                role: 'coach',
                kind: 'chat',
                moment: null,
                personaId: safety?.level === 'blocked' ? null : personaId,
                intensity: null,
                title: '',
                body: reply,
                audioStatus: 'none',
                audioStorageObjectId: null,
                voice: null,
                feedback: null,
                openedAt: now,
                data: {
                  links: done.links,
                  ...(safety ? { safety: safety.screen } : {}),
                  ...(done.fallback ? { fallback: true } : {}),
                  ...(done.pausedUntil ? { pausedUntil: done.pausedUntil } : {}),
                },
                createdAt: now,
              },
            ];
            setPending(null);
            onCompleteRef.current(items, done);
            if (done.profileUpdated) onProfileUpdatedRef.current?.();
          },
          onError: (frame) =>
            fail({ kind: 'other', message: frame.message }, frame.userMessageId ?? turn.storedUserMessageId),
        },
        abort.signal,
        { retryOf: turn.storedUserMessageId },
      ).then(
        () => {
          if (finished || abort.signal.aborted) return;
          const cutOff: CoachChatFailure = { kind: 'other', message: 'The reply was cut off. Try again.' };
          if (sawFrame) void failCutOff(cutOff);
          else fail(cutOff);
        },
        (err: unknown) => {
          if (finished) return;
          if (sawFrame) void failCutOff(coachChatFailureOf(err));
          else fail(coachChatFailureOf(err));
        },
      );
    },
    [isMounted, personaId],
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (pending?.status === 'streaming') return;
      setMemoryUpdates([]);
      localCounter += 1;
      run({
        localId: `local-${localCounter}`,
        text: trimmed,
        createdAt: new Date().toISOString(),
        status: 'streaming',
        reply: '',
        tools: [],
        safety: null,
        failure: null,
        storedUserMessageId: null,
      });
    },
    [pending, run],
  );

  const retry = useCallback(() => {
    if (!pending || pending.status !== 'failed') return;
    run({ ...pending, status: 'streaming', reply: '', tools: [], safety: null, failure: null });
  }, [pending, run]);

  const dismiss = useCallback(() => {
    controller.current?.abort();
    setPending(null);
  }, []);

  const dismissMemoryUpdate = useCallback((memoryId: string) => {
    setMemoryUpdates((current) => current.filter((m) => m.memoryId !== memoryId));
  }, []);

  return {
    pending,
    isStreaming: pending?.status === 'streaming',
    send,
    retry,
    dismiss,
    memoryUpdates,
    dismissMemoryUpdate,
  };
}
