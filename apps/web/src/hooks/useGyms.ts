import { useCallback, useEffect, useState } from 'react';
import {
  createGym,
  deleteGym,
  gymErrorMessage,
  isForbidden,
  listGyms,
  saveTemporaryGym,
  setDefaultGym,
  type GymDetail,
  type GymInput,
  type GymSummary,
  type GymType,
} from '../services/gyms';
import { useIsMounted } from './useIsMounted';

export interface UseGymsOptions {
  /** `false` skips the request (the caller lacks `gyms:read`). */
  enabled?: boolean;
}

export interface UseGymsReturn {
  gyms: GymSummary[];
  isLoading: boolean;
  /** The LOAD error only; a failed mutation rejects instead. */
  error: string | null;
  /** The load answered `403`. */
  forbidden: boolean;
  refresh: () => Promise<void>;
  /** Resolves with the created gym, then refetches the list. */
  create: (input: GymInput) => Promise<GymDetail>;
  setDefault: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** "Save gym" (E6.2): make a temporary gym permanent (same id), then refetch. */
  save: (id: string, input?: { name?: string; type?: GymType }) => Promise<void>;
}

/** E3.3. The caller's gyms, `GET /api/gyms`, with the list-level mutations. */
export function useGyms({ enabled = true }: UseGymsOptions = {}): UseGymsReturn {
  const [gyms, setGyms] = useState<GymSummary[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      setIsLoading(true);
      setError(null);
      const data = await listGyms();
      if (isMounted()) {
        setGyms(data);
        setForbidden(false);
      }
    } catch (err) {
      if (isMounted()) {
        setForbidden(isForbidden(err));
        setError(gymErrorMessage(err, 'Failed to load your gyms'));
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [enabled, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (input: GymInput) => {
      const created = await createGym(input);
      void refresh();
      return created;
    },
    [refresh],
  );

  const setDefault = useCallback(
    async (id: string) => {
      await setDefaultGym(id);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteGym(id);
      await refresh();
    },
    [refresh],
  );

  const save = useCallback(
    async (id: string, input: { name?: string; type?: GymType } = {}) => {
      await saveTemporaryGym(id, input);
      await refresh();
    },
    [refresh],
  );

  return { gyms, isLoading, error, forbidden, refresh, create, setDefault, remove, save };
}
