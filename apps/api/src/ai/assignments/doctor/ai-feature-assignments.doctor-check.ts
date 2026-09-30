import { Injectable, OnModuleInit } from '@nestjs/common';

import type { AiKeyPolicy } from '../../../common/schemas/settings.schema';
import { DoctorCheck, DoctorCheckOutcome } from '../../../doctor/doctor-check.interface';
import { DoctorCheckRegistry } from '../../../doctor/doctor-check.registry';
import { AI_SETTINGS_PATH } from '../../config/doctor/ai-enabled.doctor-check';
import { AiConfigService, providerPolicy, providerRequiresKey } from '../../config/ai-config.service';
import { AiAssignmentsAdminService } from '../ai-assignments-admin.service';
import { type AssignmentsView, effectiveAssignment, truncatedList } from './effective-assignment';

export const AI_ASSIGNMENTS_SETTINGS_PATH = '/admin/settings/ai/assignments';

/** Whether a provider can serve a caller who brought no key of their own. */
export interface ProviderKeyReach {
  /** The administrator marked the provider `requiresKey: false`. */
  keyless: boolean;
  /** An organization key is stored (status only; never read). */
  orgKey: boolean;
}

export interface FeatureAssignmentsFacts {
  view: AssignmentsView;
  keyPolicy: AiKeyPolicy;
  webSearchEnabled: boolean;
  /** Keyed by provider id; a provider absent here is treated as needing a user's key. */
  reach: Readonly<Record<string, ProviderKeyReach>>;
}

/**
 * Pure: does every AI feature (the photo features AND the training agent
 * roles, which are the features `training.<role>`) resolve to a model a call
 * can actually use?
 *
 *   - no enabled, capable model for a feature → `fail`: the runtime's
 *     `resolveFeature` falls through assignment, default and auto pick and
 *     ends in `missing_capability`, so every call for it fails;
 *   - under `byok_with_org_fallback`, no capable model on a provider that
 *     serves a caller without their own key (org key stored, or keyless) →
 *     `fail`: the policy promises those users AI and they get none;
 *   - a stored feature assignment or default that is no longer enabled or
 *     capable → `warn`: calls still work (resolution falls through), but not
 *     on the administrator's choice;
 *   - a feature that needs web search while it is switched off is neither: it
 *     is the operator's choice (the `ai.web-search` check owns it) and is only
 *     counted.
 *
 * Under plain `byok` users bring their own keys, so a provider without an org
 * key is expected, not a problem.
 */
export function decideFeatureAssignments(facts: FeatureAssignmentsFacts): DoctorCheckOutcome {
  const { view, keyPolicy, webSearchEnabled, reach } = facts;
  const servesKeylessCaller = (provider: string) => {
    const r = reach[provider];
    return r !== undefined && (r.keyless || (keyPolicy === 'byok_with_org_fallback' && r.orgKey));
  };

  const failing: string[] = [];
  const unreachable: string[] = [];
  const stale: string[] = [];
  const waitingOnWebSearch: string[] = [];
  const counts = { admin_feature: 0, admin_default: 0, auto: 0 };

  for (const row of view.features) {
    if (row.requiresWebSearch && !webSearchEnabled) {
      waitingOnWebSearch.push(row.featureId);
      continue;
    }

    const effective = effectiveAssignment(row, view);

    if (!effective) {
      failing.push(row.featureId);
      continue;
    }

    counts[effective.source] += 1;

    if (row.warning) stale.push(row.featureId);

    if (
      keyPolicy === 'byok_with_org_fallback' &&
      !row.eligibleModels.some((model) => servesKeylessCaller(model.provider))
    ) {
      unreachable.push(row.featureId);
    }
  }

  const defaultStale = view.assignments.default !== null && view.default.warning !== null;
  const data = {
    features: view.features.length,
    assigned: counts.admin_feature,
    viaDefault: counts.admin_default,
    auto: counts.auto,
    noCapableModel: failing.length,
    noOrgReachableModel: unreachable.length,
    staleAssignments: stale.length + (defaultStale ? 1 : 0),
    waitingOnWebSearch: waitingOnWebSearch.length,
    keyPolicy,
  };

  const problems: string[] = [];

  if (failing.length > 0) problems.push(`no enabled model can serve ${truncatedList(failing)}`);
  if (unreachable.length > 0) {
    problems.push(`users without their own key have no model for ${truncatedList(unreachable)}`);
  }

  if (problems.length > 0) {
    return {
      status: 'fail',
      detail: capitalize(problems.join('; ')),
      remedy:
        failing.length > 0
          ? `Enable a capable model and its provider at ${AI_SETTINGS_PATH}, then assign it at ${AI_ASSIGNMENTS_SETTINGS_PATH}.`
          : `Save an organization key for a capable model's provider at ${AI_SETTINGS_PATH}, or switch the key policy to byok there.`,
      data,
    };
  }

  const staleNames = [...(defaultStale ? ['default'] : []), ...stale];

  if (staleNames.length > 0) {
    return {
      status: 'warn',
      detail: `Stored assignment is no longer enabled or capable (calls fall through to another model): ${truncatedList(staleNames)}`,
      remedy: `Pick an eligible model for each flagged row at ${AI_ASSIGNMENTS_SETTINGS_PATH}.`,
      data,
    };
  }

  const served = counts.admin_feature + counts.admin_default + counts.auto;
  const parts = [
    `${counts.admin_feature} assigned`,
    `${counts.admin_default} via the default`,
    `${counts.auto} auto-picked`,
  ];
  const webSearchNote =
    waitingOnWebSearch.length > 0 ? `; ${truncatedList(waitingOnWebSearch)} wait(s) for web search` : '';

  return {
    status: 'pass',
    detail: `${served} feature(s) have a model: ${parts.join(', ')}${webSearchNote}`,
    data,
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * `ai` / `ai.feature-assignments` — every AI feature, including each training
 * agent role, resolves to an enabled, capable model reachable under the key
 * policy.
 *
 * The training agent roles are NOT a separate check: `TrainingModelResolver`
 * is `resolveFeature` over `training.<role>`, so this one covers them.
 *
 * Reads the admin assignments view (settings, catalog rows) and key STATUS
 * (`AiConfigService.hasOrgKey`, which describes and never decrypts). No model
 * is called and no user's keys are consulted.
 */
@Injectable()
export class AiFeatureAssignmentsDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'ai.feature-assignments';
  readonly category = 'ai';
  readonly label = 'AI feature model assignments';
  readonly settingsPath = AI_ASSIGNMENTS_SETTINGS_PATH;
  readonly dependsOn = ['ai.enabled'];

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly assignments: AiAssignmentsAdminService,
    private readonly aiConfig: AiConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const [view, policy] = await Promise.all([this.assignments.describe(), this.aiConfig.resolve({ fresh: true })]);
    const providers = [...new Set(view.features.flatMap((row) => row.eligibleModels.map((m) => m.provider)))];
    const reach: Record<string, ProviderKeyReach> = {};

    await Promise.all(
      providers.map(async (provider) => {
        reach[provider] = {
          keyless: !providerRequiresKey(providerPolicy(policy, provider)),
          orgKey: await this.aiConfig.hasOrgKey(provider),
        };
      }),
    );

    return decideFeatureAssignments({
      view,
      keyPolicy: policy.keyPolicy,
      webSearchEnabled: policy.hostedTools.web_search,
      reach,
    });
  }
}
