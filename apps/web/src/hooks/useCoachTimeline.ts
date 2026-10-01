/**
 * The coach timeline (E7.8, #248): `GET /api/coach/messages`, cursor-paged.
 *
 * The API answers newest first; `items` here is in DISPLAY order, oldest
 * first, so the newest message sits at the bottom. `loadOlder` follows
 * `nextCursor` (`before=`) and prepends.
 *
 * - `markOpened` posts `.../opened` AT MOST ONCE per message id for the life of
 *   the page, and only for a coach message the server has not seen opened. A
 *   failure (including a `404` while E7.5's route is not deployed) is
 *   swallowed: opening is a signal, never something to show an error for.
 * - `setFeedback` is optimistic and reverts when the post fails.
 * - A failed older-page load keeps everything already loaded on screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  coachErrorOf,
  getCoachMessages,
  markCoachMessageOpened,
  setCoachMessageFeedback,
  type CoachFeedback,
  type CoachTimelineItem,
} from '../services/coach';
import { useIsMounted } from './useIsMounted';

export interface UseCoachTimelineReturn {
  /** Oldest first. */
  items: CoachTimelineItem[];
  isLoading: boolean;
  /** The first page failed; nothing is loaded. */
  error: string | null;
  hasMore: boolean;
  isLoadingOlder: boolean;
  /** An older page failed; what is loaded stays. */
  olderError: string | null;
  reload: () => Promise<void>;
  loadOlder: () => Promise<void>;
  /** Append messages created on this page (a finished chat turn), in order. */
  append: (items: CoachTimelineItem[]) => void;
  markOpened: (id: string) => void;
  setFeedback: (id: string, feedback: CoachFeedback | null) => Promise<boolean>;
}

export function useCoachTimeline(options: { enabled?: boolean } = {}): UseCoachTimelineReturn {
  const enabled = options.enabled ?? true;
  // Newest first, as the API pages them; reversed once for display.
  const [newestFirst, setNewestFirst] = useState<CoachTimelineItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const opened = useRef(new Set<string>());
  const olderInFlight = useRef(false);
  const isMounted = useIsMounted();
  const latest = useRef<CoachTimelineItem[]>([]);
  useEffect(() => {
    latest.current = newestFirst;
  }, [newestFirst]);

  const reload = useCallback(async () => {
    if (!enabled) return;
    setIsLoading(true);
    try {
      const page = await getCoachMessages();
      if (!isMounted()) return;
      setNewestFirst(page.items);
      setCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      if (isMounted()) setError(coachErrorOf(err, 'Could not load your coach messages.').message);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [enabled, isMounted]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadOlder = useCallback(async () => {
    if (!cursor || olderInFlight.current) return;
    olderInFlight.current = true;
    setIsLoadingOlder(true);
    try {
      const page = await getCoachMessages({ before: cursor });
      if (!isMounted()) return;
      setNewestFirst((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !known.has(item.id))];
      });
      setCursor(page.nextCursor);
      setOlderError(null);
    } catch (err) {
      if (isMounted()) setOlderError(coachErrorOf(err, 'Could not load older messages.').message);
    } finally {
      olderInFlight.current = false;
      if (isMounted()) setIsLoadingOlder(false);
    }
  }, [cursor, isMounted]);

  const append = useCallback((items: CoachTimelineItem[]) => {
    for (const item of items) opened.current.add(item.id);
    setNewestFirst((current) => {
      const known = new Set(current.map((item) => item.id));
      const fresh = items.filter((item) => !known.has(item.id));
      return [...fresh.reverse(), ...current];
    });
  }, []);

  const markOpened = useCallback(
    (id: string) => {
      if (opened.current.has(id)) return;
      opened.current.add(id);
      void markCoachMessageOpened(id)
        .then(() => {
          if (!isMounted()) return;
          const now = new Date().toISOString();
          setNewestFirst((current) =>
            current.map((item) => (item.id === id && !item.openedAt ? { ...item, openedAt: now } : item)),
          );
        })
        .catch(() => {
          // A signal, not an action: never an error on screen.
        });
    },
    [isMounted],
  );

  const setFeedback = useCallback(
    async (id: string, feedback: CoachFeedback | null): Promise<boolean> => {
      const previous = latest.current.find((item) => item.id === id)?.feedback ?? null;
      setNewestFirst((current) => current.map((item) => (item.id === id ? { ...item, feedback } : item)));
      try {
        await setCoachMessageFeedback(id, feedback);
        return true;
      } catch {
        if (isMounted()) {
          setNewestFirst((current) =>
            current.map((item) => (item.id === id ? { ...item, feedback: previous } : item)),
          );
        }
        return false;
      }
    },
    [isMounted],
  );

  const items = useMemo(() => [...newestFirst].reverse(), [newestFirst]);

  return {
    items,
    isLoading,
    error,
    hasMore: cursor !== null,
    isLoadingOlder,
    olderError,
    reload,
    loadOlder,
    append,
    markOpened,
    setFeedback,
  };
}
