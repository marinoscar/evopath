/**
 * One background AI run: start, poll until it settles, cancel — issue #434,
 * epic #419.
 *
 * `POST /ai/runs` enqueues the request as a queue job (CLAUDE.md: every
 * long-running activity is a queue job) and answers 202 with a run id; this
 * hook then reads `GET /ai/runs/:id` every `intervalMs` (2 s by default)
 * until the run is `succeeded`, `failed` or `cancelled`, and stops.
 *
 * POLLING IS A TIMEOUT CHAIN, NOT AN INTERVAL: the next read is scheduled
 * only after the previous one answered, so a slow API can never stack
 * overlapping requests.
 *
 * A FAILED READ IS NOT A FAILED RUN (#509). A read that fails for a reason
 * that can clear on its own — the browser's network `TypeError` ("Failed to
 * fetch"), a 5xx, a 408/429 — marks the last-known `run` as `stale` and keeps
 * polling with a modest linear backoff; the next successful read clears it.
 * Only after {@link AI_RUN_MAX_POLL_FAILURES} consecutive failures does the
 * hook give up, stop polling and surface `error` (with `stale` still set, so
 * the card can say the status it shows is the last one it saw, not the
 * current one). A read the server refuses outright (any other 4xx — 404: not
 * theirs, or gone) will not start answering on its own, so it stops polling
 * and surfaces the error at once, as before. A run that itself settled
 * `failed` is not a read failure at all: it arrives as `run.errorCode`.
 *
 * `onSettled` fires exactly once per run, when it reaches a terminal state.
 *
 * ANY RUN, NOT ONLY TEXT (#445). `start` queues a text response; `startWith`
 * takes whichever call created the run — `POST /ai/images`,
 * `POST /ai/images/edits`, and the media routes after them all answer the
 * same 202 `{ runId, jobId }` and settle through the same `GET /ai/runs/:id`.
 * Narrow the settled `output` with `isAiResponseRunOutput` /
 * `isAiImageRunOutput`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelAiRun,
  createAiRun,
  getAiRun,
  type AiResponseRequest,
  type AiRun,
  type AiRunStarted,
  type AiRunStatus,
} from '../services/ai';
import { ApiError } from '../services/api';
import { toAiErrorInfo, type AiErrorInfo } from '../services/aiErrors';
import { useIsMounted } from './useIsMounted';

export const AI_RUN_POLL_INTERVAL_MS = 2000;

/** Consecutive transient read failures tolerated before the hook gives up. */
export const AI_RUN_MAX_POLL_FAILURES = 3;

/**
 * Whether a failed `GET /ai/runs/:id` may succeed if simply retried: a
 * network-level failure (no HTTP response at all), a 5xx, a 408 or a 429.
 */
function isTransientReadFailure(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  return err.status >= 500 || err.status === 408 || err.status === 429;
}

const TERMINAL: readonly AiRunStatus[] = ['succeeded', 'failed', 'cancelled'];

export function isAiRunTerminal(status: AiRunStatus): boolean {
  return TERMINAL.includes(status);
}

export interface UseAiRunOptions {
  intervalMs?: number;
  onSettled?: (run: AiRun) => void;
}

export interface UseAiRunReturn {
  /** The latest known state of the run, or `null` before the first read. */
  run: AiRun | null;
  runId: string | null;
  /** True from `start()` until the run settles (or cannot be read). */
  isActive: boolean;
  isStarting: boolean;
  isCancelling: boolean;
  /**
   * A real failure to start, read or cancel the run — never a single
   * transient read failure. A run that settled `failed` reports through
   * `run.errorCode` instead.
   */
  error: AiErrorInfo | null;
  /**
   * True while the latest read of the run failed, so `run` is the last
   * KNOWN state rather than the current one (#509). Cleared by the next
   * successful read.
   */
  stale: boolean;
  /** Start a text run; resolves to its id, or `null` when the API refused it. */
  start: (request: AiResponseRequest) => Promise<string | null>;
  /**
   * Start a run through any call that answers 202 `{ runId, jobId }` (an image
   * generation, say) and poll it like `start`. Resolves to its id, or `null`
   * when the call threw.
   */
  startWith: (create: () => Promise<AiRunStarted>) => Promise<string | null>;
  cancel: () => Promise<void>;
  /** Forget the run (stops polling; does NOT cancel it server-side). */
  clear: () => void;
}

export function useAiRun(options: UseAiRunOptions = {}): UseAiRunReturn {
  const { intervalMs = AI_RUN_POLL_INTERVAL_MS, onSettled } = options;
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<AiRun | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [error, setError] = useState<AiErrorInfo | null>(null);
  const [polling, setPolling] = useState(false);
  const [stale, setStale] = useState(false);
  const isMounted = useIsMounted();

  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const settledRef = useRef<string | null>(null);

  const accept = useCallback(
    (next: AiRun) => {
      if (!isMounted()) return;
      setRun(next);
      setStale(false);
      if (isAiRunTerminal(next.status)) {
        setPolling(false);
        if (settledRef.current !== next.id) {
          settledRef.current = next.id;
          onSettledRef.current?.(next);
        }
      }
    },
    [isMounted],
  );

  useEffect(() => {
    if (!runId || !polling) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;

    const poll = async () => {
      try {
        const next = await getAiRun(runId);
        if (cancelled) return;
        failures = 0;
        accept(next);
        if (!isAiRunTerminal(next.status)) timer = setTimeout(poll, intervalMs);
      } catch (err) {
        if (cancelled || !isMounted()) return;
        const transient = isTransientReadFailure(err);
        failures += 1;
        setStale(true);
        if (transient && failures < AI_RUN_MAX_POLL_FAILURES) {
          // Keep the last-known run on screen, flagged stale; back off a little.
          timer = setTimeout(poll, intervalMs * (failures + 1));
          return;
        }
        const info = toAiErrorInfo(err, 'Could not read the background run');
        setError(
          err instanceof ApiError
            ? info
            : {
                ...info,
                message:
                  "Lost contact with the server while checking this run's status. The run may still be in progress.",
              },
        );
        setPolling(false);
      }
    };

    timer = setTimeout(poll, intervalMs);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [runId, polling, intervalMs, accept, isMounted]);

  const startWith = useCallback(
    async (create: () => Promise<AiRunStarted>) => {
      setIsStarting(true);
      setError(null);
      setStale(false);
      setRun(null);
      setRunId(null);
      setPolling(false);
      try {
        const started = await create();
        if (!isMounted()) return started.runId;
        setRunId(started.runId);
        setPolling(true);
        return started.runId;
      } catch (err) {
        if (isMounted()) setError(toAiErrorInfo(err, 'Could not start the background run'));
        return null;
      } finally {
        if (isMounted()) setIsStarting(false);
      }
    },
    [isMounted],
  );

  const start = useCallback((request: AiResponseRequest) => startWith(() => createAiRun(request)), [startWith]);

  const cancel = useCallback(async () => {
    if (!runId) return;
    setIsCancelling(true);
    try {
      const next = await cancelAiRun(runId);
      accept(next);
    } catch (err) {
      if (isMounted()) setError(toAiErrorInfo(err, 'Could not cancel the background run'));
    } finally {
      if (isMounted()) setIsCancelling(false);
    }
  }, [runId, accept, isMounted]);

  const clear = useCallback(() => {
    setRunId(null);
    setRun(null);
    setError(null);
    setStale(false);
    setPolling(false);
  }, []);

  const isActive = isStarting || polling;

  return { run, runId, isActive, isStarting, isCancelling, error, stale, start, startWith, cancel, clear };
}
