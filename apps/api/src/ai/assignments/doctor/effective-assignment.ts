import type { AiAssignmentsResponse, AiEligibleModel } from '../dto/ai-assignments.dto';

// =============================================================================
// Deployment-wide effective assignment, for the doctor (#182)
// =============================================================================
//
// `resolveFeature` answers "which model will THIS USER get?" and needs a
// user's usable models. The doctor has no user, so it answers the
// deployment-wide half of the same precedence from the admin view
// (`AiAssignmentsAdminService.describe()`), which already lists, per feature,
// every enabled, non-deprecated, capable model of an enabled provider
// (`eligibleModels`) and flags a stored assignment that no longer qualifies
// (`warning`):
//
//   1. the feature's own assignment, when it has no warning;
//   2. the default model, when it has no warning AND is eligible for the feature;
//   3. an auto pick among the eligible models;
//   4. nothing — every call for the feature fails (`missing_capability`).
//
// Pure; reads nothing.
// =============================================================================

/** The parts of the admin view a doctor decision reads (the per-feature stored values are on each row). */
export type AssignmentsView = Pick<AiAssignmentsResponse, 'default' | 'features'> & {
  assignments: Pick<AiAssignmentsResponse['assignments'], 'default'>;
};
export type FeatureRow = AiAssignmentsResponse['features'][number];

export type EffectiveSource = 'admin_feature' | 'admin_default' | 'auto';

export interface EffectiveAssignment {
  source: EffectiveSource;
  /** The model, or `null` for `auto` (the pick depends on each user's keys). */
  model: { provider: string; modelId: string } | null;
  /** The providers a call may land on: the model's, or every eligible model's for `auto`. */
  providers: string[];
}

function isEligible(row: FeatureRow, ref: { provider: string; modelId: string }): boolean {
  return row.eligibleModels.some((m: AiEligibleModel) => m.provider === ref.provider && m.modelId === ref.modelId);
}

/** The model `row`'s feature resolves to deployment-wide, or `null` when no capable model exists. */
export function effectiveAssignment(row: FeatureRow, view: AssignmentsView): EffectiveAssignment | null {
  if (row.assignment && !row.warning) {
    return {
      source: 'admin_feature',
      model: { provider: row.assignment.provider, modelId: row.assignment.modelId },
      providers: [row.assignment.provider],
    };
  }

  const stored = view.assignments.default;

  if (stored && !view.default.warning && isEligible(row, stored)) {
    return {
      source: 'admin_default',
      model: { provider: stored.provider, modelId: stored.modelId },
      providers: [stored.provider],
    };
  }

  if (row.eligibleModels.length > 0) {
    return { source: 'auto', model: null, providers: [...new Set(row.eligibleModels.map((m) => m.provider))] };
  }

  return null;
}

/** `a, b, c +2 more` — keeps a detail line short. */
export function truncatedList(items: readonly string[], max = 3): string {
  const shown = items.slice(0, max).join(', ');

  return items.length > max ? `${shown} +${items.length - max} more` : shown;
}
