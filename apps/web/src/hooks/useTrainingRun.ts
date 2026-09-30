/**
 * Follow one training run live: `GET /api/ai/training/runs/:runId`, then its
 * event stream from the last contiguous `seq`, folded by `reduceRunEvents`.
 *
 * REPLAY WITHOUT DUPLICATES. The view model is keyed by `seq`, so a replay
 * (first load, a reload, a reconnect) only fills what is missing. The stream
 * client (`connectSse`) reconnects to ONE fixed URL, which would replay from
 * the cursor the connection was opened with; so on `reconnecting` this hook
 * closes it and opens a new one with `?after=<lastSeq>` instead. A gap (an
 * event past a hole) does the same; a hole the server cannot fill after two
 * tries is skipped rather than looped on.
 *
 * `event: end` means the run is terminal (or waiting for a decision) and
 * every event was sent: the hook closes the stream and refetches the run
 * once. While the stream is open the run is refetched every minute, which
 * keeps `heartbeatAt` fresh for the "waiting for the worker" banner.
 *
 * Leaving the page closes the stream and NEVER cancels the run.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import {
  cancelTrainingRun,
  connectTrainingRunStream,
  getTrainingRun,
  resumeTrainingRun,
  type SseConnection,
  type TrainingRunConnect,
  type TrainingRunView,
} from '../services/trainingAgents';
import {
  hasGap,
  initialRunViewState,
  reduceRunEvents,
  skipGap,
  type RunViewState,
} from '../utils/reduceRunEvents';
import { useIsMounted } from './useIsMounted';

export type RunConnection = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface UseTrainingRunOptions {
  /** The stream opener; tests pass a fake. */
  connect?: TrainingRunConnect;
  /** How often the run row is refetched while the stream is open. */
  pollMs?: number;
  /** Delay before re-opening after a drop (the new URL carries the cursor). */
  reconnectDelayMs?: number;
}

export interface UseTrainingRunReturn {
  run: TrainingRunView | null;
  view: RunViewState;
  connection: RunConnection;
  /** The stream ended (`event: end`). */
  ended: boolean;
  /** The first load failed. */
  error: string | null;
  notFound: boolean;
  /** The stream stopped without `end` (for example the session could not be renewed). */
  lost: boolean;
  cancel: () => Promise<void>;
  resume: () => Promise<void>;
  reconnect: () => void;
  refetch: () => Promise<void>;
}

const MAX_GAP_RETRIES = 2;

export function useTrainingRun(runId: string, options: UseTrainingRunOptions = {}): UseTrainingRunReturn {
  const { connect = connectTrainingRunStream, pollMs = 60_000, reconnectDelayMs = 1_000 } = options;
  const isMounted = useIsMounted();
  const [run, setRun] = useState<TrainingRunView | null>(null);
  const [view, setView] = useState<RunViewState>(initialRunViewState);
  const [connection, setConnection] = useState<RunConnection>('connecting');
  const [ended, setEnded] = useState(false);
  const [lost, setLost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const viewRef = useRef<RunViewState>(initialRunViewState());
  const connectionRef = useRef<SseConnection | null>(null);
  const generation = useRef(0);
  const endedRef = useRef(false);
  const gapRetries = useRef(0);
  /** The `lastSeq` a hole was found after, while one is open. */
  const holeAt = useRef<number | null>(null);
  /** The current connection was opened to fill `holeAt`. */
  const reopenedForHole = useRef(false);
  /** A connection opened at least once: a later `connecting` is a reconnect. */
  const everOpened = useRef(false);
  const reopenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRef = useRef<() => void>(() => {});

  const refetch = useCallback(async () => {
    try {
      const fresh = await getTrainingRun(runId);
      if (isMounted()) {
        setRun(fresh);
        setError(null);
      }
    } catch (err) {
      if (!isMounted()) return;
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      setError(err instanceof Error && err.message ? err.message : 'Could not load the run');
    }
  }, [isMounted, runId]);

  const closeStream = useCallback(() => {
    generation.current += 1;
    if (reopenTimer.current) clearTimeout(reopenTimer.current);
    reopenTimer.current = null;
    connectionRef.current?.close();
    connectionRef.current = null;
  }, []);

  const scheduleReopen = useCallback(
    (delay: number, forHole = false) => {
      closeStream();
      if (endedRef.current) return;
      setConnection('reconnecting');
      reopenTimer.current = setTimeout(() => {
        openRef.current();
        reopenedForHole.current = forHole;
      }, delay);
    },
    [closeStream],
  );

  const open = useCallback(() => {
    closeStream();
    if (endedRef.current) return;
    const gen = generation.current;
    const current = () => gen === generation.current && isMounted();
    setLost(false);
    connectionRef.current = connect(runId, viewRef.current.lastSeq, {
      onStateChange: (state) => {
        if (!current()) return;
        if (state === 'open') {
          everOpened.current = true;
          setConnection('open');
        } else if (state === 'connecting') setConnection(everOpened.current ? 'reconnecting' : 'connecting');
        else if (state === 'reconnecting') {
          // Re-open with the current cursor rather than let the client replay
          // from the one this connection was opened with.
          scheduleReopen(reconnectDelayMs);
        } else if (state === 'closed' && !endedRef.current) {
          // The client gave up (a session that could not be renewed). The run
          // continues server-side.
          setConnection('closed');
          setLost(true);
        }
      },
      onEvent: (event) => {
        if (!current()) return;
        let next = reduceRunEvents(viewRef.current, event);
        if (!hasGap(next)) {
          holeAt.current = null;
          gapRetries.current = 0;
        } else if (!hasGap(viewRef.current)) {
          // A new hole: ask the server for it from the last contiguous seq.
          holeAt.current = next.lastSeq;
          gapRetries.current = 1;
          viewRef.current = next;
          setView(next);
          scheduleReopen(0, true);
          return;
        } else if (reopenedForHole.current && next.lastSeq === holeAt.current) {
          // The connection opened to fill the hole skipped past it again.
          reopenedForHole.current = false;
          gapRetries.current += 1;
          if (gapRetries.current > MAX_GAP_RETRIES) {
            next = skipGap(next);
            holeAt.current = null;
            gapRetries.current = 0;
          } else {
            viewRef.current = next;
            setView(next);
            scheduleReopen(0, true);
            return;
          }
        } else if (next.lastSeq !== holeAt.current) {
          // The replay is filling the hole in order; keep reading.
          holeAt.current = next.lastSeq;
        }
        viewRef.current = next;
        setView(next);
      },
      onEnd: () => {
        if (!current()) return;
        endedRef.current = true;
        if (hasGap(viewRef.current)) {
          viewRef.current = skipGap(viewRef.current);
          setView(viewRef.current);
        }
        setEnded(true);
        closeStream();
        setConnection('closed');
        void refetch();
      },
    });
  }, [closeStream, connect, isMounted, reconnectDelayMs, refetch, runId, scheduleReopen]);

  openRef.current = open;

  // Load the run, then follow it. A new runId starts from scratch.
  useEffect(() => {
    viewRef.current = initialRunViewState();
    setView(viewRef.current);
    endedRef.current = false;
    gapRetries.current = 0;
    holeAt.current = null;
    reopenedForHole.current = false;
    setEnded(false);
    setRun(null);
    setNotFound(false);
    setConnection('connecting');
    let cancelled = false;
    (async () => {
      try {
        const loaded = await getTrainingRun(runId);
        if (cancelled || !isMounted()) return;
        setRun(loaded);
        openRef.current();
      } catch (err) {
        if (cancelled || !isMounted()) return;
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        setError(err instanceof Error && err.message ? err.message : 'Could not load the run');
        setConnection('closed');
      }
    })();
    return () => {
      cancelled = true;
      closeStream();
    };
  }, [closeStream, isMounted, runId]);

  // Keep the row fresh while following (heartbeat, cancel requested, usage).
  useEffect(() => {
    if (ended || !run || pollMs <= 0) return;
    const timer = setInterval(() => void refetch(), pollMs);
    return () => clearInterval(timer);
  }, [ended, pollMs, refetch, run]);

  const cancel = useCallback(async () => {
    const updated = await cancelTrainingRun(runId);
    if (isMounted()) setRun(updated);
  }, [isMounted, runId]);

  const resume = useCallback(async () => {
    const updated = await resumeTrainingRun(runId);
    if (!isMounted()) return;
    setRun(updated);
    endedRef.current = false;
    setEnded(false);
    openRef.current();
  }, [isMounted, runId]);

  const reconnect = useCallback(() => {
    endedRef.current = false;
    setEnded(false);
    openRef.current();
  }, []);

  return { run, view, connection, ended, error, notFound, lost, cancel, resume, reconnect, refetch };
}
