import type { AiCapability } from '../../ai/core/capabilities';
import type { TaskReasoningEffort, TrainingAgentRole } from '../../common/schemas/settings.schema';
import type { TrainingRunKind } from './token-estimate';

// =============================================================================
// Training agent roles: what each needs and what it defaults to
// =============================================================================
//
// The role list itself is `TRAINING_AGENT_ROLES` in the settings schema (the
// single list; a later feature appends its roles there). These tables are
// keyed by it, so adding a role without a row here is a type error.
// =============================================================================

/** The model capabilities a role cannot run without. */
export const TRAINING_ROLE_NEEDS: Readonly<Record<TrainingAgentRole, readonly AiCapability[]>> = {
  researcher: ['responses', 'structured_output', 'hosted_tools'],
  planner: ['responses', 'structured_output'],
  critic: ['responses', 'structured_output'],
  evaluator: ['responses', 'structured_output'],
};

/** The reasoning effort a role asks for when the user has not chosen one. */
export const TRAINING_ROLE_DEFAULT_EFFORT: Readonly<Record<TrainingAgentRole, TaskReasoningEffort>> = {
  researcher: 'medium',
  planner: 'high',
  critic: 'high',
  evaluator: 'medium',
};

/**
 * Providers whose hosted web search the researcher may use. OpenAI only for
 * now: it is the one provider whose hosted `web_search` tool the platform
 * drives, so a researcher on any other provider could not search at all.
 */
export const RESEARCHER_PROVIDERS: readonly string[] = ['openai'];

/** The roles each run kind needs a model for before it may start. */
export const TRAINING_KIND_ROLES: Readonly<Record<TrainingRunKind, readonly TrainingAgentRole[]>> = {
  create: ['researcher', 'planner', 'critic', 'evaluator'],
  revise: ['planner', 'critic'],
  evaluate: ['evaluator'],
};

/**
 * Roles a run kind freezes when they are usable but does not need to start:
 * an evaluation's light critique (`critique_light`) is skipped, with a
 * warning, when the critic has no usable model.
 */
export const TRAINING_KIND_OPTIONAL_ROLES: Readonly<Record<TrainingRunKind, readonly TrainingAgentRole[]>> = {
  create: [],
  revise: [],
  evaluate: ['critic'],
};
