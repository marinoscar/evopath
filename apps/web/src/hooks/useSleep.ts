/**
 * The last N nights of sleep (`GET /api/sleep`) — issue #283 scope update.
 * The range ends on today in the Health Profile's time zone (the API's own
 * notion of a day), falling back to the browser's.
 *
 * The house fetch-hook contract: `useIsMounted()` guards `setState` past an
 * `await`; an `ApiError` becomes its message; `refresh` resolves.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import { listSleep, SLEEP_NIGHTS_SHOWN, type SleepSession } from '../services/sleep';
import { localDateIn } from '../utils/localDates';
import { addDays } from '../utils/goalFormat';
import { useIsMounted } from './useIsMounted';

export function useSleep(timeZone: string | null | undefined, nights: number = SLEEP_NIGHTS_SHOWN) {
  const [sessions, setSessions] = useState<SleepSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const to = localDateIn(timeZone);
  const from = addDays(to, -(nights - 1));

  const refresh = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const next = await listSleep({ from, to });
      if (isMounted()) setSessions(next);
    } catch (err) {
      if (isMounted()) {
        setError(err instanceof ApiError && err.message ? err.message : 'Failed to load your sleep');
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [from, to, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { sessions, from, to, isLoading, error, refresh };
}
