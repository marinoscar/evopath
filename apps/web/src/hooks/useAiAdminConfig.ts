/**
 * Load, save, key-manage and probe the deployment's AI configuration
 * (`/api/admin/ai/*`). Issue #429, epic #419.
 *
 * The house hook contract, as `useStorageConfig` states it:
 *
 *   - SEPARATE FLAG GROUPS. `save` is the ordinary form edit and owns
 *     `isSaving`/`saveError`. The provider KEY writes (`setKey`/`removeKey`)
 *     act immediately, per provider, and own `keyAction`/`keyError`. `test` is
 *     a PROBE — it saves nothing — and owns `probingProvider`/`probeError`
 *     plus the per-provider `testResults`. Folding them together would make
 *     the Save button spin while a key is being verified, and let a save error
 *     and a provider diagnosis overwrite each other.
 *   - EVERY WRITE RESOLVES `true`/`false` RATHER THAN THROWING.
 *   - `useIsMounted()` GUARDS EVERY `setState` PAST AN `await`.
 *
 * ⚠ THE AI-SPECIFIC CODE IS IN `details.reason`. The API's error envelope
 * carries the generic HTTP code at the top level (`FORBIDDEN`, `BAD_REQUEST`)
 * and the AI taxonomy code (`AI_KEY_INVALID`, `AI_KEY_REQUIRED`, …) under
 * `details.reason`. `toAiErrorInfo` (`services/aiErrors.ts`) — the one
 * helper every AI surface uses — reads it there.
 *
 * ⚠ THE PROBE NEVER REJECTS ON A BAD ANSWER. `POST …/test` answers 200 with
 * `success: false` for a rejected key; that lands in `testResults` like any
 * other result. A rejection means the CALL failed and becomes `probeError`.
 *
 * ⚠ NO KEY IS EVER HELD HERE. `setKey` and `test` take the typed key as an
 * argument and forward it; nothing in this hook's state can hold one, and the
 * response that comes back is the masked `keyStatus`.
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import {
  deleteAiProviderKey,
  getAiAdminConfig,
  setAiProviderKey,
  testAiProvider,
  updateAiAdminConfig,
} from '../services/ai';
import type { AiAdminConfig, AiAdminConfigInput, AiProbeResult } from '../services/ai';
import { toAiErrorInfo } from '../services/aiErrors';
import { useIsMounted } from './useIsMounted';

/** A copy of `record` with `key` removed. */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/** 403 is named explicitly — it is the one failure an admin can act on themselves. */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const reason = toAiErrorInfo(err).code;
    if (err.status === 403 && !reason) {
      return 'You do not have permission to manage the AI configuration';
    }
    switch (reason) {
      case 'AI_KEY_INVALID':
        return 'The provider rejected this key, so nothing was stored. Check the key and try again.';
      case 'AI_KEY_REQUIRED':
        return (
          err.message ||
          'The organisation-key fallback needs a stored key for every enabled provider. Save a key first.'
        );
      case 'AI_PROVIDER_UNAVAILABLE':
        return 'The provider could not be reached to verify the key. Try again shortly.';
      case 'AI_UNKNOWN_PROVIDER':
        return err.message || 'That provider does not exist in this deployment.';
      case 'AI_PROVIDER_NOT_REGISTERED':
        return (
          err.message ||
          'That provider is not available in this build, so it can be switched off but not on.'
        );
      // #448 — the provider-specific settings (Azure OpenAI, OpenAI-compatible).
      case 'AI_BASE_URL_REQUIRED':
        return (
          err.message ||
          'This provider needs an endpoint before it can be enabled. Enter its base URL, then save.'
        );
      case 'AI_PROVIDER_SETTINGS_INVALID':
        return (
          err.message ||
          "One of this provider's settings was refused. Check the URL (https for Azure OpenAI, no user name, password or #fragment), the API version and the deployment names."
        );
      case 'AI_PROVIDER_FIELD_UNSUPPORTED':
        return err.message || 'This provider does not accept one of the settings sent. Reload the page and try again.';
      default:
        // `PUT …/key` answers 503 when the provider could not be asked to
        // verify the key at all — nothing was stored, and retrying is the fix.
        if (err.status === 503) {
          return 'The provider could not be reached to verify the key, so nothing was stored. Try again shortly.';
        }
        return err.message || fallback;
    }
  }
  return fallback;
}

/** Which key write is in flight, if any. Only one ever is. */
export interface AiKeyAction {
  provider: string;
  action: 'save' | 'remove';
}

/** A failed call scoped to one provider's card. */
export interface AiProviderError {
  provider: string;
  message: string;
}

export interface UseAiAdminConfigReturn {
  config: AiAdminConfig | null;
  isLoading: boolean;
  /** Failure to LOAD — "nothing to show", distinct from "your change did not stick". */
  loadError: string | null;
  refresh: () => Promise<void>;

  isSaving: boolean;
  saveError: string | null;
  clearSaveError: () => void;
  /** `PUT` with `If-Match: version`. A 409 reloads the configuration and explains. */
  save: (input: AiAdminConfigInput) => Promise<boolean>;

  keyAction: AiKeyAction | null;
  keyError: AiProviderError | null;
  clearKeyError: () => void;
  /** Warnings the last key removal came back with (e.g. `ORG_FALLBACK_WITHOUT_KEY`). */
  keyWarnings: string[];
  clearKeyWarnings: () => void;
  setKey: (provider: string, apiKey: string) => Promise<boolean>;
  removeKey: (provider: string) => Promise<boolean>;

  /** The provider whose probe is in flight, or `null`. */
  probingProvider: string | null;
  /** The last failure of the probe CALL itself — never a diagnosis. */
  probeError: AiProviderError | null;
  clearProbeError: () => void;
  /** The last probe result per provider, pass or fail. */
  testResults: Record<string, AiProbeResult>;
  clearTestResult: (provider: string) => void;
  test: (provider: string, input?: { apiKey?: string; baseUrl?: string }) => Promise<void>;
}

export function useAiAdminConfig(): UseAiAdminConfigReturn {
  const [config, setConfig] = useState<AiAdminConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [keyAction, setKeyAction] = useState<AiKeyAction | null>(null);
  const [keyError, setKeyError] = useState<AiProviderError | null>(null);
  const [keyWarnings, setKeyWarnings] = useState<string[]>([]);
  const [probingProvider, setProbingProvider] = useState<string | null>(null);
  const [probeError, setProbeError] = useState<AiProviderError | null>(null);
  const [testResults, setTestResults] = useState<Record<string, AiProbeResult>>({});

  const isMounted = useIsMounted();

  const fetchConfig = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const data = await getAiAdminConfig();
      if (isMounted()) setConfig(data);
    } catch (err) {
      if (isMounted()) setLoadError(messageFor(err, 'Failed to load the AI configuration'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  /**
   * THE RESPONSE IS THE NEW BASELINE, never the input: the server owns
   * `keyStatus` and `version`, and `version` is what the NEXT save sends as
   * `If-Match`, so two saves in a row work with no reload in between.
   */
  const save = useCallback(
    async (input: AiAdminConfigInput): Promise<boolean> => {
      try {
        setIsSaving(true);
        setSaveError(null);
        const data = await updateAiAdminConfig(input, config?.version ?? 0);
        if (isMounted()) setConfig(data);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && !toAiErrorInfo(err).code) {
          // Somebody else saved between this page's load and this click. Every
          // retry would 409 identically until the form is rebuilt from the
          // current row, so reload it and say plainly the fields were replaced.
          await fetchConfig();
          if (isMounted()) {
            setSaveError(
              'Someone else changed the AI configuration while you were editing. ' +
                'The form has been reloaded with the current configuration — review it and save again.',
            );
          }
          return false;
        }
        if (isMounted()) setSaveError(messageFor(err, 'Failed to save the AI configuration'));
        return false;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [config, fetchConfig, isMounted],
  );

  const setKey = useCallback(
    async (provider: string, apiKey: string): Promise<boolean> => {
      try {
        setKeyAction({ provider, action: 'save' });
        setKeyError(null);
        setKeyWarnings([]);
        const data = await setAiProviderKey(provider, apiKey);
        if (isMounted()) {
          setConfig(data);
          // The last probe described a different key.
          setTestResults((prev) => without(prev, provider));
        }
        return true;
      } catch (err) {
        if (isMounted()) {
          setKeyError({ provider, message: messageFor(err, 'Failed to save the key') });
        }
        return false;
      } finally {
        if (isMounted()) setKeyAction(null);
      }
    },
    [isMounted],
  );

  const removeKey = useCallback(
    async (provider: string): Promise<boolean> => {
      try {
        setKeyAction({ provider, action: 'remove' });
        setKeyError(null);
        setKeyWarnings([]);
        const data = await deleteAiProviderKey(provider);
        if (isMounted()) {
          const { warnings, ...view } = data;
          setConfig(view);
          setKeyWarnings(warnings);
          setTestResults((prev) => without(prev, provider));
        }
        return true;
      } catch (err) {
        if (isMounted()) {
          setKeyError({ provider, message: messageFor(err, 'Failed to remove the key') });
        }
        return false;
      } finally {
        if (isMounted()) setKeyAction(null);
      }
    },
    [isMounted],
  );

  const test = useCallback(
    async (provider: string, input: { apiKey?: string; baseUrl?: string } = {}) => {
      try {
        setProbingProvider(provider);
        setProbeError(null);
        setTestResults((prev) => without(prev, provider));
        const result = await testAiProvider(provider, input);
        if (isMounted()) setTestResults((prev) => ({ ...prev, [provider]: result }));
      } catch (err) {
        if (isMounted()) {
          setProbeError({ provider, message: messageFor(err, 'The provider test could not be run') });
        }
      } finally {
        if (isMounted()) setProbingProvider(null);
      }
    },
    [isMounted],
  );

  const clearSaveError = useCallback(() => setSaveError(null), []);
  const clearKeyError = useCallback(() => setKeyError(null), []);
  const clearKeyWarnings = useCallback(() => setKeyWarnings([]), []);
  const clearProbeError = useCallback(() => setProbeError(null), []);
  const clearTestResult = useCallback(
    (provider: string) => setTestResults((prev) => without(prev, provider)),
    [],
  );

  return {
    config,
    isLoading,
    loadError,
    refresh: fetchConfig,
    isSaving,
    saveError,
    clearSaveError,
    save,
    keyAction,
    keyError,
    clearKeyError,
    keyWarnings,
    clearKeyWarnings,
    setKey,
    removeKey,
    probingProvider,
    probeError,
    clearProbeError,
    testResults,
    clearTestResult,
    test,
  };
}
