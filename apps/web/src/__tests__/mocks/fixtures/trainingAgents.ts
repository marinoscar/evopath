/**
 * Training agents fixtures: `GET /api/ai/training/models`,
 * `POST /api/ai/training/estimate` and the usable models they are chosen from.
 */
import type { UsableAiModel } from '../../../services/ai';
import type {
  RoleResolution,
  TrainingModelsView,
  TrainingRunEstimate,
} from '../../../services/trainingAgents';

/** OpenAI, every capability a researcher needs, all four efforts. */
export const mockFrontierModel: UsableAiModel = {
  provider: 'openai',
  modelId: 'frontier-1',
  displayName: 'Frontier One',
  capabilities: {
    capabilities: ['responses', 'structured_output', 'hosted_tools', 'reasoning'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
  },
  keySource: 'user',
};

/** Structured output and reasoning up to `medium`, but no hosted tools. */
export const mockMediumModel: UsableAiModel = {
  provider: 'anthropic',
  modelId: 'medium-1',
  displayName: 'Medium One',
  capabilities: {
    capabilities: ['responses', 'structured_output', 'reasoning'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    reasoningEfforts: ['low', 'medium'],
  },
  keySource: 'org',
};

/** Text only: no structured output, no reasoning. */
export const mockPlainModel: UsableAiModel = {
  provider: 'openai',
  modelId: 'plain-1',
  displayName: 'Plain One',
  capabilities: {
    capabilities: ['responses'],
    inputModalities: ['text'],
    outputModalities: ['text'],
  },
  keySource: 'user',
};

export const mockTrainingUsableModels: UsableAiModel[] = [mockFrontierModel, mockMediumModel, mockPlainModel];

const BASE_NEEDS = ['responses', 'structured_output'];

export function mockRoleResolution(overrides: Partial<RoleResolution> & Pick<RoleResolution, 'role'>): RoleResolution {
  return {
    state: 'auto',
    model: { provider: 'openai', modelId: 'frontier-1', displayName: 'Frontier One', keySource: 'user' },
    needs: overrides.role === 'researcher' ? [...BASE_NEEDS, 'hosted_tools'] : BASE_NEEDS,
    requestedEffort: 'medium',
    effectiveEffort: 'medium',
    fix: null,
    ...overrides,
  };
}

export const mockTrainingModelsView: TrainingModelsView = {
  roles: {
    researcher: mockRoleResolution({ role: 'researcher' }),
    planner: mockRoleResolution({ role: 'planner', requestedEffort: 'high', effectiveEffort: 'high' }),
    critic: mockRoleResolution({ role: 'critic', requestedEffort: 'high', effectiveEffort: 'high' }),
    evaluator: mockRoleResolution({ role: 'evaluator' }),
  },
  webSearch: { adminEnabled: true },
  limits: {
    defaultRunTokens: { create: 400_000, revise: 400_000, evaluate: 150_000 },
    minRunTokens: 10_000,
    hardMaxRunTokens: 2_000_000,
  },
  canRun: { create: true, revise: true, evaluate: true, blockers: [] },
};

export const mockTrainingRunEstimate: TrainingRunEstimate = {
  tokens: {
    low: 60_000,
    high: 180_000,
    byRole: {
      researcher: { low: 20_000, high: 40_000 },
      planner: { low: 20_000, high: 70_000 },
      critic: { low: 12_000, high: 50_000 },
      evaluator: { low: 8_000, high: 20_000 },
    },
  },
  cap: 400_000,
  capBinding: false,
};
