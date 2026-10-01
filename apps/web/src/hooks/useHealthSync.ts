/**
 * Fetch hooks over `services/healthSync.ts` — issue #283, epic #276.
 *
 * The house fetch-hook contract (`useDoctor`, `useAbout`):
 *   - `useIsMounted()` guards every `setState` past an `await`;
 *   - an `ApiError` becomes its message, with 403 named explicitly;
 *   - `refresh` RESOLVES rather than throwing — the error is already captured
 *     for rendering.
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import {
  getAndroidAppConfig,
  listDevices,
  listDiagnostics,
  listRuns,
  putAndroidAppConfig,
  type AndroidAppConfig,
  type Device,
  type ReportSummary,
  type Run,
  type TrustedApp,
} from '../services/healthSync';
import { useIsMounted } from './useIsMounted';

export function healthSyncErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'You do not have permission to see this.';
    return err.message || fallback;
  }
  return fallback;
}

interface Loaded<T> {
  data: T;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** Load `fetcher()` on mount (and whenever it changes) while `enabled`. */
function useLoad<T>(fetcher: () => Promise<T>, initial: T, fallback: string, enabled = true): Loaded<T> {
  const [data, setData] = useState<T>(initial);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const next = await fetcher();
      if (isMounted()) setData(next);
    } catch (err) {
      if (isMounted()) setError(healthSyncErrorMessage(err, fallback));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [fetcher, fallback, isMounted]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  return { data, isLoading, error, refresh };
}

const NO_DEVICES: Device[] = [];
const NO_RUNS: Run[] = [];
const NO_REPORTS: ReportSummary[] = [];

/** `GET /api/health-sync/devices` */
export function useHealthSyncDevices() {
  const fetcher = useCallback(() => listDevices(), []);
  const { data, ...rest } = useLoad(fetcher, NO_DEVICES, 'Failed to load your connected devices');
  return { devices: data, ...rest };
}

/** `GET /api/health-sync/devices/:id/runs`, only once `enabled` (a section was opened). */
export function useDeviceRuns(deviceId: string, enabled: boolean) {
  const fetcher = useCallback(() => listRuns(deviceId), [deviceId]);
  const { data, ...rest } = useLoad(fetcher, NO_RUNS, 'Failed to load the sync history', enabled);
  return { runs: data, ...rest };
}

/** `GET /api/health-sync/devices/:id/diagnostics`, only once `enabled`. */
export function useDeviceDiagnostics(deviceId: string, enabled: boolean) {
  const fetcher = useCallback(() => listDiagnostics(deviceId), [deviceId]);
  const { data, ...rest } = useLoad(fetcher, NO_REPORTS, 'Failed to load the diagnostic reports', enabled);
  return { reports: data, ...rest };
}

/** `GET` / `PUT /api/admin/android-app` */
export function useAndroidAppConfig() {
  const fetcher = useCallback(() => getAndroidAppConfig(), []);
  const loaded = useLoad<AndroidAppConfig | null>(fetcher, null, 'Failed to load the Android app settings');
  const [override, setOverride] = useState<AndroidAppConfig | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const save = useCallback(
    async (trustedApps: TrustedApp[]): Promise<boolean> => {
      try {
        setIsSaving(true);
        setSaveError(null);
        const next = await putAndroidAppConfig(trustedApps);
        if (isMounted()) setOverride(next);
        return true;
      } catch (err) {
        if (isMounted()) setSaveError(healthSyncErrorMessage(err, 'Failed to save the trusted apps'));
        return false;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [isMounted],
  );

  return {
    config: override ?? loaded.data,
    isLoading: loaded.isLoading,
    error: loaded.error,
    isSaving,
    saveError,
    save,
  };
}
