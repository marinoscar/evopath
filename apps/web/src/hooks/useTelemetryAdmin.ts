/**
 * The Telemetry settings page's data — issue #537, epic #528.
 *
 * Loads `GET /admin/telemetry/config` and `GET /admin/telemetry/status`
 * together, and saves with `If-Match: <version>`. A stale version answers 409;
 * that is surfaced as `conflict` (not a generic error) so the page can offer a
 * reload rather than a retry that would fail the same way.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import {
  getTelemetryAdminConfig,
  getTelemetryStatus,
  updateTelemetryAdminConfig,
  type TelemetryAdminConfig,
  type TelemetrySettingsUpdate,
  type TelemetryStatus,
} from '../services/telemetry';
import { useIsMounted } from './useIsMounted';

export interface UseTelemetryAdminReturn {
  config: TelemetryAdminConfig | null;
  status: TelemetryStatus | null;
  isLoading: boolean;
  loadError: string | null;
  statusError: string | null;
  isSaving: boolean;
  saveError: string | null;
  /** True after a save was refused with 409 — someone else saved first. */
  conflict: boolean;
  reload: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  /** Resolves `true` on success. */
  save: (settings: TelemetrySettingsUpdate) => Promise<boolean>;
}

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError || err instanceof Error ? err.message : fallback;
}

export function useTelemetryAdmin(): UseTelemetryAdminReturn {
  const [config, setConfig] = useState<TelemetryAdminConfig | null>(null);
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const isMounted = useIsMounted();

  const refreshStatus = useCallback(async () => {
    try {
      const next = await getTelemetryStatus();
      if (isMounted()) {
        setStatus(next);
        setStatusError(null);
      }
    } catch (err) {
      if (isMounted()) setStatusError(message(err, 'Failed to load telemetry status'));
    }
  }, [isMounted]);

  const reload = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    setSaveError(null);
    setConflict(false);
    try {
      const [next] = await Promise.all([getTelemetryAdminConfig(), refreshStatus()]);
      if (isMounted()) setConfig(next);
    } catch (err) {
      if (isMounted()) setLoadError(message(err, 'Failed to load telemetry configuration'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted, refreshStatus]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (settings: TelemetrySettingsUpdate) => {
      setIsSaving(true);
      setSaveError(null);
      setConflict(false);
      try {
        const next = await updateTelemetryAdminConfig(settings, config?.version);
        if (isMounted()) setConfig(next);
        void refreshStatus();
        return true;
      } catch (err) {
        if (isMounted()) {
          if (err instanceof ApiError && err.status === 409) {
            setConflict(true);
          } else {
            setSaveError(message(err, 'Failed to save telemetry configuration'));
          }
        }
        return false;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [config?.version, isMounted, refreshStatus],
  );

  return {
    config,
    status,
    isLoading,
    loadError,
    statusError,
    isSaving,
    saveError,
    conflict,
    reload,
    refreshStatus,
    save,
  };
}
