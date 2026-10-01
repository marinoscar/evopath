import type { AiCapability, AiInputModality } from '../core/capabilities';
import {
  AI_FEATURE_IDS,
  type AiFeatureId,
  type TaskReasoningEffort,
  type TrainingAgentRole,
} from '../../common/schemas/settings.schema';
import {
  RESEARCHER_PROVIDERS,
  TRAINING_ROLE_DEFAULT_EFFORT,
  TRAINING_ROLE_NEEDS,
} from '../../training-agents/models/training-role-defaults';

// =============================================================================
// AI features (#173): the single list of what an administrator assigns a model
// to, and what each feature needs of that model
// =============================================================================
//
// The ids are `AI_FEATURE_IDS` (settings schema, so the stored
// `ai.assignments` can name them). Every row here is keyed by it, so adding an
// id without a definition is a type error.
//
// The training rows are DERIVED from the training agents' own tables
// (`TRAINING_ROLE_NEEDS`, `RESEARCHER_PROVIDERS`,
// `TRAINING_ROLE_DEFAULT_EFFORT`), never restated: a role that gains a need
// gains it here. That file is plain data with no module or runtime
// dependency, so importing it does not couple the AI platform to the graph.
//
// The photo rows need exactly what the intake analyze route has always
// required (`vision_input` + `structured_output`) plus an `image` input
// modality — the same filter the web's `visionModels` applied.
// =============================================================================

export type AiFeatureGroup = 'photo' | 'training';

export interface AiFeatureDefinition {
  readonly id: AiFeatureId;
  readonly group: AiFeatureGroup;
  /** Short English label for the admin page and error messages. */
  readonly label: string;
  /** Model capabilities the feature cannot run without (each also a provider port). */
  readonly needs: readonly AiCapability[];
  /** Input modalities the model must accept. */
  readonly inputModalities: readonly AiInputModality[];
  /** Providers the feature may use; `null` = any. */
  readonly providers: readonly string[] | null;
  /** The feature also needs the administrator's hosted web-search switch. */
  readonly requiresWebSearch: boolean;
  /** Whether an assignment may carry a `reasoningEffort`, and the effort used when it does not. */
  readonly defaultEffort: TaskReasoningEffort | null;
  /** The training agent role this feature is, if any. */
  readonly trainingRole: TrainingAgentRole | null;
}

const VISION_NEEDS: readonly AiCapability[] = ['vision_input', 'structured_output'];

function photo(id: AiFeatureId, label: string): AiFeatureDefinition {
  return {
    id,
    group: 'photo',
    label,
    needs: VISION_NEEDS,
    inputModalities: ['image'],
    providers: null,
    requiresWebSearch: false,
    defaultEffort: null,
    trainingRole: null,
  };
}

const TRAINING_LABELS: Readonly<Record<TrainingAgentRole, string>> = {
  researcher: 'Training plan researcher',
  planner: 'Training plan planner',
  critic: 'Training plan critic',
  evaluator: 'Training plan evaluator',
};

function training(role: TrainingAgentRole): AiFeatureDefinition {
  return {
    id: trainingFeatureId(role),
    group: 'training',
    label: TRAINING_LABELS[role],
    needs: TRAINING_ROLE_NEEDS[role],
    inputModalities: [],
    providers: role === 'researcher' ? RESEARCHER_PROVIDERS : null,
    requiresWebSearch: role === 'researcher',
    defaultEffort: TRAINING_ROLE_DEFAULT_EFFORT[role],
    trainingRole: role,
  };
}

/**
 * The health summary (H8, #192): a text-only structured call that turns the
 * server-built health digest into the summary the training planner reads.
 * Grouped with the training agents because it exists only for them.
 */
function healthSummary(): AiFeatureDefinition {
  return {
    id: 'health_summary',
    group: 'training',
    label: 'Health summary for training plans',
    needs: ['structured_output'],
    inputModalities: [],
    providers: null,
    requiresWebSearch: false,
    defaultEffort: null,
    trainingRole: null,
  };
}

/** The feature id of a training role. */
export function trainingFeatureId(role: TrainingAgentRole): AiFeatureId {
  return `training.${role}`;
}

export const AI_FEATURES: Readonly<Record<AiFeatureId, AiFeatureDefinition>> = {
  gym_scan: photo('gym_scan', 'Gym equipment scan'),
  workout_prefill: photo('workout_prefill', 'Workout prefill from a photo'),
  body_metric_reading: photo('body_metric_reading', 'Body metric photo reading'),
  lab_report: photo('lab_report', 'Lab report reading'),
  'training.researcher': training('researcher'),
  'training.planner': training('planner'),
  'training.critic': training('critic'),
  'training.evaluator': training('evaluator'),
  health_summary: healthSummary(),
};

/** Every feature, in `AI_FEATURE_IDS` order. */
export function listAiFeatures(): AiFeatureDefinition[] {
  return AI_FEATURE_IDS.map((id) => AI_FEATURES[id]);
}

export function isAiFeatureId(value: string): value is AiFeatureId {
  return (AI_FEATURE_IDS as readonly string[]).includes(value);
}

/** What a model offers, as far as feature fitness is concerned. */
export interface FeatureFitInput {
  provider: string;
  capabilities: readonly AiCapability[];
  /** Absent = not known (a catalog row read without them); treated as none. */
  inputModalities?: readonly AiInputModality[];
}

/**
 * Why `model` cannot serve `feature`, or an empty list when it can: each
 * missing capability (model-declared AND provider port), each missing input
 * modality as `input:<modality>`, and `provider:<id>` when the feature is
 * restricted to other providers.
 */
export function featureShortfall(
  feature: AiFeatureDefinition,
  model: FeatureFitInput,
  providerSupports: (provider: string, capability: AiCapability) => boolean,
): string[] {
  const missing: string[] = [];

  if (feature.providers && !feature.providers.includes(model.provider)) {
    missing.push(`provider:${model.provider}`);
  }

  for (const cap of feature.needs) {
    if (!model.capabilities.includes(cap) || !providerSupports(model.provider, cap)) missing.push(cap);
  }

  for (const modality of feature.inputModalities) {
    if (!(model.inputModalities ?? []).includes(modality)) missing.push(`input:${modality}`);
  }

  return missing;
}

/** Whether `model` can serve `feature`. */
export function isCapableForFeature(
  feature: AiFeatureDefinition,
  model: FeatureFitInput,
  providerSupports: (provider: string, capability: AiCapability) => boolean,
): boolean {
  return featureShortfall(feature, model, providerSupports).length === 0;
}
