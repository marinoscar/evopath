/**
 * Run the admin Doctor (`GET /api/admin/doctor`) — issue #634.
 *
 * The house fetch-hook contract (`useAbout`, `useStorageConfig`):
 *   - `useIsMounted()` guards every `setState` past an `await`;
 *   - an `ApiError` becomes its message, with 403 named explicitly;
 *   - `rerun` RESOLVES rather than throwing — the caller is a click handler
 *     and the error has already been captured for rendering.
 *
 * ⚠ `error` MEANS THE REQUEST FAILED. A report whose verdict is `fail` is a
 * successful read and lands in `report`: the failing checks are what the page
 * exists to show.
 *
 * Loads on mount (which may be served from the API's short cache); `rerun`
 * sends `refresh=true` so every probe runs again. The previous report stays
 * on screen while a rerun is in flight.
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import { getDoctorReport } from '../services/doctor';
import type { DoctorReport } from '../services/doctor';
import { useIsMounted } from './useIsMounted';

function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) {
      return 'You do not have permission to run the Doctor';
    }
    return err.message || 'Failed to run the Doctor checks';
  }
  return 'Failed to run the Doctor checks';
}

export interface UseDoctorReturn {
  /** `null` until the first run resolves. Never a signal about the deployment itself. */
  report: DoctorReport | null;
  isLoading: boolean;
  /** The REQUEST failed (403, network, maintenance). Never a failing check. */
  error: string | null;
  /** Run every check again, bypassing any cache (`refresh=true`). */
  rerun: () => Promise<void>;
}

export function useDoctor(): UseDoctorReturn {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const run = useCallback(
    async (refresh: boolean) => {
      try {
        setIsLoading(true);
        setError(null);
        const response = await getDoctorReport(refresh ? { refresh: true } : {});
        if (isMounted()) setReport(response);
      } catch (err) {
        if (isMounted()) setError(messageFor(err));
      } finally {
        if (isMounted()) setIsLoading(false);
      }
    },
    [isMounted],
  );

  useEffect(() => {
    void run(false);
  }, [run]);

  const rerun = useCallback(() => run(true), [run]);

  return { report, isLoading, error, rerun };
}
