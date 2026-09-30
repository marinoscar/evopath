/**
 * Quick workout adaptation (E6.1) hooks over `services/trainingAdaptation.ts`.
 *
 * - `useAdaptation(id)`: one adaptation, with cancel, apply (both modes) and
 *   discard. Each action refetches the row so the page renders what the API
 *   stored; a refused action rejects with the `ApiError` for the caller to
 *   explain.
 * - `useAdaptationPreview(request)`: the debounced "what will be sent"
 *   preview, refreshed when the request changes. Only a request that asks
 *   for a change is previewed (the API refuses the others with 400).
 * - `useAdaptationResume(enabled)`: the latest ready, unapplied adaptation
 *   this browser started in the last 24 hours, for the Today resume chip.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import {
  adaptationRequestProblem,
  applyAdaptationPlan,
  applyAdaptationWorkout,
  cancelAdaptation,
  discardAdaptation,
  forgetAdaptation,
  getAdaptation,
  previewAdaptation,
  recallAdaptation,
  RESUME_WINDOW_MS,
  type AdaptationPreview,
  type AdaptationRequest,
  type AdaptationView,
  type ApplyPlanResult,
  type ApplyWorkoutResult,
} from '../services/trainingAdaptation';
import { useIsMounted } from './useIsMounted';

const messageOf = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

export interface UseAdaptationReturn {
  adaptation: AdaptationView | null;
  isLoading: boolean;
  error: string | null;
  notFound: boolean;
  refetch: () => Promise<void>;
  cancel: () => Promise<void>;
  applyWorkout: () => Promise<ApplyWorkoutResult>;
  applyPlan: () => Promise<ApplyPlanResult>;
  discard: () => Promise<void>;
}

export function useAdaptation(id: string): UseAdaptationReturn {
  const [adaptation, setAdaptation] = useState<AdaptationView | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const isMounted = useIsMounted();

  const refetch = useCallback(async () => {
    try {
      const fresh = await getAdaptation(id);
      if (!isMounted()) return;
      setAdaptation(fresh);
      setError(null);
      setNotFound(false);
    } catch (err) {
      if (!isMounted()) return;
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      setError(messageOf(err, 'Could not load the adjusted workout'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [id, isMounted]);

  useEffect(() => {
    setAdaptation(null);
    setIsLoading(true);
    setNotFound(false);
    void refetch();
  }, [refetch]);

  const cancel = useCallback(async () => {
    const updated = await cancelAdaptation(id);
    if (isMounted()) setAdaptation(updated);
  }, [id, isMounted]);

  const applyWorkout = useCallback(async () => {
    const result = await applyAdaptationWorkout(id);
    forgetAdaptation(id);
    void refetch();
    return result;
  }, [id, refetch]);

  const applyPlan = useCallback(async () => {
    const result = await applyAdaptationPlan(id);
    forgetAdaptation(id);
    void refetch();
    return result;
  }, [id, refetch]);

  const discard = useCallback(async () => {
    await discardAdaptation(id);
    forgetAdaptation(id);
    await refetch();
  }, [id, refetch]);

  return { adaptation, isLoading, error, notFound, refetch, cancel, applyWorkout, applyPlan, discard };
}

/** How long the request must stay still before the preview is refreshed. */
export const ADAPTATION_PREVIEW_DEBOUNCE_MS = 400;

export interface UseAdaptationPreviewReturn {
  preview: AdaptationPreview | null;
  isLoading: boolean;
  error: string | null;
}

export function useAdaptationPreview(
  request: AdaptationRequest,
  { enabled = true, delayMs = ADAPTATION_PREVIEW_DEBOUNCE_MS }: { enabled?: boolean; delayMs?: number } = {},
): UseAdaptationPreviewReturn {
  const [preview, setPreview] = useState<AdaptationPreview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const isMounted = useIsMounted();
  const key = JSON.stringify(request);
  const previewable = enabled && adaptationRequestProblem(request) === null;

  useEffect(() => {
    if (!previewable) {
      latest.current += 1;
      setIsLoading(false);
      setPreview(null);
      setError(null);
      return undefined;
    }
    setIsLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const requestId = ++latest.current;
      previewAdaptation(JSON.parse(key) as AdaptationRequest, { signal: controller.signal })
        .then((data) => {
          if (!isMounted() || requestId !== latest.current) return;
          setPreview(data);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!isMounted() || requestId !== latest.current || controller.signal.aborted) return;
          setError(messageOf(err, 'Could not preview what will be sent'));
        })
        .finally(() => {
          if (isMounted() && requestId === latest.current) setIsLoading(false);
        });
    }, delayMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [delayMs, isMounted, key, previewable]);

  return { preview, isLoading, error };
}

export interface UseAdaptationResumeReturn {
  /** A ready, unapplied adaptation to offer, or null. */
  ready: AdaptationView | null;
}

export function useAdaptationResume(enabled: boolean): UseAdaptationResumeReturn {
  const [ready, setReady] = useState<AdaptationView | null>(null);
  const isMounted = useIsMounted();

  useEffect(() => {
    if (!enabled) {
      setReady(null);
      return;
    }
    const remembered = recallAdaptation();
    if (!remembered) return;
    getAdaptation(remembered.id)
      .then((view) => {
        if (!isMounted()) return;
        const age = Date.now() - new Date(view.updatedAt).getTime();
        if (view.status === 'ready' && view.appliedAs === null && !(age > RESUME_WINDOW_MS)) {
          setReady(view);
          return;
        }
        setReady(null);
        // Still working: it may become ready; anything else will never be offered.
        if (view.status !== 'queued' && view.status !== 'running') forgetAdaptation(view.id);
      })
      .catch((err: unknown) => {
        if (!isMounted()) return;
        setReady(null);
        if (err instanceof ApiError && err.status === 404) forgetAdaptation(remembered.id);
      });
  }, [enabled, isMounted]);

  return { ready };
}
