/**
 * One photo intake: read it, poll it while the AI scan runs, and edit its
 * draft items — the state behind a review screen built on
 * `components/intake/AiDraftReview.tsx`.
 *
 * POLLING IS A TIMEOUT CHAIN (the next read is scheduled only after the
 * previous one answered) and runs only while `status === 'scanning'`, every
 * `intervalMs` (2 s). It copies `useAiRun`'s tolerance: a read that fails for
 * a reason that can clear on its own (a network `TypeError`, a 5xx, 408, 429)
 * marks the intake `stale` and keeps polling with a linear backoff; only
 * {@link PHOTO_INTAKE_MAX_POLL_FAILURES} consecutive failures stop it and
 * surface `error`. Any other 4xx (404: not theirs, or gone) stops at once. A
 * hidden tab skips the read and checks again one interval later.
 *
 * Every mutation adopts the item (or intake) the server returned, so two tabs
 * editing the same item end at "last write wins" with the UI showing what the
 * server holds. The server decides everything — schema validation,
 * provenance (`originalAiValue`, `userVerified`), whether apply may run.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import { toAiErrorInfo, type AiErrorInfo } from '../services/aiErrors';
import {
  acceptAllDraftItems,
  addDraftItem,
  analyzeIntake,
  applyIntake,
  deleteDraftItem,
  discardIntake,
  getIntake,
  updateDraftItem,
  type DraftItemView,
  type PhotoIntakePhotoView,
  type PhotoIntakeView,
} from '../services/intake';
import { useIsMounted } from './useIsMounted';

export const PHOTO_INTAKE_POLL_INTERVAL_MS = 2000;
export const PHOTO_INTAKE_MAX_POLL_FAILURES = 3;

function isTransientReadFailure(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  return err.status >= 500 || err.status === 408 || err.status === 429;
}

export interface UsePhotoIntakeOptions {
  intervalMs?: number;
  /** Fires once each time a scan leaves `scanning` (to `ready` or `failed`). */
  onScanSettled?: (intake: PhotoIntakeView) => void;
}

export interface UsePhotoIntakeReturn<TValue = unknown, TContext = unknown> {
  intake: PhotoIntakeView<TValue, TContext> | null;
  items: DraftItemView<TValue>[];
  photos: PhotoIntakePhotoView[];
  isLoading: boolean;
  isScanning: boolean;
  /** True while a mutation is in flight. */
  isMutating: boolean;
  /** The last read or mutation failure (never a single transient poll failure). */
  error: AiErrorInfo | null;
  /** The last poll failed; `intake` is the last KNOWN state. */
  stale: boolean;
  /** The scan itself failed (`status === 'failed'`), as `AiErrorAlert` reads it. */
  scanError: AiErrorInfo | null;
  refresh: () => Promise<void>;
  clearError: () => void;
  /**
   * Start the AI read. The server picks the model (#173); `expected` is the
   * model the caller was shown, used only to fill the intake optimistically
   * until the next poll reports the one the server used.
   */
  analyze: (expected?: { provider: string; modelId: string } | null) => Promise<boolean>;
  acceptItem: (itemId: string) => Promise<void>;
  rejectItem: (itemId: string) => Promise<void>;
  restoreItem: (itemId: string) => Promise<void>;
  editItem: (itemId: string, value: TValue) => Promise<void>;
  addItem: (kind: string, value: TValue) => Promise<void>;
  /** User items only; an AI item is rejected instead. */
  deleteItem: (itemId: string) => Promise<void>;
  acceptAll: () => Promise<void>;
  /** Resolves with the kind's result, or `undefined` when the API refused. */
  apply: <TResult = unknown>() => Promise<TResult | undefined>;
  discard: () => Promise<boolean>;
}

export function usePhotoIntake<TValue = unknown, TContext = unknown>(
  intakeId: string | null | undefined,
  options: UsePhotoIntakeOptions = {},
): UsePhotoIntakeReturn<TValue, TContext> {
  const { intervalMs = PHOTO_INTAKE_POLL_INTERVAL_MS } = options;
  const [intake, setIntake] = useState<PhotoIntakeView<TValue, TContext> | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(intakeId));
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<AiErrorInfo | null>(null);
  const [stale, setStale] = useState(false);
  const isMounted = useIsMounted();

  const onSettledRef = useRef(options.onScanSettled);
  onSettledRef.current = options.onScanSettled;
  const previousStatus = useRef<string | null>(null);

  const adopt = useCallback((next: PhotoIntakeView<TValue, TContext>) => {
    const before = previousStatus.current;
    previousStatus.current = next.status;
    setIntake(next);
    if (before === 'scanning' && next.status !== 'scanning') {
      onSettledRef.current?.(next as PhotoIntakeView);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!intakeId) return;
    try {
      const next = await getIntake<TValue, TContext>(intakeId);
      if (!isMounted()) return;
      adopt(next);
      setStale(false);
      setError(null);
    } catch (err) {
      if (isMounted()) setError(toAiErrorInfo(err, 'Could not load this photo intake'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [intakeId, adopt, isMounted]);

  useEffect(() => {
    setIntake(null);
    previousStatus.current = null;
    setError(null);
    setStale(false);
    setIsLoading(Boolean(intakeId));
    if (intakeId) void refresh();
  }, [intakeId, refresh]);

  const scanning = intake?.status === 'scanning';

  useEffect(() => {
    if (!intakeId || !scanning) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;

    const poll = async () => {
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(poll, intervalMs);
        return;
      }
      try {
        const next = await getIntake<TValue, TContext>(intakeId);
        if (cancelled || !isMounted()) return;
        failures = 0;
        setStale(false);
        adopt(next);
        if (next.status === 'scanning') timer = setTimeout(poll, intervalMs);
      } catch (err) {
        if (cancelled || !isMounted()) return;
        failures += 1;
        setStale(true);
        if (isTransientReadFailure(err) && failures < PHOTO_INTAKE_MAX_POLL_FAILURES) {
          timer = setTimeout(poll, intervalMs * (failures + 1));
          return;
        }
        const info = toAiErrorInfo(err, 'Could not read the scan status');
        setError(
          err instanceof ApiError
            ? info
            : {
                ...info,
                message: 'Lost contact with the server while checking the scan. It may still be running.',
              },
        );
      }
    };

    timer = setTimeout(poll, intervalMs);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [intakeId, scanning, intervalMs, adopt, isMounted]);

  /** Run one mutation with the shared busy/error bookkeeping. */
  const run = useCallback(
    async <T,>(fallback: string, call: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
      setPending((n) => n + 1);
      setError(null);
      try {
        const value = await call();
        return { ok: true, value };
      } catch (err) {
        if (isMounted()) setError(toAiErrorInfo(err, fallback));
        return { ok: false };
      } finally {
        if (isMounted()) setPending((n) => n - 1);
      }
    },
    [isMounted],
  );

  const replaceItem = useCallback(
    (item: DraftItemView<TValue>) => {
      if (!isMounted()) return;
      setIntake((current) => {
        if (!current) return current;
        const exists = current.items.some((entry) => entry.id === item.id);
        const items = exists
          ? current.items.map((entry) => (entry.id === item.id ? item : entry))
          : [...current.items, item];
        return { ...current, items: [...items].sort((a, b) => a.sortOrder - b.sortOrder) };
      });
    },
    [isMounted],
  );

  const setItemStatus = useCallback(
    async (itemId: string, status: DraftItemView['status'], fallback: string) => {
      if (!intakeId) return;
      const result = await run(fallback, () => updateDraftItem<TValue>(intakeId, itemId, { status }));
      if (result.ok) replaceItem(result.value);
    },
    [intakeId, run, replaceItem],
  );

  const acceptItem = useCallback(
    (itemId: string) => setItemStatus(itemId, 'accepted', 'Could not accept this item'),
    [setItemStatus],
  );
  const rejectItem = useCallback(
    (itemId: string) => setItemStatus(itemId, 'rejected', 'Could not reject this item'),
    [setItemStatus],
  );
  const restoreItem = useCallback(
    (itemId: string) => setItemStatus(itemId, 'pending', 'Could not restore this item'),
    [setItemStatus],
  );

  const editItem = useCallback(
    async (itemId: string, value: TValue) => {
      if (!intakeId) return;
      const result = await run('Could not save this item', () => updateDraftItem<TValue>(intakeId, itemId, { value }));
      if (result.ok) replaceItem(result.value);
    },
    [intakeId, run, replaceItem],
  );

  const addItem = useCallback(
    async (kind: string, value: TValue) => {
      if (!intakeId) return;
      const result = await run('Could not add this item', () => addDraftItem<TValue>(intakeId, { kind, value }));
      if (result.ok) replaceItem(result.value);
    },
    [intakeId, run, replaceItem],
  );

  const deleteItem = useCallback(
    async (itemId: string) => {
      if (!intakeId) return;
      const result = await run('Could not delete this item', () => deleteDraftItem(intakeId, itemId));
      if (result.ok && isMounted()) {
        setIntake((current) =>
          current ? { ...current, items: current.items.filter((item) => item.id !== itemId) } : current,
        );
      }
    },
    [intakeId, run, isMounted],
  );

  const acceptAll = useCallback(async () => {
    if (!intakeId) return;
    const result = await run('Could not accept the items', () => acceptAllDraftItems<TValue>(intakeId));
    if (result.ok) for (const item of result.value) replaceItem(item);
  }, [intakeId, run, replaceItem]);

  const analyze = useCallback(
    async (expected?: { provider: string; modelId: string } | null) => {
      if (!intakeId) return false;
      const result = await run('Could not start the scan', () => analyzeIntake(intakeId));
      if (!result.ok) return false;
      if (isMounted()) {
        previousStatus.current = 'scanning';
        setIntake((current) =>
          current
            ? {
                ...current,
                status: 'scanning',
                provider: expected?.provider ?? current.provider,
                modelId: expected?.modelId ?? current.modelId,
                jobId: result.value.jobId,
                errorCode: null,
                errorMessage: null,
              }
            : current,
        );
      }
      return true;
    },
    [intakeId, run, isMounted],
  );

  const apply = useCallback(async <TResult,>() => {
    if (!intakeId) return undefined;
    const result = await run('Could not save these items', () => applyIntake<TResult>(intakeId));
    if (!result.ok) return undefined;
    if (isMounted()) setIntake((current) => (current ? { ...current, status: 'applied' } : current));
    return result.value;
  }, [intakeId, run, isMounted]);

  const discard = useCallback(async () => {
    if (!intakeId) return false;
    const result = await run('Could not discard this intake', () => discardIntake(intakeId));
    return result.ok;
  }, [intakeId, run]);

  const clearError = useCallback(() => setError(null), []);

  const scanError: AiErrorInfo | null =
    intake?.status === 'failed'
      ? { code: intake.errorCode, message: intake.errorMessage || 'The scan could not read these photos.' }
      : null;

  return {
    intake,
    items: intake?.items ?? [],
    photos: intake?.photos ?? [],
    isLoading,
    isScanning: scanning,
    isMutating: pending > 0,
    error,
    stale,
    scanError,
    refresh,
    clearError,
    analyze,
    acceptItem,
    rejectItem,
    restoreItem,
    editItem,
    addItem,
    deleteItem,
    acceptAll,
    apply,
    discard,
  };
}
