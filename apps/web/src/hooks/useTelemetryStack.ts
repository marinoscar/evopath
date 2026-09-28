/**
 * The Telemetry services section's data — issue #567.
 *
 * Loads `GET /admin/telemetry/stack` and polls it: every `activeIntervalMs`
 * (3 s) while a deploy job is pending/running, else every `idleIntervalMs`
 * (30 s). Polling pauses with the tab (`useVisiblePolling`) and stops on
 * unmount. `deploy()` POSTs `/admin/telemetry/stack/deploy` and re-reads the
 * stack at once, so the progress indicator appears without waiting a tick.
 *
 * The browser never decides anything here: the API reports the containers and
 * the job, and runs the deployment as a queue job.
 *
 * Writes resolve `true`/`false` and never throw.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import {
  deployTelemetryStack,
  getTelemetryStack,
  type TelemetryStack,
  type TelemetryStackDeploy,
} from '../services/telemetry';
import { useIsMounted } from './useIsMounted';
import { useVisiblePolling } from './useVisiblePolling';

export const TELEMETRY_STACK_ACTIVE_POLL_MS = 3_000;
export const TELEMETRY_STACK_IDLE_POLL_MS = 30_000;

export interface UseTelemetryStackOptions {
  activeIntervalMs?: number;
  idleIntervalMs?: number;
}

export interface UseTelemetryStackReturn {
  stack: TelemetryStack | null;
  isLoading: boolean;
  loadError: string | null;
  /** The deploy POST is in flight. */
  isRequesting: boolean;
  deployError: string | null;
  /** A deploy is requested or its job is pending/running. */
  isDeploying: boolean;
  /** The job id the last successful POST returned, until the stack reports it settled. */
  requestedJobId: string | null;
  reload: () => Promise<void>;
  deploy: () => Promise<boolean>;
}

export function isDeployActive(deploy: TelemetryStackDeploy | null | undefined): boolean {
  return deploy?.status === 'pending' || deploy?.status === 'running';
}

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError || err instanceof Error ? err.message : fallback;
}

export function useTelemetryStack(options: UseTelemetryStackOptions = {}): UseTelemetryStackReturn {
  const activeIntervalMs = options.activeIntervalMs ?? TELEMETRY_STACK_ACTIVE_POLL_MS;
  const idleIntervalMs = options.idleIntervalMs ?? TELEMETRY_STACK_IDLE_POLL_MS;

  const [stack, setStack] = useState<TelemetryStack | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [requestedJobId, setRequestedJobId] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const reload = useCallback(async () => {
    try {
      const next = await getTelemetryStack();
      if (!isMounted()) return;
      setStack(next);
      setLoadError(null);
    } catch (err) {
      if (isMounted()) setLoadError(message(err, 'Failed to load the telemetry services'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The requested job is tracked until the stack reports it settled — the
  // first GET after the POST can still describe the previous deploy.
  useEffect(() => {
    if (
      requestedJobId &&
      stack?.deploy?.jobId === requestedJobId &&
      !isDeployActive(stack.deploy)
    ) {
      setRequestedJobId(null);
    }
  }, [requestedJobId, stack]);

  const isDeploying = isRequesting || !!requestedJobId || isDeployActive(stack?.deploy);

  useVisiblePolling(() => void reload(), isDeploying ? activeIntervalMs : idleIntervalMs);

  const deploy = useCallback(async () => {
    setIsRequesting(true);
    setDeployError(null);
    try {
      const { jobId } = await deployTelemetryStack();
      if (isMounted()) setRequestedJobId(jobId);
      await reload();
      return true;
    } catch (err) {
      if (isMounted()) setDeployError(message(err, 'The deployment could not be started'));
      return false;
    } finally {
      if (isMounted()) setIsRequesting(false);
    }
  }, [isMounted, reload]);

  return {
    stack,
    isLoading,
    loadError,
    isRequesting,
    deployError,
    isDeploying,
    requestedJobId,
    reload,
    deploy,
  };
}
