/**
 * The Danger Zone page's data (issue #202): the summary of what a factory
 * reset would delete (`useUserDataSummary`), and the reset itself
 * (`useUserDataReset`) — start the job, then poll it until it settles.
 *
 * THE POLL IS A PLAIN TIMEOUT CHAIN, not `useVisiblePolling`. That hook pauses
 * in a background tab, which is right for a dashboard nobody is watching, but
 * the reset dialog cannot be dismissed while the job runs: a user who switches
 * tabs and comes back should find the result, not a spinner that only resumes
 * on focus. The job settles in seconds, so the extra requests are bounded.
 *
 * The API decides everything: whether the phrase is right, what is deleted,
 * and whether the caller may. This hook only reports what it says.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import {
  getUserDataResetJob,
  getUserDataSummary,
  startUserDataReset,
  type UserDataResetJob,
  type UserDataSummary,
} from '../services/userData';
import { useIsMounted } from './useIsMounted';

/** How often the reset job is re-read while it is pending or running. */
export const RESET_POLL_INTERVAL_MS = 1500;

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.message) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export interface UseUserDataSummaryReturn {
  summary: UserDataSummary | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useUserDataSummary(): UseUserDataSummaryReturn {
  const [summary, setSummary] = useState<UserDataSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await getUserDataSummary();
      if (isMounted()) setSummary(next ?? {});
    } catch (err) {
      if (isMounted()) {
        setSummary(null);
        setError(messageOf(err, 'Could not load a summary of your data.'));
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { summary, isLoading, error, refresh };
}

export type ResetPhase = 'idle' | 'starting' | 'running' | 'succeeded' | 'failed';

export interface UseUserDataResetReturn {
  phase: ResetPhase;
  /** The settled job (on success, carries `result`). */
  job: UserDataResetJob | null;
  error: string | null;
  /** POST the reset, then poll until the job settles. */
  start: (confirmation: string) => Promise<void>;
  /** Back to `idle`, e.g. when the dialog closes after a failure. */
  reset: () => void;
}

export function useUserDataReset(
  pollIntervalMs: number = RESET_POLL_INTERVAL_MS,
): UseUserDataResetReturn {
  const [phase, setPhase] = useState<ResetPhase>('idle');
  const [job, setJob] = useState<UserDataResetJob | null>(null);
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
        const next = await getUserDataResetJob(jobId);
        if (!isMounted()) return;
        if (next.status === 'succeeded') {
          setJob(next);
          setPhase('succeeded');
          return;
        }
        if (next.status === 'failed') {
          setJob(next);
          fail(next.error || 'The reset failed. Some of your data may not have been deleted.');
          return;
        }
        timer.current = setTimeout(() => void poll(jobId), pollIntervalMs);
      } catch (err) {
        fail(messageOf(err, 'Lost track of the reset. Check your data and try again.'));
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
        const accepted = await startUserDataReset(confirmation);
        if (!isMounted()) return;
        setPhase('running');
        if (accepted.status === 'succeeded' || accepted.status === 'failed') {
          await poll(accepted.jobId);
          return;
        }
        timer.current = setTimeout(() => void poll(accepted.jobId), pollIntervalMs);
      } catch (err) {
        fail(messageOf(err, 'The reset could not be started.'));
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
