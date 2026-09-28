/**
 * AI usage aggregates (issue #444, epic #420) — `GET /api/admin/ai/usage`
 * (`useAiUsage`, `ai_config:read`) and `GET /api/ai/usage/me` (`useMyAiUsage`,
 * `ai:use`).
 *
 * Both are thin readers over one shared loader: the query is a PARAMETER, the
 * effect keys on its scalars, and a response that arrives after the query has
 * changed is dropped rather than painted over the newer one (switching 7 → 90
 * days quickly must not end on the 7-day numbers).
 *
 * Like `useJobInsights`, neither polls: usage over a 30-day window does not
 * move at a timescale worth an interval, and refreshing is an explicit act.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import {
  getAiUsage,
  getMyAiUsage,
  type AiMyUsageGroupBy,
  type AiMyUsageQuery,
  type AiUsageQuery,
  type AiUsageReport,
} from '../services/ai';
import { useIsMounted } from './useIsMounted';

export interface UseAiUsageReturn<G extends string> {
  report: AiUsageReport<G> | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

function useUsageReport<G extends string>(
  fetcher: () => Promise<AiUsageReport<G>>,
  queryKey: string,
  fallbackError: string,
): UseAiUsageReturn<G> {
  const [report, setReport] = useState<AiUsageReport<G> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const latest = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(async () => {
    const ticket = ++latest.current;
    const current = () => isMounted() && ticket === latest.current;
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetcherRef.current();
      if (current()) setReport(data);
    } catch (err) {
      if (current()) {
        setReport(null);
        setError(err instanceof ApiError ? err.message : fallbackError);
      }
    } finally {
      if (current()) setIsLoading(false);
    }
    // `queryKey` stands in for the query object, so a new object with the same
    // values does not re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, fallbackError, isMounted]);

  useEffect(() => {
    void load();
  }, [load]);

  return { report, isLoading, error, refresh: load };
}

/** Organisation-wide usage, one grouping per call. */
export function useAiUsage(query: AiUsageQuery): UseAiUsageReturn<AiUsageQuery['groupBy']> {
  return useUsageReport(
    () => getAiUsage(query),
    JSON.stringify([query.groupBy, query.from, query.to, query.userId, query.provider, query.model]),
    'Failed to load AI usage',
  );
}

/** The caller's own usage. */
export function useMyAiUsage(query: AiMyUsageQuery): UseAiUsageReturn<AiMyUsageGroupBy> {
  return useUsageReport(
    () => getMyAiUsage(query),
    JSON.stringify([query.groupBy, query.from, query.to]),
    'Failed to load your AI usage',
  );
}
