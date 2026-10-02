/**
 * The caller's memories and memory preferences (#325), for `/settings/memory`.
 *
 * Loads `GET /api/memories` once (items, preferences, the deployment's policy
 * and counts) and exposes one async action per API call. Every action returns
 * `{ ok: true, ... }` or `{ ok: false, message }` with the refusal already
 * mapped to a sentence (`memoryErrorMessage`), so the page never inspects an
 * `ApiError` itself. After a write the list is re-read rather than patched
 * locally: counts, ordering and the server's dedupe are the API's to decide.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  createMemory,
  deleteAllMemories,
  deleteMemory,
  listMemories,
  memoryErrorMessage,
  restoreMemory,
  updateMemory,
  updateMemorySettings,
  type MemoryCreateInput,
  type MemoryListView,
  type MemoryUpdateInput,
  type UserMemory,
} from '../services/memories';
import type { MemorySettingsPatch } from '../types';
import { useIsMounted } from './useIsMounted';

export type MemoryActionResult<T = undefined> = { ok: true; value: T } | { ok: false; message: string };

export interface UseMemoriesReturn {
  view: MemoryListView | null;
  isLoading: boolean;
  loadError: string | null;
  /** True while any write is in flight. */
  isSaving: boolean;
  refresh: () => Promise<void>;
  add: (input: MemoryCreateInput) => Promise<MemoryActionResult<UserMemory>>;
  update: (id: string, input: MemoryUpdateInput) => Promise<MemoryActionResult<UserMemory>>;
  remove: (id: string) => Promise<MemoryActionResult>;
  restore: (id: string) => Promise<MemoryActionResult<UserMemory>>;
  removeAll: () => Promise<MemoryActionResult>;
  saveSettings: (patch: MemorySettingsPatch) => Promise<MemoryActionResult>;
}

export function useMemories(): UseMemoriesReturn {
  const [view, setView] = useState<MemoryListView | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingWrites, setPendingWrites] = useState(0);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    try {
      const data = await listMemories();
      if (isMounted()) {
        setView(data);
        setLoadError(null);
      }
    } catch (err) {
      if (isMounted()) setLoadError(memoryErrorMessage(err));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const limit = view?.policy.maxPerUser;

  /** Run one write, re-read the list on success, map a refusal. */
  const write = useCallback(
    async <T,>(call: () => Promise<T>): Promise<MemoryActionResult<T>> => {
      setPendingWrites((n) => n + 1);
      try {
        const value = await call();
        await refresh();
        return { ok: true, value };
      } catch (err) {
        return { ok: false, message: memoryErrorMessage(err, limit) };
      } finally {
        if (isMounted()) setPendingWrites((n) => Math.max(0, n - 1));
      }
    },
    [refresh, limit, isMounted],
  );

  const add = useCallback((input: MemoryCreateInput) => write(() => createMemory(input)), [write]);
  const update = useCallback(
    (id: string, input: MemoryUpdateInput) => write(() => updateMemory(id, input)),
    [write],
  );
  const remove = useCallback(
    (id: string) => write(async () => {
      await deleteMemory(id);
      return undefined;
    }),
    [write],
  );
  const restore = useCallback((id: string) => write(() => restoreMemory(id)), [write]);
  const removeAll = useCallback(
    () => write(async () => {
      await deleteAllMemories();
      return undefined;
    }),
    [write],
  );
  const saveSettings = useCallback(
    (patch: MemorySettingsPatch) => write(async () => {
      await updateMemorySettings(patch);
      return undefined;
    }),
    [write],
  );

  return {
    view,
    isLoading,
    loadError,
    isSaving: pendingWrites > 0,
    refresh,
    add,
    update,
    remove,
    restore,
    removeAll,
    saveSettings,
  };
}
