import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import {
  getHealthProfile,
  saveHealthProfile,
  type HealthProfile,
  type HealthProfileInput,
} from '../services/health';
import { useIsMounted } from './useIsMounted';

export interface UseHealthProfileReturn {
  profile: HealthProfile | null;
  isLoading: boolean;
  /** The LOAD error only. A failed save rejects `save` instead. */
  error: string | null;
  isSaving: boolean;
  /**
   * Full-replace the profile, sending the loaded `version` as `If-Match`.
   *
   * Rejects with the `ApiError` on failure, including a `409`
   * (`isHealthProfileConflict`). Unlike `useUserSettings`, a conflict does NOT
   * refetch: that would replace the form's source with the newer row and wipe
   * the edits the user is looking at. The caller offers `refresh` instead.
   */
  save: (input: HealthProfileInput) => Promise<HealthProfile>;
  refresh: () => Promise<void>;
}

/** Issue #47 (E2.1). The caller's own health profile, `GET`/`PUT /api/health-profile`. */
export function useHealthProfile(): UseHealthProfileReturn {
  const [profile, setProfile] = useState<HealthProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const isMounted = useIsMounted();

  const fetchProfile = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await getHealthProfile();
      if (isMounted()) setProfile(data);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to load your health profile';
      if (isMounted()) setError(message);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void fetchProfile();
  }, [fetchProfile]);

  const save = useCallback(
    async (input: HealthProfileInput) => {
      setIsSaving(true);
      try {
        const saved = await saveHealthProfile(input, profile?.version ?? 0);
        if (isMounted()) setProfile(saved);
        return saved;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [profile?.version, isMounted],
  );

  return { profile, isLoading, error, isSaving, save, refresh: fetchProfile };
}
