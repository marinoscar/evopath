import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import {
  deleteCheckIn,
  getTodayCheckIn,
  saveCheckIn,
  type CheckIn,
  type CheckInInput,
  type TodayCheckIn,
} from '../services/health';
import { useIsMounted } from './useIsMounted';

export interface UseCheckInReturn {
  /** Today in the profile time zone, as the SERVER says (`null` until loaded). */
  date: string | null;
  /** Today's check-in, or `null` when there is none (or not loaded yet). */
  checkIn: CheckIn | null;
  isLoading: boolean;
  error: string | null;
  /** True when the API answered `403`: no health-data grant, nothing to retry. */
  forbidden: boolean;
  /**
   * `PUT /api/check-ins/:date`. Resolves with the stored check-in and, when
   * `date` is still today, updates `checkIn`. Rejects with the `ApiError`
   * (a `409` when another device saved the same day first).
   */
  save: (date: string, input: CheckInInput) => Promise<CheckIn>;
  /** `DELETE /api/check-ins/:date`. A `404` (already gone) counts as deleted. */
  remove: (date: string) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Issue #56 (E2.4). Today's daily check-in (`GET /api/check-ins/today`).
 *
 * The server decides what "today" is, in the user's profile time zone, so a
 * wrong device clock or a travelling user cannot check in for the wrong day;
 * callers send `date` back unchanged on `save`.
 */
export function useCheckIn(options: { enabled?: boolean } = {}): UseCheckInReturn {
  const enabled = options.enabled ?? true;
  const [today, setToday] = useState<TodayCheckIn | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await getTodayCheckIn();
      if (isMounted()) {
        setToday(data);
        setForbidden(false);
      }
    } catch (err) {
      if (!isMounted()) return;
      setForbidden(err instanceof ApiError && err.status === 403);
      setError(err instanceof ApiError ? err.message : "Failed to load today's check-in");
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  const save = useCallback(
    async (date: string, input: CheckInInput) => {
      const saved = await saveCheckIn(date, input);
      if (isMounted()) {
        setToday((prev) => (prev && prev.date === saved.date ? { ...prev, checkIn: saved } : prev));
      }
      return saved;
    },
    [isMounted],
  );

  const remove = useCallback(
    async (date: string) => {
      try {
        await deleteCheckIn(date);
      } catch (err) {
        // Already deleted (another device, another tab): the outcome the user asked for.
        if (!(err instanceof ApiError && err.status === 404)) throw err;
      }
      if (isMounted()) {
        setToday((prev) => (prev && prev.date === date ? { ...prev, checkIn: null } : prev));
      }
    },
    [isMounted],
  );

  return {
    date: today?.date ?? null,
    checkIn: today?.checkIn ?? null,
    isLoading,
    error,
    forbidden,
    save,
    remove,
    refresh,
  };
}
