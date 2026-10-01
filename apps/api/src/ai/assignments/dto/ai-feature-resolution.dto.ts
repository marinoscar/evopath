import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AI_FEATURE_IDS, TASK_REASONING_EFFORTS } from '../../../common/schemas/settings.schema';
import { AI_CAPABILITIES, AI_INPUT_MODALITIES } from '../../core/capabilities';
import { AI_KEY_SOURCES } from '../../keys/dto/usable-ai-model.dto';

// =============================================================================
// One AI feature, resolved for one caller (#173): which model it will use, or
// why it cannot run and who can fix that. Guidance for the UI and the
// run-start / analyze checks; the gate pipeline stays the authority on every
// call. Identifiers only, never key material.
// =============================================================================

export const FEATURE_RESOLUTION_STATES = [
  /** An administrator's assignment (feature or default) is used. */
  'ready',
  /** Nothing assigned was usable; a deterministic pick among usable capable models. */
  'auto',
  /** No key source at all for the caller (no own key, no org key that serves them, no keyless provider). */
  'no_key',
  /** A key source exists, but no enabled model is usable with it. */
  'no_models',
  /** Usable models exist, but none can serve this feature. */
  'missing_capability',
  /** The feature needs hosted web search and the administrator's switch is off. */
  'web_search_disabled',
  /** The AI kill switch is off. */
  'ai_disabled',
] as const;

export type FeatureResolutionState = (typeof FEATURE_RESOLUTION_STATES)[number];

/** States in which the feature has a model it can run on. */
export const RUNNABLE_FEATURE_STATES: readonly FeatureResolutionState[] = ['ready', 'auto'];

export const FEATURE_MODEL_SOURCES = ['admin_feature', 'admin_default', 'auto'] as const;
export type FeatureModelSource = (typeof FEATURE_MODEL_SOURCES)[number];

const modelRefSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
});

export const featureResolutionSchema = z.object({
  featureId: z.enum(AI_FEATURE_IDS),
  state: z.enum(FEATURE_RESOLUTION_STATES),
  /** The model the feature will use. Absent in every blocking state. */
  model: modelRefSchema
    .extend({
      displayName: z.string(),
      /** Whose key pays: the caller's own, the organisation's, or none needed. */
      keySource: z.enum(AI_KEY_SOURCES),
    })
    .optional(),
  /** Where the model came from. Absent in every blocking state. */
  source: z.enum(FEATURE_MODEL_SOURCES).optional(),
  /** The capabilities the feature requires of its model. */
  needs: z.array(z.enum(AI_CAPABILITIES)),
  /** Input modalities the feature requires (`image` for the photo features). */
  inputModalities: z.array(z.enum(AI_INPUT_MODALITIES)),
  /** The effort the administrator assigned, else the feature default; `null` for a feature without efforts. */
  requestedEffort: z.enum(TASK_REASONING_EFFORTS).nullable(),
  /** The effort that will actually be sent; always one the model offers, or null. */
  effectiveEffort: z.enum(TASK_REASONING_EFFORTS).nullable(),
  effortNote: z.enum(['clamped', 'model_has_no_reasoning']).optional(),
  /**
   * The administrator's assignment for this feature when it exists but is not
   * usable or capable for this caller (their key does not reach it, it was
   * disabled, ...). Resolution fell through to the next step; never blocks.
   */
  assignmentUnavailable: modelRefSchema.optional(),
  /** For `missing_capability`: up to five catalog models that WOULD work. */
  candidates: z
    .array(
      modelRefSchema.extend({
        displayName: z.string(),
        /** Whether an administrator has enabled the model. */
        enabled: z.boolean(),
      }),
    )
    .optional(),
  /** Who can fix a blocking state: the caller (`keys`: add a key) or an administrator. */
  fix: z.enum(['keys', 'admin']).nullable(),
});

export type FeatureResolution = z.infer<typeof featureResolutionSchema>;

export const aiFeaturesViewSchema = z.object({
  features: z.array(
    featureResolutionSchema.extend({
      label: z.string(),
      group: z.enum(['photo', 'training', 'coach']),
    }),
  ),
});

export class AiFeaturesView extends createZodDto(aiFeaturesViewSchema) {}
export type AiFeaturesViewData = z.infer<typeof aiFeaturesViewSchema>;
