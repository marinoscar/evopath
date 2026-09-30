import { Injectable } from '@nestjs/common';

import { EMPTY_AI_MODEL_CAPABILITIES } from '../../ai/catalog/ai-catalog.service';
import { AiConfigService, providerPolicy } from '../../ai/config/ai-config.service';
import { aiModelCapabilitiesSchema } from '../../ai/core/capabilities';
import { AiProviderRegistry } from '../../ai/core/provider-registry';
import { AiKeyResolver } from '../../ai/keys/ai-key-resolver.service';
import { UsableModelsService } from '../../ai/keys/usable-models.service';
import {
  TRAINING_AGENT_ROLES,
  type TrainingAgentRole,
  userAiSettingsSchema,
  type UserAiSettingsValue,
} from '../../common/schemas/settings.schema';
import { PrismaService } from '../../prisma/prisma.service';
import type { RoleResolution } from './dto/role-resolution.dto';
import { type CatalogModel, type RoleResolutionFacts, resolveRole } from './training-role-resolution';

// =============================================================================
// TrainingModelResolver: which model each training agent role will use
// =============================================================================
//
// Reads, never writes, and never touches key material: the usable-models list
// (`UsableModelsService`, the read-only seam `AiKeysModule` exports), the AI
// policy (`AiConfigService.resolve`), which providers have a key source
// (`AiKeyResolver.sourceFor`, a yes/no answer) and the catalog rows. The
// decision itself is the pure `resolveRole` in `training-role-resolution.ts`.
// =============================================================================

@Injectable()
export class TrainingModelResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiConfig: AiConfigService,
    private readonly registry: AiProviderRegistry,
    private readonly keyResolver: AiKeyResolver,
    private readonly usableModels: UsableModelsService,
  ) {}

  /** Every role's resolution for `userId`, from one gathering of the facts. */
  async resolveAll(userId: string): Promise<Record<TrainingAgentRole, RoleResolution>> {
    const facts = await this.facts(userId);

    return Object.fromEntries(TRAINING_AGENT_ROLES.map((role) => [role, resolveRole(role, facts)])) as Record<
      TrainingAgentRole,
      RoleResolution
    >;
  }

  async resolve(userId: string, role: TrainingAgentRole): Promise<RoleResolution> {
    return resolveRole(role, await this.facts(userId));
  }

  /** The caller's stored `ai` namespace, read raw (never creates a settings row). */
  async userAiSettings(userId: string): Promise<UserAiSettingsValue | undefined> {
    const row = await this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    const parsed = userAiSettingsSchema.safeParse((row?.value as { ai?: unknown } | null | undefined)?.ai);

    return parsed.success ? parsed.data : undefined;
  }

  private async facts(userId: string): Promise<RoleResolutionFacts> {
    const policy = await this.aiConfig.resolve();
    const providerSupports = (provider: string, cap: Parameters<AiProviderRegistry['supports']>[1]) =>
      this.registry.supports(provider, cap);
    const settings = await this.userAiSettings(userId);

    if (!policy.enabled) {
      return {
        aiEnabled: false,
        webSearchEnabled: false,
        usable: [],
        hasAnyKeySource: false,
        providerSupports,
        catalog: [],
        settings,
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
    let hasAnyKeySource = false;

    for (const provider of providers) {
      if (await this.keyResolver.sourceFor(userId, provider, withUserKey.has(provider))) {
        hasAnyKeySource = true;
        break;
      }
    }

    const catalog: CatalogModel[] = catalogRows.map((row) => {
      const parsed = aiModelCapabilitiesSchema.safeParse(row.capabilities);

      return {
        provider: row.provider,
        modelId: row.modelId,
        displayName: row.displayName,
        capabilities: (parsed.success ? parsed.data : EMPTY_AI_MODEL_CAPABILITIES).capabilities,
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
      settings,
    };
  }
}
