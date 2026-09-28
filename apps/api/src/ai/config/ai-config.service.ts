import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import type { z } from 'zod';

import {
  type AiOpenAiApiStyle,
  systemAiSchema,
  type SystemAiValue,
} from '../../common/schemas/settings.schema';
import { CredentialsService } from '../../credentials/credentials.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { AiError } from '../core/ai-error';
import { AiProviderRegistry } from '../core/provider-registry';
import { AI_CREDENTIAL_PURPOSE, aiCredentialName } from './ai-credential.constants';
import type { AiPublicConfig } from './dto/ai-public-config.dto';

// =============================================================================
// AiConfigService — the one cached answer to "is AI on?" (issue #428, epic #419)
// =============================================================================
//
// Every other AI story asks this service, never `SystemSettingsService`
// directly, so the kill switch (docs/specs/ai-platform.md §2.19) has exactly one
// reading and one cache. Modelled on `StorageConfigService`:
//
//   - The `ai` settings namespace is cached for AI_POLICY_CACHE_MS. A burst of
//     AI calls costs one `system_settings` read, and an edit made on another
//     instance lands within one TTL.
//   - The instance that HANDLED an admin write does not wait at all: the admin
//     service calls `invalidateCache()` synchronously after the write.
//   - ⚠ THE ORG KEY IS NEVER CACHED. `getOrgKey` decrypts on every call, so a
//     rotation or a removal is live on the very next call, and no plaintext
//     key sits in this process's memory between calls.
// =============================================================================

/**
 * How long a settings read is reused. The same five seconds as
 * `STORAGE_POLICY_CACHE_MS` and `MAINTENANCE_PERSISTED_CACHE_MS`, for the same
 * reasons — see `storage-config.service.ts`.
 */
export const AI_POLICY_CACHE_MS = 5_000;

/** The deployment-wide AI policy (`ai` settings namespace). */
export type AiPolicy = SystemAiValue;

/**
 * One provider's slot in the policy — the union of every slot's fields
 * (#448: the Azure OpenAI and OpenAI-compatible slots carry more than
 * `enabled`/`baseUrl`), so a generic reader can ask for any of them and get
 * `undefined` where a provider has no such field.
 */
export interface AiProviderPolicy {
  enabled: boolean;
  baseUrl?: string;
  apiVersion?: string;
  apiStyle?: AiOpenAiApiStyle;
  deployments?: Record<string, string>;
  requiresKey?: boolean;
}

/** The provider-specific settings a slot may carry besides `enabled` (#448). */
export const AI_PROVIDER_SETTINGS_FIELDS = ['baseUrl', 'apiVersion', 'apiStyle', 'deployments', 'requiresKey'] as const;
export type AiProviderSettingsField = (typeof AI_PROVIDER_SETTINGS_FIELDS)[number];

/** A provider's own slot schema, or `undefined` for an id with no settings slot. */
export function providerSlotSchema(providerId: string): z.ZodObject<z.ZodRawShape> | undefined {
  const shape = systemAiSchema.shape.providers.shape as Record<string, z.ZodObject<z.ZodRawShape> | undefined>;

  return Object.prototype.hasOwnProperty.call(shape, providerId) ? shape[providerId] : undefined;
}

/**
 * The settings fields `providerId`'s slot accepts besides `enabled`, read off
 * its schema — so a slot that gains a field gains it here with no list to
 * update. Empty for an id with no slot.
 */
export function providerSettingsFields(providerId: string): AiProviderSettingsField[] {
  const schema = providerSlotSchema(providerId);

  if (!schema) return [];

  const keys = new Set(Object.keys(schema.shape));

  return AI_PROVIDER_SETTINGS_FIELDS.filter((field) => keys.has(field));
}

/**
 * Whether calls to this provider need a key (#448). Only the
 * OpenAI-compatible slot can say no — `requiresKey: false` is the
 * administrator's opt-in to a keyless server, resolved as `keySource:
 * 'none'` — and absent means yes, as it does for every other provider.
 */
export function providerRequiresKey(slot: AiProviderPolicy | undefined): boolean {
  return slot?.requiresKey !== false;
}

/**
 * What an adapter call carries from the provider's slot (#448): the endpoint
 * as `baseUrl`, and every other non-secret setting (`apiVersion`,
 * `apiStyle`, `deployments`, `requiresKey`) as `providerSettings`, for the
 * adapter to read with its own schema. `enabled` is the runtime's business,
 * never the adapter's. Nothing here can hold a secret — the slot has no
 * field able to (see `settings.schema.ts`'s compile-time proof).
 */
export function providerCallSettings(
  slot: AiProviderPolicy | undefined,
): { baseUrl?: string; providerSettings?: Readonly<Record<string, unknown>> } {
  if (!slot) return {};

  const { enabled: _enabled, baseUrl, ...rest } = slot;
  const settings = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));

  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(Object.keys(settings).length > 0 ? { providerSettings: settings } : {}),
  };
}

/**
 * A provider's policy slot by id, or `undefined` for an id the settings schema
 * has no slot for. `providers` is a closed object keyed by `AI_PROVIDER_IDS`;
 * this is the one place that indexes it by an arbitrary string.
 */
export function providerPolicy(policy: AiPolicy, providerId: string): AiProviderPolicy | undefined {
  const providers = policy.providers as Record<string, AiProviderPolicy | undefined>;

  return Object.prototype.hasOwnProperty.call(providers, providerId)
    ? providers[providerId]
    : undefined;
}

@Injectable()
export class AiConfigService implements OnModuleInit {
  private readonly logger = new Logger(AiConfigService.name);

  /** Last successful settings read. Carries no secret — `SystemAiValue` has no field able to. */
  private cache: { value: AiPolicy; readAt: number } | null = null;

  constructor(
    private readonly systemSettings: SystemSettingsService,
    private readonly credentials: CredentialsService,
    private readonly registry: AiProviderRegistry,
  ) {}

  /**
   * One best-effort settings read at startup, so the first request after a
   * restart is answered from a warm cache. Detached and swallowed on purpose:
   * it must never delay or prevent boot. It reads the SETTINGS only — never
   * a key (see `StorageConfigService.onModuleInit` for why boot is not a
   * moment to decrypt anything).
   */
  onModuleInit(): void {
    void this.resolve({ fresh: true })
      .then((policy) => {
        this.logger.log(
          `AI policy loaded: enabled=${policy.enabled} keyPolicy=${policy.keyPolicy}`,
        );
      })
      .catch((error: unknown) => {
        this.logger.warn(
          'Could not read the AI settings at startup; they will be read again on ' +
            `first use: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  /**
   * The current policy. `fresh: true` bypasses the cache — for a caller that
   * is SHOWING or TESTING the configuration, never for a hot path.
   */
  async resolve(opts: { fresh?: boolean } = {}): Promise<AiPolicy> {
    const now = Date.now();

    if (!opts.fresh && this.cache && now - this.cache.readAt < AI_POLICY_CACHE_MS) {
      return this.cache.value;
    }

    const value = await this.systemSettings.getAiPolicy();
    this.cache = { value, readAt: Date.now() };

    return value;
  }

  /** The kill switch (§2.19). */
  async isEnabled(): Promise<boolean> {
    return (await this.resolve()).enabled;
  }

  /** Throws `AiError('AI_DISABLED')` (403) when the kill switch is off. */
  async assertEnabled(): Promise<void> {
    if (!(await this.isEnabled())) {
      throw new AiError('AI_DISABLED', 'AI features are disabled in this deployment.');
    }
  }

  /**
   * The provider's policy slot, when AI is on, the provider is enabled in
   * settings AND an adapter for it is registered in this process.
   *
   * @throws AiError('AI_DISABLED') when the kill switch is off.
   * @throws AiError('AI_PROVIDER_DISABLED') for any other "no".
   */
  async assertProviderEnabled(providerId: string): Promise<AiProviderPolicy> {
    const policy = await this.resolve();

    if (!policy.enabled) {
      throw new AiError('AI_DISABLED', 'AI features are disabled in this deployment.');
    }

    const slot = providerPolicy(policy, providerId);

    if (!slot?.enabled || !this.registry.get(providerId)) {
      throw new AiError(
        'AI_PROVIDER_DISABLED',
        `AI provider "${providerId}" is not enabled in this deployment.`,
        { details: { provider: providerId } },
      );
    }

    return slot;
  }

  /**
   * The admin (org) key for `providerId`, decrypted, or `null` when none is
   * stored.
   *
   * ⚠ PLAINTEXT, AND NEVER CACHED. Call it at the moment of use, hand the value
   * straight to an adapter, and never log, persist or return it. Whether a
   * caller may USE it to serve a user is `AiKeyResolver`'s decision (§2.2), not
   * this method's.
   */
  async getOrgKey(providerId: string): Promise<string | null> {
    return this.credentials.getSecret(AI_CREDENTIAL_PURPOSE, aiCredentialName(providerId));
  }

  /**
   * Whether an admin (org) key is stored for `providerId` — answered from the
   * credential's metadata, WITHOUT decrypting it. For callers that only need
   * to know a key exists (the usable-models listing), so they never hold
   * plaintext they will not use.
   */
  async hasOrgKey(providerId: string): Promise<boolean> {
    return (await this.credentials.describe(AI_CREDENTIAL_PURPOSE, aiCredentialName(providerId))) !== null;
  }

  /**
   * `GET /api/ai/config` — the narrow projection any signed-in user may read.
   *
   * Answered from the CACHED policy (it is polled by every browser) and only
   * ever `describe`s a key, never decrypts one. Lists REGISTERED providers
   * only: a settings slot with no adapter is nothing a user can call.
   */
  async describePublic(): Promise<AiPublicConfig> {
    const policy = await this.resolve();

    if (!policy.enabled) {
      // Nothing is available while AI is off — background runs included.
      return {
        enabled: false,
        keyPolicy: policy.keyPolicy,
        allowBackgroundRuns: false,
        allowRealtime: false,
        hostedTools: {
          web_search: false,
          file_search: false,
          code_interpreter: false,
          image_generation: false,
          mcp: false,
        },
        providers: [],
      };
    }

    const providers = await Promise.all(
      this.registry.ids().map(async (id) => {
        const adapter = this.registry.get(id);
        const info = await this.credentials.describe(AI_CREDENTIAL_PURPOSE, aiCredentialName(id));

        return {
          id,
          displayName: adapter?.displayName ?? id,
          enabled: providerPolicy(policy, id)?.enabled ?? false,
          hasOrgKey: info !== null,
          supportsPreviousResponseId: this.registry.supportsPreviousResponseId(id),
          requiresKey: providerRequiresKey(providerPolicy(policy, id)),
        };
      }),
    );

    return {
      enabled: true,
      keyPolicy: policy.keyPolicy,
      allowBackgroundRuns: policy.defaults.allowBackgroundRuns,
      allowRealtime: policy.defaults.allowRealtime,
      // Named booleans only — never the host allowlist.
      hostedTools: {
        web_search: policy.hostedTools.web_search,
        file_search: policy.hostedTools.file_search,
        code_interpreter: policy.hostedTools.code_interpreter,
        image_generation: policy.hostedTools.image_generation,
        mcp: policy.hostedTools.mcp,
      },
      providers,
    };
  }

  /**
   * Drop the cached policy so the next read consults the row. Call it
   * SYNCHRONOUSLY right after any write to the `ai` namespace, before the audit
   * row — the ordering `StorageConfigService.invalidateCache` explains.
   */
  invalidateCache(): void {
    this.cache = null;
  }
}
