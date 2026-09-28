/**
 * Whether telemetry exists in this deployment, as every authenticated user may
 * know it (`GET /api/telemetry/config`) — issue #537, epic #528.
 *
 * A deliberate mirror of `useAiConfig.ts`, for the same two reasons:
 *
 * 1. FAIL CLOSED. `config` is never `null`: until the first answer arrives,
 *    and whenever the first fetch fails, it is {@link TELEMETRY_CONFIG_DISABLED},
 *    so no telemetry surface is offered on a guess.
 *
 * 2. ONE FETCH PER SHELL. `TelemetryConfigProvider`
 *    (`contexts/TelemetryConfigContext.tsx`) fetches once around the
 *    authenticated shell; `useTelemetryConfig()` reads that when present and
 *    falls back to fetching for itself when rendered in isolation.
 *
 * The `telemetry` feature is ON when `available && enabled`: a store is
 * deployed AND collection is switched on. `refresh()` is what the Telemetry
 * settings page calls after a save.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import { getTelemetryConfig, type TelemetryPublicConfig } from '../services/telemetry';
import { useIsMounted } from './useIsMounted';

/** The answer assumed before the API has given one, and after it failed to. */
export const TELEMETRY_CONFIG_DISABLED: TelemetryPublicConfig = Object.freeze({
  available: false,
  enabled: false,
  assistantEnabled: false,
});

export interface UseTelemetryConfigReturn {
  config: TelemetryPublicConfig;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** The shell-wide answer; `null` means "no provider above this component". */
export const TelemetryConfigContext = createContext<UseTelemetryConfigReturn | null>(null);

/** Whether the `telemetry` settings feature is on for this answer. */
export function isTelemetryOn(config: TelemetryPublicConfig): boolean {
  return config.available === true && config.enabled === true;
}

/** The fetching implementation; `skip` makes it an inert stub. */
export function useTelemetryConfigQuery(options: { skip?: boolean } = {}): UseTelemetryConfigReturn {
  const { skip = false } = options;
  const [config, setConfig] = useState<TelemetryPublicConfig>(TELEMETRY_CONFIG_DISABLED);
  const [isLoading, setIsLoading] = useState(!skip);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);
  const isMounted = useIsMounted();

  const fetchConfig = useCallback(async () => {
    try {
      if (!loaded.current && isMounted()) setIsLoading(true);
      setError(null);
      const data = await getTelemetryConfig();
      loaded.current = true;
      if (isMounted()) setConfig(data);
    } catch (err) {
      if (isMounted()) {
        if (!loaded.current) setConfig(TELEMETRY_CONFIG_DISABLED);
        setError(err instanceof ApiError ? err.message : 'Failed to load telemetry configuration');
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    if (skip) return;
    void fetchConfig();
  }, [fetchConfig, skip]);

  return useMemo(
    () => ({ config, isLoading: skip ? false : isLoading, error, refresh: fetchConfig }),
    [config, isLoading, error, fetchConfig, skip],
  );
}

/** The telemetry configuration — the shell's shared copy when there is one. */
export function useTelemetryConfig(): UseTelemetryConfigReturn {
  const shared = useContext(TelemetryConfigContext);
  const own = useTelemetryConfigQuery({ skip: shared !== null });
  return shared ?? own;
}

export interface TelemetryFeatureFlags {
  telemetry: boolean;
}

/**
 * The `telemetry` entry of the registries' feature map — read from the shell's
 * provider ONLY, never fetched (the navigation chrome renders in many isolated
 * tests; without a provider it answers "off" with no request).
 */
export function useTelemetryFeatures(): TelemetryFeatureFlags {
  const shared = useContext(TelemetryConfigContext);
  return { telemetry: shared ? isTelemetryOn(shared.config) : false };
}
