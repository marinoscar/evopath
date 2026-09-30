/**
 * Whether the AI plan affordances (Create with AI, Revise with AI) may be
 * offered, and if not, why and where to fix it.
 *
 * Presentation only: the API refuses a run it cannot start. This reads the
 * public AI config (`useAiConfig`), the caller's `ai:use` grant and, when
 * both allow it, `GET /api/ai/training/models` (`canRun` and each role's
 * state). With AI off or without `ai:use`, no training route is called.
 */
import { useCallback, useEffect, useState } from 'react';
import { useAiConfig } from './useAiConfig';
import { usePermissions } from './usePermissions';
import { useIsMounted } from './useIsMounted';
import {
  getTrainingModels,
  type RoleResolutionState,
  type TrainingModelsView,
  type TrainingPlanRunKind,
} from '../services/trainingAgents';
import type { TrainingAgentRole } from '../types';

export const ROLE_LABEL: Record<TrainingAgentRole, string> = {
  researcher: 'Researcher',
  planner: 'Planner',
  critic: 'Critic',
  evaluator: 'Coach',
};

export const AGENT_SETTINGS_PATH = '/settings/ai/agents';

export interface TrainingBlocker {
  message: string;
  fix: { label: string; to: string } | null;
}

/** One sentence per blocking role state, with where it is fixed. */
export function blockerFor(role: TrainingAgentRole, state: RoleResolutionState): TrainingBlocker {
  const who = `The ${ROLE_LABEL[role].toLowerCase()} agent`;
  switch (state) {
    case 'no_key':
      return { message: `${who} needs an AI key.`, fix: { label: 'Add a key', to: '/settings/ai' } };
    case 'no_models':
      return { message: `${who} has no enabled model. Ask an administrator to enable one, or add a key.`, fix: null };
    case 'missing_capability':
      return {
        message:
          role === 'researcher'
            ? `${who} needs web search: choose an OpenAI model that supports hosted tools.`
            : `${who} needs a model with structured output.`,
        fix: { label: 'Choose a model', to: AGENT_SETTINGS_PATH },
      };
    case 'web_search_disabled':
      return {
        message: `${who} needs web search: an administrator can turn it on at Admin, AI, Hosted tools, Web search.`,
        fix: null,
      };
    case 'stale_preference':
      return { message: `${who}'s saved model is no longer available.`, fix: { label: 'Choose a model', to: AGENT_SETTINGS_PATH } };
    case 'ai_disabled':
      return { message: 'AI is switched off for this app.', fix: null };
    default:
      return { message: `${who} cannot run right now.`, fix: { label: 'Check the agents', to: AGENT_SETTINGS_PATH } };
  }
}

export interface UseTrainingAvailabilityReturn {
  /** AI is on and the caller holds `ai:use`: AI affordances may be shown at all. */
  aiVisible: boolean;
  /** Everything is ready for a run of `kind`. */
  canRun: (kind: TrainingPlanRunKind) => boolean;
  /** Why a run cannot start, when it cannot (null while loading or when ready). */
  blocker: (kind: TrainingPlanRunKind) => TrainingBlocker | null;
  models: TrainingModelsView | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useTrainingAvailability(): UseTrainingAvailabilityReturn {
  const { config, isLoading: configLoading } = useAiConfig();
  const { hasPermission } = usePermissions();
  const aiVisible = config.enabled && hasPermission('ai:use');
  const [models, setModels] = useState<TrainingModelsView | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    if (!aiVisible) return;
    setIsLoading(true);
    try {
      const view = await getTrainingModels();
      if (isMounted()) {
        setModels(view);
        setError(null);
      }
    } catch (err) {
      if (isMounted()) setError(err instanceof Error && err.message ? err.message : 'Could not check the AI agents');
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [aiVisible, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const blocker = useCallback(
    (kind: TrainingPlanRunKind): TrainingBlocker | null => {
      if (configLoading) return null;
      if (!config.enabled) return { message: 'AI is switched off for this app.', fix: null };
      if (!hasPermission('ai:use')) return { message: 'Your role cannot use AI features.', fix: null };
      if (error) return { message: error, fix: null };
      if (!models) return null;
      if (models.canRun[kind]) return null;
      const first = models.canRun.blockers[0];
      return first
        ? blockerFor(first.role, first.state)
        : { message: 'The AI agents are not ready.', fix: { label: 'Check the agents', to: AGENT_SETTINGS_PATH } };
    },
    [config.enabled, configLoading, error, hasPermission, models],
  );

  const canRun = useCallback(
    (kind: TrainingPlanRunKind) => aiVisible && !!models && models.canRun[kind] && !error,
    [aiVisible, error, models],
  );

  return { aiVisible, canRun, blocker, models, isLoading: isLoading || configLoading, error, refresh };
}
