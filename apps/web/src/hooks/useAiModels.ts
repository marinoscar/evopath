/**
 * The organisation's AI model catalogue (`/api/admin/ai/models`) — issue
 * #429, epic #419.
 *
 * Fetches one page for the filter it is given and re-fetches whenever that
 * filter changes (compare by value, so a caller may rebuild the object every
 * render). A response that arrives after a newer request was sent is DROPPED:
 * typing in the search box fires several requests, and the last one to be
 * sent — not the last one to land — is the one on screen.
 *
 * ⚠ ENABLING IS OPTIMISTIC. `setEnabled` flips the row at once and rolls it
 * back if the API refuses (409 `AI_MODEL_DEPRECATED`, 400
 * `AI_MODEL_UNCLASSIFIED`, or anything else). Resolves `true`/`false`; the refusal lands in `updateError`, worded
 * from the AI code in `details.reason`.
 *
 * `refreshCatalog` enqueues discovery on the job queue and resolves the job
 * id — the catalogue does not change until that job runs, so the list is not
 * re-read here.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import { listAiModels, refreshAiModels, updateAiModel } from '../services/ai';
import type { AiModel, AiModelCapabilities, AiModelListFilter } from '../services/ai';
import { toAiErrorInfo } from '../services/aiErrors';
import { useIsMounted } from './useIsMounted';

/** The AI code an error carries (`details.reason`), or `null`. */
function aiErrorReason(err: unknown): string | null {
  return toAiErrorInfo(err).code;
}

function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403 && !aiErrorReason(err)) {
      return 'You do not have permission to manage AI models';
    }
    return err.message || fallback;
  }
  return fallback;
}

/** Why a model's enablement was refused, in words an admin can act on. */
function enableRefusalMessage(err: unknown, enabling: boolean): string {
  switch (aiErrorReason(err)) {
    case 'AI_MODEL_DEPRECATED':
      return 'This model has been withdrawn by the provider and cannot be enabled.';
    case 'AI_MODEL_UNCLASSIFIED':
      return 'Classify this model first — edit its capabilities, then enable it.';
    default:
      return messageFor(err, enabling ? 'Failed to enable the model' : 'Failed to disable the model');
  }
}

export interface UseAiModelsReturn {
  models: AiModel[];
  total: number;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;

  /** Ids with a PATCH in flight. */
  pendingIds: ReadonlySet<string>;
  updateError: string | null;
  clearUpdateError: () => void;
  /** Optimistic; rolls back on refusal. */
  setEnabled: (model: AiModel, enabled: boolean) => Promise<boolean>;
  /** Admin override — the server sets `capabilitySource: 'admin_override'`. */
  updateCapabilities: (model: AiModel, capabilities: AiModelCapabilities) => Promise<boolean>;

  isRefreshing: boolean;
  refreshError: string | null;
  clearRefreshError: () => void;
  /** Enqueue discovery for one provider. Resolves the job id, or `null` on failure. */
  refreshCatalog: (provider: string) => Promise<string | null>;
}

export function useAiModels(filter: AiModelListFilter): UseAiModelsReturn {
  const [models, setModels] = useState<AiModel[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const isMounted = useIsMounted();
  const requestSeq = useRef(0);

  // Value identity, so a caller rebuilding the filter object every render
  // does not refetch every render.
  const filterKey = JSON.stringify(filter);

  const fetchModels = useCallback(async () => {
    const seq = ++requestSeq.current;
    const isCurrent = () => isMounted() && seq === requestSeq.current;
    try {
      setIsLoading(true);
      setError(null);
      const response = await listAiModels(JSON.parse(filterKey) as AiModelListFilter);
      if (isCurrent()) {
        setModels(response.items);
        setTotal(response.total);
      }
    } catch (err) {
      if (isCurrent()) setError(messageFor(err, 'Failed to load the model catalogue'));
    } finally {
      if (isCurrent()) setIsLoading(false);
    }
  }, [filterKey, isMounted]);

  useEffect(() => {
    void fetchModels();
  }, [fetchModels]);

  const markPending = useCallback((id: string, pending: boolean) => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (pending) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const replaceModel = useCallback((id: string, patch: (model: AiModel) => AiModel) => {
    setModels((prev) => prev.map((model) => (model.id === id ? patch(model) : model)));
  }, []);

  const setEnabled = useCallback(
    async (model: AiModel, enabled: boolean): Promise<boolean> => {
      const previous = model.enabled;
      setUpdateError(null);
      markPending(model.id, true);
      replaceModel(model.id, (row) => ({ ...row, enabled }));
      try {
        const updated = await updateAiModel(model.id, { enabled });
        if (isMounted()) replaceModel(model.id, () => updated);
        return true;
      } catch (err) {
        if (isMounted()) {
          replaceModel(model.id, (row) => ({ ...row, enabled: previous }));
          setUpdateError(enableRefusalMessage(err, enabled));
        }
        return false;
      } finally {
        if (isMounted()) markPending(model.id, false);
      }
    },
    [isMounted, markPending, replaceModel],
  );

  const updateCapabilities = useCallback(
    async (model: AiModel, capabilities: AiModelCapabilities): Promise<boolean> => {
      setUpdateError(null);
      markPending(model.id, true);
      try {
        const updated = await updateAiModel(model.id, { capabilities });
        if (isMounted()) replaceModel(model.id, () => updated);
        return true;
      } catch (err) {
        if (isMounted()) {
          setUpdateError(messageFor(err, 'Failed to save the model capabilities'));
        }
        return false;
      } finally {
        if (isMounted()) markPending(model.id, false);
      }
    },
    [isMounted, markPending, replaceModel],
  );

  const refreshCatalog = useCallback(
    async (provider: string): Promise<string | null> => {
      try {
        setIsRefreshing(true);
        setRefreshError(null);
        const { jobId } = await refreshAiModels(provider);
        return jobId;
      } catch (err) {
        if (isMounted()) {
          setRefreshError(
            aiErrorReason(err) === 'AI_KEY_REQUIRED'
              ? 'This provider has no organization key, so its models cannot be discovered. Save a key on the AI page first.'
              : messageFor(err, 'The catalogue refresh could not be queued'),
          );
        }
        return null;
      } finally {
        if (isMounted()) setIsRefreshing(false);
      }
    },
    [isMounted],
  );

  const clearUpdateError = useCallback(() => setUpdateError(null), []);
  const clearRefreshError = useCallback(() => setRefreshError(null), []);

  return {
    models,
    total,
    isLoading,
    error,
    refetch: fetchModels,
    pendingIds,
    updateError,
    clearUpdateError,
    setEnabled,
    updateCapabilities,
    isRefreshing,
    refreshError,
    clearRefreshError,
    refreshCatalog,
  };
}
