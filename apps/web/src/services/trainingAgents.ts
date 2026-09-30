/**
 * The training agents' model settings, read side (`/api/ai/training/*`), as
 * the web app sees it.
 *
 * Shaped after `services/ai.ts`: `services/api.ts` stays the transport and this
 * module holds the two calls next to the types they produce. Both routes sit
 * behind `ai:use` and the AI kill switch (`403 AI_DISABLED` while AI is off).
 *
 * The role resolution is GUIDANCE computed by the API from the caller's saved
 * choices, usable models and the administrator's switches; the browser only
 * renders it. The preferences themselves are written through the user settings
 * document (`ai.taskModels`, `ai.training`), not through these routes.
 *
 * No response here carries key material: `keySource` says whose key pays,
 * never the key.
 */
import { api } from './api';
import type { AiKeySource } from './ai';
import type { TaskReasoningEffort, TrainingAgentRole } from '../types';

/** The roles in the order the page shows them; mirrors `TRAINING_AGENT_ROLES`. */
export const TRAINING_AGENT_ROLES: readonly TrainingAgentRole[] = [
  'researcher',
  'planner',
  'critic',
  'evaluator',
];

/** Mirrors `ROLE_RESOLUTION_STATES` in the API's `role-resolution.dto.ts`. */
export type RoleResolutionState =
  | 'ready'
  | 'auto'
  | 'no_key'
  | 'no_models'
  | 'missing_capability'
  | 'stale_preference'
  | 'web_search_disabled'
  | 'ai_disabled';

export interface TrainingModelRef {
  provider: string;
  modelId: string;
}

/** One role, resolved: the model it will use, or why it cannot run and where to fix it. */
export interface RoleResolution {
  role: TrainingAgentRole;
  state: RoleResolutionState;
  /** Absent in every blocking state. */
  model?: TrainingModelRef & { displayName: string; keySource: AiKeySource };
  /** Capabilities this role requires of its model. */
  needs: string[];
  /** What the user chose, or the role default. */
  requestedEffort: TaskReasoningEffort | null;
  /** What will actually be sent: always an effort the model offers, or null. */
  effectiveEffort: TaskReasoningEffort | null;
  effortNote?: 'clamped' | 'model_has_no_reasoning';
  /** The saved model when it is no longer usable. */
  stalePreference?: TrainingModelRef;
  /** For `missing_capability`: up to five catalog models that would work. */
  candidates?: Array<TrainingModelRef & { displayName: string; enabled: boolean }>;
  fix: 'settings' | 'keys' | 'admin' | null;
}

export type TrainingRunKind = 'create' | 'revise' | 'evaluate';

/** `GET /api/ai/training/models`. */
export interface TrainingModelsView {
  roles: Record<TrainingAgentRole, RoleResolution>;
  webSearch: { adminEnabled: boolean };
  limits: {
    defaultRunTokens: Record<TrainingRunKind, number>;
    minRunTokens: number;
    hardMaxRunTokens: number;
  };
  canRun: {
    create: boolean;
    revise: boolean;
    evaluate: boolean;
    blockers: Array<{ role: TrainingAgentRole; state: RoleResolutionState }>;
  };
}

export interface TokenRange {
  low: number;
  high: number;
}

/** `POST /api/ai/training/estimate` body. */
export interface EstimateTrainingRunInput {
  kind: TrainingRunKind;
  criticRounds?: 1 | 2 | 3;
  contextChars?: number;
}

/** `POST /api/ai/training/estimate` (answers 200). An estimate, not a quote: tokens only. */
export interface TrainingRunEstimate {
  tokens: TokenRange & { byRole: Partial<Record<TrainingAgentRole, TokenRange>> };
  /** The per-run cap that applies: the user's `maxRunTokens`, else the default for this kind. */
  cap: number;
  /** `tokens.high` exceeds `cap`: a run may stop at the cap. */
  capBinding: boolean;
}

export async function getTrainingModels(): Promise<TrainingModelsView> {
  return api.get<TrainingModelsView>('/ai/training/models');
}

export async function estimateTrainingRun(input: EstimateTrainingRunInput): Promise<TrainingRunEstimate> {
  return api.post<TrainingRunEstimate>('/ai/training/estimate', input);
}
