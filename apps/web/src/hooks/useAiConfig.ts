/**
 * Whether AI is switched on in this deployment, as every authenticated user
 * may know it (`GET /api/ai/config`) — issue #425, epic #419.
 *
 * Mirrors `useNotificationConfig`: `{ config, isLoading, error, refresh }`,
 * fetch on mount, an `useIsMounted` guard. Two deliberate differences:
 *
 * 1. FAIL CLOSED. `config` is never `null`: until the first answer arrives,
 *    and whenever the first fetch fails, it is {@link AI_CONFIG_DISABLED}. A
 *    UI that cannot tell whether AI is on hides every AI surface rather than
 *    offering pages whose every call would `403 AI_DISABLED`. The API is the
 *    real gate; this only decides what is worth showing.
 *
 * 2. ONE FETCH PER SHELL. The answer gates the settings hubs, the Console
 *    rail, the AppBar title, the rail/bottom-bar/user-menu destinations, the
 *    quick actions and four routes. Each of those calling the endpoint on its
 *    own would be half a dozen identical requests per page load, so
 *    `AiConfigProvider` (`contexts/AiConfigContext.tsx`) fetches once around
 *    the authenticated shell and `useAiConfig()` reads that when present. With
 *    no provider above it (a unit test, a component rendered in isolation) it
 *    falls back to fetching for itself, exactly like `useNotificationConfig`.
 *
 * `isLoading` is true only until the FIRST answer settles. A later `refresh()`
 * (the admin AI page after switching AI on) keeps the current answer on
 * screen while it runs — a route guarded on this value must not unmount the
 * page it guards just because the page asked for a re-read — and a failed
 * refresh keeps the last known answer and reports `error`.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import { getAiConfig, type AiPublicConfig } from '../services/ai';
import { useIsMounted } from './useIsMounted';

/** The answer assumed before the API has given one, and after it failed to. */
export const AI_CONFIG_DISABLED: AiPublicConfig = Object.freeze({
  enabled: false,
  keyPolicy: 'byok',
  providers: [],
}) as AiPublicConfig;

export interface UseAiConfigReturn {
  config: AiPublicConfig;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * The shell-wide answer. `null` means "no provider above this component" —
 * see `useAiConfig`'s fallback.
 */
export const AiConfigContext = createContext<UseAiConfigReturn | null>(null);

/**
 * The fetching implementation. `skip` turns it into an inert stub (no
 * request, not loading) so `useAiConfig` can call it unconditionally, per the
 * rules of hooks, and still not fetch when a provider already has.
 */
export function useAiConfigQuery(options: { skip?: boolean } = {}): UseAiConfigReturn {
  const { skip = false } = options;
  const [config, setConfig] = useState<AiPublicConfig>(AI_CONFIG_DISABLED);
  const [isLoading, setIsLoading] = useState(!skip);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);

  const isMounted = useIsMounted();

  const fetchConfig = useCallback(async () => {
    try {
      if (!loaded.current && isMounted()) setIsLoading(true);
      setError(null);
      const data = await getAiConfig();
      loaded.current = true;
      if (isMounted()) setConfig(data);
    } catch (err) {
      if (isMounted()) {
        // Fail closed on the first answer; keep the last known one after.
        if (!loaded.current) setConfig(AI_CONFIG_DISABLED);
        setError(err instanceof ApiError ? err.message : 'Failed to load AI configuration');
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    if (skip) return;
    void fetchConfig();
  }, [fetchConfig, skip]);

  // Memoised: this object is a context value, and a fresh one per render
  // would re-render every consumer in the shell on every provider render.
  return useMemo(
    () => ({ config, isLoading: skip ? false : isLoading, error, refresh: fetchConfig }),
    [config, isLoading, error, fetchConfig, skip],
  );
}

/** The AI configuration — the shell's shared copy when there is one. */
export function useAiConfig(): UseAiConfigReturn {
  const shared = useContext(AiConfigContext);
  const own = useAiConfigQuery({ skip: shared !== null });
  return shared ?? own;
}

/** The feature flags `SettingsFeatureKey`-gated registries read. */
export interface AiFeatureFlags {
  ai: boolean;
}

/**
 * The feature map the registries (`visibleSettingsSections`,
 * `settingsPageTitle`, `isDestinationVisible`) take — read from the shell's
 * provider ONLY, never fetched.
 *
 * For the navigation chrome (rail, bottom bar, user menu, quick actions,
 * AppBar), which renders on every page and in many isolated tests: without a
 * provider it answers "AI off" with no request, which is the correct fail-closed
 * answer and keeps those components free of network side effects.
 */
export function useAiFeatures(): AiFeatureFlags {
  const shared = useContext(AiConfigContext);
  return { ai: shared?.config.enabled === true };
}
