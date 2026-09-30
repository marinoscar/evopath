import { Injectable } from '@nestjs/common';

import {
  AI_FEATURE_IDS,
  type AiFeatureId,
  EMPTY_AI_ASSIGNMENTS,
  type SystemAiAssignmentsValue,
} from '../../common/schemas/settings.schema';
import { PrismaService } from '../../prisma/prisma.service';
import { EMPTY_AI_MODEL_CAPABILITIES } from '../catalog/ai-catalog.service';
import { type AiPolicy, AiConfigService, providerPolicy } from '../config/ai-config.service';
import { type AiCapability, aiModelCapabilitiesSchema } from '../core/capabilities';
import { AiProviderRegistry } from '../core/provider-registry';
import { AiKeyResolver } from '../keys/ai-key-resolver.service';
import { UsableModelsService } from '../keys/usable-models.service';
import { AI_FEATURES } from './ai-features';
import { type CatalogModel, type FeatureResolutionFacts, resolveFeature } from './ai-feature-resolution';
import type { AiFeaturesViewData, FeatureResolution } from './dto/ai-feature-resolution.dto';

// =============================================================================
// AiFeatureModelResolver (#173): which model each AI feature uses for a caller
// =============================================================================
//
// Reads, never writes, and never touches key material: the usable-models list
// (`UsableModelsService`), the AI policy and its `assignments`
// (`AiConfigService.resolve`), which providers have a key source for the
// caller (`AiKeyResolver.sourceFor`, a yes/no answer) and the catalog rows.
// The decision itself is the pure `resolveFeature`.
// =============================================================================

/** `ai.assignments` of a policy, `EMPTY_AI_ASSIGNMENTS` when unset. */
export function assignmentsOf(policy: Pick<AiPolicy, 'assignments'>): SystemAiAssignmentsValue {
  return policy.assignments ?? EMPTY_AI_ASSIGNMENTS;
}

@Injectable()
export class AiFeatureModelResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiConfig: AiConfigService,
    private readonly registry: AiProviderRegistry,
    private readonly keyResolver: AiKeyResolver,
    private readonly usableModels: UsableModelsService,
  ) {}

  /** One feature's resolution for `userId`. */
  async resolve(userId: string, featureId: AiFeatureId): Promise<FeatureResolution> {
    return resolveFeature(featureId, await this.facts(userId));
  }

  /** Every feature's resolution, from one gathering of the facts (`GET /api/ai/features`). */
  async overview(userId: string): Promise<AiFeaturesViewData> {
    const facts = await this.facts(userId);

    return {
      features: AI_FEATURE_IDS.map((id) => ({
        ...resolveFeature(id, facts),
        label: AI_FEATURES[id].label,
        group: AI_FEATURES[id].group,
      })),
    };
  }

  /** Everything a resolution depends on, for callers that resolve several features at once. */
  async facts(userId: string): Promise<FeatureResolutionFacts> {
    const policy = await this.aiConfig.resolve();
    const providerSupports = (provider: string, cap: AiCapability) => this.registry.supports(provider, cap);
    const assignments = assignmentsOf(policy);

    if (!policy.enabled) {
      return {
        aiEnabled: false,
        webSearchEnabled: false,
        usable: [],
        hasAnyKeySource: false,
        providerSupports,
        catalog: [],
        assignments,
      };
    }

    const providers = this.registry.ids().filter((id) => providerPolicy(policy, id)?.enabled);

    const [usable, keyRows, catalogRows] = await Promise.all([
      this.usableModels.listForUser(userId),
      this.prisma.userAiKey.findMany({
        where: { userId, provider: { in: providers } },
        select: { provider: true },
      }),
      this.prisma.aiModel.findMany({
        where: { provider: { in: providers }, deprecatedAt: null },
        select: { provider: true, modelId: true, displayName: true, capabilities: true, enabled: true },
      }),
    ]);

    const withUserKey = new Set(keyRows.map((row) => row.provider));
    let hasAnyKeySource = usable.length > 0;

    for (const provider of providers) {
      if (hasAnyKeySource) break;
      if (await this.keyResolver.sourceFor(userId, provider, withUserKey.has(provider))) {
        hasAnyKeySource = true;
      }
    }

    const catalog: CatalogModel[] = catalogRows.map((row) => {
      const parsed = aiModelCapabilitiesSchema.safeParse(row.capabilities);
      const caps = parsed.success ? parsed.data : EMPTY_AI_MODEL_CAPABILITIES;

      return {
        provider: row.provider,
        modelId: row.modelId,
        displayName: row.displayName,
        capabilities: caps.capabilities,
        inputModalities: caps.inputModalities,
        enabled: row.enabled,
      };
    });

    return {
      aiEnabled: true,
      webSearchEnabled: policy.hostedTools.web_search,
      usable,
      hasAnyKeySource,
      providerSupports,
      catalog,
      assignments,
    };
  }
}
