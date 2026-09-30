import type { AiCapability, AiInputModality } from '../core/capabilities';
import type { UsableAiModel } from '../keys/dto/usable-ai-model.dto';
import {
  type AiFeatureId,
  type AiModelRef,
  type SystemAiAssignmentsValue,
  TASK_REASONING_EFFORTS,
  type TaskReasoningEffort,
} from '../../common/schemas/settings.schema';
import { AI_FEATURES, type AiFeatureDefinition, isCapableForFeature } from './ai-features';
import type { FeatureResolution } from './dto/ai-feature-resolution.dto';

// =============================================================================
// Feature model resolution (#173), as pure functions over facts gathered once
// =============================================================================
//
// ALL model selection is the administrator's. For one feature:
//   1. the administrator's assignment for the feature (`admin_feature`);
//   2. the administrator's default model (`admin_default`);
//   3. a deterministic auto pick among usable capable models (`auto`);
//   4. otherwise a blocking state that names who can fix it.
// Each step applies only when its model is USABLE for the caller
// (`UsableModelsService.listForUser`) AND CAPABLE for the feature
// (`featureShortfall`). A feature assignment that fails either check is
// reported as `assignmentUnavailable` and resolution falls through — a user is
// never blocked while any capable model is usable for them.
//
// Nothing here reads a user's model preference: users do not choose models.
// =============================================================================

/** A catalog row, for listing `candidates` (enabled or not). */
export interface CatalogModel {
  provider: string;
  modelId: string;
  displayName: string | null;
  capabilities: readonly AiCapability[];
  inputModalities?: readonly AiInputModality[];
  enabled: boolean;
}

/** Everything a resolution depends on, gathered once per request. */
export interface FeatureResolutionFacts {
  aiEnabled: boolean;
  webSearchEnabled: boolean;
  /** The caller's usable models (`UsableModelsService.listForUser`). */
  usable: readonly UsableAiModel[];
  /** Whether any enabled provider has a key source for the caller (own, org or keyless). */
  hasAnyKeySource: boolean;
  /** Provider-level port support (`AiProviderRegistry.supports`). */
  providerSupports: (provider: string, capability: AiCapability) => boolean;
  /** Non-deprecated catalog rows of the enabled providers. */
  catalog: readonly CatalogModel[];
  /** The administrator's `ai.assignments` (`EMPTY_AI_ASSIGNMENTS` when unset). */
  assignments: SystemAiAssignmentsValue;
}

/** Most models listed as `candidates` on a `missing_capability` resolution. */
export const FEATURE_MAX_CANDIDATES = 5;

const EFFORT_RANK = new Map<TaskReasoningEffort, number>(TASK_REASONING_EFFORTS.map((e, i) => [e, i]));

function hasReasoning(model: UsableAiModel): boolean {
  return model.capabilities.capabilities.includes('reasoning');
}

/** Whether a usable model can serve `feature`. */
export function isUsableModelCapable(
  feature: AiFeatureDefinition,
  model: UsableAiModel,
  providerSupports: FeatureResolutionFacts['providerSupports'],
): boolean {
  return isCapableForFeature(
    feature,
    {
      provider: model.provider,
      capabilities: model.capabilities.capabilities,
      inputModalities: model.capabilities.inputModalities,
    },
    providerSupports,
  );
}

/**
 * The deterministic auto pick: reasoning-capable first, then the larger
 * context window, then `modelId` ascending (then `provider`, so two providers
 * serving one model id still order the same way every time).
 */
export function pickAuto(models: readonly UsableAiModel[]): UsableAiModel | undefined {
  return [...models].sort(
    (a, b) =>
      Number(hasReasoning(b)) - Number(hasReasoning(a)) ||
      (b.capabilities.contextWindow ?? 0) - (a.capabilities.contextWindow ?? 0) ||
      a.modelId.localeCompare(b.modelId) ||
      a.provider.localeCompare(b.provider),
  )[0];
}

/**
 * The effort that will be sent for `requested` on `model`. Never an effort the
 * model does not list: the requested one if listed, else the highest listed
 * below it (`clamped`), else the lowest listed (`clamped`). A model without the
 * `reasoning` capability, or with an empty effort list, gets `null`.
 */
export function effectiveEffortFor(
  model: UsableAiModel,
  requested: TaskReasoningEffort | null,
): Pick<FeatureResolution, 'effectiveEffort' | 'effortNote'> {
  const offered = hasReasoning(model) ? (model.capabilities.reasoningEfforts ?? []) : [];

  if (offered.length === 0) {
    return { effectiveEffort: null, effortNote: 'model_has_no_reasoning' };
  }

  if (requested === null) {
    return { effectiveEffort: null };
  }

  if (offered.includes(requested)) {
    return { effectiveEffort: requested };
  }

  const ranked = [...offered].sort((a, b) => EFFORT_RANK.get(a)! - EFFORT_RANK.get(b)!);
  const rank = EFFORT_RANK.get(requested)!;
  const below = ranked.filter((e) => EFFORT_RANK.get(e)! < rank);

  return { effectiveEffort: below.at(-1) ?? ranked[0], effortNote: 'clamped' };
}

export function findUsable(
  usable: readonly UsableAiModel[],
  ref: AiModelRef | null | undefined,
): UsableAiModel | undefined {
  return ref ? usable.find((m) => m.provider === ref.provider && m.modelId === ref.modelId) : undefined;
}

/** The effort a feature asks for: the administrator's, else the feature default; `null` for a feature without efforts. */
export function requestedEffortFor(
  feature: AiFeatureDefinition,
  assignments: SystemAiAssignmentsValue,
): TaskReasoningEffort | null {
  if (feature.defaultEffort === null) return null;

  return assignments.features[feature.id]?.reasoningEffort ?? feature.defaultEffort;
}

/** Resolve one feature. Pure. */
export function resolveFeature(featureId: AiFeatureId, facts: FeatureResolutionFacts): FeatureResolution {
  const feature = AI_FEATURES[featureId];
  const requestedEffort = requestedEffortFor(feature, facts.assignments);
  const base = {
    featureId,
    needs: [...feature.needs],
    inputModalities: [...feature.inputModalities],
    requestedEffort,
  };

  if (!facts.aiEnabled) {
    return { ...base, state: 'ai_disabled', effectiveEffort: null, fix: 'admin' };
  }

  const capable = facts.usable.filter((m) => isUsableModelCapable(feature, m, facts.providerSupports));
  const capableRef = (ref: AiModelRef | null | undefined) => {
    const found = findUsable(facts.usable, ref);
    return found && capable.includes(found) ? found : undefined;
  };

  const assigned = facts.assignments.features[featureId] ?? null;
  const fromFeature = capableRef(assigned);
  const fromDefault = fromFeature ? undefined : capableRef(facts.assignments.default);
  const fromAuto = fromFeature || fromDefault ? undefined : pickAuto(capable);
  const chosen = fromFeature ?? fromDefault ?? fromAuto;
  const assignmentUnavailable =
    assigned && !fromFeature ? { assignmentUnavailable: { provider: assigned.provider, modelId: assigned.modelId } } : {};

  if (chosen && feature.requiresWebSearch && !facts.webSearchEnabled) {
    return { ...base, state: 'web_search_disabled', effectiveEffort: null, ...assignmentUnavailable, fix: 'admin' };
  }

  if (chosen) {
    const source = fromFeature ? 'admin_feature' : fromDefault ? 'admin_default' : 'auto';

    return {
      ...base,
      state: source === 'auto' ? 'auto' : 'ready',
      source,
      model: {
        provider: chosen.provider,
        modelId: chosen.modelId,
        displayName: chosen.displayName ?? chosen.modelId,
        keySource: chosen.keySource,
      },
      ...(feature.defaultEffort === null
        ? { effectiveEffort: null }
        : effectiveEffortFor(chosen, requestedEffort)),
      ...assignmentUnavailable,
      fix: null,
    };
  }

  const blocked = { ...base, effectiveEffort: null, ...assignmentUnavailable };

  if (facts.usable.length === 0) {
    return facts.hasAnyKeySource
      ? { ...blocked, state: 'no_models', fix: 'admin' }
      : { ...blocked, state: 'no_key', fix: 'keys' };
  }

  const candidates = facts.catalog
    .filter((m) =>
      isCapableForFeature(
        feature,
        { provider: m.provider, capabilities: m.capabilities, inputModalities: m.inputModalities },
        facts.providerSupports,
      ),
    )
    .sort(
      (a, b) =>
        Number(b.enabled) - Number(a.enabled) ||
        a.provider.localeCompare(b.provider) ||
        a.modelId.localeCompare(b.modelId),
    )
    .slice(0, FEATURE_MAX_CANDIDATES)
    .map((m) => ({
      provider: m.provider,
      modelId: m.modelId,
      displayName: m.displayName ?? m.modelId,
      enabled: m.enabled,
    }));

  // An enabled candidate the caller cannot use is one their key does not
  // reach (or no key for that provider): a key fixes it. Otherwise only an
  // administrator can enable or classify a capable model.
  return {
    ...blocked,
    state: 'missing_capability',
    candidates,
    fix: candidates.some((c) => c.enabled) ? 'keys' : 'admin',
  };
}
