/**
 * Agent usage (E6.3): one run's usage by step and role
 * (`useAgentRunUsage`), and the agents' usage in one UTC month
 * (`useMonthlyAgentUsage`).
 *
 * Neither polls. A run's numbers only settle when the run does, so the run
 * reader fetches once for the run and once more when `settled` turns true
 * (the parent knows when the run ended: its stream said so). A response that
 * arrives after the query changed is dropped rather than painted over the
 * newer one, like `useAiUsage`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import {
  getMonthlyTrainingUsage,
  getTrainingRunUsage,
  type TrainingMonthlyUsage,
  type TrainingRunUsage,
} from '../services/trainingUsage';
import { useIsMounted } from './useIsMounted';

interface Loaded<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  /** The request was answered `404` (not this user's, or gone). */
  notFound: boolean;
  refresh: () => Promise<void>;
}

function useLoader<T>(
  fetcher: (() => Promise<T>) | null,
  queryKey: string,
  fallbackError: string,
): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(fetcher !== null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const isMounted = useIsMounted();
  const latest = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(async () => {
    const fetch = fetcherRef.current;
    const ticket = ++latest.current;
    if (!fetch) {
      setIsLoading(false);
      return;
    }
    const current = () => isMounted() && ticket === latest.current;
    setIsLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const next = await fetch();
      if (current()) setData(next);
    } catch (err) {
      if (current()) {
        setData(null);
        setNotFound(err instanceof ApiError && err.status === 404);
        setError(err instanceof ApiError && err.message ? err.message : fallbackError);
      }
    } finally {
      if (current()) setIsLoading(false);
    }
    // `queryKey` stands in for the fetcher's inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, fallbackError, isMounted]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, isLoading, error, notFound, refresh: load };
}

export interface UseAgentRunUsageOptions {
  /** The run finished (or failed, or was cancelled): read the final numbers once more. */
  settled?: boolean;
}

export interface UseAgentRunUsageReturn {
  usage: TrainingRunUsage | null;
  isLoading: boolean;
  error: string | null;
  notFound: boolean;
  refresh: () => Promise<void>;
}

/** One run's usage. `runId` null or empty: nothing is fetched. */
export function useAgentRunUsage(
  runId: string | null | undefined,
  { settled = true }: UseAgentRunUsageOptions = {},
): UseAgentRunUsageReturn {
  const { data, isLoading, error, notFound, refresh } = useLoader(
    runId ? () => getTrainingRunUsage(runId) : null,
    runId ?? '',
    'Failed to load the usage of this run',
  );

  // Refetch once when the run settles after it was first read unsettled.
  const wasSettled = useRef(settled);
  useEffect(() => {
    if (settled && !wasSettled.current) void refresh();
    wasSettled.current = settled;
  }, [settled, refresh]);

  return { usage: data, isLoading, error, notFound, refresh };
}

export interface UseMonthlyAgentUsageOptions {
  /** `false`: nothing is fetched (a closed sheet). */
  enabled?: boolean;
}

export interface UseMonthlyAgentUsageReturn {
  report: TrainingMonthlyUsage | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** The agents' usage in one UTC month (`YYYY-MM`); omitted: the current UTC month. */
export function useMonthlyAgentUsage(
  month?: string,
  { enabled = true }: UseMonthlyAgentUsageOptions = {},
): UseMonthlyAgentUsageReturn {
  const { data, isLoading, error, refresh } = useLoader(
    enabled ? () => getMonthlyTrainingUsage(month) : null,
    `${enabled ? 'on' : 'off'}:${month ?? ''}`,
    'Failed to load your agent usage',
  );
  return { report: data, isLoading, error, refresh };
}
