/**
 * Start a destructive reset job, then poll it until it settles. Shared by the
 * per-user Danger Zone (`useUserDataReset`, issue #202) and the admin factory
 * reset (`useFactoryReset`, issue #211): both POST a confirmation phrase, get
 * `202 { jobId, status }`, and read the job until it is `succeeded` or
 * `failed`.
 *
 * THE POLL IS A PLAIN TIMEOUT CHAIN, not `useVisiblePolling`. That hook pauses
 * in a background tab, which is right for a dashboard nobody is watching, but
 * a reset dialog cannot be dismissed while the job runs: a user who switches
 * tabs and comes back should find the result, not a spinner that only resumes
 * on focus. The job settles in seconds, so the extra requests are bounded.
 *
 * The API decides everything: whether the phrase is right, what is deleted,
 * and whether the caller may. This hook only reports what it says.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import { useIsMounted } from './useIsMounted';

/** How often a reset job is re-read while it is pending or running. */
export const RESET_POLL_INTERVAL_MS = 1500;

export type ResetJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export type ResetPhase = 'idle' | 'starting' | 'running' | 'succeeded' | 'failed';

export interface ResetJobAccepted {
  jobId: string;
  status: ResetJobStatus;
}

export interface ResetJobLike {
  jobId: string;
  status: ResetJobStatus;
  error?: string | null;
}

export interface ResetJobMessages {
  /** A job that settled as `failed` without an error of its own. */
  failed: string;
  /** A poll request that threw. */
  lost: string;
  /** The POST that threw (and carried no message). */
  notStarted: string;
}

export interface UseResetJobOptions<J extends ResetJobLike> {
  startJob: (confirmation: string) => Promise<ResetJobAccepted>;
  getJob: (jobId: string) => Promise<J>;
  messages: ResetJobMessages;
  pollIntervalMs?: number;
}

export interface UseResetJobReturn<J> {
  phase: ResetPhase;
  /** The settled job (on success, carries `result`). */
  job: J | null;
  error: string | null;
  /** POST the reset, then poll until the job settles. */
  start: (confirmation: string) => Promise<void>;
  /** Back to `idle`, e.g. when the dialog closes after a failure. */
  reset: () => void;
}

export function resetErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.message) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function useResetJob<J extends ResetJobLike>(
  options: UseResetJobOptions<J>,
): UseResetJobReturn<J> {
  const pollIntervalMs = options.pollIntervalMs ?? RESET_POLL_INTERVAL_MS;
  // The callers pass module functions and literal messages; a ref keeps the
  // callbacks below stable without asking them to memoise anything.
  const opts = useRef(options);
  useEffect(() => {
    opts.current = options;
  });

  const [phase, setPhase] = useState<ResetPhase>('idle');
  const [job, setJob] = useState<J | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  const fail = useCallback(
    (message: string) => {
      if (!isMounted()) return;
      setError(message);
      setPhase('failed');
    },
    [isMounted],
  );

  const poll = useCallback(
    async (jobId: string) => {
      try {
        const next = await opts.current.getJob(jobId);
        if (!isMounted()) return;
        if (next.status === 'succeeded') {
          setJob(next);
          setPhase('succeeded');
          return;
        }
        if (next.status === 'failed') {
          setJob(next);
          fail(next.error || opts.current.messages.failed);
          return;
        }
        timer.current = setTimeout(() => void poll(jobId), pollIntervalMs);
      } catch (err) {
        fail(resetErrorMessage(err, opts.current.messages.lost));
      }
    },
    [fail, isMounted, pollIntervalMs],
  );

  const start = useCallback(
    async (confirmation: string) => {
      clearTimer();
      setError(null);
      setJob(null);
      setPhase('starting');
      try {
        const accepted = await opts.current.startJob(confirmation);
        if (!isMounted()) return;
        setPhase('running');
        if (accepted.status === 'succeeded' || accepted.status === 'failed') {
          await poll(accepted.jobId);
          return;
        }
        timer.current = setTimeout(() => void poll(accepted.jobId), pollIntervalMs);
      } catch (err) {
        fail(resetErrorMessage(err, opts.current.messages.notStarted));
      }
    },
    [fail, isMounted, poll, pollIntervalMs],
  );

  const reset = useCallback(() => {
    clearTimer();
    setPhase('idle');
    setJob(null);
    setError(null);
  }, []);

  return { phase, job, error, start, reset };
}
