/**
 * The caller's own AI provider keys (`/api/ai/keys`) — issue #430, epic #419.
 *
 * One `UserAiKey` view per ENABLED provider, configured or not. The API never
 * returns a key (see `services/ai.ts`), so nothing this hook holds can leak
 * one: `setKey` sends the typed key once and keeps only the masked view the
 * server answers with.
 *
 * `error` is the LIST's error only. `setKey`, `deleteKey` and `testKey` throw
 * to their caller instead of writing it, because each is triggered from one
 * provider's card and its failure belongs inline on that card — a
 * `400 AI_KEY_INVALID` for OpenAI must not become a page-level banner that
 * reads as though every key were broken.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import {
  deleteUserAiKey,
  listUserAiKeys,
  setUserAiKey,
  testUserAiKey,
  type AiProbeResult,
  type UserAiKey,
} from '../services/ai';
import { useIsMounted } from './useIsMounted';

export interface UseUserAiKeysReturn {
  keys: UserAiKey[];
  isLoading: boolean;
  error: string | null;
  /** Verify and store a key (PUT). Rejects — nothing stored — when the provider refuses it. */
  setKey: (provider: string, apiKey: string) => Promise<UserAiKey>;
  /** Remove the stored key. Idempotent server-side. */
  deleteKey: (provider: string) => Promise<void>;
  /**
   * Probe a key. Blank `apiKey` tests the STORED key, which also refreshes its
   * verification and reachable models server-side — so the list is re-read.
   * Always resolves with the probe result (the endpoint answers 200); read
   * `success`.
   */
  testKey: (provider: string, apiKey?: string) => Promise<AiProbeResult>;
  refresh: () => Promise<void>;
}

export function useUserAiKeys(): UseUserAiKeysReturn {
  const [keys, setKeys] = useState<UserAiKey[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await listUserAiKeys();
      if (isMounted()) setKeys(data);
    } catch (err) {
      if (isMounted()) {
        setError(err instanceof ApiError ? err.message : 'Failed to load your AI keys');
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upsert = useCallback(
    (view: UserAiKey) => {
      if (!isMounted()) return;
      setKeys((current) =>
        current.some((entry) => entry.provider === view.provider)
          ? current.map((entry) => (entry.provider === view.provider ? view : entry))
          : [...current, view],
      );
    },
    [isMounted],
  );

  const setKey = useCallback(
    async (provider: string, apiKey: string) => {
      const view = await setUserAiKey(provider, apiKey);
      upsert(view);
      return view;
    },
    [upsert],
  );

  const deleteKey = useCallback(
    async (provider: string) => {
      await deleteUserAiKey(provider);
      await refresh();
    },
    [refresh],
  );

  const testKey = useCallback(
    async (provider: string, apiKey?: string) => {
      const result = await testUserAiKey(provider, apiKey);
      // Only a stored-key probe changes anything the list shows.
      if (result.usedStoredKey) await refresh();
      return result;
    },
    [refresh],
  );

  return { keys, isLoading, error, setKey, deleteKey, testKey, refresh };
}
