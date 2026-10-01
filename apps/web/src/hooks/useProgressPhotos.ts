import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import {
  PROGRESS_PHOTO_PAGE_SIZE,
  getLatestProgressPhoto,
  listProgressPhotos,
  type ProgressPhoto,
  type ProgressPhotoPose,
} from '../services/progressPhotos';
import { useIsMounted } from './useIsMounted';

export interface UseProgressPhotosReturn {
  photos: ProgressPhoto[];
  /** True while there is another page to load. */
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  /** The LOAD error only; a failed delete rejects its own call. */
  error: string | null;
  /** The API answered 403 (no `health_data:read`). */
  forbidden: boolean;
  /** Fetch the next page and append it. */
  loadMore: () => Promise<void>;
  /** Start again from the first page, e.g. after an add. */
  refresh: () => Promise<void>;
  /** Drop one photo from the list without a refetch (after a delete). */
  removeLocal: (id: string) => void;
}

function loadErrorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Failed to load your progress photos';
}

/**
 * E7.9 (#249). The caller's progress photos, `GET /api/progress-photos`,
 * newest first, keyset-paged through `nextCursor` ("Load more"). Changing
 * `pose` starts again from the first page.
 *
 * Only the newest request may write state: a slow answer for the previous
 * pose filter is dropped rather than shown under the new one.
 */
export function useProgressPhotos(pose: ProgressPhotoPose | null): UseProgressPhotosReturn {
  const [photos, setPhotos] = useState<ProgressPhoto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const isMounted = useIsMounted();
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    const current = () => isMounted() && seq === requestSeq.current;
    setIsLoading(true);
    setError(null);
    try {
      const page = await listProgressPhotos({ pose, limit: PROGRESS_PHOTO_PAGE_SIZE });
      if (!current()) return;
      setPhotos(page.items);
      setNextCursor(page.nextCursor);
      setForbidden(false);
    } catch (err) {
      if (!current()) return;
      setForbidden(err instanceof ApiError && err.status === 403);
      setError(loadErrorMessage(err));
    } finally {
      if (current()) setIsLoading(false);
    }
  }, [pose, isMounted]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    const seq = requestSeq.current;
    const current = () => isMounted() && seq === requestSeq.current;
    setIsLoadingMore(true);
    setError(null);
    try {
      const page = await listProgressPhotos({ pose, limit: PROGRESS_PHOTO_PAGE_SIZE, cursor: nextCursor });
      if (!current()) return;
      setPhotos((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...page.items.filter((p) => !seen.has(p.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (!current()) return;
      setError(loadErrorMessage(err));
    } finally {
      if (isMounted()) setIsLoadingMore(false);
    }
  }, [nextCursor, pose, isMounted]);

  const removeLocal = useCallback((id: string) => {
    setPhotos((prev) => prev.filter((p) => p.id !== id));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    photos,
    hasMore: nextCursor !== null,
    isLoading,
    isLoadingMore,
    error,
    forbidden,
    loadMore,
    refresh,
    removeLocal,
  };
}

export interface UseLatestProgressPhotoReturn {
  photo: ProgressPhoto | null;
  isLoading: boolean;
}

/**
 * The newest photo of `pose` (`GET /api/progress-photos?pose=X&limit=1`), the
 * ghost overlay's source. `null` pose asks nothing. A failed read is simply
 * "no overlay": the add flow never breaks because the ghost is missing.
 */
export function useLatestProgressPhoto(pose: ProgressPhotoPose | null): UseLatestProgressPhotoReturn {
  const [photo, setPhoto] = useState<ProgressPhoto | null>(null);
  const [isLoading, setIsLoading] = useState(pose !== null);

  useEffect(() => {
    if (!pose) {
      setPhoto(null);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setPhoto(null);
    getLatestProgressPhoto(pose)
      .then((latest) => {
        if (!cancelled) setPhoto(latest);
      })
      .catch(() => {
        if (!cancelled) setPhoto(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pose]);

  return { photo, isLoading };
}

/** At most this many pages are read for the compare picker (100 per page). */
export const COMPARE_MAX_PAGES = 10;

export interface UseAllProgressPhotosReturn {
  photos: ProgressPhoto[];
  isLoading: boolean;
  error: string | null;
}

/**
 * Every photo of `pose` (newest first), for the compare picker, which needs
 * the OLDEST photo as its default "before". Reads up to
 * {@link COMPARE_MAX_PAGES} pages of 100. `enabled: false` asks nothing.
 */
export function useAllProgressPhotos(pose: ProgressPhotoPose, enabled: boolean): UseAllProgressPhotosReturn {
  const [photos, setPhotos] = useState<ProgressPhoto[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    (async () => {
      const all: ProgressPhoto[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < COMPARE_MAX_PAGES; page += 1) {
        const result = await listProgressPhotos({ pose, limit: 100, cursor });
        all.push(...result.items);
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return all;
    })()
      .then((all) => {
        if (!cancelled) setPhotos(all);
      })
      .catch((err) => {
        if (!cancelled) setError(loadErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pose, enabled]);

  return { photos, isLoading, error };
}
