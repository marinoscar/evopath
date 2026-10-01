/**
 * The opt-in AI health summary (H8, #192) for the Training agents page.
 *
 * Loads `GET /api/ai/training/health-summary`, sends the consent
 * (`PUT .../consent`) and a refresh (`POST .../refresh`), and re-reads the
 * view every few seconds while a summary is being written (`pending`), so the
 * new text appears without a reload. Nothing here decides anything: the API
 * owns the consent, the staleness and the refusals; a thrown `ApiError`
 * reaches the caller unchanged so it can word the 409 reasons.
 *
 * `enabled: false` (the caller lacks `health_data:read`) makes no request.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import {
  getHealthSummary,
  refreshHealthSummary,
  setHealthSummaryConsent,
  type HealthSummaryView,
} from '../services/healthSummary';
import { useIsMounted } from './useIsMounted';

/** How often the view is re-read while a summary is being written. */
export const HEALTH_SUMMARY_POLL_MS = 5_000;

export interface UseHealthSummaryOptions {
  enabled?: boolean;
  pollMs?: number;
}

export interface UseHealthSummaryReturn {
  view: HealthSummaryView | null;
  isLoading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Turns the consent on or off. Rejects with the API's error. */
  setConsent: (enabled: boolean) => Promise<void>;
  /** Queues a new summary. Rejects with the API's error (409 reasons included). */
  refresh: () => Promise<void>;
}

export function useHealthSummary({
  enabled = true,
  pollMs = HEALTH_SUMMARY_POLL_MS,
}: UseHealthSummaryOptions = {}): UseHealthSummaryReturn {
  const [view, setView] = useState<HealthSummaryView | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const reload = useCallback(async () => {
    try {
      const next = await getHealthSummary();
      if (!isMounted()) return;
      setView(next);
      setError(null);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof ApiError ? err.message : 'Failed to load your health summary');
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    void reload();
  }, [enabled, reload]);

  const pending = view?.pending ?? false;
  useEffect(() => {
    if (!enabled || !pending) return;
    const timer = setTimeout(() => void reload(), pollMs);
    return () => clearTimeout(timer);
  }, [enabled, pending, pollMs, reload, view]);

  const setConsent = useCallback(
    async (next: boolean) => {
      const updated = await setHealthSummaryConsent(next);
      if (isMounted()) setView(updated);
    },
    [isMounted],
  );

  const refresh = useCallback(async () => {
    const updated = await refreshHealthSummary();
    if (isMounted()) setView(updated);
  }, [isMounted]);

  return { view, isLoading, error, reload, setConsent, refresh };
}
