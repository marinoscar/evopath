/**
 * The caller's recent health exports, polled while any is still being made.
 *
 * Issue #191 (H7). One list is the single source of progress: a new export is
 * prepended to it, and every `pending` or `running` item is re-read through
 * `GET /api/health/exports/:id` with a growing delay (2 s, then x1.5 up to
 * 10 s) until it is `ready`, `failed` or `expired`. Closing the dialog stops
 * the polling (`enabled` false); reopening it lists the exports again, so an
 * export started earlier is picked up where it was left.
 *
 * Download URLs are short-lived and never kept: `download(id)` asks the API
 * for a fresh one right before it is opened.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createHealthExport,
  describeHealthExportError,
  getHealthExport,
  isHealthExportActive,
  listHealthExports,
  type CreateHealthExportInput,
  type HealthExport,
} from '../services/healthExport';
import { useIsMounted } from './useIsMounted';

export const HEALTH_EXPORT_POLL_INITIAL_MS = 2000;
export const HEALTH_EXPORT_POLL_MAX_MS = 10_000;
const BACKOFF = 1.5;

export interface UseHealthExportsOptions {
  /** First poll delay; tests pass a few milliseconds. */
  pollIntervalMs?: number;
  /** Opens a download URL; defaults to a new browsing context without an opener. */
  openUrl?: (url: string) => void;
}

export interface UseHealthExportsReturn {
  /** Newest first. `null` until the first list resolves. */
  items: HealthExport[] | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Queues an export and prepends it. Throws the API error (the caller maps it). */
  create: (input: CreateHealthExportInput) => Promise<HealthExport>;
  /** Fetches a fresh URL and opens it. Resolves to a message when it could not. */
  download: (id: string) => Promise<string | null>;
}

function defaultOpenUrl(url: string): void {
  // A signed URL to object storage with `Content-Disposition: attachment`:
  // opened rather than fetched, so the browser's own download handles it.
  // `noopener` because the target is a third-party storage host.
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** The list never holds a URL: it would outlive its five minutes. */
function withoutUrl(item: HealthExport): HealthExport {
  return item.download ? { ...item, download: null } : item;
}

export function useHealthExports(enabled: boolean, options: UseHealthExportsOptions = {}): UseHealthExportsReturn {
  const { pollIntervalMs = HEALTH_EXPORT_POLL_INITIAL_MS, openUrl = defaultOpenUrl } = options;
  const [items, setItems] = useState<HealthExport[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const merge = useCallback((updated: HealthExport[]) => {
    setItems((prev) => {
      if (!prev) return prev;
      const byId = new Map(updated.map((item) => [item.id, withoutUrl(item)]));
      return prev.map((item) => byId.get(item.id) ?? item);
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const list = await listHealthExports();
      if (isMounted()) setItems(list.map(withoutUrl));
    } catch (err) {
      if (isMounted()) setError(describeHealthExportError(err, 'Could not load your recent exports.'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  // The ids still being made, as a stable key: the poll restarts only when the set changes.
  const activeKey = useMemo(
    () => (items ?? []).filter(isHealthExportActive).map((item) => item.id).join(','),
    [items],
  );

  useEffect(() => {
    if (!enabled || activeKey === '') return undefined;
    const ids = activeKey.split(',');
    let cancelled = false;
    let delay = pollIntervalMs;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const results = await Promise.allSettled(ids.map((id) => getHealthExport(id)));
      if (cancelled) return;
      // A failed read (a blip) is retried on the next tick, after a longer wait.
      merge(results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])));
      delay = Math.min(delay * BACKOFF, HEALTH_EXPORT_POLL_MAX_MS);
      timer = setTimeout(() => void tick(), delay);
    };

    timer = setTimeout(() => void tick(), delay);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, activeKey, pollIntervalMs, merge]);

  const create = useCallback(
    async (input: CreateHealthExportInput) => {
      const created = await createHealthExport(input);
      if (isMounted()) {
        setItems((prev) => [withoutUrl(created), ...(prev ?? []).filter((item) => item.id !== created.id)]);
      }
      return created;
    },
    [isMounted],
  );

  const download = useCallback(
    async (id: string): Promise<string | null> => {
      try {
        const current = await getHealthExport(id);
        if (isMounted()) merge([current]);
        if (current.status === 'ready' && current.download) {
          openUrl(current.download.url);
          return null;
        }
        return current.status === 'expired'
          ? 'This export has expired. Create a new one.'
          : 'This export is not ready to download.';
      } catch (err) {
        return describeHealthExportError(err, 'Could not get the download link. Please try again.');
      }
    },
    [isMounted, merge, openUrl],
  );

  return { items, isLoading, error, refresh, create, download };
}
