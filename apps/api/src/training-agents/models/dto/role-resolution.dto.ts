import { z } from 'zod';

import {
  featureResolutionSchema,
  FEATURE_RESOLUTION_STATES,
  RUNNABLE_FEATURE_STATES,
} from '../../../ai/assignments/dto/ai-feature-resolution.dto';
import { TRAINING_AGENT_ROLES } from '../../../common/schemas/settings.schema';

// =============================================================================
// One training agent role, resolved: which model it will use, or why it cannot
// run and who can fix that. A role is the AI feature `training.<role>` (#173),
// resolved by the platform's one feature resolver (administrator assignment,
// then the administrator's default, then an auto pick); this adds the role.
// Guidance for the UI and the run-start check; the platform's gate pipeline
// stays the authority on every call. Carries identifiers only, never key
// material.
// =============================================================================

export const ROLE_RESOLUTION_STATES = FEATURE_RESOLUTION_STATES;

export type RoleResolutionState = (typeof ROLE_RESOLUTION_STATES)[number];

/** States in which the role has a model it can run on. */
export const RUNNABLE_ROLE_STATES: readonly RoleResolutionState[] = RUNNABLE_FEATURE_STATES;

export const roleResolutionSchema = featureResolutionSchema.extend({
  role: z.enum(TRAINING_AGENT_ROLES),
});

export type RoleResolution = z.infer<typeof roleResolutionSchema>;
