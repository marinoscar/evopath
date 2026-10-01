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
 * Unmounting aborts the stream; the server then discards the partial reply.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  coachChatFailureOf,
  streamCoachChat,
  type CoachChatDone,
  type CoachChatFailure,
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
}

export interface UseCoachChatOptions {
  /** The persona the reply is attributed to (dropped for a safety reply). */
  personaId?: string | null;
  onComplete: (items: CoachTimelineItem[], done: CoachChatDone) => void;
}

export interface UseCoachChatReturn {
  pending: CoachPendingTurn | null;
  isStreaming: boolean;
  send: (text: string) => void;
  retry: () => void;
  dismiss: () => void;
}

let localCounter = 0;

export function useCoachChat({ personaId = null, onComplete }: UseCoachChatOptions): UseCoachChatReturn {
  const [pending, setPending] = useState<CoachPendingTurn | null>(null);
  const controller = useRef<AbortController | null>(null);
  const onCompleteRef = useRef(onComplete);
  const isMounted = useIsMounted();

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

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

      const fail = (failure: CoachChatFailure) => {
        finished = true;
        if (isMounted()) setPending((current) => (current ? { ...current, status: 'failed', failure } : current));
      };

      void streamCoachChat(
        turn.text,
        {
          onSafety: (frame) => {
            safety = frame;
            if (isMounted()) setPending((current) => (current ? { ...current, safety: frame } : current));
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
                id: done.userMessageId || `${turn.localId}-user`,
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
          },
          onError: (frame) => fail({ kind: 'other', message: frame.message }),
        },
        abort.signal,
      ).then(
        () => {
          if (!finished && !abort.signal.aborted) {
            fail({ kind: 'other', message: 'The reply was cut off. Try again.' });
          }
        },
        (err: unknown) => fail(coachChatFailureOf(err)),
      );
    },
    [isMounted, personaId],
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (pending?.status === 'streaming') return;
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

  return { pending, isStreaming: pending?.status === 'streaming', send, retry, dismiss };
}
