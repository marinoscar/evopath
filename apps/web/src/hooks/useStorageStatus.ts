/**
 * Whether object storage is configured in this deployment (`GET
 * /api/storage/status`) — issue #204.
 *
 * FAILS OPEN, deliberately the opposite of `useAiConfig`: `configured` is
 * `null` ("unknown") while loading and whenever the read fails, and only an
 * explicit `false` from the API makes a caller swap an upload control for
 * `FeatureUnavailableNotice`. An unknown answer never blocks an upload; the
 * API is the real gate and reports its own error if storage is missing.
 *
 * `skip` makes the hook inert (no request, `configured: null`), so a caller
 * that lacks `storage:write` — and so never shows an upload control — asks
 * nothing.
 */
import { useEffect, useState } from 'react';
import { getStorageStatus } from '../services/storage';

export interface UseStorageStatusReturn {
  /** `true`/`false` from the API; `null` while unknown (loading, failed or skipped). */
  configured: boolean | null;
  isLoading: boolean;
}

export function useStorageStatus(options: { skip?: boolean } = {}): UseStorageStatusReturn {
  const { skip = false } = options;
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(!skip);

  useEffect(() => {
    if (skip) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    getStorageStatus()
      .then((status) => {
        if (!cancelled) setConfigured(typeof status.configured === 'boolean' ? status.configured : null);
      })
      .catch(() => {
        // Unknown, not "off": never block on a failed read.
        if (!cancelled) setConfigured(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skip]);

  return { configured: skip ? null : configured, isLoading: skip ? false : isLoading };
}

export default useStorageStatus;
