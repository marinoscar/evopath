/**
 * The GreptimeDB connection section's data — issue #558, epic #528.
 *
 * Loads `GET /admin/telemetry/connection`; saves (`PUT`) and reverts
 * (`DELETE`) with `If-Match: <the connection's version>` — its own counter,
 * not `/config`'s. A stale version answers 409, surfaced as `conflict` so the
 * page can offer a reload. `test` probes a candidate connection: the route
 * always answers 200 with a diagnosis, so a refused login lands in
 * `testResult`, and only a failed CALL lands in `testError`.
 *
 * Writes resolve `true`/`false` and never throw.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import {
  getTelemetryConnection,
  resetTelemetryConnection,
  testTelemetryConnection,
  updateTelemetryConnection,
  type TelemetryConnection,
  type TelemetryConnectionInput,
  type TelemetryConnectionTestResult,
} from '../services/telemetry';
import { useIsMounted } from './useIsMounted';

export interface UseTelemetryConnectionReturn {
  connection: TelemetryConnection | null;
  isLoading: boolean;
  loadError: string | null;
  /** A save or revert is in flight. */
  isSaving: boolean;
  saveError: string | null;
  /** True after a write was refused with 409 — someone else changed it first. */
  conflict: boolean;
  isTesting: boolean;
  testResult: TelemetryConnectionTestResult | null;
  testError: string | null;
  reload: () => Promise<void>;
  save: (input: TelemetryConnectionInput) => Promise<boolean>;
  revert: () => Promise<boolean>;
  test: (input: TelemetryConnectionInput) => Promise<void>;
  clearTestResult: () => void;
}

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError || err instanceof Error ? err.message : fallback;
}

export function useTelemetryConnection(): UseTelemetryConnectionReturn {
  const [connection, setConnection] = useState<TelemetryConnection | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<TelemetryConnectionTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const reload = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    setSaveError(null);
    setConflict(false);
    try {
      const next = await getTelemetryConnection();
      if (isMounted()) setConnection(next);
    } catch (err) {
      if (isMounted()) setLoadError(message(err, 'Failed to load the telemetry connection'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const write = useCallback(
    async (run: () => Promise<TelemetryConnection>, fallback: string) => {
      setIsSaving(true);
      setSaveError(null);
      setConflict(false);
      try {
        const next = await run();
        if (isMounted()) {
          setConnection(next);
          setTestResult(null);
          setTestError(null);
        }
        return true;
      } catch (err) {
        if (isMounted()) {
          if (err instanceof ApiError && err.status === 409) {
            setConflict(true);
          } else {
            setSaveError(message(err, fallback));
          }
        }
        return false;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [isMounted],
  );

  const version = connection?.version;

  const save = useCallback(
    (input: TelemetryConnectionInput) =>
      write(
        () => updateTelemetryConnection(input, version),
        'Failed to save the telemetry connection',
      ),
    [write, version],
  );

  const revert = useCallback(
    () =>
      write(
        () => resetTelemetryConnection(version),
        'Failed to revert the telemetry connection',
      ),
    [write, version],
  );

  const test = useCallback(
    async (input: TelemetryConnectionInput) => {
      setIsTesting(true);
      setTestResult(null);
      setTestError(null);
      try {
        const result = await testTelemetryConnection(input);
        if (isMounted()) setTestResult(result);
      } catch (err) {
        if (isMounted()) setTestError(message(err, 'The connection test could not be run'));
      } finally {
        if (isMounted()) setIsTesting(false);
      }
    },
    [isMounted],
  );

  const clearTestResult = useCallback(() => {
    setTestResult(null);
    setTestError(null);
  }, []);

  return {
    connection,
    isLoading,
    loadError,
    isSaving,
    saveError,
    conflict,
    isTesting,
    testResult,
    testError,
    reload,
    save,
    revert,
    test,
    clearTestResult,
  };
}
