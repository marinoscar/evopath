import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { EMPTY_AI_MODEL_CAPABILITIES } from '../catalog/ai-catalog.service';
import { AiConfigService, providerPolicy } from '../config/ai-config.service';
import { AiError } from '../core/ai-error';
import {
  aiModelCapabilitiesSchema,
  type AiCapability,
  type AiModelCapabilities,
} from '../core/capabilities';
import { AiProviderRegistry } from '../core/provider-registry';
import { AiKeyResolver, type AiKeySource, keyRequired } from './ai-key-resolver.service';
import type { UsableAiModel } from './dto/usable-ai-model.dto';

// =============================================================================
// UsableModelsService — "which models can I use?" (issue #431, epic #419)
// =============================================================================
//
// docs/specs/ai-platform.md §2.18. Not a new source of truth: it intersects two
// facts that already exist —
//
//   - the ADMIN's decision: `ai_models` rows with `enabled` and no
//     `deprecatedAt`;
//   - the KEY's reach: the user's `reachableModelIds` (computed when the key
//     was set, refreshed weekly and on every stored-key test), or — when the
//     org key serves the provider (the fallback policy, or the caller holds
//     `ai_config:write`, #593) — no restriction beyond the admin's.
//
// Which key serves a provider is `AiKeyResolver.sourceFor`'s answer, never
// re-derived here, so the usable list and the runtime can never disagree
// about whether the org key applies.
//
// `assertUsable` is the single-model form, called by the runtime's gate
// pipeline (#432) before any provider call, and the one place the model-gate
// error codes originate.
// =============================================================================

const MODEL_SELECT = {
  provider: true,
  modelId: true,
  displayName: true,
  capabilities: true,
  enabled: true,
  deprecatedAt: true,
} satisfies Prisma.AiModelSelect;

type ModelRow = Prisma.AiModelGetPayload<{ select: typeof MODEL_SELECT }>;

@Injectable()
export class UsableModelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiConfig: AiConfigService,
    private readonly registry: AiProviderRegistry,
    private readonly resolver: AiKeyResolver,
  ) {}

  /** Every model `userId` can call right now, by provider then model id. */
  async listForUser(userId: string): Promise<UsableAiModel[]> {
    const policy = await this.aiConfig.resolve();

    if (!policy.enabled) {
      return [];
    }

    const providers = this.registry.ids().filter((id) => providerPolicy(policy, id)?.enabled);

    if (providers.length === 0) {
      return [];
    }

    const [keyRows, modelRows] = await Promise.all([
      this.prisma.userAiKey.findMany({
        where: { userId, provider: { in: providers } },
        select: { provider: true, reachableModelIds: true },
      }),
      this.prisma.aiModel.findMany({
        where: { provider: { in: providers }, enabled: true, deprecatedAt: null },
        select: MODEL_SELECT,
      }),
    ]);

    const reachableByProvider = new Map(
      keyRows.map((row) => [row.provider, new Set(row.reachableModelIds)]),
    );
    const usable: UsableAiModel[] = [];
    // Rule 2's permission lookup, at most once per listing — and only if some
    // provider without a user key actually reaches that rule.
    let writer: Promise<boolean> | undefined;
    const holdsAiConfigWrite = () => (writer ??= this.resolver.holdsAiConfigWrite(userId));

    for (const provider of providers) {
      const reachable = reachableByProvider.get(provider);
      const keySource = await this.resolver.sourceFor(
        userId,
        provider,
        reachable !== undefined,
        holdsAiConfigWrite,
      );

      if (!keySource) {
        continue;
      }

      for (const row of modelRows) {
        if (row.provider !== provider) continue;
        if (keySource === 'user' && !reachable?.has(row.modelId)) continue;

        usable.push(toUsable(row, keySource));
      }
    }

    return usable.sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId),
    );
  }

  /**
   * Refuse, with the precise reason, a call `userId` cannot make:
   *
   *   AI_DISABLED / AI_PROVIDER_DISABLED  the platform or provider is off
   *   AI_MODEL_NOT_ENABLED                unknown, not admin-enabled, or deprecated
   *   AI_CAPABILITY_UNSUPPORTED           the model (or provider) lacks a needed capability
   *   AI_KEY_REQUIRED                     no key resolves (AiKeyResolver's rule)
   *   AI_MODEL_NOT_REACHABLE              the user's key cannot reach this model
   *
   * Decrypts nothing — the runtime resolves the key itself, afterwards.
   */
  async assertUsable(
    userId: string,
    provider: string,
    modelId: string,
    capability?: AiCapability | readonly AiCapability[],
  ): Promise<{ model: UsableAiModel; keySource: AiKeySource }> {
    await this.aiConfig.assertProviderEnabled(provider);

    const row = await this.prisma.aiModel.findUnique({
      where: { provider_modelId: { provider, modelId } },
      select: MODEL_SELECT,
    });

    if (!row || !row.enabled || row.deprecatedAt) {
      throw new AiError(
        'AI_MODEL_NOT_ENABLED',
        `Model "${modelId}" is not available in this deployment.`,
        { details: { provider, model: modelId } },
      );
    }

    const capabilities = parseCapabilities(row.capabilities);
    const needed: readonly AiCapability[] =
      capability === undefined ? [] : typeof capability === 'string' ? [capability] : capability;

    for (const cap of needed) {
      if (!capabilities.capabilities.includes(cap) || !this.registry.supports(provider, cap)) {
        throw new AiError(
          'AI_CAPABILITY_UNSUPPORTED',
          `Model "${modelId}" does not support ${cap}.`,
          { details: { provider, model: modelId, capability: cap } },
        );
      }
    }

    const keyRow = await this.prisma.userAiKey.findUnique({
      where: { userId_provider: { userId, provider } },
      select: { reachableModelIds: true },
    });
    const keySource = await this.resolver.sourceFor(userId, provider, keyRow !== null);

    if (!keySource) {
      throw keyRequired(provider);
    }

    if (keySource === 'user' && !keyRow?.reachableModelIds.includes(modelId)) {
      throw new AiError(
        'AI_MODEL_NOT_REACHABLE',
        `Your API key for "${provider}" cannot reach model "${modelId}".`,
        { details: { provider, model: modelId } },
      );
    }

    return { model: toUsable(row, keySource), keySource };
  }
}

function parseCapabilities(value: unknown): AiModelCapabilities {
  const parsed = aiModelCapabilitiesSchema.safeParse(value);

  return parsed.success ? parsed.data : EMPTY_AI_MODEL_CAPABILITIES;
}

function toUsable(row: ModelRow, keySource: AiKeySource): UsableAiModel {
  return {
    provider: row.provider,
    modelId: row.modelId,
    displayName: row.displayName,
    capabilities: parseCapabilities(row.capabilities),
    keySource,
  };
}
