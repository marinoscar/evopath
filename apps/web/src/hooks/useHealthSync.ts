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
  deleteRelease,
  getAndroidAppConfig,
  getLatestRelease,
  listReleases,
  makeReleaseCurrent,
  uploadRelease,
  type AdminRelease,
  type Release,
  type UploadReleaseInput,
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

  const { refresh: reload } = loaded;
  /** Re-read the config (#287: making a release current can trust its signer server-side). */
  const refresh = useCallback(async () => {
    await reload();
    if (isMounted()) setOverride(null);
  }, [reload, isMounted]);

  return {
    config: override ?? loaded.data,
    isLoading: loaded.isLoading,
    error: loaded.error,
    isSaving,
    saveError,
    save,
    refresh,
  };
}

/**
 * `GET /api/android-app/releases/latest` (#287) while `enabled`: the current
 * APK, or `null` when none is published (the API's 404 `NO_RELEASE`).
 */
export function useLatestRelease(enabled = true) {
  const fetcher = useCallback(() => getLatestRelease(), []);
  const { data, ...rest } = useLoad<Release | null>(fetcher, null, 'Failed to load the Android app release', enabled);
  return { release: data, ...rest };
}

/** What a failed release write answered: the message to show and the API's code. */
export interface ReleaseWriteError {
  message: string;
  code: string | null;
}

function releaseWriteError(err: unknown, fallback: string): ReleaseWriteError {
  return {
    message: healthSyncErrorMessage(err, fallback),
    code: err instanceof ApiError ? (err.code ?? null) : null,
  };
}

const NO_RELEASES: AdminRelease[] = [];

/**
 * The admin release list (#287) and its writes. Every write re-reads the list
 * afterwards: making one release current clears the flag on another, which
 * only the server knows.
 */
export function useAndroidReleases() {
  const fetcher = useCallback(() => listReleases(), []);
  const { data, refresh, ...rest } = useLoad(fetcher, NO_RELEASES, 'Failed to load the Android app releases');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const isMounted = useIsMounted();

  const run = useCallback(
    async <T,>(work: () => Promise<T>, fallback: string): Promise<{ ok: true; value: T } | { ok: false; error: ReleaseWriteError }> => {
      try {
        const value = await work();
        await refresh();
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: releaseWriteError(err, fallback) };
      }
    },
    [refresh],
  );

  const upload = useCallback(
    async (input: UploadReleaseInput) => {
      setIsUploading(true);
      try {
        return await run(() => uploadRelease(input), 'Failed to upload the release');
      } finally {
        if (isMounted()) setIsUploading(false);
      }
    },
    [run, isMounted],
  );

  const makeCurrent = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        return await run(() => makeReleaseCurrent(id), 'Failed to make the release current');
      } finally {
        if (isMounted()) setBusyId(null);
      }
    },
    [run, isMounted],
  );

  const remove = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        return await run(() => deleteRelease(id), 'Failed to delete the release');
      } finally {
        if (isMounted()) setBusyId(null);
      }
    },
    [run, isMounted],
  );

  return { releases: data, refresh, ...rest, busyId, isUploading, upload, makeCurrent, remove };
}
