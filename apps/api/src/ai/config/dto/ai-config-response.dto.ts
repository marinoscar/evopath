import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AI_KEY_POLICIES, AI_OPENAI_API_STYLES } from '../../../common/schemas/settings.schema';
import { AI_CAPABILITIES } from '../../core/capabilities';

// =============================================================================
// GET /api/admin/ai/config — response (issue #428, epic #419)
// =============================================================================
//
// The `ai` settings namespace joined, per provider, with the MASKED status of
// that provider's admin (org) key. The key itself is never in this shape: it is
// held in the encrypted credential store and `keyStatus` is built from
// `CredentialsService.describe`, which cannot decrypt anything.
// =============================================================================

/** Masked, non-secret facts about a stored admin key. Mirrors storage's `secretStatus`. */
export const aiKeyStatusSchema = z.object({
  /** Whether an admin key is stored for this provider. */
  configured: z.boolean(),
  /** A masked hint (`••••Xk9q`) so an admin can tell two keys apart. Never the key. */
  hint: z.string().nullable(),
  updatedAt: z.iso.datetime().nullable(),
  updatedByUserId: z.string().nullable(),
});

export const aiAdminProviderSchema = z.object({
  /** Stable provider id (`openai`). */
  id: z.string(),
  /** The adapter's display name, or the id when no adapter is registered. */
  displayName: z.string(),
  /**
   * Whether an adapter for this provider is registered in this process. A
   * provider can have a settings slot and no adapter (a fork removed it), in
   * which case it cannot be enabled.
   */
  registered: z.boolean(),
  /** The `ai.providers.<id>.enabled` switch, as stored. */
  enabled: z.boolean(),
  /**
   * Endpoint override for OpenAI-compatible gateways, or null for the provider
   * default. For `azure-openai` it is the resource endpoint
   * (`https://<resource>.openai.azure.com`) and for `openai-compatible` the
   * server's API root (`http://ollama.internal:11434/v1`); both need one
   * before they can be enabled (#448).
   */
  baseUrl: z.string().nullable(),
  /**
   * The settings fields this provider accepts besides `enabled` (#448) —
   * `baseUrl` for every provider, plus `apiVersion`, `apiStyle` and
   * `deployments` for `azure-openai`, and `apiStyle` and `requiresKey` for
   * `openai-compatible`. A form renders exactly these.
   */
  settingsFields: z.array(z.enum(['baseUrl', 'apiVersion', 'apiStyle', 'deployments', 'requiresKey'])),
  /** Azure OpenAI `api-version`, or null for the default (`2025-04-01-preview`). */
  apiVersion: z.string().nullable(),
  /**
   * Which wire API the adapter speaks, or null for the default — `responses`
   * for `azure-openai`, `chat_completions` for `openai-compatible`.
   */
  apiStyle: z.enum(AI_OPENAI_API_STYLES).nullable(),
  /** Azure OpenAI model id -> deployment name, or null when none is configured. */
  deployments: z.record(z.string(), z.string()).nullable(),
  /**
   * OpenAI-compatible: whether calls need a key, or null for the default
   * (`true`). `false` means keyless (`keySource: "none"`).
   */
  requiresKey: z.boolean().nullable(),
  keyStatus: aiKeyStatusSchema,
  /** Capabilities the provider's ADAPTER supports (derived from its ports), not any one model's. */
  supportedCapabilities: z.array(z.enum(AI_CAPABILITIES)),
});

export const aiConfigResponseSchema = z.object({
  /** The platform kill switch. */
  enabled: z.boolean(),
  keyPolicy: z.enum(AI_KEY_POLICIES),
  logPromptContent: z.boolean(),
  defaults: z.object({
    /** Deployment-wide output-token cap, or null for none. */
    maxOutputTokensCap: z.number().int().nullable(),
    allowBackgroundRuns: z.boolean(),
    /** Whether users may mint realtime voice sessions (#449). */
    allowRealtime: z.boolean(),
  }),
  /** Days usage events are kept before the daily `ai.usage.purge` deletes them. */
  usageRetentionDays: z.number().int(),
  /** Which provider-hosted tools are switched on, and the MCP host allowlist (#442). */
  hostedTools: z.object({
    web_search: z.boolean(),
    file_search: z.boolean(),
    code_interpreter: z.boolean(),
    image_generation: z.boolean(),
    mcp: z.boolean(),
    mcpAllowedHosts: z.array(z.string()),
  }),
  /**
   * Rate limits and output caps (#450), exactly as stored — every field
   * optional, absent means unlimited; `{}` when none are configured.
   */
  limits: z.object({
    perUser: z
      .object({ requestsPerMinute: z.number().int().optional(), requestsPerDay: z.number().int().optional() })
      .optional(),
    orgKey: z
      .object({ requestsPerDayPerUser: z.number().int().optional(), tokensPerDayPerUser: z.number().int().optional() })
      .optional(),
    /** Keyed `<provider>:<modelId>`. */
    perModel: z
      .record(
        z.string(),
        z.object({ maxOutputTokens: z.number().int().optional(), requestsPerMinutePerUser: z.number().int().optional() }),
      )
      .optional(),
  }),
  /** Registered providers ∪ providers with a settings slot. */
  providers: z.array(aiAdminProviderSchema),
  /** The system-settings row version — send it back as `If-Match` on `PUT`. `0` when nothing is stored yet. */
  version: z.number().int(),
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.object({ id: z.string(), email: z.string() }).nullable(),
});

export class AiConfigResponseDto extends createZodDto(aiConfigResponseSchema) {}
export type AiConfigResponse = z.infer<typeof aiConfigResponseSchema>;
export type AiAdminProvider = z.infer<typeof aiAdminProviderSchema>;

/** Warning codes the key-removal response can carry. */
export const AI_KEY_REMOVAL_WARNINGS = ['ORG_FALLBACK_WITHOUT_KEY'] as const;

/**
 * `DELETE /api/admin/ai/providers/:provider/key` — the admin view, plus
 * `warnings`. `ORG_FALLBACK_WITHOUT_KEY` means the deployment's key policy is
 * still `byok_with_org_fallback`, so users without their own key now have no
 * key at all for this provider.
 */
export const aiKeyRemovalResponseSchema = aiConfigResponseSchema.extend({
  warnings: z.array(z.enum(AI_KEY_REMOVAL_WARNINGS)),
});

export class AiKeyRemovalResponseDto extends createZodDto(aiKeyRemovalResponseSchema) {}
export type AiKeyRemovalResponse = z.infer<typeof aiKeyRemovalResponseSchema>;
