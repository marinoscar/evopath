/**
 * The deployment's coach policy (`/api/admin/coach/settings`, E7.3, #243).
 *
 * `ai_config:read` loads it; `ai_config:write` saves it. The house hook
 * contract: `save` resolves rather than throwing, and every `setState` past
 * an `await` is guarded by `useIsMounted()`. The PUT answers the stored
 * policy, which becomes the new baseline.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  coachErrorOf,
  getSystemCoachSettings,
  updateSystemCoachSettings,
  type SystemCoachSettings,
} from '../services/coach';
import { useIsMounted } from './useIsMounted';

export type SystemCoachSaveResult = { ok: true } | { ok: false; message: string };

export interface UseSystemCoachSettingsReturn {
  settings: SystemCoachSettings | null;
  isLoading: boolean;
  loadError: string | null;
  isSaving: boolean;
  refresh: () => Promise<void>;
  save: (patch: Partial<SystemCoachSettings>) => Promise<SystemCoachSaveResult>;
}

export function useSystemCoachSettings(): UseSystemCoachSettingsReturn {
  const [settings, setSettings] = useState<SystemCoachSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await getSystemCoachSettings();
      if (isMounted()) {
        setSettings(data);
        setLoadError(null);
      }
    } catch (err) {
      if (isMounted()) setLoadError(coachErrorOf(err, 'Failed to load the coach settings').message);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (patch: Partial<SystemCoachSettings>): Promise<SystemCoachSaveResult> => {
      setIsSaving(true);
      try {
        const data = await updateSystemCoachSettings(patch);
        if (isMounted()) setSettings(data);
        return { ok: true };
      } catch (err) {
        const info = coachErrorOf(err, 'Failed to save the coach settings');
        if (info.status === 403) return { ok: false, message: 'You do not have permission to change the coach settings.' };
        if (info.status === null || info.status >= 500) {
          return { ok: false, message: 'Could not reach the server, so nothing was saved. Try again.' };
        }
        return { ok: false, message: info.message };
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [isMounted],
  );

  return { settings, isLoading, loadError, isSaving, refresh, save };
}
