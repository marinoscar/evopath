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
  type TrainingRunKind,
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

/** Where an AI administrator assigns the agents' models (#173). */
export const AI_ASSIGNMENTS_PATH = '/admin/settings/ai/assignments';

export interface BlockerOptions {
  /** Who can fix it, when the API said (`RoleResolution.fix`). */
  fix?: 'keys' | 'admin' | null;
  /** The caller holds `ai_config:write`: link them to the assignments page for an administrator's fix. */
  canAssign?: boolean;
}

/**
 * One sentence per blocking role state, with where it is fixed. Models are
 * an administrator's choice (#173): a user is never sent to pick one, only to
 * add a key when a key is what is missing.
 */
export function blockerFor(
  role: TrainingAgentRole,
  state: RoleResolutionState,
  { fix, canAssign = false }: BlockerOptions = {},
): TrainingBlocker {
  const who = `The ${ROLE_LABEL[role].toLowerCase()} agent`;
  const addKey = { label: 'Add a key', to: '/settings/ai' };
  const assign = canAssign ? { label: 'Assign a model', to: AI_ASSIGNMENTS_PATH } : null;
  const needs = role === 'researcher' ? 'web search (an OpenAI model with hosted tools)' : 'structured output';
  switch (state) {
    case 'no_key':
      return { message: `${who} needs an AI key.`, fix: addKey };
    case 'no_models':
      return {
        message: `${who} has no model available. Your administrator hasn't assigned or enabled one yet.`,
        fix: assign,
      };
    case 'missing_capability':
      if (fix === 'keys') {
        return {
          message: `${who} needs a model with ${needs}, and none of the models your keys reach has it. Add a key for a provider that does.`,
          fix: addKey,
        };
      }
      if (fix === 'admin') {
        return {
          message: `${who} needs a model with ${needs}. Your administrator hasn't assigned one yet.`,
          fix: assign,
        };
      }
      return {
        message: `${who} needs a model with ${needs}, and none is available to you. Ask your administrator to assign one.`,
        fix: assign,
      };
    case 'web_search_disabled':
      return {
        message: `${who} needs web search: an administrator can turn it on at Admin, AI, Hosted tools, Web search.`,
        fix: null,
      };
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
  canRun: (kind: TrainingRunKind) => boolean;
  /** Why a run cannot start, when it cannot (null while loading or when ready). */
  blocker: (kind: TrainingRunKind) => TrainingBlocker | null;
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
    (kind: TrainingRunKind): TrainingBlocker | null => {
      if (configLoading) return null;
      if (!config.enabled) return { message: 'AI is switched off for this app.', fix: null };
      if (!hasPermission('ai:use')) return { message: 'Your role cannot use AI features.', fix: null };
      if (error) return { message: error, fix: null };
      if (!models) return null;
      if (models.canRun[kind]) return null;
      const first = models.canRun.blockers[0];
      return first
        ? blockerFor(first.role, first.state, {
            fix: models.roles[first.role]?.fix,
            canAssign: hasPermission('ai_config:write'),
          })
        : { message: 'The AI agents are not ready.', fix: { label: 'Check the agents', to: AGENT_SETTINGS_PATH } };
    },
    [config.enabled, configLoading, error, hasPermission, models],
  );

  const canRun = useCallback(
    (kind: TrainingRunKind) => aiVisible && !!models && models.canRun[kind] && !error,
    [aiVisible, error, models],
  );

  return { aiVisible, canRun, blocker, models, isLoading: isLoading || configLoading, error, refresh };
}
