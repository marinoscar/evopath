/**
 * The AI platform's HTTP surface (epic #419, umbrella #418), as the web app
 * sees it.
 *
 * Issue #425. Shaped after `services/storageConfig.ts`: `services/api.ts`
 * stays the transport (the `ApiService` instance, the refresh dance, the
 * maintenance recogniser) and this module holds every Phase 1 AI call next to
 * the types it produces. The tail of `services/api.ts` is legacy; nothing new
 * goes there.
 *
 * Three route families, three audiences:
 *
 * - `GET /ai/config` — any authenticated user. The PUBLIC projection of the
 *   `ai` system-settings namespace: whether AI is on at all, the key policy,
 *   and which providers exist. It is what hides the AI cards, the AI
 *   destination and the AI routes when an administrator has not switched AI
 *   on (see `hooks/useAiConfig.ts`). It never carries a key hint.
 * - `/admin/ai/*` — `ai_config:read` / `ai_config:write`. The organisation's
 *   configuration, provider keys and model catalogue.
 * - `/ai/keys`, `/ai/models`, `/ai/responses`, `/ai/runs`, `/ai/images`, `/ai/audio/*`,
 *   `/ai/embeddings`, `/ai/usage/me` — `ai:use`, and refused with
 *   `403 AI_DISABLED` while AI is off.
 *
 * =============================================================================
 * A KEY ONLY EVER TRAVELS ONE WAY
 * =============================================================================
 *
 * No response type below carries an API key, because no endpoint returns one.
 * Keys appear only as WRITE-ONLY `apiKey` arguments; what comes back is a
 * masked {@link SecretStatus} (admin keys) or a {@link UserAiKey} view (a
 * user's own key). Nothing here should grow a field that could hold the real
 * key coming back.
 *
 * =============================================================================
 * ⚠ THE TEST ENDPOINTS ANSWER 200 WHEN THE ANSWER IS BAD
 * =============================================================================
 *
 * `POST /admin/ai/providers/:p/test` always returns HTTP 200; the outcome is
 * in the body's `success` and per-check `status`. A caller that reads only
 * the status code reports success for every rejected key.
 */
import { api, API_BASE_URL } from './api';
import { postSse } from './sse';

// =============================================================================
// Shared vocabulary
// =============================================================================

/**
 * Whose key pays for a call. `byok` — each user must bring their own;
 * `byok_with_org_fallback` — a user without a key falls back to the
 * organisation's key for that provider.
 */
export const AI_KEY_POLICIES = ['byok', 'byok_with_org_fallback'] as const;
export type AiKeyPolicy = (typeof AI_KEY_POLICIES)[number];

/**
 * The machine-readable codes the AI API answers with (`ApiError.code`).
 * Mirrors `AI_ERROR_STATUS` in `apps/api/src/ai/core/ai-error.ts` (#424).
 */
export const AI_ERROR_CODES = [
  'AI_DISABLED',
  'AI_REALTIME_DISABLED',
  'AI_PROVIDER_DISABLED',
  'AI_KEY_REQUIRED',
  'AI_KEY_INVALID',
  'AI_MODEL_NOT_ENABLED',
  'AI_MODEL_NOT_REACHABLE',
  'AI_CAPABILITY_UNSUPPORTED',
  'AI_TOOL_DISABLED',
  'AI_RATE_LIMITED',
  'AI_PROVIDER_UNAVAILABLE',
  'AI_CONTENT_FILTERED',
  'AI_INVALID_REQUEST',
  'AI_STRUCTURED_OUTPUT_INVALID',
  'AI_STORAGE_UNAVAILABLE',
] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

/** Confirmation literal the admin key DELETE requires (same idiom as push). */
export const AI_KEY_REMOVE_CONFIRMATION = 'REMOVE';

// =============================================================================
// Configuration
// =============================================================================

/** `GET /ai/config` — what every authenticated user may know. */
export interface AiPublicConfig {
  enabled: boolean;
  keyPolicy: AiKeyPolicy;
  /** Empty while `enabled` is false. */
  providers: {
    id: string;
    displayName: string;
    enabled: boolean;
    hasOrgKey: boolean;
    /**
     * Whether a request may continue a conversation by `previousResponseId`
     * (#446). `false` for a stateless provider (Anthropic): send the
     * conversation so far as `input` instead, or the API answers `400
     * AI_CAPABILITY_UNSUPPORTED`. Optional so an older API that omits it
     * still works — absent means chain, the pre-#446 behaviour.
     */
    supportsPreviousResponseId?: boolean;
    /**
     * Whether calling this provider needs a key (#448). `false` only for an
     * OpenAI-compatible server the administrator marked keyless: nobody adds
     * a key for it and its calls are recorded with `keySource: 'none'`.
     * Optional so an older API that omits it still works — absent means a key
     * is needed, the pre-#448 behaviour. Test with `=== false`.
     */
    requiresKey?: boolean;
  }[];
  /**
   * `defaults.allowBackgroundRuns` (#433): whether `POST /ai/runs` accepts a
   * request; always `false` while `enabled` is false. Optional so an older API
   * that omits it still works — absent means "unknown": the playground offers
   * background runs, handles a refusal, and hides them only on `false`.
   */
  allowBackgroundRuns?: boolean;
  /**
   * `defaults.allowRealtime` (#449): whether `POST /ai/realtime/sessions`
   * mints a voice session; always `false` while `enabled` is false. Optional
   * so an older API that omits it still works — absent means "off": the
   * playground offers Voice only on an explicit `true`.
   */
  allowRealtime?: boolean;
  /**
   * Which provider-hosted tools an administrator has switched on (#442); all
   * false while `enabled` is false. Offer a tool only when its flag is true —
   * a request naming a disabled one is `403 AI_TOOL_DISABLED`. Optional so an
   * older API that omits it still works: absent means "none".
   */
  hostedTools?: Record<AiHostedToolType, boolean>;
}

/** The provider-hosted tool types (#442). */
export const AI_HOSTED_TOOL_TYPES = [
  'web_search',
  'file_search',
  'code_interpreter',
  'image_generation',
  'mcp',
] as const;
export type AiHostedToolType = (typeof AI_HOSTED_TOOL_TYPES)[number];

/** `ai.hostedTools` — each hosted tool's switch, plus the MCP host allowlist (admin only). */
export type AiHostedToolsSettings = Record<AiHostedToolType, boolean> & {
  /** `mcp.example.com` or `*.example.com`; empty means any `https://` host. */
  mcpAllowedHosts: string[];
};

/**
 * One model's `ai.limits.perModel` entry (#450). `maxOutputTokens` clamps
 * every call to the model (the smaller of it and `defaults.maxOutputTokensCap`
 * wins); `requestsPerMinutePerUser` limits each user's calls to it.
 */
export interface AiModelLimits {
  maxOutputTokens?: number;
  requestsPerMinutePerUser?: number;
}

/**
 * `ai.limits` (#450) — rate limits and output caps. Every field is optional
 * and ABSENT MEANS UNLIMITED; `{}` is "no limits at all". Each value is an
 * integer from 1 to {@link AI_LIMIT_MAX}.
 */
export interface AiLimits {
  /** Every inference call a user makes, whoever's key pays. */
  perUser?: { requestsPerMinute?: number; requestsPerDay?: number };
  /** Only calls the organization key pays for. */
  orgKey?: { requestsPerDayPerUser?: number; tokensPerDayPerUser?: number };
  /** Keyed `<provider>:<modelId>` — see {@link aiModelLimitKey}. At most 500 entries. */
  perModel?: Record<string, AiModelLimits>;
}

/** The largest value any `ai.limits` field accepts. */
export const AI_LIMIT_MAX = 1_000_000_000;

/** A `limits.perModel` key: `<provider>:<modelId>`. */
export function aiModelLimitKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

/** Masked status of a stored credential — never the credential itself. */
export interface SecretStatus {
  configured: boolean;
  hint: string | null;
  updatedAt: string | null;
  updatedByUserId: string | null;
}

export interface AiAdminProvider {
  id: string;
  displayName: string;
  /**
   * Whether this build has an adapter for the provider. `false` for a
   * provider that exists only as a settings key (a removed adapter): it can
   * be switched off but not on (`400 AI_PROVIDER_NOT_REGISTERED`).
   */
  registered: boolean;
  enabled: boolean;
  /**
   * The operator's endpoint override; `null` means the provider's default.
   * For `azure-openai` it is the resource endpoint
   * (`https://<resource>.openai.azure.com`); for `openai-compatible` the API
   * root, `/v1` included. Both need one before they can be enabled (#448).
   */
  baseUrl: string | null;
  /**
   * The settings fields this provider accepts besides `enabled` (#448). A
   * form renders exactly these, and the `PUT` sends exactly these — a field a
   * provider does not list is `400 AI_PROVIDER_FIELD_UNSUPPORTED`. Optional
   * so an older API that omits it still works — absent means `['baseUrl']`.
   */
  settingsFields?: AiProviderSettingsField[];
  /** Azure OpenAI `api-version`; `null` for the default ({@link AI_AZURE_DEFAULT_API_VERSION}). */
  apiVersion?: string | null;
  /** Wire API; `null` for the provider's default (see {@link aiDefaultApiStyle}). */
  apiStyle?: AiApiStyle | null;
  /** Azure OpenAI model id -> deployment name; `null` when none is configured. */
  deployments?: Record<string, string> | null;
  /** OpenAI-compatible: whether calls need a key; `null` for the default (`true`). */
  requiresKey?: boolean | null;
  keyStatus: SecretStatus;
  supportedCapabilities: string[];
}

/** A provider settings field besides `enabled` (#448) — `AiAdminProvider.settingsFields`. */
export type AiProviderSettingsField = 'baseUrl' | 'apiVersion' | 'apiStyle' | 'deployments' | 'requiresKey';

/** Which wire API an OpenAI-shaped adapter speaks (#448). */
export type AiApiStyle = 'responses' | 'chat_completions';

/** Azure OpenAI's `api-version` when none is set — mirrors the API's default. */
export const AI_AZURE_DEFAULT_API_VERSION = '2025-04-01-preview';

/** Most Azure deployments one provider accepts — mirrors the API's cap. */
export const AI_AZURE_DEPLOYMENTS_MAX = 200;

/**
 * An Azure `api-version` or deployment name: a letter or digit, then up to 63
 * of letters, digits, `.`, `_`, `-`. Mirrors the API's own pattern.
 */
export const AI_AZURE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Longest model id a `deployments` entry may map — mirrors the API. */
export const AI_AZURE_MODEL_ID_MAX = 256;

/** The `apiStyle` a provider uses while its own is unset (`null`). */
export function aiDefaultApiStyle(providerId: string): AiApiStyle {
  return providerId === 'openai-compatible' ? 'chat_completions' : 'responses';
}

/** The fields a provider's form renders and its `PUT` entry carries; `['baseUrl']` from an older API. */
export function aiProviderSettingsFields(provider: Pick<AiAdminProvider, 'settingsFields'>): AiProviderSettingsField[] {
  return provider.settingsFields ?? ['baseUrl'];
}

/** One provider's entry in the `PUT` body. Only `enabled` plus that provider's `settingsFields`. */
export interface AiProviderSettingsInput {
  enabled: boolean;
  baseUrl?: string | null;
  apiVersion?: string | null;
  apiStyle?: AiApiStyle | null;
  deployments?: Record<string, string> | null;
  requiresKey?: boolean | null;
}

/**
 * A provider's `PUT` entry: `enabled`, plus ONLY the fields its
 * `settingsFields` lists — any other is `400 AI_PROVIDER_FIELD_UNSUPPORTED`.
 * `baseUrl` is always sent (a `null` clears it, the pre-#448 shape the three
 * built-in providers keep exactly); the other fields are omitted when unset,
 * which the full-replace `PUT` reads as "back to the default".
 */
export function aiProviderSettingsToInput(
  provider: Pick<AiAdminProvider, 'settingsFields'>,
  values: {
    enabled: boolean;
    baseUrl: string | null;
    apiVersion?: string | null;
    apiStyle?: AiApiStyle | null;
    deployments?: Record<string, string> | null;
    requiresKey?: boolean | null;
  },
): AiProviderSettingsInput {
  const fields = aiProviderSettingsFields(provider);
  const input: AiProviderSettingsInput = { enabled: values.enabled };
  if (fields.includes('baseUrl')) input.baseUrl = values.baseUrl?.trim() || null;
  if (fields.includes('apiVersion') && values.apiVersion?.trim()) input.apiVersion = values.apiVersion.trim();
  if (fields.includes('apiStyle') && values.apiStyle) input.apiStyle = values.apiStyle;
  if (fields.includes('deployments') && values.deployments && Object.keys(values.deployments).length > 0) {
    input.deployments = { ...values.deployments };
  }
  if (fields.includes('requiresKey') && typeof values.requiresKey === 'boolean') {
    input.requiresKey = values.requiresKey;
  }
  return input;
}

/** `GET /admin/ai/config`. */
export interface AiAdminConfig {
  enabled: boolean;
  keyPolicy: AiKeyPolicy;
  logPromptContent: boolean;
  /**
   * `maxOutputTokensCap: null` means no cap. `allowRealtime` (#449) is absent
   * from an older API — read as off.
   */
  defaults: { maxOutputTokensCap: number | null; allowBackgroundRuns: boolean; allowRealtime?: boolean };
  /** Absent from an API older than #442 — read as every tool off. */
  hostedTools?: AiHostedToolsSettings;
  /** Rate limits and output caps (#450); `{}` — or absent, from an older API — means unlimited. */
  limits?: AiLimits;
  providers: AiAdminProvider[];
  version: number;
  updatedAt: string | null;
  updatedBy: { id: string; email: string } | null;
}

/** `DELETE /admin/ai/providers/:p/key` — the config view plus warnings. */
export interface AiAdminConfigWithWarnings extends AiAdminConfig {
  /** `['ORG_FALLBACK_WITHOUT_KEY']` when an org-fallback policy is left keyless; else `[]`. */
  warnings: string[];
}

/**
 * `PUT /admin/ai/config` body — a FULL REPLACE. For every provider included,
 * an omitted, `''` or `null` `baseUrl` CLEARS the stored override, and an
 * omitted or `null` `maxOutputTokensCap` clears the cap; so a caller that
 * wants to keep either must send it. A provider left out of `providers`
 * entirely keeps its settings.
 */
export interface AiAdminConfigInput {
  enabled: boolean;
  keyPolicy: AiKeyPolicy;
  logPromptContent: boolean;
  /** `allowRealtime` (#449): omit to keep the stored value. */
  defaults: { maxOutputTokensCap?: number | null; allowBackgroundRuns: boolean; allowRealtime?: boolean };
  /** Omit to keep the stored value (#442). */
  hostedTools?: AiHostedToolsSettings;
  /**
   * Omit to keep the stored value (#450). When sent it REPLACES the stored
   * limits wholesale — `{}` lifts every limit, and a `perModel` entry left out
   * is lifted too.
   */
  limits?: AiLimits;
  /** Each entry carries only `enabled` plus that provider's `settingsFields` — see {@link aiProviderSettingsToInput}. */
  providers: Record<string, AiProviderSettingsInput>;
}

/**
 * The `PUT` body that re-saves `config` exactly as it stands — every value
 * explicit, because the PUT is a full replace. A read-modify-write caller
 * (the model dialog's per-model limits) spreads its one change over this.
 */
export function aiAdminConfigToInput(config: AiAdminConfig): AiAdminConfigInput {
  const providers: AiAdminConfigInput['providers'] = {};
  for (const provider of config.providers) {
    providers[provider.id] = aiProviderSettingsToInput(provider, provider);
  }
  return {
    enabled: config.enabled,
    keyPolicy: config.keyPolicy,
    logPromptContent: config.logPromptContent,
    defaults: { ...config.defaults },
    ...(config.hostedTools ? { hostedTools: config.hostedTools } : {}),
    limits: config.limits ?? {},
    providers,
  };
}

/**
 * `limits` with one model's `perModel` entry replaced — or removed, when
 * `entry` sets nothing. Every other entry, and `perUser`/`orgKey`, is kept.
 */
export function withModelLimits(limits: AiLimits | undefined, key: string, entry: AiModelLimits): AiLimits {
  const perModel = { ...(limits?.perModel ?? {}) };
  if (entry.maxOutputTokens === undefined && entry.requestsPerMinutePerUser === undefined) {
    delete perModel[key];
  } else {
    perModel[key] = entry;
  }
  const next: AiLimits = { ...(limits ?? {}) };
  delete next.perModel;
  if (Object.keys(perModel).length > 0) next.perModel = perModel;
  return next;
}

export interface AiProbeCheck {
  id: 'credentials' | 'list_models' | 'responses_smoke' | (string & {});
  label: string;
  status: 'passed' | 'failed' | 'skipped';
  code: string;
  detail: string;
  error: string | null;
}

/** `POST /admin/ai/providers/:p/test` and `POST /ai/keys/:p/test` — always 200. */
export interface AiProbeResult {
  success: boolean;
  provider: string;
  usedStoredKey: boolean;
  /** Models the key can list; `null` when listing was not reached. */
  modelCount: number | null;
  /** The model the smoke call used; `null` when it was skipped. */
  smokeModelId: string | null;
  checks: AiProbeCheck[];
  attemptedAt: string;
}

// =============================================================================
// Models
// =============================================================================

export interface AiModelCapabilities {
  capabilities: string[];
  inputModalities: string[];
  outputModalities: string[];
  reasoningEfforts?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  /** The voices an `audio_speech` model speaks in (#439), in the provider's order. */
  voices?: string[];
}

/** A row of the organisation's model catalogue (`/admin/ai/models`). */
export interface AiModel {
  id: string;
  provider: string;
  modelId: string;
  displayName: string | null;
  /** `null` for an `unclassified` model nobody has described yet. */
  capabilities: AiModelCapabilities | null;
  capabilitySource: 'catalog' | 'admin_override' | 'unclassified';
  enabled: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  discoveredAt: string;
  lastSeenAt: string;
  /** Set once the provider stopped listing the model. */
  deprecatedAt: string | null;
  updatedAt: string;
  updatedByUserId: string | null;
}

export interface AiModelListFilter {
  provider?: string;
  capability?: string;
  enabled?: boolean;
  includeDeprecated?: boolean;
  q?: string;
  page?: number;
  pageSize?: number;
}

/** Paginated like `GET /admin/jobs`. */
export interface AiModelListResponse {
  items: AiModel[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface AiModelUpdateInput {
  enabled?: boolean;
  displayName?: string | null;
  capabilities?: AiModelCapabilities;
}

// =============================================================================
// Per-user keys and usable models
// =============================================================================

/** The caller's own key for one provider, masked. */
export interface UserAiKey {
  provider: string;
  configured: boolean;
  hint: string | null;
  verifiedAt: string | null;
  lastErrorCode: string | null;
  reachableModelCount: number;
  reachableCheckedAt: string | null;
}

/** A model this caller can actually call right now, and whose key pays. */
export interface UsableAiModel {
  provider: string;
  modelId: string;
  displayName: string | null;
  capabilities: AiModelCapabilities;
  /** `'none'` (#448): a keyless server — nobody's key pays. */
  keySource: AiKeySource;
}

/** Whose key paid for a call (#448 added `'none'`, a keyless server). */
export type AiKeySource = 'user' | 'org' | 'none';

// =============================================================================
// Responses and runs
// =============================================================================

export type AiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url?: string; storageObjectId?: string; detail?: 'low' | 'high' | 'auto' }
  | { type: 'file'; storageObjectId?: string; url?: string; filename?: string };

export type AiInputItem =
  | {
      type: 'message';
      role: 'user' | 'assistant' | 'system' | 'developer';
      content: AiContentPart[];
    }
  | { type: 'function_call_output'; callId: string; output: string };

/**
 * `POST /ai/responses` (and `/stream`, `/ai/runs`) body. HTTP callers send a
 * JSON Schema for structured output, never Zod; function tools are not
 * accepted over HTTP in Phase 1.
 */
/**
 * A provider-hosted tool a request may carry (#442) — mirrors
 * `aiHostedToolSchema` (`apps/api/src/ai/core/hosted-tools.ts`), which is
 * `.strict()`. Offered only when the model has `hosted_tools` AND the tool's
 * `GET /ai/config` `hostedTools` flag is on; otherwise `403 AI_TOOL_DISABLED`.
 */
export type AiHostedTool =
  | {
      type: 'web_search';
      searchContextSize?: 'low' | 'medium' | 'high';
      userLocation?: { country?: string; city?: string };
    }
  | { type: 'file_search'; vectorStoreIds: string[]; maxResults?: number }
  | { type: 'code_interpreter'; container?: { type: 'auto' } }
  | { type: 'image_generation'; size?: string; quality?: string }
  | {
      type: 'mcp';
      serverLabel: string;
      serverUrl: string;
      allowedTools?: string[];
      requireApproval?: 'never' | 'always';
      /** ⚠ Secret; refused on a background run. */
      headers?: Record<string, string>;
    };

/** `web_search` result (#442): what was searched and the sources consulted. */
export interface AiWebSearchCallResult {
  queries: string[];
  sources: Array<{ url: string }>;
}

/** `file_search` result: queries run and chunks retrieved. */
export interface AiFileSearchCallResult {
  queries: string[];
  results: Array<{ fileId?: string; filename?: string; score?: number; text?: string }>;
}

/** `code_interpreter` result: the code run and what it printed or drew. */
export interface AiCodeInterpreterCallResult {
  code: string | null;
  containerId: string;
  outputs: Array<{ type: 'logs'; logs: string } | { type: 'image'; url: string }>;
}

/**
 * `image_generation` result: the image was saved as the caller's storage
 * object, or `storageObjectId` is `null` and `storageError` says why.
 */
export interface AiImageGenerationCallResult {
  storageObjectId: string | null;
  storageError?: 'AI_STORAGE_UNAVAILABLE';
  mimeType?: string;
  revisedPrompt?: string;
  size?: string;
  quality?: string;
}

export interface AiResponseRequest {
  provider?: string;
  model?: string;
  instructions?: string;
  input: string | AiInputItem[];
  /** Provider-hosted tools (#442); function tools are not accepted over HTTP. */
  tools?: AiHostedTool[];
  structuredOutput?: { name: string; jsonSchema: object; strict?: boolean };
  reasoning?: {
    effort?: 'minimal' | 'low' | 'medium' | 'high';
    summary?: 'auto' | 'concise' | 'detailed';
  };
  maxOutputTokens?: number;
  temperature?: number;
  previousResponseId?: string;
  metadata?: Record<string, string>;
  providerOptions?: Record<string, Record<string, unknown>>;
}

/** A web-search citation: `text.slice(startIndex, endIndex)` is the passage it supports (#442). */
export interface AiUrlCitation {
  url: string;
  title: string;
  startIndex: number;
  endIndex: number;
}

export type AiOutputItem =
  | { type: 'message'; text: string; citations?: AiUrlCitation[] }
  | { type: 'reasoning'; summary: string[] }
  | { type: 'function_call'; callId: string; name: string; arguments: string }
  | { type: 'hosted_tool_call'; id?: string; tool: string; status: string; result?: unknown };

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface AiResponse<T = unknown> {
  id: string;
  provider: string;
  model: string;
  output: AiOutputItem[];
  outputText: string;
  parsed?: T;
  usage: AiUsage;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
  providerRequestId?: string;
}

/** One SSE frame of `POST /ai/responses/stream`; `type` is the frame's `event:`. */
export type AiStreamEvent =
  | { type: 'response.created'; id: string }
  | { type: 'output_text.delta'; delta: string }
  | { type: 'reasoning_summary.delta'; delta: string }
  | { type: 'function_call.arguments.delta'; callId: string; delta: string }
  | { type: 'output_item.done'; item: AiOutputItem }
  | { type: 'response.completed'; response: AiResponse }
  | { type: 'error'; code: AiErrorCode; message: string };

export type AiRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** `POST /ai/runs` — 202. */
export interface AiRunStarted {
  runId: string;
  jobId: string;
}

/**
 * A succeeded image run's `output` (#437): storage objects the caller owns.
 * Download each through `GET /storage/objects/:id/download`
 * (`services/storage.ts`); the bytes are never in the run.
 */
export interface AiImageRunOutput {
  type: 'images';
  provider: string;
  model: string;
  /** One per image, in the order the provider returned them. */
  storageObjectIds: string[];
  images: {
    storageObjectId: string;
    mimeType: string;
    /** Bytes. */
    size: number;
    /** The prompt the provider actually used, where it rewrote it. */
    revisedPrompt?: string;
  }[];
  usage: AiUsage;
}

/** A succeeded transcription run's `output` (#438): the transcript. */
export interface AiTranscriptionRunOutput {
  type: 'transcription';
  provider: string;
  model: string;
  /** The recording that was transcribed (the caller's storage object). */
  storageObjectId: string;
  text: string;
  /** As the provider reports it — an ISO code or a name such as `english`. */
  language?: string;
  durationSeconds?: number;
  /** Timestamped segments, where the model produces them. */
  segments?: { startSeconds: number; endSeconds: number; text: string }[];
  words?: { startSeconds: number; endSeconds: number; word: string }[];
  usage: AiUsage;
}

/**
 * A succeeded speech run's `output` (#439): the audio as a storage object the
 * caller owns. `aiGenerated` is always true — a player must say so.
 */
export interface AiSpeechRunOutput {
  type: 'speech';
  provider: string;
  model: string;
  storageObjectId: string;
  mimeType: string;
  /** Bytes. */
  size: number;
  format: AiSpeechFormat;
  voice: string;
  /** Characters spoken. */
  characters: number;
  aiGenerated: true;
  usage: AiUsage;
}

/** Every shape a succeeded run's `output` can take — discriminate with the guards below. */
export type AiRunOutput = AiResponse | AiImageRunOutput | AiTranscriptionRunOutput | AiSpeechRunOutput;

function runOutputType(output: AiRunOutput | null | undefined): string | null {
  return output && 'type' in output && typeof output.type === 'string' ? output.type : null;
}

export function isAiImageRunOutput(output: AiRunOutput | null | undefined): output is AiImageRunOutput {
  return runOutputType(output) === 'images';
}

export function isAiTranscriptionRunOutput(
  output: AiRunOutput | null | undefined,
): output is AiTranscriptionRunOutput {
  return runOutputType(output) === 'transcription';
}

export function isAiSpeechRunOutput(output: AiRunOutput | null | undefined): output is AiSpeechRunOutput {
  return runOutputType(output) === 'speech';
}

/** A text run's output (`POST /ai/runs`): an {@link AiResponse} — the one shape with no `type`. */
export function isAiResponseRunOutput(output: AiRunOutput | null | undefined): output is AiResponse {
  return !!output && runOutputType(output) === null;
}

/** `GET /ai/runs/:id` — scoped to the caller. */
export interface AiRun {
  id: string;
  status: AiRunStatus;
  provider: string;
  modelId: string;
  /** Once `succeeded`; otherwise `null`. */
  output: AiRunOutput | null;
  errorCode: string | null;
  /** A safe, generic description of the failure once `failed`. */
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

// =============================================================================
// Calls — public configuration
// =============================================================================

export async function getAiConfig(): Promise<AiPublicConfig> {
  return api.get<AiPublicConfig>('/ai/config');
}

// =============================================================================
// Calls — administration (`ai_config:*`)
// =============================================================================

const ADMIN = '/admin/ai';

export async function getAiAdminConfig(): Promise<AiAdminConfig> {
  return api.get<AiAdminConfig>(`${ADMIN}/config`);
}

/**
 * Replace the configuration. `expectedVersion` travels as `If-Match`; a stale
 * version answers 409, exactly like the storage configuration.
 */
export async function updateAiAdminConfig(
  input: AiAdminConfigInput,
  expectedVersion?: number,
): Promise<AiAdminConfig> {
  return api.put<AiAdminConfig>(`${ADMIN}/config`, input, {
    headers:
      expectedVersion === undefined ? undefined : { 'If-Match': String(expectedVersion) },
  });
}

/** Store the organisation key for a provider. Verified first; 400 `AI_KEY_INVALID` stores nothing. */
export async function setAiProviderKey(
  provider: string,
  apiKey: string,
): Promise<AiAdminConfig> {
  return api.put<AiAdminConfig>(
    `${ADMIN}/providers/${encodeURIComponent(provider)}/key`,
    { apiKey },
  );
}

export async function deleteAiProviderKey(
  provider: string,
): Promise<AiAdminConfigWithWarnings> {
  return api.delete<AiAdminConfigWithWarnings>(`${ADMIN}/providers/${encodeURIComponent(provider)}/key`, {
    body: JSON.stringify({ confirmation: AI_KEY_REMOVE_CONFIRMATION }),
  });
}

/** Probe a provider. Blank `apiKey` means "use the stored key". Always 200 — read `success`. */
export async function testAiProvider(
  provider: string,
  input: { apiKey?: string; baseUrl?: string } = {},
): Promise<AiProbeResult> {
  return api.post<AiProbeResult>(
    `${ADMIN}/providers/${encodeURIComponent(provider)}/test`,
    stripBlank(input),
  );
}

export async function listAiModels(filter: AiModelListFilter = {}): Promise<AiModelListResponse> {
  const query = new URLSearchParams();
  if (filter.provider) query.set('provider', filter.provider);
  if (filter.capability) query.set('capability', filter.capability);
  if (filter.enabled !== undefined) query.set('enabled', String(filter.enabled));
  if (filter.includeDeprecated) query.set('includeDeprecated', 'true');
  if (filter.q?.trim()) query.set('q', filter.q.trim());
  if (filter.page) query.set('page', String(filter.page));
  if (filter.pageSize) query.set('pageSize', String(filter.pageSize));
  const suffix = query.toString();
  return api.get<AiModelListResponse>(`${ADMIN}/models${suffix ? `?${suffix}` : ''}`);
}

export async function updateAiModel(id: string, input: AiModelUpdateInput): Promise<AiModel> {
  return api.patch<AiModel>(`${ADMIN}/models/${encodeURIComponent(id)}`, input);
}

/** `POST /admin/ai/models/refresh` — the queued job. */
export interface AiCatalogRefreshQueued {
  jobId: string;
  status: string;
}

/** Enqueue a catalogue refresh for one provider. 409 `AI_KEY_REQUIRED` when it has no org key. */
export async function refreshAiModels(provider: string): Promise<AiCatalogRefreshQueued> {
  return api.post<AiCatalogRefreshQueued>(`${ADMIN}/models/refresh`, { provider });
}

// =============================================================================
// Calls — the caller's own keys and models (`ai:use`)
// =============================================================================

export async function listUserAiKeys(): Promise<UserAiKey[]> {
  return api.get<UserAiKey[]>('/ai/keys');
}

export async function setUserAiKey(provider: string, apiKey: string): Promise<UserAiKey> {
  return api.put<UserAiKey>(`/ai/keys/${encodeURIComponent(provider)}`, { apiKey });
}

export async function deleteUserAiKey(provider: string): Promise<void> {
  await api.delete<void>(`/ai/keys/${encodeURIComponent(provider)}`);
}

/** Probe the caller's stored key, or `apiKey` when given. Always 200 — read `success`. */
export async function testUserAiKey(provider: string, apiKey?: string): Promise<AiProbeResult> {
  return api.post<AiProbeResult>(
    `/ai/keys/${encodeURIComponent(provider)}/test`,
    stripBlank({ apiKey }),
  );
}

export async function listUsableAiModels(): Promise<UsableAiModel[]> {
  return api.get<UsableAiModel[]>('/ai/models');
}

// =============================================================================
// Calls — responses and background runs (`ai:use`)
// =============================================================================

export async function createAiResponse(req: AiResponseRequest): Promise<AiResponse> {
  return api.post<AiResponse>('/ai/responses', req);
}

/** Callbacks for {@link streamAiResponse}. Every one is optional. */
export interface AiStreamHandlers {
  /** Every event, in order, before the typed callbacks below. */
  onEvent?: (event: AiStreamEvent) => void;
  /** Each `output_text.delta` — append to the visible answer. */
  onTextDelta?: (delta: string) => void;
  /** Each `reasoning_summary.delta`. */
  onReasoningDelta?: (delta: string) => void;
  /** The final `response.completed`. */
  onCompleted?: (response: AiResponse) => void;
  /** An `error` event — a failure AFTER streaming began. */
  onError?: (code: AiErrorCode, message: string) => void;
}

/**
 * Where the stream is POSTed, resolved against the same base as every call.
 * A function, not a module-level constant: reading `API_BASE_URL` at import
 * time breaks every test that mocks `services/api` without that export and
 * merely imports this module transitively (through `useAiConfig`).
 */
export function aiStreamUrl(): string {
  return `${API_BASE_URL}/ai/responses/stream`;
}

/**
 * `POST /ai/responses/stream` — one prompt, one streamed answer, via
 * `postSse` (no reconnect: a reconnect would re-submit the prompt).
 *
 * Resolves with the completed {@link AiResponse}, or `null` when the stream
 * ended without one (an `error` event, delivered to `onError`, or `signal`
 * aborted — aborting is not an error). REJECTS with `ApiError` when a gate
 * refused the request before the first byte (`AI_DISABLED`,
 * `AI_KEY_REQUIRED`, `AI_MODEL_NOT_ENABLED`, …) — the same error, with the
 * same `code`, the non-streaming call would have thrown.
 */
export async function streamAiResponse(
  req: AiResponseRequest,
  handlers: AiStreamHandlers = {},
  signal?: AbortSignal,
): Promise<AiResponse | null> {
  let completed: AiResponse | null = null;

  await postSse<Record<string, unknown>>({
    url: aiStreamUrl(),
    body: req,
    authorization: () => {
      const token = api.getAccessToken();
      return token ? `Bearer ${token}` : null;
    },
    reauthenticate: () => api.refreshToken(),
    signal,
    onFrame: (eventName, data) => {
      // The frame's `event:` line is authoritative for the type; the JSON
      // body carries the rest (and usually repeats `type`).
      const payload = typeof data === 'object' && data !== null ? data : {};
      const event = { ...payload, type: eventName } as AiStreamEvent;

      handlers.onEvent?.(event);
      switch (event.type) {
        case 'output_text.delta':
          handlers.onTextDelta?.(event.delta);
          break;
        case 'reasoning_summary.delta':
          handlers.onReasoningDelta?.(event.delta);
          break;
        case 'response.completed':
          completed = event.response;
          handlers.onCompleted?.(event.response);
          break;
        case 'error':
          handlers.onError?.(event.code, event.message);
          break;
        default:
          break;
      }
    },
  });

  return completed;
}

export async function createAiRun(req: AiResponseRequest): Promise<AiRunStarted> {
  return api.post<AiRunStarted>('/ai/runs', req);
}

export async function getAiRun(id: string): Promise<AiRun> {
  return api.get<AiRun>(`/ai/runs/${encodeURIComponent(id)}`);
}

export async function cancelAiRun(id: string): Promise<AiRun> {
  return api.post<AiRun>(`/ai/runs/${encodeURIComponent(id)}/cancel`);
}

// =============================================================================
// Images (#437) — always asynchronous: 202 { runId, jobId }, then poll the run
// =============================================================================

/** Mirrors `apps/api/src/ai/core/types/media.types.ts`. */
export const AI_IMAGES_MAX_N = 4;
export const AI_IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const;
export const AI_IMAGE_INPUT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const AI_IMAGE_MASK_MIME_TYPES = ['image/png'] as const;
/** The largest source image (or mask) an edit reads, in bytes (25 MiB). */
export const AI_IMAGE_INPUT_MAX_BYTES = 25 * 1024 * 1024;
export const AI_IMAGE_PROMPT_MAX_CHARS = 32_000;

/** `POST /ai/images` body. `model` is required — never inferred from the chat default. */
export interface AiImageGenerateRequest {
  provider?: string;
  model: string;
  prompt: string;
  /** `WIDTHxHEIGHT` or `auto`; the provider decides which sizes a model accepts. */
  size?: string;
  quality?: (typeof AI_IMAGE_QUALITIES)[number];
  background?: 'transparent' | 'opaque' | 'auto';
  outputFormat?: 'png' | 'jpeg' | 'webp';
  /** 1 to {@link AI_IMAGES_MAX_N}. */
  n?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
}

/** `POST /ai/images/edits` body: inputs are the caller's own, `ready` storage objects. */
export interface AiImageEditRequest extends AiImageGenerateRequest {
  imageStorageObjectIds: string[];
  maskStorageObjectId?: string;
}

export async function createAiImageRun(req: AiImageGenerateRequest): Promise<AiRunStarted> {
  return api.post<AiRunStarted>('/ai/images', req);
}

export async function createAiImageEditRun(req: AiImageEditRequest): Promise<AiRunStarted> {
  return api.post<AiRunStarted>('/ai/images/edits', req);
}

// =============================================================================
// Audio (#438 transcription, #439 speech) — always asynchronous runs
// =============================================================================

/** Recording types a transcription accepts (`audio/*` plus MP4/WebM video). */
export const AI_TRANSCRIPTION_INPUT_ACCEPT = 'audio/*,video/mp4,video/webm';
/** The largest recording the provider takes (OpenAI: 25 MiB). */
export const AI_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;
export const AI_TRANSCRIPTION_PROMPT_MAX_CHARS = 4_000;

/** `POST /ai/audio/transcriptions` body. */
export interface AiTranscriptionRequest {
  provider?: string;
  storageObjectId: string;
  model?: string;
  /** ISO-639-1 (`en`). */
  language?: string;
  prompt?: string;
  timestampGranularities?: ('segment' | 'word')[];
}

export const AI_SPEECH_FORMATS = ['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm'] as const;
export type AiSpeechFormat = (typeof AI_SPEECH_FORMATS)[number];
/** The longest text one speech run speaks. */
export const AI_SPEECH_INPUT_MAX_CHARS = 4_096;

/** `POST /ai/audio/speech` body. */
export interface AiSpeechRequest {
  provider?: string;
  input: string;
  model?: string;
  /** One of the model's `capabilities.voices`. */
  voice?: string;
  format?: AiSpeechFormat;
  instructions?: string;
  /** 0.25 to 4; 1 is normal. */
  speed?: number;
}

export async function createAiTranscriptionRun(req: AiTranscriptionRequest): Promise<AiRunStarted> {
  return api.post<AiRunStarted>('/ai/audio/transcriptions', req);
}

export async function createAiSpeechRun(req: AiSpeechRequest): Promise<AiRunStarted> {
  return api.post<AiRunStarted>('/ai/audio/speech', req);
}

// =============================================================================
// Realtime voice sessions (#449)
// =============================================================================

/** The longest `instructions` one realtime session accepts. */
export const AI_REALTIME_INSTRUCTIONS_MAX_CHARS = 16_000;

/** `POST /ai/realtime/sessions` body. Every field is optional. */
export interface AiRealtimeSessionRequest {
  provider?: string;
  /** A model with `realtime`; omitted, the first usable one. */
  model?: string;
  /** One of the model's `capabilities.voices`; omitted, its first. */
  voice?: string;
  /** Initial system instructions (at most {@link AI_REALTIME_INSTRUCTIONS_MAX_CHARS}). */
  instructions?: string;
}

/**
 * `POST /ai/realtime/sessions` → 201.
 *
 * ⚠ `clientSecret` is the provider's EPHEMERAL, single-session secret (never
 * the user's key — that stays on the server). It is still a credential: keep
 * it in a local variable for the one SDP exchange it exists for, and never
 * log, render or store it.
 */
export interface AiRealtimeSession {
  provider: string;
  model: string;
  voice: string;
  clientSecret: string;
  /** ISO 8601 — the deadline to CONNECT with `clientSecret`; a connected call continues. */
  expiresAt: string;
  /** Where the browser POSTs its SDP offer (`Content-Type: application/sdp`). */
  connectUrl: string;
}

export async function createRealtimeSession(req: AiRealtimeSessionRequest = {}): Promise<AiRealtimeSession> {
  return api.post<AiRealtimeSession>('/ai/realtime/sessions', req);
}

// =============================================================================
// Embeddings (#440) — synchronous
// =============================================================================

/** The most inputs one `POST /ai/embeddings` accepts; a larger batch is `AI_INVALID_REQUEST`. */
export const AI_EMBEDDINGS_MAX_INPUTS = 256;

/** `POST /ai/embeddings` body. `model` is required: vectors compare only within one model. */
export interface AiEmbeddingsRequest {
  provider?: string;
  model: string;
  input: string | string[];
  /** Shorten every vector, where the model supports it. */
  dimensions?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface AiEmbeddingsResponse {
  provider: string;
  model: string;
  /** The length of every vector. */
  dimensions: number;
  /** One per input, in input order. */
  vectors: number[][];
  usage: AiUsage;
}

export async function createAiEmbeddings(req: AiEmbeddingsRequest): Promise<AiEmbeddingsResponse> {
  return api.post<AiEmbeddingsResponse>('/ai/embeddings', req);
}

// =============================================================================
// Usage aggregates (#443 API, #444 UI)
// =============================================================================
//
// ⚠ EVERY usage type lives HERE and nowhere else, so a backend report that
// differs slightly from #443's contract is a one-place edit. Both routes answer
// the same shape; only the scope (everyone vs. the caller) and the allowed
// `groupBy` values differ.

/** `groupBy` values `GET /admin/ai/usage` accepts. */
export const AI_USAGE_ADMIN_GROUP_BY = ['day', 'user', 'model', 'provider', 'keySource'] as const;
export type AiUsageGroupBy = (typeof AI_USAGE_ADMIN_GROUP_BY)[number];

/** `groupBy` values `GET /ai/usage/me` accepts — a user sees only their own rows. */
export const AI_USAGE_MY_GROUP_BY = ['day', 'model'] as const;
export type AiMyUsageGroupBy = (typeof AI_USAGE_MY_GROUP_BY)[number];

/** The range options the UI offers. The API caps a range at 90 days. */
export const AI_USAGE_RANGE_OPTIONS = [7, 30, 90] as const;
export type AiUsageRangeDays = (typeof AI_USAGE_RANGE_OPTIONS)[number];
/** The API's own default when `from`/`to` are omitted. */
export const AI_USAGE_DEFAULT_RANGE_DAYS: AiUsageRangeDays = 30;

/** Counters shared by the totals block and each series entry. */
export interface AiUsageCounters {
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  /** Non-token units summed per key (`{ images: 2 }`, `{ audioSeconds: 31.4 }`). */
  units: Record<string, number>;
}

export interface AiUsageTotals extends AiUsageCounters {
  /** The subset paid for by the organisation's key (`keySource = 'org'`). */
  orgKeyRequests: number;
  orgKeyInputTokens: number;
  orgKeyOutputTokens: number;
}

/**
 * One group. `key` is the grouping value — `YYYY-MM-DD` for `day`, the user id
 * for `user`, the model id for `model`, and so on; `label` is what to show
 * (the email for `user`).
 */
export interface AiUsageSeriesEntry extends AiUsageCounters {
  key: string;
  label: string;
}

/** `GET /admin/ai/usage` and `GET /ai/usage/me`. */
export interface AiUsageReport<G extends string = AiUsageGroupBy> {
  range: { from: string; to: string };
  groupBy: G;
  totals: AiUsageTotals;
  series: AiUsageSeriesEntry[];
}

/** `from` / `to` as ISO dates (`YYYY-MM-DD`, inclusive, UTC). */
export interface AiUsageRange {
  from: string;
  to: string;
}

export interface AiUsageQuery extends Partial<AiUsageRange> {
  groupBy: AiUsageGroupBy;
  userId?: string;
  provider?: string;
  model?: string;
}

export interface AiMyUsageQuery extends Partial<AiUsageRange> {
  groupBy: AiMyUsageGroupBy;
}

/**
 * The last `days` days, ending today (UTC), as the inclusive ISO-date pair the
 * usage routes take. `now` is injectable for tests.
 */
export function aiUsageRangeForDays(days: number, now: Date = new Date()): AiUsageRange {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  return { from: toIsoDate(from), to: toIsoDate(to) };
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function usageQueryString(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query) as [string, unknown][]) {
    if (typeof value === 'string' && value !== '') params.set(key, value);
  }
  return params.toString();
}

/** `GET /admin/ai/usage` — `ai_config:read`. Not behind the AI kill switch. */
export async function getAiUsage(query: AiUsageQuery): Promise<AiUsageReport> {
  return api.get<AiUsageReport>(`${ADMIN}/usage?${usageQueryString(query)}`);
}

/** `GET /ai/usage/me` — `ai:use`, the caller's own usage only. */
export async function getMyAiUsage(
  query: AiMyUsageQuery,
): Promise<AiUsageReport<AiMyUsageGroupBy>> {
  return api.get<AiUsageReport<AiMyUsageGroupBy>>(`/ai/usage/me?${usageQueryString(query)}`);
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Drop blank optional strings so "blank means use the stored value" is
 * expressed by ABSENCE, which is what the API's schema reads — an empty
 * string would be a (too short) key.
 */
function stripBlank<T extends Record<string, string | undefined>>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(input) as [keyof T, string | undefined][]) {
    if (value !== undefined && value.trim() !== '') out[key] = value as T[keyof T];
  }
  return out;
}
