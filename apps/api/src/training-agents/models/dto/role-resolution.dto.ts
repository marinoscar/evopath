import { z } from 'zod';

import { AI_CAPABILITIES } from '../../../ai/core/capabilities';
import { AI_KEY_SOURCES } from '../../../ai/keys/dto/usable-ai-model.dto';
import { TASK_REASONING_EFFORTS, TRAINING_AGENT_ROLES } from '../../../common/schemas/settings.schema';

// =============================================================================
// One training agent role, resolved: which model it will use, or why it cannot
// run and where the user goes to fix that. Guidance for the UI and the
// run-start check; the platform's gate pipeline stays the authority on every
// call. Carries identifiers only, never key material.
// =============================================================================

export const ROLE_RESOLUTION_STATES = [
  'ready',
  'auto',
  'no_key',
  'no_models',
  'missing_capability',
  'stale_preference',
  'web_search_disabled',
  'ai_disabled',
] as const;

export type RoleResolutionState = (typeof ROLE_RESOLUTION_STATES)[number];

/** States in which the role has a model it can run on. */
export const RUNNABLE_ROLE_STATES: readonly RoleResolutionState[] = ['ready', 'auto', 'stale_preference'];

const modelRefSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
});

export const roleResolutionSchema = z.object({
  role: z.enum(TRAINING_AGENT_ROLES),
  state: z.enum(ROLE_RESOLUTION_STATES),
  /** The model the role will use. Absent in every blocking state. */
  model: modelRefSchema
    .extend({
      displayName: z.string(),
      /** Whose key pays: the caller's own, the organisation's, or none needed. */
      keySource: z.enum(AI_KEY_SOURCES),
    })
    .optional(),
  /** The capabilities this role requires of its model. */
  needs: z.array(z.enum(AI_CAPABILITIES)),
  /** The effort the user chose, or the role default. */
  requestedEffort: z.enum(TASK_REASONING_EFFORTS).nullable(),
  /** The effort that will actually be sent; always one the model offers, or null. */
  effectiveEffort: z.enum(TASK_REASONING_EFFORTS).nullable(),
  effortNote: z.enum(['clamped', 'model_has_no_reasoning']).optional(),
  /**
   * The user's saved model for this role when it is no longer usable. Set on
   * `stale_preference` and on a blocking state reached from a stale preference.
   */
  stalePreference: modelRefSchema.optional(),
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
  /** Where to go to fix it: the agent settings, the key settings, or an administrator. */
  fix: z.enum(['settings', 'keys', 'admin']).nullable(),
});

export type RoleResolution = z.infer<typeof roleResolutionSchema>;
