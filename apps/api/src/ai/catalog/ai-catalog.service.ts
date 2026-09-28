// =============================================================================
// AI model catalog (issue #427, epic #419)
// =============================================================================
//
// Discovers one provider's models with the ADMIN key, classifies each through
// the adapter's own `classifyModel`, and persists the result in `ai_models`.
// See docs/specs/ai-platform.md §2.17 for the rules this file implements.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Job, Prisma } from '@prisma/client';

import { CredentialsService } from '../../credentials/credentials.service';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { AiError } from '../core/ai-error';
import { AiModelCapabilities, aiModelCapabilitiesSchema } from '../core/capabilities';
import {
  AI_KEYLESS_API_KEY,
  AiDiscoveredModel,
  AiDiscoveredModelMetadata,
  AiProviderAdapter,
} from '../core/provider-adapter.interface';
import { AiProviderRegistry } from '../core/provider-registry';
import { AI_CREDENTIAL_PURPOSE, aiCredentialName } from '../config/ai-credential.constants';
import { type AiProviderPolicy, providerCallSettings, providerRequiresKey } from '../config/ai-config.service';

/** The job type that runs {@link AiCatalogService.sync} for one provider. PERMANENT. */
export const AI_CATALOG_REFRESH_TYPE = 'ai.catalog.refresh';

/** The `subjectType` every catalog refresh job carries; the subject id is the provider id. */
export const AI_CATALOG_SUBJECT_TYPE = 'ai_provider';

/**
 * Why a sync did nothing. Each is an ordinary, expected outcome — not a
 * failure — so the refresh job returns normally on every one of them.
 */
export type AiCatalogSkipReason =
  | 'AI_DISABLED'
  | 'AI_PROVIDER_DISABLED'
  | 'NO_ADMIN_KEY'
  | 'PROVIDER_NOT_REGISTERED';

export interface AiCatalogSyncCounts {
  /** Rows inserted: models this deployment had never seen. */
  added: number;
  /** Existing rows whose capabilities changed or that reappeared after deprecation. */
  updated: number;
  /** Rows newly marked deprecated because the provider no longer lists them. */
  deprecated: number;
  /** Distinct model ids the provider returned. */
  total: number;
}

export type AiCatalogSyncResult = AiCatalogSyncCounts | { skipped: AiCatalogSkipReason };

export interface AiCatalogSyncOptions {
  /** The administrator who asked for this sync, when one did. Recorded in the audit row. */
  actorUserId?: string | null;
  /** The queue job this sync runs under, recorded on the usage row. */
  jobId?: string | null;
}

/** Narrows a sync result to its skipped arm. */
export function isCatalogSyncSkipped(
  result: AiCatalogSyncResult,
): result is { skipped: AiCatalogSkipReason } {
  return 'skipped' in result;
}

/**
 * What an unclassified model is stored with: no capability at all, so the
 * runtime gate refuses every request against it until an administrator
 * decides what it can do.
 */
export const EMPTY_AI_MODEL_CAPABILITIES: AiModelCapabilities = {
  capabilities: [],
  inputModalities: [],
  outputModalities: [],
};

export type AiCapabilitySource = 'catalog' | 'admin_override' | 'unclassified';

@Injectable()
export class AiCatalogService {
  private readonly logger = new Logger(AiCatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly credentials: CredentialsService,
    private readonly registry: AiProviderRegistry,
    private readonly jobs: JobsService,
  ) {}

  /**
   * Queues a catalog refresh for `providerId`. Deduplicated by the queue on
   * type + subject, so asking twice while one is pending returns that job.
   */
  async enqueueRefresh(providerId: string, actorUserId?: string | null): Promise<Job> {
    return this.jobs.enqueue({
      type: AI_CATALOG_REFRESH_TYPE,
      reason: 'rerun',
      subjectType: AI_CATALOG_SUBJECT_TYPE,
      subjectId: providerId,
      payload: actorUserId ? { providerId, actorUserId } : { providerId },
    });
  }

  /**
   * Discovers, classifies and persists `providerId`'s model catalog.
   *
   * The preservation rules (docs/specs/ai-platform.md §2.17) are the point:
   *
   *   - a NEW model is inserted `enabled: false`, classified or `unclassified`;
   *   - an EXISTING model gets `lastSeenAt` and a cleared `deprecatedAt`, its
   *     capabilities only when they are not an `admin_override`, and its
   *     `enabled` flag is never written;
   *   - a model the provider no longer lists is deprecated and force-disabled,
   *     never deleted (usage history references it by value).
   *
   * Every skip is returned, not thrown. A provider failure is recorded as a
   * failed usage row and rethrown as an `AiError`.
   */
  async sync(providerId: string, options: AiCatalogSyncOptions = {}): Promise<AiCatalogSyncResult> {
    const policy = await this.systemSettings.getAiPolicy();

    if (!policy.enabled) {
      return { skipped: 'AI_DISABLED' };
    }

    const providerPolicy = (policy.providers as Record<string, AiProviderPolicy | undefined>)[
      providerId
    ];

    if (!providerPolicy?.enabled) {
      return { skipped: 'AI_PROVIDER_DISABLED' };
    }

    const adapter = this.registry.get(providerId);

    if (!adapter) {
      this.logger.warn(
        `AI provider "${providerId}" is enabled in settings but no adapter is registered; ` +
          'catalog sync skipped',
      );

      return { skipped: 'PROVIDER_NOT_REGISTERED' };
    }

    const apiKey = await this.credentials.getSecret(
      AI_CREDENTIAL_PURPOSE,
      aiCredentialName(providerId),
    );

    // A keyless provider (#448: `requiresKey: false`) lists its models with
    // no key at all; every other provider needs the admin key to discover.
    const discoveryKey = apiKey ?? (providerRequiresKey(providerPolicy) ? null : AI_KEYLESS_API_KEY);

    if (!discoveryKey) {
      return { skipped: 'NO_ADMIN_KEY' };
    }

    const discovered = await this.discover(adapter, providerId, discoveryKey, providerPolicy, options);
    const { modelIds, metadata } = uniqueModels(discovered);
    const counts = await this.persist(adapter, providerId, modelIds, metadata);

    await this.audit(providerId, options.actorUserId ?? null, counts);

    return counts;
  }

  /**
   * One `listModels` round trip with the ADMIN key, recorded as exactly one
   * `ai_usage_events` row whether it succeeds or fails.
   */
  private async discover(
    adapter: AiProviderAdapter,
    providerId: string,
    apiKey: string,
    providerPolicy: AiProviderPolicy,
    options: AiCatalogSyncOptions,
  ): Promise<AiDiscoveredModel[]> {
    const started = Date.now();

    try {
      const models = await adapter.listModels({
        apiKey,
        ...providerCallSettings(providerPolicy),
        requestId: randomUUID(),
      });

      await this.recordUsage(providerId, 'succeeded', Date.now() - started, null, options);

      return models;
    } catch (error) {
      const aiError = AiError.wrap(error);

      await this.recordUsage(providerId, 'failed', Date.now() - started, aiError.code, options);

      throw aiError;
    }
  }

  /** Applies one discovery result to `ai_models`, atomically. */
  private async persist(
    adapter: AiProviderAdapter,
    providerId: string,
    modelIds: string[],
    metadata: ReadonlyMap<string, AiDiscoveredModelMetadata> = new Map(),
  ): Promise<AiCatalogSyncCounts> {
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.aiModel.findMany({
        where: { provider: providerId },
        select: {
          id: true,
          modelId: true,
          capabilities: true,
          capabilitySource: true,
          deprecatedAt: true,
        },
      });

      // An empty listing with live rows is far more likely a provider glitch
      // than a provider that withdrew every model at once — and taking it at
      // face value would force-disable the whole catalog. Refuse; the job
      // retries, and a genuine withdrawal will still be empty next time.
      if (modelIds.length === 0 && existing.some((row) => row.deprecatedAt === null)) {
        throw new AiError(
          'AI_PROVIDER_UNAVAILABLE',
          'The AI provider returned an empty model list; the catalog was left unchanged.',
          { details: { provider: providerId } },
        );
      }

      const byModelId = new Map(existing.map((row) => [row.modelId, row]));
      const listed = new Set(modelIds);

      let added = 0;
      let updated = 0;

      const inserts: Prisma.AiModelCreateManyInput[] = [];
      const seenOnly: string[] = [];

      for (const modelId of modelIds) {
        const row = byModelId.get(modelId);
        const classified = this.classify(adapter, modelId, metadata.get(modelId));

        if (!row) {
          inserts.push({
            provider: providerId,
            modelId,
            capabilities: toJson(classified.capabilities),
            capabilitySource: classified.source,
            contextWindow: classified.capabilities.contextWindow ?? null,
            maxOutputTokens: classified.capabilities.maxOutputTokens ?? null,
            enabled: false,
            discoveredAt: now,
            lastSeenAt: now,
          });
          added += 1;
          continue;
        }

        const data: Prisma.AiModelUpdateInput = { lastSeenAt: now };
        let changed = false;

        if (row.deprecatedAt !== null) {
          // Reappearance clears deprecation but is NOT re-enablement.
          data.deprecatedAt = null;
          changed = true;
        }

        if (
          row.capabilitySource !== 'admin_override' &&
          (row.capabilitySource !== classified.source ||
            canonicalJson(row.capabilities) !== canonicalJson(classified.capabilities))
        ) {
          data.capabilities = toJson(classified.capabilities);
          data.capabilitySource = classified.source;
          data.contextWindow = classified.capabilities.contextWindow ?? null;
          data.maxOutputTokens = classified.capabilities.maxOutputTokens ?? null;
          changed = true;
        }

        if (!changed) {
          // The common case: only liveness moves. Batched below.
          seenOnly.push(row.id);
          continue;
        }

        // `enabled` is deliberately absent from `data`: a refresh never
        // writes it for a model the provider still lists.
        await tx.aiModel.update({ where: { id: row.id }, data });
        updated += 1;
      }

      if (seenOnly.length > 0) {
        await tx.aiModel.updateMany({
          where: { id: { in: seenOnly } },
          data: { lastSeenAt: now },
        });
      }

      if (inserts.length > 0) {
        await tx.aiModel.createMany({ data: inserts, skipDuplicates: true });
      }

      const missing = existing.filter((row) => !listed.has(row.modelId));
      const newlyDeprecated = missing.filter((row) => row.deprecatedAt === null).map((row) => row.id);
      const alreadyDeprecated = missing.filter((row) => row.deprecatedAt !== null).map((row) => row.id);

      if (newlyDeprecated.length > 0) {
        await tx.aiModel.updateMany({
          where: { id: { in: newlyDeprecated } },
          data: { deprecatedAt: now, enabled: false },
        });
      }

      if (alreadyDeprecated.length > 0) {
        // Keep the original deprecation date, but a withdrawn model is never
        // servable — whatever an administrator did to it in the meantime.
        await tx.aiModel.updateMany({
          where: { id: { in: alreadyDeprecated }, enabled: true },
          data: { enabled: false },
        });
      }

      return { added, updated, deprecated: newlyDeprecated.length, total: modelIds.length };
    });
  }

  /**
   * The adapter's classification, validated. An invalid classifier output is
   * treated as "unclassified" rather than stored — the catalog must never
   * hold a capability record the runtime cannot trust.
   */
  private classify(
    adapter: AiProviderAdapter,
    modelId: string,
    metadata: AiDiscoveredModelMetadata | undefined,
  ): { capabilities: AiModelCapabilities; source: AiCapabilitySource } {
    // The listing's own metadata goes back to the adapter that produced it
    // (#447); an adapter whose listing carries none is called with the id alone.
    const raw = metadata ? adapter.classifyModel(modelId, metadata) : adapter.classifyModel(modelId);

    if (raw === null) {
      return { capabilities: EMPTY_AI_MODEL_CAPABILITIES, source: 'unclassified' };
    }

    const parsed = aiModelCapabilitiesSchema.safeParse(raw);

    if (!parsed.success) {
      this.logger.warn(
        `Adapter "${adapter.id}" returned an invalid classification for "${modelId}"; ` +
          'storing it as unclassified',
      );

      return { capabilities: EMPTY_AI_MODEL_CAPABILITIES, source: 'unclassified' };
    }

    return { capabilities: parsed.data, source: 'catalog' };
  }

  private async recordUsage(
    providerId: string,
    status: 'succeeded' | 'failed',
    latencyMs: number,
    errorCode: string | null,
    options: AiCatalogSyncOptions,
  ): Promise<void> {
    await this.prisma.aiUsageEvent.create({
      data: {
        userId: null,
        provider: providerId,
        modelId: '*',
        operation: 'catalog',
        keySource: 'admin_discovery',
        latencyMs,
        status,
        errorCode,
        jobId: options.jobId ?? null,
      },
    });
  }

  /** No audit service exists; written directly, as `StorageConfigAdminService.audit` does. */
  private async audit(
    providerId: string,
    actorUserId: string | null,
    counts: AiCatalogSyncCounts,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action: 'ai_catalog:refresh',
        targetType: AI_CATALOG_SUBJECT_TYPE,
        targetId: providerId,
        meta: { added: counts.added, updated: counts.updated, deprecated: counts.deprecated },
      },
    });
  }
}

/** Distinct, non-empty model ids, in first-seen order. */
/**
 * The distinct, trimmed ids of a listing, in order, plus the listing metadata
 * of each (#447) — the first listing of an id wins, the same as for the id.
 */
function uniqueModels(models: AiDiscoveredModel[]): {
  modelIds: string[];
  metadata: Map<string, AiDiscoveredModelMetadata>;
} {
  const ids = new Set<string>();
  const metadata = new Map<string, AiDiscoveredModelMetadata>();

  for (const model of models) {
    const id = typeof model?.id === 'string' ? model.id.trim() : '';

    if (id.length > 0 && !ids.has(id)) {
      ids.add(id);

      if (model.metadata && typeof model.metadata === 'object') {
        metadata.set(id, model.metadata);
      }
    }
  }

  return { modelIds: [...ids], metadata };
}

function toJson(capabilities: AiModelCapabilities): Prisma.InputJsonValue {
  return capabilities as unknown as Prisma.InputJsonValue;
}

/**
 * Key-order-independent JSON, so a JSONB value read back (PostgreSQL reorders
 * object keys) compares equal to the same classification built in memory.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }

  return value;
}
