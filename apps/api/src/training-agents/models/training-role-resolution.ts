import { resolveFeature, type FeatureResolutionFacts } from '../../ai/assignments/ai-feature-resolution';
import { trainingFeatureId } from '../../ai/assignments/ai-features';
import type { TrainingAgentRole } from '../../common/schemas/settings.schema';
import type { RoleResolution } from './dto/role-resolution.dto';

// =============================================================================
// Role resolution (#173: a role is the AI feature `training.<role>`)
// =============================================================================
//
// One precedence implementation for the whole platform: the pure
// `resolveFeature` in `ai/assignments/ai-feature-resolution.ts`
//   1. the administrator's assignment for `training.<role>` (with its effort);
//   2. the administrator's default model;
//   3. a deterministic auto pick among usable capable models (`auto`);
//   4. otherwise a blocking state that names who can fix it.
// Users do not choose models, so no user preference is read.
// =============================================================================

export {
  type CatalogModel,
  effectiveEffortFor,
  pickAuto,
} from '../../ai/assignments/ai-feature-resolution';

/** Everything a resolution depends on, gathered once per request. */
export type RoleResolutionFacts = FeatureResolutionFacts;

/** Resolve one role. Pure. */
export function resolveRole(role: TrainingAgentRole, facts: RoleResolutionFacts): RoleResolution {
  return { role, ...resolveFeature(trainingFeatureId(role), facts) };
}
