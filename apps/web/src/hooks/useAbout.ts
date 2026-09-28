/**
 * What is deployed here, read from `GET /api/admin/about` (issue #401, epic
 * #397).
 *
 * Deliberately the canonical "one GET, no params" fetch hook — the same shape
 * as `useNotificationConfig`, down to the three `useState`s, the `useIsMounted`
 * guard on every `setState` past an `await`, the `useCallback` fetch and the
 * `{ data, isLoading, error, refresh }` return. There is nothing special about
 * this endpoint from the client's side: it takes no parameters, it is not
 * paginated, it is not polled, and it is not cached across mounts.
 *
 * =============================================================================
 * ⚠ `error` MEANS THE REQUEST FAILED. IT NEVER MEANS "THE DEPLOYMENT IS BROKEN".
 * =============================================================================
 *
 * This is the one thing a reader of this hook has to get right, and it is a
 * property of the API rather than a convention of this file. `GET
 * /api/admin/about` ALWAYS answers 200 for an authorized caller — a missing
 * deploy document is `deployInfoStatus: 'absent'`, an unreadable one is
 * `'invalid'`, a run that failed partway is `run.outcome: 'failure'` beside a
 * complete document, and a database that did not answer is `database: null`
 * with a `databaseError` string. Every one of those arrives here as a
 * successful `data`, and the PAGE renders each as a fact.
 *
 * So `error` being non-null here means something else entirely went wrong: a
 * 403 (the caller does not hold `system_settings:read`), a network failure, or
 * a maintenance window. Treating `deployInfoStatus !== 'ok'` as an error — or
 * surfacing `databaseError` through this field — would throw away exactly the
 * facts an operator opened the page to read, at the moment they came for them.
 *
 * NOT POLLED, deliberately. A deployment's identity changes when somebody
 * deploys, which is not something that happens while you watch — unlike the
 * worker fleet's health, which `useVisiblePolling` exists for. `refresh` is
 * exposed so the page can offer an explicit re-read (the API re-reads the file
 * from disk on every request, so that genuinely picks up a fresh deploy without
 * a restart or a reload).
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError, getAbout } from '../services/api';
import type { AboutResponse } from '../types';
import { useIsMounted } from './useIsMounted';

interface UseAboutReturn {
  /** `null` until the first read resolves — never a signal about the deployment itself. */
  data: AboutResponse | null;
  isLoading: boolean;
  /** The REQUEST failed (403, network, maintenance). Never a deploy-document state. */
  error: string | null;
  refresh: () => Promise<void>;
}

export function useAbout(): UseAboutReturn {
  const [data, setData] = useState<AboutResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Every `setState` past an `await` is guarded: a request that settles after
  // the component is gone must not schedule an update on it. Same rule as the
  // other fetch hooks in this directory.
  const isMounted = useIsMounted();

  const fetchAbout = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const response = await getAbout();
      if (isMounted()) setData(response);
    } catch (err) {
      if (isMounted()) {
        setError(
          err instanceof ApiError ? err.message : 'Failed to load deployment information',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void fetchAbout();
  }, [fetchAbout]);

  return { data, isLoading, error, refresh: fetchAbout };
}
