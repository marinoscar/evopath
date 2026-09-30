/**
 * Can this user's photos be read by AI for one photo feature right now, and
 * by which model? (#173)
 *
 * The state behind `components/intake/AiVisionDisclosure.tsx`. Every photo
 * flow has a manual path; this only decides whether the AI path is offered
 * and names the model (and whose key) the photos would be sent to.
 *
 * THE SERVER CHOOSES THE MODEL. An administrator assigns a model per feature
 * (or an organization default) at `/admin/settings/ai/assignments`; `GET
 * /api/ai/features` resolves it for the caller. The browser never picks one:
 * analyze sends `{}` and the API resolves the same model again.
 *
 * - `loading`: the answer is not in yet.
 * - `ai_disabled`: AI is off in this deployment (`useAiConfig`, fail-closed,
 *   or the API answered `AI_DISABLED`).
 * - `error`: the availability check itself failed. Its own state: a failed
 *   request says nothing about the caller's keys.
 * - `ready`: a model will be used; `source` says whether an administrator
 *   chose it or it was picked automatically (`auto`).
 * - every other API state (`no_key`, `no_models`, `missing_capability`,
 *   `web_search_disabled`) as the API named it, with `fix` saying who can
 *   fix it.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import {
  getAiFeatures,
  RUNNABLE_FEATURE_STATES,
  type AiFeatureView,
  type AiPhotoFeatureId,
  type FeatureModelSource,
  type FeatureResolution,
  type FeatureResolutionState,
} from '../services/aiAssignments';
import { toAiErrorInfo, type AiErrorInfo } from '../services/aiErrors';
import { useAiConfig } from './useAiConfig';
import { useIsMounted } from './useIsMounted';

export type VisionAvailabilityStatus =
  | 'loading'
  | 'ready'
  | 'error'
  | Exclude<FeatureResolutionState, 'ready' | 'auto'>;

export type VisionModel = NonNullable<FeatureResolution['model']>;

export interface UseVisionAvailabilityReturn {
  featureId: AiPhotoFeatureId;
  status: VisionAvailabilityStatus;
  /** The model the photos will be sent to (only when `ready`). */
  model: VisionModel | null;
  /** Where the model came from (only when `ready`). */
  source: FeatureModelSource | null;
  /** Who can fix a blocking state. */
  fix: 'keys' | 'admin' | null;
  /** Re-ask the API (after an `error`, say). */
  refresh: () => Promise<void>;
}

/** The hook's status for one API resolution. */
export function visionStatusOf(resolution: Pick<FeatureResolution, 'state' | 'model'>): VisionAvailabilityStatus {
  if (RUNNABLE_FEATURE_STATES.includes(resolution.state)) return resolution.model ? 'ready' : 'error';
  return resolution.state as VisionAvailabilityStatus;
}

type Fetched =
  | { kind: 'idle' }
  | { kind: 'loaded'; feature: AiFeatureView | null }
  | { kind: 'ai_disabled' }
  | { kind: 'error' };

export function useVisionAvailability(featureId: AiPhotoFeatureId): UseVisionAvailabilityReturn {
  const { config, isLoading: configLoading } = useAiConfig();
  const enabled = config.enabled === true;
  const [fetched, setFetched] = useState<Fetched>({ kind: 'idle' });
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    if (!enabled) return;
    // No reset to `loading` here: a re-check keeps the last answer on screen
    // until the new one arrives, so a flow mounted under `ready` is not torn
    // down by the check itself.
    try {
      const view = await getAiFeatures();
      if (!isMounted()) return;
      setFetched({ kind: 'loaded', feature: view.features.find((entry) => entry.featureId === featureId) ?? null });
    } catch (err) {
      if (!isMounted()) return;
      const disabled = err instanceof ApiError && toAiErrorInfo(err).code === 'AI_DISABLED';
      setFetched(disabled ? { kind: 'ai_disabled' } : { kind: 'error' });
    }
  }, [enabled, featureId, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  let status: VisionAvailabilityStatus;
  let feature: AiFeatureView | null = null;
  if (configLoading) status = 'loading';
  else if (!enabled) status = 'ai_disabled';
  else if (fetched.kind === 'idle') status = 'loading';
  else if (fetched.kind === 'ai_disabled') status = 'ai_disabled';
  else if (fetched.kind === 'error' || !fetched.feature) status = 'error';
  else {
    feature = fetched.feature;
    status = visionStatusOf(feature);
  }

  const ready = status === 'ready' && feature?.model;
  return {
    featureId,
    status,
    model: ready ? feature!.model! : null,
    source: ready ? (feature!.source ?? null) : null,
    fix: status === 'ready' ? null : (feature?.fix ?? null),
    refresh,
  };
}

/** The analyze refusals that mean the feature's model changed under the page (#173). */
export const FEATURE_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'AI_FEATURE_UNAVAILABLE',
  'AI_MODEL_ASSIGNMENT_LOCKED',
]);

/**
 * Re-check availability when an analyze was refused because the feature's
 * model is no longer what the page was shown (an administrator changed the
 * assignment, a key was removed), so the disclosure never names a stale model.
 */
export function useRefreshOnFeatureRefusal(error: AiErrorInfo | null, refresh: () => Promise<void>): void {
  const code = error?.code ?? null;
  useEffect(() => {
    if (code && FEATURE_REFUSAL_CODES.has(code)) void refresh();
  }, [code, error, refresh]);
}
