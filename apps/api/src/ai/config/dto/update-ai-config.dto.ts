import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  AI_AZURE_API_VERSION_PATTERN,
  AI_KEY_POLICIES,
  AI_OPENAI_API_STYLES,
  aiAzureDeploymentsSchema,
  AI_LIMIT_MODEL_KEY_MAX,
  AI_LIMIT_MODEL_KEY_PATTERN,
  AI_LIMIT_VALUE_MAX,
  AI_LIMITS_PER_MODEL_MAX,
  AI_MCP_ALLOWED_HOST_PATTERN,
  AI_MCP_ALLOWED_HOSTS_MAX,
  AI_USAGE_RETENTION_MAX_DAYS,
} from '../../../common/schemas/settings.schema';

// =============================================================================
// PUT /api/admin/ai/config — body (issue #428, epic #419)
// =============================================================================
//
// The whole `ai` namespace, in a shape a form can send back unchanged:
// `providers` is keyed by provider id (the admin view lists them as an array
// with more fields; `enabled`, `baseUrl` and — for the providers whose
// `settingsFields` name them (#448) — `apiVersion`, `apiStyle`, `deployments`
// and `requiresKey` are writable).
//
// There is NO key field here and there must never be one. The admin key has
// its own routes (`PUT`/`DELETE /api/admin/ai/providers/:provider/key`) so it
// is verified against the provider before it is stored, and so a settings save
// can never carry, echo or audit it.
// =============================================================================

/** Largest accepted provider id — generous; real ids are short. */
const PROVIDER_ID_MAX = 64;

export const aiProviderSettingsInputSchema = z.object({
  enabled: z.boolean(),
  /**
   * Endpoint override for an OpenAI-compatible gateway. Omit (or send null /
   * empty) for "no override" — which CLEARS a stored override.
   */
  baseUrl: z
    .union([z.url().max(2048), z.literal('')])
    .nullish(),
  /**
   * The rest are provider-specific (#448) — only a provider whose
   * `settingsFields` lists the field accepts a value for it; for any other
   * provider it must be omitted, null or empty. Omit / null / empty CLEARS a
   * stored value, back to the provider default. The per-provider rules (an
   * `https`-only Azure endpoint, no credentials in a URL, ...) are applied by
   * the service against the provider's own settings schema.
   */
  /** Azure OpenAI: the `api-version` query value. Default `2025-04-01-preview`. */
  apiVersion: z
    .union([z.string().regex(AI_AZURE_API_VERSION_PATTERN), z.literal('')])
    .nullish(),
  /** Azure OpenAI (default `responses`) and OpenAI-compatible (default `chat_completions`). */
  apiStyle: z.enum(AI_OPENAI_API_STYLES).nullish(),
  /** Azure OpenAI: model id -> deployment name. Replaces the stored map whole; `{}` or null clears it. */
  deployments: aiAzureDeploymentsSchema.nullish(),
  /**
   * OpenAI-compatible: `false` opts in to a keyless server — calls carry no
   * credential and usage is recorded with `keySource: "none"`. Default `true`.
   */
  requiresKey: z.boolean().nullish(),
});

/** `ai.hostedTools` (#442) — every provider-hosted tool type's switch, and the MCP host allowlist. */
export const aiHostedToolsSettingsSchema = z.object({
  web_search: z.boolean(),
  file_search: z.boolean(),
  code_interpreter: z.boolean(),
  image_generation: z.boolean(),
  mcp: z.boolean(),
  /**
   * Hosts an MCP `serverUrl` may name — `mcp.example.com`, or `*.example.com`
   * for its subdomains. Empty: any `https://` host.
   */
  mcpAllowedHosts: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .max(253)
        .regex(AI_MCP_ALLOWED_HOST_PATTERN, 'A hostname, or *.hostname for its subdomains'),
    )
    .max(AI_MCP_ALLOWED_HOSTS_MAX),
});

const aiLimitValueSchema = z.number().int().positive().max(AI_LIMIT_VALUE_MAX);

/**
 * `ai.limits` (#450) — per-user and per-model rate limits and output caps.
 * Every field is optional; ABSENT MEANS UNLIMITED. Sent whole: the object
 * submitted replaces the stored one, so leaving a field (or a per-model entry)
 * out is how a limit is lifted.
 */
export const aiLimitsSettingsSchema = z.object({
  /** Every inference call a user makes, whoever's key pays. */
  perUser: z
    .object({
      requestsPerMinute: aiLimitValueSchema.optional(),
      requestsPerDay: aiLimitValueSchema.optional(),
    })
    .optional(),
  /** Only calls the organization key pays for — a user on their own key is never counted. */
  orgKey: z
    .object({
      requestsPerDayPerUser: aiLimitValueSchema.optional(),
      /** Input + output tokens per user per UTC day. */
      tokensPerDayPerUser: aiLimitValueSchema.optional(),
    })
    .optional(),
  /**
   * Keyed `<provider>:<modelId>` (`openai:gpt-4.1-mini`). `maxOutputTokens`
   * clamps every call to that model (the smaller of it and
   * `defaults.maxOutputTokensCap` wins); `requestsPerMinutePerUser` limits each
   * user's calls to it.
   */
  perModel: z
    .record(
      z
        .string()
        .max(AI_LIMIT_MODEL_KEY_MAX)
        .regex(AI_LIMIT_MODEL_KEY_PATTERN, 'A "<provider>:<modelId>" key, e.g. "openai:gpt-4.1-mini"'),
      z.object({
        maxOutputTokens: aiLimitValueSchema.optional(),
        requestsPerMinutePerUser: aiLimitValueSchema.optional(),
      }),
    )
    .refine((value) => Object.keys(value).length <= AI_LIMITS_PER_MODEL_MAX, {
      message: `At most ${AI_LIMITS_PER_MODEL_MAX} per-model limits`,
    })
    .optional(),
});

export const updateAiConfigSchema = z.object({
  enabled: z.boolean(),
  keyPolicy: z.enum(AI_KEY_POLICIES),
  logPromptContent: z.boolean(),
  defaults: z.object({
    /** Omit or null for "no cap" — which CLEARS a stored cap. */
    maxOutputTokensCap: z.number().int().positive().max(1_000_000).nullish(),
    allowBackgroundRuns: z.boolean(),
    /**
     * Whether users may mint realtime voice sessions (#449). Omit to keep the
     * stored value, like `usageRetentionDays`, so a client written before the
     * field existed still saves.
     */
    allowRealtime: z.boolean().optional(),
  }),
  /**
   * Days `ai_usage_events` rows are kept before the daily purge deletes them
   * (#443). Omit to keep the stored value — the one field of this body that is
   * not full-replace, so a client written before it existed still saves.
   */
  usageRetentionDays: z.number().int().min(1).max(AI_USAGE_RETENTION_MAX_DAYS).optional(),
  /**
   * Which provider-hosted tools users may call (#442), all off by default.
   * Omit to keep the stored value, like `usageRetentionDays`, so a client
   * written before it existed still saves.
   */
  hostedTools: aiHostedToolsSettingsSchema.optional(),
  /**
   * Rate limits and output caps (#450), none by default. Omit to keep the
   * stored value, like `hostedTools`; when sent, it REPLACES the stored limits
   * wholesale (`{}` lifts every limit).
   */
  limits: aiLimitsSettingsSchema.optional(),
  /**
   * Per-provider settings keyed by provider id. A provider left out keeps its
   * stored settings.
   */
  providers: z.record(
    z.string().min(1).max(PROVIDER_ID_MAX),
    aiProviderSettingsInputSchema,
  ),
});

export class UpdateAiConfigDto extends createZodDto(updateAiConfigSchema) {}
export type UpdateAiConfigInput = z.output<typeof updateAiConfigSchema>;
