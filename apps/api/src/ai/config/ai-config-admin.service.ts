import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { SystemAiValue } from '../../common/schemas/settings.schema';
import type { CredentialInfo } from '../../credentials/interfaces/credential-info.interface';
import { CredentialsService } from '../../credentials/credentials.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { AiError, isAiErrorCode } from '../core/ai-error';
import type { AiProviderAdapter } from '../core/provider-adapter.interface';
import { AiProviderRegistry } from '../core/provider-registry';
import {
  AI_CREDENTIAL_PURPOSE,
  aiCredentialLabel,
  aiCredentialName,
} from './ai-credential.constants';
import {
  AI_PROVIDER_SETTINGS_FIELDS,
  AiConfigService,
  providerCallSettings,
  providerPolicy,
  providerRequiresKey,
  providerSettingsFields,
  providerSlotSchema,
  type AiProviderPolicy,
} from './ai-config.service';
import type {
  AiAdminProvider,
  AiConfigResponse,
  AiKeyRemovalResponse,
} from './dto/ai-config-response.dto';
import type { UpdateAiConfigInput } from './dto/update-ai-config.dto';

// =============================================================================
// AiConfigAdminService — read and write the AI configuration (#428, epic #419)
// =============================================================================
//
// Modelled on `StorageConfigAdminService`:
//
//     system_settings.global -> `ai` namespace         (non-secret policy)
//   + credentials(ai, <providerId>)                    (masked, never decrypted)
//   + AiProviderRegistry                               (what this process can talk to)
//   -> what `GET /api/admin/ai/config` renders
//
// ⚠ NOTHING IN THIS FILE CALLS `CredentialsService.getSecret`. An admin READ
// has no business decrypting a key; `describe` returns a masked hint. The one
// place an admin key is ever decrypted for an admin route is the connection
// test (`AiProviderTestService`), at the moment of use.
//
// Audit rows are written directly through Prisma — there is no audit service in
// this codebase — with `targetType` `ai_config` and codes / field NAMES only in
// `meta`, never a key and never a value that could hold one
// (docs/specs/ai-platform.md §2.21).
// =============================================================================

/** Stable reason codes for the 400s this service raises (in `details.reason`). */
export const AI_CONFIG_REJECTIONS = {
  UNKNOWN_PROVIDER: 'AI_UNKNOWN_PROVIDER',
  PROVIDER_NOT_REGISTERED: 'AI_PROVIDER_NOT_REGISTERED',
  KEY_REQUIRED: 'AI_KEY_REQUIRED',
  /** A provider-specific field (#448) sent for a provider whose slot has no such field. */
  FIELD_UNSUPPORTED: 'AI_PROVIDER_FIELD_UNSUPPORTED',
  /** A provider's settings failed its own slot schema (#448: an http Azure endpoint, credentials in a URL, ...). */
  SETTINGS_INVALID: 'AI_PROVIDER_SETTINGS_INVALID',
  /** Enabling a provider that cannot work without an endpoint (#448) before one is set. */
  BASE_URL_REQUIRED: 'AI_BASE_URL_REQUIRED',
} as const;

/**
 * Providers that have no default host and so cannot be enabled without a
 * `baseUrl` (#448): an Azure resource and a self-hosted server are, by
 * definition, somewhere only the administrator knows.
 */
const PROVIDERS_REQUIRING_BASE_URL = new Set(['azure-openai', 'openai-compatible']);

type SettingsRow = {
  version: number;
  updatedAt: Date;
  updatedByUser: { id: string; email: string } | null;
} | null;

@Injectable()
export class AiConfigAdminService {
  private readonly logger = new Logger(AiConfigAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly credentials: CredentialsService,
    private readonly registry: AiProviderRegistry,
    private readonly aiConfig: AiConfigService,
  ) {}

  /**
   * Everything `GET /api/admin/ai/config` renders.
   *
   * Reads the policy FRESH (an admin looking at the page must never be shown a
   * value up to five seconds stale) and does not create the settings row as a
   * side effect — `getAiPolicy` and `readRow` are both read-only.
   */
  async describeForAdmin(): Promise<AiConfigResponse> {
    const [policy, row] = await Promise.all([
      this.aiConfig.resolve({ fresh: true }),
      this.readRow(),
    ]);

    const ids = this.knownProviderIds(policy);
    const keyInfos = await Promise.all(
      ids.map((id) => this.credentials.describe(AI_CREDENTIAL_PURPOSE, aiCredentialName(id))),
    );

    return {
      enabled: policy.enabled,
      keyPolicy: policy.keyPolicy,
      logPromptContent: policy.logPromptContent,
      defaults: {
        maxOutputTokensCap: policy.defaults.maxOutputTokensCap ?? null,
        allowBackgroundRuns: policy.defaults.allowBackgroundRuns,
        allowRealtime: policy.defaults.allowRealtime,
      },
      usageRetentionDays: policy.usageRetentionDays,
      hostedTools: { ...policy.hostedTools, mcpAllowedHosts: [...policy.hostedTools.mcpAllowedHosts] },
      limits: structuredClone(policy.limits),
      providers: ids.map((id, index) => this.describeProvider(id, policy, keyInfos[index])),
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.updatedByUser ?? null,
    };
  }

  /**
   * `PUT /api/admin/ai/config` — full replace of the `ai` namespace.
   *
   * Order, each step load-bearing (the same order `StorageConfigAdminService
   * .replace` follows):
   *   1. read the row; `If-Match` is refused BEFORE anything is written;
   *   2. validate the providers and the key policy against the registry and
   *      the credential store — every refusal here is a 400 that wrote nothing;
   *   3. `patchSettings`, passing `expectedVersion` again so the write itself
   *      re-checks it;
   *   4. ⚠ `invalidateCache()` SYNCHRONOUSLY, before the audit row, so this
   *      instance answers "is AI on?" from the new value immediately;
   *   5. the audit row, with changed field NAMES only.
   *
   * FULL REPLACE OF THE OPTIONAL FIELDS TOO: an empty/absent `baseUrl` or
   * `maxOutputTokensCap` in the body CLEARS a stored one. `patchSettings`
   * keeps a field it is not sent, so a cleared field is sent as an explicit
   * `null`, which its merge treats as "remove" (see `toPatch`).
   */
  async replace(
    input: UpdateAiConfigInput,
    userId: string,
    expectedVersion?: number,
  ): Promise<AiConfigResponse> {
    const row = await this.readRow();
    const currentVersion = row?.version ?? 0;

    if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
      throw new ConflictException(
        `AI settings version mismatch. Expected ${expectedVersion}, found ${currentVersion}`,
      );
    }

    const current = await this.systemSettings.getAiPolicy();
    const next = this.buildNext(current, input);

    await this.assertKeysForFallback(next);

    await this.systemSettings.patchSettings({ ai: toPatch(next) }, userId, expectedVersion);

    // Step 4 — see the method comment. Nothing awaits between the write and this.
    this.aiConfig.invalidateCache();

    const changedFields = diffFieldNames(current, next);

    await this.audit(userId, 'ai_config:replace', 'ai', { changedFields });

    this.logger.log(
      `AI configuration replaced by user ${userId} ` +
        `(enabled=${next.enabled} keyPolicy=${next.keyPolicy} ` +
        `changed=${changedFields.join(',') || '(none)'})`,
    );

    return this.describeForAdmin();
  }

  /**
   * `PUT /api/admin/ai/providers/:provider/key` — verify, then store.
   *
   * VERIFY FIRST. A key the provider rejects is a `400 AI_KEY_INVALID` and
   * nothing is written: storing an unverified key would let a typo silently
   * replace a working one. A provider that cannot be reached answers with its
   * own `AiError` (e.g. `503 AI_PROVIDER_UNAVAILABLE`) — also storing nothing.
   */
  async setKey(provider: string, apiKey: string, userId: string): Promise<AiConfigResponse> {
    const adapter = this.requireRegistered(provider);
    const policy = await this.aiConfig.resolve({ fresh: true });

    await this.verifyKey(adapter, apiKey, providerPolicy(policy, provider));

    await this.credentials.setSecret(AI_CREDENTIAL_PURPOSE, aiCredentialName(provider), apiKey, {
      label: aiCredentialLabel(adapter.displayName),
      updatedByUserId: userId,
    });

    await this.audit(userId, 'ai_config:set_key', provider, { provider });

    this.logger.log(`AI provider key for "${provider}" set by user ${userId}`);

    return this.describeForAdmin();
  }

  /**
   * `DELETE /api/admin/ai/providers/:provider/key`. Idempotent — removing a
   * key that is not there is not an error. Under `byok_with_org_fallback` the
   * response carries `ORG_FALLBACK_WITHOUT_KEY`: the policy still promises a
   * fallback that no longer exists for this provider.
   */
  async deleteKey(provider: string, userId: string): Promise<AiKeyRemovalResponse> {
    const policy = await this.aiConfig.resolve({ fresh: true });

    if (!this.knownProviderIds(policy).includes(provider)) {
      throw this.unknownProvider(provider);
    }

    await this.credentials.deleteSecret(AI_CREDENTIAL_PURPOSE, aiCredentialName(provider));

    await this.audit(userId, 'ai_config:delete_key', provider, { provider });

    this.logger.log(`AI provider key for "${provider}" removed by user ${userId}`);

    const view = await this.describeForAdmin();

    return {
      ...view,
      warnings:
        view.keyPolicy === 'byok_with_org_fallback' ? ['ORG_FALLBACK_WITHOUT_KEY'] : [],
    };
  }

  /**
   * Whether calls to `provider` need a key (#448) — false only for an
   * OpenAI-compatible server the administrator marked `requiresKey: false`.
   * Read fresh: it gates an admin action.
   */
  async providerRequiresKey(provider: string): Promise<boolean> {
    return providerRequiresKey(providerPolicy(await this.aiConfig.resolve({ fresh: true }), provider));
  }

  /** The adapter for `provider`, or a 404 naming it. */
  requireRegistered(provider: string): AiProviderAdapter {
    const adapter = this.registry.get(provider);

    if (!adapter) {
      throw this.unknownProvider(provider);
    }

    return adapter;
  }

  /** Registered providers first (registration order), then settings-only slots. */
  knownProviderIds(policy: SystemAiValue): string[] {
    return [...new Set([...this.registry.ids(), ...Object.keys(policy.providers)])];
  }

  // ---------------------------------------------------------------------------

  private describeProvider(
    id: string,
    policy: SystemAiValue,
    keyInfo: CredentialInfo | null,
  ): AiAdminProvider {
    const adapter = this.registry.get(id);
    const slot = providerPolicy(policy, id);

    return {
      id,
      displayName: adapter?.displayName ?? id,
      registered: adapter !== undefined,
      enabled: slot?.enabled ?? false,
      baseUrl: slot?.baseUrl ?? null,
      settingsFields: providerSettingsFields(id),
      apiVersion: slot?.apiVersion ?? null,
      apiStyle: slot?.apiStyle ?? null,
      deployments: slot?.deployments ? { ...slot.deployments } : null,
      requiresKey: slot?.requiresKey ?? null,
      keyStatus: {
        configured: keyInfo !== null,
        hint: keyInfo?.hint ?? null,
        updatedAt: keyInfo?.updatedAt.toISOString() ?? null,
        updatedByUserId: keyInfo?.updatedByUserId ?? null,
      },
      supportedCapabilities: this.registry.capabilities(id),
    };
  }

  /**
   * The namespace to write. A provider the body leaves out keeps its stored
   * slot; a provider id with no settings slot is a 400, as is ENABLING a
   * provider no adapter is registered for (it could never serve a call).
   */
  private buildNext(current: SystemAiValue, input: UpdateAiConfigInput): SystemAiValue {
    for (const id of Object.keys(input.providers)) {
      if (providerPolicy(current, id) === undefined) {
        throw this.unknownProvider(id, BadRequestException);
      }
    }

    const providers: Record<string, AiProviderPolicy> = {};

    for (const id of Object.keys(current.providers)) {
      const stored = providerPolicy(current, id) as AiProviderPolicy;
      const submitted = input.providers[id];

      if (!submitted) {
        providers[id] = stored;
        continue;
      }

      if (submitted.enabled && !this.registry.get(id)) {
        throw new BadRequestException({
          message: `AI provider "${id}" cannot be enabled: no adapter for it is available in this deployment.`,
          details: { reason: AI_CONFIG_REJECTIONS.PROVIDER_NOT_REGISTERED, provider: id },
        });
      }

      providers[id] = this.buildSlot(id, submitted);
    }

    const maxOutputTokensCap = input.defaults.maxOutputTokensCap ?? undefined;

    return {
      enabled: input.enabled,
      keyPolicy: input.keyPolicy,
      logPromptContent: input.logPromptContent,
      defaults: {
        ...(maxOutputTokensCap !== undefined ? { maxOutputTokensCap } : {}),
        allowBackgroundRuns: input.defaults.allowBackgroundRuns,
        // Optional in the body (#449): omitted keeps the stored value.
        allowRealtime: input.defaults.allowRealtime ?? current.defaults.allowRealtime,
      },
      providers: providers as SystemAiValue['providers'],
      // Optional in the body (#443): a client written before the field
      // existed keeps the stored retention rather than failing validation.
      usageRetentionDays: input.usageRetentionDays ?? current.usageRetentionDays,
      // Optional in the body too (#442), for the same reason. The host list is
      // de-duplicated; the DTO already trimmed and lower-cased every entry.
      hostedTools: input.hostedTools
        ? { ...input.hostedTools, mcpAllowedHosts: [...new Set(input.hostedTools.mcpAllowedHosts)] }
        : { ...current.hostedTools, mcpAllowedHosts: [...current.hostedTools.mcpAllowedHosts] },
      // Optional in the body too (#450). When sent it replaces the stored
      // limits WHOLESALE — leaving a field out is how a limit is lifted.
      limits: structuredClone(input.limits ?? current.limits),
    };
  }

  /**
   * One provider's next slot from its submitted settings (#448). Every field
   * the body leaves empty is ABSENT (the provider default) — full replace, as
   * for `baseUrl` before it. A value for a field this provider's slot does not
   * have is a 400 rather than silently dropped, and the built slot must pass
   * the provider's own schema (an `https`-only Azure endpoint, no credentials
   * in a URL): the admin form is the one place such a mistake can be caught
   * before it breaks every call.
   */
  private buildSlot(id: string, submitted: UpdateAiConfigInput['providers'][string]): AiProviderPolicy {
    const allowed = new Set<string>(providerSettingsFields(id));
    const slot: Record<string, unknown> = { enabled: submitted.enabled };

    for (const field of AI_PROVIDER_SETTINGS_FIELDS) {
      const raw = submitted[field];
      const empty =
        raw === undefined ||
        raw === null ||
        raw === '' ||
        (field === 'deployments' && typeof raw === 'object' && Object.keys(raw).length === 0);

      if (empty) continue;

      if (!allowed.has(field)) {
        throw new BadRequestException({
          message: `AI provider "${id}" has no "${field}" setting.`,
          details: { reason: AI_CONFIG_REJECTIONS.FIELD_UNSUPPORTED, provider: id, field },
        });
      }

      slot[field] = field === 'deployments' ? { ...(raw as Record<string, string>) } : raw;
    }

    const parsed = providerSlotSchema(id)?.safeParse(slot);

    if (parsed && !parsed.success) {
      throw new BadRequestException({
        message: `The settings for AI provider "${id}" are not valid: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || id}: ${issue.message}`)
          .join('; ')}.`,
        details: {
          reason: AI_CONFIG_REJECTIONS.SETTINGS_INVALID,
          provider: id,
          fields: [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '')))].filter(Boolean),
        },
      });
    }

    if (submitted.enabled && PROVIDERS_REQUIRING_BASE_URL.has(id) && !slot.baseUrl) {
      throw new BadRequestException({
        message: `AI provider "${id}" needs a base URL before it can be enabled.`,
        details: { reason: AI_CONFIG_REJECTIONS.BASE_URL_REQUIRED, provider: id },
      });
    }

    return slot as unknown as AiProviderPolicy;
  }

  /**
   * `byok_with_org_fallback` promises users without a key that the org key
   * will serve them, so every provider that would be LIVE under the new
   * policy must actually have one.
   *
   * Only enforced while `next.enabled` is true: the kill switch must always be
   * reachable, so a deployment whose key went missing can still be turned OFF
   * (or have the offending provider disabled) without first fixing the key.
   */
  private async assertKeysForFallback(next: SystemAiValue): Promise<void> {
    if (next.keyPolicy !== 'byok_with_org_fallback' || !next.enabled) {
      return;
    }

    for (const id of Object.keys(next.providers)) {
      const slot = providerPolicy(next, id);

      // A keyless provider (#448) is served with no key at all: it needs no fallback.
      if (!slot?.enabled || !providerRequiresKey(slot)) continue;

      const info = await this.credentials.describe(AI_CREDENTIAL_PURPOSE, aiCredentialName(id));

      if (!info) {
        throw new BadRequestException({
          message:
            `The "byok_with_org_fallback" key policy needs an admin key for every enabled ` +
            `provider, and "${id}" has none. Save a key for it first, or disable it.`,
          details: { reason: AI_CONFIG_REJECTIONS.KEY_REQUIRED, provider: id },
        });
      }
    }
  }

  private async verifyKey(
    adapter: AiProviderAdapter,
    apiKey: string,
    slot: AiProviderPolicy | undefined,
  ): Promise<void> {
    let verification;

    try {
      verification = await adapter.verifyKey({
        apiKey,
        ...providerCallSettings(slot),
        requestId: randomUUID(),
      });
    } catch (error) {
      // `wrap` uses a generic message — an SDK's own text may echo the request.
      throw AiError.wrap(error);
    }

    if (verification.ok) return;

    const code =
      verification.code && isAiErrorCode(verification.code) ? verification.code : 'AI_KEY_INVALID';

    throw new AiError(
      code,
      code === 'AI_KEY_INVALID'
        ? `The ${adapter.displayName} API rejected this key. Nothing was saved.`
        : `The ${adapter.displayName} key could not be verified. Nothing was saved.`,
      { details: { provider: adapter.id } },
    );
  }

  /** The `global` settings row's provenance, WITHOUT creating it. See `StorageConfigAdminService.readRow`. */
  private async readRow(): Promise<SettingsRow> {
    return this.prisma.systemSettings.findUnique({
      where: { key: 'global' },
      select: {
        version: true,
        updatedAt: true,
        updatedByUser: { select: { id: true, email: true } },
      },
    });
  }

  private unknownProvider(
    provider: string,
    Exception: typeof NotFoundException | typeof BadRequestException = NotFoundException,
  ): Error {
    return new Exception({
      message: `Unknown AI provider "${provider}".`,
      details: { reason: AI_CONFIG_REJECTIONS.UNKNOWN_PROVIDER, provider },
    });
  }

  /** Audit row with codes / names only. `targetId` is `'ai'` or a provider id. */
  private async audit(
    userId: string,
    action: string,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action,
        targetType: 'ai_config',
        targetId,
        meta: meta as Prisma.InputJsonValue,
      },
    });
  }
}

/**
 * `next` as a settings PATCH body: every optional field this namespace can
 * hold is sent explicitly, as `null` when absent, so the PATCH merge REMOVES
 * a stored value rather than keeping it. That is what makes the admin PUT a
 * full replace of the optional fields as well as the required ones.
 */
export function toPatch(next: SystemAiValue) {
  return {
    ...next,
    // Every settings field the provider's slot HAS is sent, `null` when
    // absent (#448), so a cleared `apiVersion`/`deployments`/... is removed.
    providers: Object.fromEntries(
      Object.entries(next.providers).map(([id, slot]) => {
        const policy = slot as AiProviderPolicy;

        return [
          id,
          {
            enabled: policy.enabled,
            ...Object.fromEntries(providerSettingsFields(id).map((field) => [field, policy[field] ?? null])),
          },
        ];
      }),
    ) as Record<keyof SystemAiValue['providers'], { enabled: boolean; baseUrl: string | null }>,
    defaults: {
      allowBackgroundRuns: next.defaults.allowBackgroundRuns,
      allowRealtime: next.defaults.allowRealtime,
      maxOutputTokensCap: next.defaults.maxOutputTokensCap ?? null,
    },
  };
}

/**
 * The dotted NAMES of the fields that differ between two policies — never the
 * values, so an audit row cannot carry anything a future field might hold.
 */
export function diffFieldNames(before: SystemAiValue, after: SystemAiValue): string[] {
  const flat = (value: SystemAiValue): Record<string, unknown> => {
    const out: Record<string, unknown> = {
      enabled: value.enabled,
      keyPolicy: value.keyPolicy,
      logPromptContent: value.logPromptContent,
      'defaults.maxOutputTokensCap': value.defaults.maxOutputTokensCap,
      'defaults.allowBackgroundRuns': value.defaults.allowBackgroundRuns,
      'defaults.allowRealtime': value.defaults.allowRealtime,
      usageRetentionDays: value.usageRetentionDays,
      'hostedTools.web_search': value.hostedTools.web_search,
      'hostedTools.file_search': value.hostedTools.file_search,
      'hostedTools.code_interpreter': value.hostedTools.code_interpreter,
      'hostedTools.image_generation': value.hostedTools.image_generation,
      'hostedTools.mcp': value.hostedTools.mcp,
      // Compared as one value: the audit row names the list, never its hosts.
      'hostedTools.mcpAllowedHosts': value.hostedTools.mcpAllowedHosts.join('\n'),
      'limits.perUser.requestsPerMinute': value.limits.perUser?.requestsPerMinute,
      'limits.perUser.requestsPerDay': value.limits.perUser?.requestsPerDay,
      'limits.orgKey.requestsPerDayPerUser': value.limits.orgKey?.requestsPerDayPerUser,
      'limits.orgKey.tokensPerDayPerUser': value.limits.orgKey?.tokensPerDayPerUser,
      // Compared as one value, like the host list: the audit row names the map.
      'limits.perModel': stableJson(value.limits.perModel ?? {}),
    };

    for (const [id, slot] of Object.entries(value.providers)) {
      const policy = slot as AiProviderPolicy;

      out[`providers.${id}.enabled`] = policy.enabled;

      for (const field of providerSettingsFields(id)) {
        // Compared as one value, like the host list: the audit row names the map.
        out[`providers.${id}.${field}`] = field === 'deployments' ? stableJson(policy.deployments ?? {}) : policy[field];
      }
    }

    return out;
  };

  const a = flat(before);
  const b = flat(after);

  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => a[key] !== b[key]);
}

/** A JSON rendering independent of key order, for comparing two values. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}
