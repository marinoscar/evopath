import type { AiCapability } from '../../ai/core/capabilities';
import type { UsableAiModel } from '../../ai/keys/dto/usable-ai-model.dto';
import {
  TASK_REASONING_EFFORTS,
  type TaskReasoningEffort,
  type TrainingAgentRole,
  type UserAiSettingsValue,
} from '../../common/schemas/settings.schema';
import type { RoleResolution } from './dto/role-resolution.dto';
import {
  RESEARCHER_PROVIDERS,
  TRAINING_MAX_CANDIDATES,
  TRAINING_ROLE_DEFAULT_EFFORT,
  TRAINING_ROLE_NEEDS,
} from './training-role-defaults';

// =============================================================================
// Role resolution, as pure functions over facts the service gathers once
// =============================================================================
//
// Precedence for a role:
//   1. the user's `ai.taskModels[role]`, if usable and capable;
//   2. the user's `ai.defaultModel`, if usable and capable;
//   3. a deterministic auto pick among usable capable models (`auto`);
//   4. otherwise a blocking state that names the fix.
// A saved role preference that is no longer usable or capable yields
// `stale_preference` with the model it fell back to; when nothing to fall
// back to exists, the blocking state wins and `stalePreference` names the
// saved model.
// =============================================================================

/** A catalog row, for listing `candidates` (enabled or not). */
export interface CatalogModel {
  provider: string;
  modelId: string;
  displayName: string | null;
  capabilities: readonly AiCapability[];
  enabled: boolean;
}

/** Everything a resolution depends on, gathered once per request. */
export interface RoleResolutionFacts {
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
  /** The caller's stored `ai` namespace, if any. */
  settings: UserAiSettingsValue | undefined;
}

const EFFORT_RANK = new Map<TaskReasoningEffort, number>(TASK_REASONING_EFFORTS.map((e, i) => [e, i]));

function providerAllowed(role: TrainingAgentRole, provider: string): boolean {
  return role !== 'researcher' || RESEARCHER_PROVIDERS.includes(provider);
}

function hasAll(
  role: TrainingAgentRole,
  provider: string,
  capabilities: readonly AiCapability[],
  providerSupports: RoleResolutionFacts['providerSupports'],
): boolean {
  return (
    providerAllowed(role, provider) &&
    TRAINING_ROLE_NEEDS[role].every((cap) => capabilities.includes(cap) && providerSupports(provider, cap))
  );
}

/** Whether `model` can serve `role` (capabilities, provider ports, provider restriction). */
export function isCapableFor(
  role: TrainingAgentRole,
  model: UsableAiModel,
  providerSupports: RoleResolutionFacts['providerSupports'],
): boolean {
  return hasAll(role, model.provider, model.capabilities.capabilities, providerSupports);
}

function hasReasoning(model: UsableAiModel): boolean {
  return model.capabilities.capabilities.includes('reasoning');
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
): Pick<RoleResolution, 'effectiveEffort' | 'effortNote'> {
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

function find(
  usable: readonly UsableAiModel[],
  ref: { provider: string; modelId: string } | null | undefined,
): UsableAiModel | undefined {
  return ref ? usable.find((m) => m.provider === ref.provider && m.modelId === ref.modelId) : undefined;
}

/** Resolve one role. Pure. */
export function resolveRole(role: TrainingAgentRole, facts: RoleResolutionFacts): RoleResolution {
  const needs = [...TRAINING_ROLE_NEEDS[role]];
  const preference = facts.settings?.taskModels?.[role];
  const requestedEffort = preference?.reasoningEffort ?? TRAINING_ROLE_DEFAULT_EFFORT[role];
  const base = { role, needs, requestedEffort };

  if (!facts.aiEnabled) {
    return { ...base, state: 'ai_disabled', effectiveEffort: null, fix: 'admin' };
  }

  const capable = facts.usable.filter((m) => isCapableFor(role, m, facts.providerSupports));
  const isCapable = (m: UsableAiModel | undefined) => (m && capable.includes(m) ? m : undefined);

  const preferred = isCapable(find(facts.usable, preference));
  const stalePreference = preference && !preferred
    ? { provider: preference.provider, modelId: preference.modelId }
    : undefined;

  const chosen = preferred ?? isCapable(find(facts.usable, facts.settings?.defaultModel)) ?? pickAuto(capable);

  if (chosen && role === 'researcher' && !facts.webSearchEnabled) {
    return {
      ...base,
      state: 'web_search_disabled',
      effectiveEffort: null,
      ...(stalePreference ? { stalePreference } : {}),
      fix: 'admin',
    };
  }

  if (chosen) {
    const fromDefault = !preferred && chosen === find(facts.usable, facts.settings?.defaultModel);
    const state = preferred ? 'ready' : stalePreference ? 'stale_preference' : fromDefault ? 'ready' : 'auto';

    return {
      ...base,
      state,
      model: {
        provider: chosen.provider,
        modelId: chosen.modelId,
        displayName: chosen.displayName ?? chosen.modelId,
        keySource: chosen.keySource,
      },
      ...effectiveEffortFor(chosen, requestedEffort),
      ...(stalePreference ? { stalePreference } : {}),
      fix: state === 'stale_preference' ? 'settings' : null,
    };
  }

  const blocked = { ...base, effectiveEffort: null, ...(stalePreference ? { stalePreference } : {}) };

  if (facts.usable.length === 0) {
    return facts.hasAnyKeySource
      ? { ...blocked, state: 'no_models', fix: 'admin' }
      : { ...blocked, state: 'no_key', fix: 'keys' };
  }

  const candidates = facts.catalog
    .filter((m) => hasAll(role, m.provider, m.capabilities, facts.providerSupports))
    .sort(
      (a, b) =>
        Number(b.enabled) - Number(a.enabled) ||
        a.provider.localeCompare(b.provider) ||
        a.modelId.localeCompare(b.modelId),
    )
    .slice(0, TRAINING_MAX_CANDIDATES)
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
