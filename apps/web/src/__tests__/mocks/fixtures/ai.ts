/**
 * Shared AI fixtures — issue #425, epic #419.
 *
 * The default MSW handlers (`../handlers.ts`) answer every Phase 1 AI route
 * from these, and the page stories built in parallel (#429 admin pages, #430
 * AI Keys, #434 Playground) import them rather than inventing their own, so
 * every AI test in the web app agrees on what a realistic answer looks like.
 * Shapes follow the API contracts in #428 (admin), #431 (keys/models) and
 * #433 (responses/runs); types are the web client's own (`services/ai.ts`).
 *
 * `GET /ai/config` answers DISABLED by default — a fresh deployment. A test
 * that needs AI on overrides it:
 *
 *   server.use(http.get('*\/api/ai/config', () => HttpResponse.json({ data: mockAiPublicConfigEnabled })));
 *
 * or, for components under the shell provider, renders with
 * `wrapperOptions: { aiEnabled: true }` (see `utils/test-utils.tsx`).
 *
 * Capability strings are the API's permanent `AI_CAPABILITIES` values
 * (`responses`, `vision_input`, `tools`, … — apps/api/src/ai/core/capabilities.ts),
 * never display names or legacy aliases.
 *
 * NO FIXTURE CARRIES A KEY. Masked hints only, exactly as the API answers.
 */
import type { StorageObject } from '../../../services/storage';
import type {
  AiAdminConfig,
  AiEmbeddingsResponse,
  AiImageRunOutput,
  AiSpeechRunOutput,
  AiTranscriptionRunOutput,
  AiModel,
  AiModelListResponse,
  AiProbeResult,
  AiPublicConfig,
  AiResponse,
  AiRun,
  AiStreamEvent,
  AiUsageCounters,
  AiUsageGroupBy,
  AiUsageReport,
  AiUsageSeriesEntry,
  UsableAiModel,
  UserAiKey,
} from '../../../services/ai';

const T0 = '2026-09-01T12:00:00.000Z';

export const mockAiPublicConfigDisabled: AiPublicConfig = {
  enabled: false,
  keyPolicy: 'byok',
  allowBackgroundRuns: false,
  providers: [],
};

export const mockAiPublicConfigEnabled: AiPublicConfig = {
  enabled: true,
  keyPolicy: 'byok_with_org_fallback',
  allowBackgroundRuns: true,
  providers: [{ id: 'openai', displayName: 'OpenAI', enabled: true, hasOrgKey: true, supportsPreviousResponseId: true }],
};

export const mockAiAdminConfig: AiAdminConfig = {
  enabled: false,
  keyPolicy: 'byok',
  logPromptContent: false,
  defaults: { maxOutputTokensCap: 4096, allowBackgroundRuns: true },
  hostedTools: {
    web_search: false,
    file_search: false,
    code_interpreter: false,
    image_generation: false,
    mcp: false,
    mcpAllowedHosts: [],
  },
  limits: {},
  providers: [
    {
      id: 'openai',
      displayName: 'OpenAI',
      registered: true,
      enabled: false,
      baseUrl: null,
      settingsFields: ['baseUrl'],
      apiVersion: null,
      apiStyle: null,
      deployments: null,
      requiresKey: null,
      keyStatus: {
        configured: true,
        hint: '••••abcd',
        updatedAt: T0,
        updatedByUserId: 'admin-user-id',
      },
      supportedCapabilities: [
        'responses',
        'vision_input',
        'structured_output',
        'tools',
        'reasoning',
        'streaming',
      ],
    },
  ],
  version: 3,
  updatedAt: T0,
  updatedBy: { id: 'admin-user-id', email: 'admin@example.com' },
};

/**
 * The admin view with the two #448 providers beside OpenAI: an Azure OpenAI
 * resource (every Azure field set) and an OpenAI-compatible server left at
 * its defaults, disabled and with no endpoint yet.
 */
export const mockAiAdminConfigWithCompatible: AiAdminConfig = {
  ...mockAiAdminConfig,
  providers: [
    ...mockAiAdminConfig.providers,
    {
      id: 'azure-openai',
      displayName: 'Azure OpenAI',
      registered: true,
      enabled: true,
      baseUrl: 'https://contoso.openai.azure.com',
      settingsFields: ['baseUrl', 'apiVersion', 'apiStyle', 'deployments'],
      apiVersion: '2024-10-21',
      apiStyle: null,
      deployments: { 'gpt-4o': 'contoso-gpt-4o' },
      requiresKey: null,
      keyStatus: { configured: true, hint: '••••az12', updatedAt: T0, updatedByUserId: 'admin-user-id' },
      supportedCapabilities: ['responses', 'structured_output', 'tools', 'streaming'],
    },
    {
      id: 'openai-compatible',
      displayName: 'OpenAI-compatible',
      registered: true,
      enabled: false,
      baseUrl: null,
      settingsFields: ['baseUrl', 'apiStyle', 'requiresKey'],
      apiVersion: null,
      apiStyle: null,
      deployments: null,
      requiresKey: null,
      keyStatus: { configured: false, hint: null, updatedAt: null, updatedByUserId: null },
      supportedCapabilities: ['responses', 'tools', 'streaming'],
    },
  ],
};

/** `GET /ai/config` with a keyless OpenAI-compatible server beside OpenAI (#448). */
export const mockAiPublicConfigKeyless: AiPublicConfig = {
  enabled: true,
  keyPolicy: 'byok',
  allowBackgroundRuns: true,
  providers: [
    { id: 'openai', displayName: 'OpenAI', enabled: true, hasOrgKey: false, supportsPreviousResponseId: true, requiresKey: true },
    {
      id: 'openai-compatible',
      displayName: 'Local Ollama',
      enabled: true,
      hasOrgKey: false,
      supportsPreviousResponseId: false,
      requiresKey: false,
    },
  ],
};

export const mockAiProbeResultPassed: AiProbeResult = {
  success: true,
  provider: 'openai',
  usedStoredKey: true,
  modelCount: 42,
  smokeModelId: null,
  checks: [
    { id: 'credentials', label: 'Credentials', status: 'passed', code: 'ok', detail: 'Key accepted', error: null },
    { id: 'list_models', label: 'List models', status: 'passed', code: 'ok', detail: '42 models', error: null },
    {
      id: 'responses_smoke',
      label: 'Responses smoke test',
      status: 'skipped',
      code: 'not_attempted',
      detail: 'No cheap enabled text model',
      error: null,
    },
  ],
  attemptedAt: T0,
};

export const mockAiProbeResultFailed: AiProbeResult = {
  success: false,
  provider: 'openai',
  usedStoredKey: false,
  modelCount: null,
  smokeModelId: null,
  checks: [
    {
      id: 'credentials',
      label: 'Credentials',
      status: 'failed',
      code: 'AI_KEY_INVALID',
      detail: 'The provider rejected this key',
      error: 'Incorrect API key provided',
    },
    {
      id: 'list_models',
      label: 'List models',
      status: 'skipped',
      code: 'not_attempted',
      detail: 'Skipped — the key was refused',
      error: null,
    },
    {
      id: 'responses_smoke',
      label: 'Responses smoke test',
      status: 'skipped',
      code: 'not_attempted',
      detail: 'Skipped — the key was refused',
      error: null,
    },
  ],
  attemptedAt: T0,
};

export const mockAiModels: AiModel[] = [
  {
    id: 'model-1',
    provider: 'openai',
    modelId: 'gpt-5-mini',
    displayName: 'GPT-5 mini',
    capabilities: {
      capabilities: ['responses', 'vision_input', 'structured_output', 'tools', 'reasoning', 'streaming'],
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
      contextWindow: 400000,
      maxOutputTokens: 128000,
    },
    capabilitySource: 'catalog',
    enabled: true,
    contextWindow: 400000,
    maxOutputTokens: 128000,
    discoveredAt: T0,
    lastSeenAt: T0,
    deprecatedAt: null,
    updatedAt: T0,
    updatedByUserId: 'admin-user-id',
  },
  {
    id: 'model-2',
    provider: 'openai',
    modelId: 'text-embedding-3-small',
    displayName: null,
    capabilities: {
      capabilities: ['embeddings'],
      inputModalities: ['text'],
      outputModalities: ['embedding'],
    },
    capabilitySource: 'catalog',
    enabled: false,
    contextWindow: null,
    maxOutputTokens: null,
    discoveredAt: T0,
    lastSeenAt: T0,
    deprecatedAt: null,
    updatedAt: T0,
    updatedByUserId: null,
  },
  {
    id: 'model-3',
    provider: 'openai',
    modelId: 'ft:custom-model',
    displayName: null,
    // Unclassified: the provider's classifier did not recognise the id.
    capabilities: null,
    capabilitySource: 'unclassified',
    enabled: false,
    contextWindow: null,
    maxOutputTokens: null,
    discoveredAt: T0,
    lastSeenAt: T0,
    deprecatedAt: null,
    updatedAt: T0,
    updatedByUserId: null,
  },
];

export const mockAiModelList: AiModelListResponse = {
  items: mockAiModels,
  total: mockAiModels.length,
  page: 1,
  pageSize: 20,
  totalPages: 1,
};

export const mockUserAiKeys: UserAiKey[] = [
  {
    provider: 'openai',
    configured: true,
    hint: '••••wxyz',
    verifiedAt: T0,
    lastErrorCode: null,
    reachableModelCount: 12,
    reachableCheckedAt: T0,
  },
];

export const mockUsableAiModels: UsableAiModel[] = [
  {
    provider: 'openai',
    modelId: 'gpt-5-mini',
    displayName: 'GPT-5 mini',
    capabilities: mockAiModels[0].capabilities!,
    keySource: 'user',
  },
];

export const mockAiResponse: AiResponse = {
  id: 'resp_123',
  provider: 'openai',
  model: 'gpt-5-mini',
  output: [{ type: 'message', text: 'Hello! How can I help?' }],
  outputText: 'Hello! How can I help?',
  usage: { inputTokens: 9, outputTokens: 7 },
  finishReason: 'stop',
  providerRequestId: 'req_abc',
};

/** The frames `POST /ai/responses/stream` sends for {@link mockAiResponse}, in order. */
export const mockAiStreamEvents: AiStreamEvent[] = [
  { type: 'response.created', id: 'resp_123' },
  { type: 'output_text.delta', delta: 'Hello! ' },
  { type: 'output_text.delta', delta: 'How can I help?' },
  { type: 'output_item.done', item: { type: 'message', text: 'Hello! How can I help?' } },
  { type: 'response.completed', response: mockAiResponse },
];

/** Serialise events the way the API does: `event: <type>\ndata: <json>\n\n`. */
export function toSseBody(events: AiStreamEvent[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

export const mockAiRun: AiRun = {
  id: 'run_1',
  status: 'succeeded',
  provider: 'openai',
  modelId: 'gpt-5-mini',
  output: mockAiResponse,
  errorCode: null,
  errorMessage: null,
  createdAt: T0,
  completedAt: T0,
};

// -----------------------------------------------------------------------------
// AI Keys page states (#430). Added alongside the #425 fixtures above rather
// than changing them. These use the API's real capability vocabulary
// (`responses`, `vision_input`, … — `apps/api/src/ai/core/capabilities.ts`),
// which the default picker filters on.
// -----------------------------------------------------------------------------

/** AI on, strict BYOK: no organisation fallback. */
export const mockAiPublicConfigByok: AiPublicConfig = {
  enabled: true,
  keyPolicy: 'byok',
  allowBackgroundRuns: true,
  providers: [{ id: 'openai', displayName: 'OpenAI', enabled: true, hasOrgKey: false, supportsPreviousResponseId: true }],
};

/** AI on, but no provider enabled yet. */
export const mockAiPublicConfigNoProviders: AiPublicConfig = {
  enabled: true,
  keyPolicy: 'byok',
  allowBackgroundRuns: true,
  providers: [{ id: 'openai', displayName: 'OpenAI', enabled: false, hasOrgKey: false, supportsPreviousResponseId: true }],
};

/** The caller has not added a key for OpenAI. */
export const mockUserAiKeysNone: UserAiKey[] = [
  {
    provider: 'openai',
    configured: false,
    hint: null,
    verifiedAt: null,
    lastErrorCode: null,
    reachableModelCount: 0,
    reachableCheckedAt: null,
  },
];

/** A stored key the weekly recheck found revoked. */
export const mockUserAiKeysErrored: UserAiKey[] = [
  { ...mockUserAiKeys[0], verifiedAt: null, lastErrorCode: 'AI_KEY_INVALID' },
];

/** Two responses-capable models (one via the org key) and one embeddings model. */
export const mockUsableAiModelsMixed: UsableAiModel[] = [
  {
    provider: 'openai',
    modelId: 'gpt-5-mini',
    displayName: 'GPT-5 mini',
    capabilities: {
      capabilities: ['responses', 'reasoning', 'structured_output', 'streaming', 'vision_input'],
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
    },
    keySource: 'user',
  },
  {
    provider: 'openai',
    modelId: 'gpt-5',
    displayName: 'GPT-5',
    capabilities: {
      capabilities: ['responses', 'streaming'],
      inputModalities: ['text'],
      outputModalities: ['text'],
    },
    keySource: 'org',
  },
  {
    provider: 'openai',
    modelId: 'text-embedding-3-small',
    displayName: null,
    capabilities: {
      capabilities: ['embeddings'],
      inputModalities: ['text'],
      outputModalities: ['embedding'],
    },
    keySource: 'user',
  },
];

/**
 * The error body `PUT /ai/keys/:provider` answers when the provider refuses
 * the key: generic top-level `code`, AI code in `details.reason`.
 */
export const mockAiKeyInvalidErrorBody = {
  statusCode: 400,
  code: 'BAD_REQUEST',
  message: 'The provider rejected this API key',
  details: { reason: 'AI_KEY_INVALID' },
};

// ---------------------------------------------------------------------------
// AI Playground (#434). Capability strings here are the API's permanent
// `AI_CAPABILITIES` values (`responses`, `reasoning`, `structured_output`,
// `streaming`, …), which is what the playground gates its controls on.
// ---------------------------------------------------------------------------

/** A reasoning model: effort + summary, structured output, streaming; no temperature. */
export const mockPlaygroundReasoningModel: UsableAiModel = {
  provider: 'openai',
  modelId: 'gpt-5-mini',
  displayName: 'GPT-5 mini',
  capabilities: {
    capabilities: ['responses', 'reasoning', 'structured_output', 'streaming', 'tools', 'vision_input'],
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    contextWindow: 400000,
    maxOutputTokens: 128000,
  },
  keySource: 'user',
};

/** A plain chat model: temperature, streaming; no reasoning, no structured output. */
export const mockPlaygroundChatModel: UsableAiModel = {
  provider: 'openai',
  modelId: 'gpt-4.1-mini',
  displayName: 'GPT-4.1 mini',
  capabilities: {
    capabilities: ['responses', 'streaming'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    maxOutputTokens: 32768,
  },
  keySource: 'org',
};

/** Usable, but cannot answer text prompts — listed disabled in the picker. */
export const mockPlaygroundEmbeddingsModel: UsableAiModel = {
  provider: 'openai',
  modelId: 'text-embedding-3-small',
  displayName: null,
  capabilities: { capabilities: ['embeddings'], inputModalities: ['text'], outputModalities: ['embedding'] },
  keySource: 'user',
};

/**
 * A Claude model (#446): Anthropic is stateless, so a follow-up turn resends
 * the conversation rather than naming `previousResponseId`. Not part of
 * `mockPlaygroundModels`; a test serves it together with
 * `mockAiPublicConfigWithAnthropic`.
 */
export const mockPlaygroundClaudeModel: UsableAiModel = {
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-5',
  displayName: 'Claude Sonnet 4.5',
  capabilities: {
    capabilities: ['responses', 'streaming'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    maxOutputTokens: 64000,
  },
  keySource: 'user',
};

/** AI on with OpenAI (chains by id) and Anthropic (cannot chain, #446). */
export const mockAiPublicConfigWithAnthropic: AiPublicConfig = {
  enabled: true,
  keyPolicy: 'byok',
  allowBackgroundRuns: true,
  providers: [
    { id: 'openai', displayName: 'OpenAI', enabled: true, hasOrgKey: false, supportsPreviousResponseId: true },
    { id: 'anthropic', displayName: 'Anthropic', enabled: true, hasOrgKey: false, supportsPreviousResponseId: false },
  ],
};

export const mockPlaygroundModels: UsableAiModel[] = [
  mockPlaygroundReasoningModel,
  mockPlaygroundChatModel,
  mockPlaygroundEmbeddingsModel,
];

export const mockAiReasoningResponse: AiResponse = {
  id: 'resp_reason_1',
  provider: 'openai',
  model: 'gpt-5-mini',
  output: [
    { type: 'reasoning', summary: ['Comparing both options.'] },
    { type: 'message', text: 'Option B is cheaper.' },
  ],
  outputText: 'Option B is cheaper.',
  usage: { inputTokens: 20, outputTokens: 6, reasoningTokens: 64 },
  finishReason: 'stop',
};

/** A reasoning stream: summary deltas first, then the answer. */
export const mockAiReasoningStreamEvents: AiStreamEvent[] = [
  { type: 'response.created', id: 'resp_reason_1' },
  { type: 'reasoning_summary.delta', delta: 'Comparing ' },
  { type: 'reasoning_summary.delta', delta: 'both options.' },
  { type: 'output_text.delta', delta: 'Option B ' },
  { type: 'output_text.delta', delta: 'is cheaper.' },
  { type: 'response.completed', response: mockAiReasoningResponse },
];

export const mockAiStructuredResponse: AiResponse = {
  id: 'resp_struct_1',
  provider: 'openai',
  model: 'gpt-5-mini',
  output: [
    {
      type: 'message',
      text: '{"name":"Dana Ruiz","email":"dana@acme.test","phone":"+1 555 0100","company":"Acme Corp"}',
    },
  ],
  outputText: '{"name":"Dana Ruiz","email":"dana@acme.test","phone":"+1 555 0100","company":"Acme Corp"}',
  parsed: { name: 'Dana Ruiz', email: 'dana@acme.test', phone: '+1 555 0100', company: 'Acme Corp' },
  usage: { inputTokens: 40, outputTokens: 30 },
  finishReason: 'stop',
};

/** An API error body as the global filter shapes it: generic `code`, AI code in `details.reason`. */
export function aiErrorBody(reason: string, message = 'AI request failed', extra: Record<string, unknown> = {}) {
  return { code: 'FORBIDDEN', message, details: { reason, ...extra } };
}

// =============================================================================
// Usage aggregates (#443 contract, #444 UI)
// =============================================================================

const USAGE_RANGE = { from: '2026-08-28', to: '2026-09-26' };

function usageEntry(key: string, label: string, counters: Partial<AiUsageCounters>): AiUsageSeriesEntry {
  return {
    key,
    label,
    requests: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    units: {},
    ...counters,
  };
}

/** Totals every populated usage fixture agrees on (120 requests, 6 failed). */
export const mockAiUsageTotals: AiUsageReport['totals'] = {
  requests: 120,
  failed: 6,
  inputTokens: 48_000,
  outputTokens: 12_500,
  reasoningTokens: 3_200,
  cachedInputTokens: 9_000,
  units: { images: 4 },
  orgKeyRequests: 30,
  orgKeyInputTokens: 11_000,
  orgKeyOutputTokens: 2_400,
};

const USAGE_SERIES: Record<AiUsageGroupBy, AiUsageSeriesEntry[]> = {
  day: [
    usageEntry('2026-09-24', '2026-09-24', { requests: 40, failed: 2, inputTokens: 16_000, outputTokens: 4_000 }),
    usageEntry('2026-09-25', '2026-09-25', { requests: 0 }),
    usageEntry('2026-09-26', '2026-09-26', { requests: 80, failed: 4, inputTokens: 32_000, outputTokens: 8_500 }),
  ],
  user: [
    usageEntry('user-dana', 'dana@acme.test', { requests: 90, failed: 5, inputTokens: 36_000, outputTokens: 9_000 }),
    usageEntry('user-lee', 'lee@acme.test', { requests: 30, failed: 1, inputTokens: 12_000, outputTokens: 3_500 }),
  ],
  model: [
    usageEntry('gpt-5-mini', 'gpt-5-mini', { requests: 100, failed: 5, inputTokens: 40_000, outputTokens: 10_000 }),
    usageEntry('gpt-5', 'gpt-5', { requests: 20, failed: 1, inputTokens: 8_000, outputTokens: 2_500, reasoningTokens: 3_200 }),
  ],
  provider: [usageEntry('openai', 'OpenAI', { requests: 120, failed: 6, inputTokens: 48_000, outputTokens: 12_500 })],
  keySource: [
    usageEntry('user', 'user', { requests: 90, failed: 4, inputTokens: 37_000, outputTokens: 10_100 }),
    usageEntry('org', 'org', { requests: 30, failed: 2, inputTokens: 11_000, outputTokens: 2_400 }),
    // A keyless OpenAI-compatible server (#448): nobody's key paid.
    usageEntry('none', 'none', { requests: 4, inputTokens: 900, outputTokens: 300 }),
  ],
};

/** A populated report for any grouping — the default MSW answer. */
export function mockAiUsageReport<G extends AiUsageGroupBy>(groupBy: G): AiUsageReport<G> {
  return { range: USAGE_RANGE, groupBy, totals: mockAiUsageTotals, series: USAGE_SERIES[groupBy] };
}

/** Nothing recorded in the range. */
export function mockAiUsageEmpty<G extends AiUsageGroupBy>(groupBy: G): AiUsageReport<G> {
  return {
    range: USAGE_RANGE,
    groupBy,
    totals: {
      requests: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      units: {},
      orgKeyRequests: 0,
      orgKeyInputTokens: 0,
      orgKeyOutputTokens: 0,
    },
    series: [],
  };
}

// =============================================================================
// Playground modes (#445) — image runs (#437 contract) and the storage objects
// they read and write. Capabilities are the API's permanent strings; the
// model ids are deliberately NOT what the playground keys on.
// =============================================================================

/** Generates and edits images. */
export const mockPlaygroundImageModel: UsableAiModel = {
  provider: 'openai',
  modelId: 'gpt-image-1',
  displayName: 'GPT Image 1',
  capabilities: {
    capabilities: ['image_generation', 'image_edit'],
    inputModalities: ['text', 'image'],
    outputModalities: ['image'],
  },
  keySource: 'user',
};

/** Generates, but cannot edit. */
export const mockPlaygroundImageGenerateOnlyModel: UsableAiModel = {
  provider: 'openai',
  modelId: 'dall-e-3',
  displayName: 'DALL·E 3',
  capabilities: { capabilities: ['image_generation'], inputModalities: ['text'], outputModalities: ['image'] },
  keySource: 'org',
};

/** Every playground mode that has a panel, plus chat. */
export const mockPlaygroundAllModeModels: UsableAiModel[] = [
  ...mockPlaygroundModels,
  mockPlaygroundImageModel,
  mockPlaygroundImageGenerateOnlyModel,
];

export const mockAiImageRunOutput: AiImageRunOutput = {
  type: 'images',
  provider: 'openai',
  model: 'gpt-image-1',
  storageObjectIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
  images: [
    {
      storageObjectId: '11111111-1111-4111-8111-111111111111',
      mimeType: 'image/png',
      size: 204800,
      revisedPrompt: 'A watercolour lighthouse at dusk, soft light',
    },
    { storageObjectId: '22222222-2222-4222-8222-222222222222', mimeType: 'image/png', size: 198000 },
  ],
  usage: { inputTokens: 12 },
};

/** Run ids the default handlers answer as image runs start with this. */
export const MOCK_IMAGE_RUN_PREFIX = 'run_img';

export const mockAiImageRun: AiRun = {
  id: 'run_img_1',
  status: 'succeeded',
  provider: 'openai',
  modelId: 'gpt-image-1',
  output: mockAiImageRunOutput,
  errorCode: null,
  errorMessage: null,
  createdAt: T0,
  completedAt: T0,
};

/** A just-uploaded object: `processing` until post-processing marks it `ready`. */
export function mockStorageObject(overrides: Partial<StorageObject> = {}): StorageObject {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'photo.png',
    size: '1024',
    mimeType: 'image/png',
    status: 'processing',
    metadata: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/** The signed URL the default handler answers for an object — never a real host. */
export function mockSignedUrl(id: string): string {
  return `https://storage.example.test/objects/${id}?signature=test`;
}

// -----------------------------------------------------------------------------
// Embeddings (#440 contract)
// -----------------------------------------------------------------------------

/**
 * A deterministic `POST /ai/embeddings` answer: one vector per input, each
 * derived from the text's character codes so identical texts are identical
 * vectors (similarity 1) and different texts differ. Default length 16.
 */
export function mockAiEmbeddingsFor(input: string | string[], dimensions = 16): AiEmbeddingsResponse {
  const inputs = Array.isArray(input) ? input : [input];
  const vectors = inputs.map((text) =>
    Array.from({ length: dimensions }, (_unused, index) => {
      const code = text.charCodeAt(index % Math.max(1, text.length)) || 1;
      return Math.round(Math.sin(code * (index + 1)) * 10_000) / 10_000;
    }),
  );
  return {
    provider: 'openai',
    model: mockPlaygroundEmbeddingsModel.modelId,
    dimensions,
    vectors,
    usage: { inputTokens: inputs.length * 4 },
  };
}

// -----------------------------------------------------------------------------
// Chat attachments (#441 contract, #445 UI): capability AND input modality.
// -----------------------------------------------------------------------------

/** Reads images and files: both attach buttons. */
export const mockPlaygroundFileModel: UsableAiModel = {
  provider: 'openai',
  modelId: 'gpt-5',
  displayName: 'GPT-5',
  capabilities: {
    capabilities: ['responses', 'streaming', 'vision_input', 'file_input'],
    inputModalities: ['text', 'image', 'file'],
    outputModalities: ['text'],
  },
  keySource: 'user',
};

// -----------------------------------------------------------------------------
// Hosted tools (#442 contract, #445 UI)
// -----------------------------------------------------------------------------

/** AI on, with every hosted tool type switched on by the administrator. */
export const mockAiPublicConfigHostedTools: AiPublicConfig = {
  ...mockAiPublicConfigEnabled,
  hostedTools: { web_search: true, file_search: true, code_interpreter: true, image_generation: true, mcp: true },
};

/** A text model that can run provider-hosted tools. */
export const mockPlaygroundHostedToolsModel: UsableAiModel = {
  provider: 'openai',
  modelId: 'gpt-5.1',
  displayName: 'GPT-5.1',
  capabilities: {
    capabilities: ['responses', 'streaming', 'hosted_tools'],
    inputModalities: ['text'],
    outputModalities: ['text'],
  },
  keySource: 'user',
};

export const HOSTED_IMAGE_OBJECT_ID = '88888888-8888-4888-8888-888888888888';

/** A response exercising every rendered hosted-tool result, plus citations. */
export const mockAiHostedToolsResponse: AiResponse = {
  id: 'resp_tools_1',
  provider: 'openai',
  model: 'gpt-5.1',
  output: [
    {
      type: 'hosted_tool_call',
      id: 'ws_1',
      tool: 'web_search',
      status: 'completed',
      result: { queries: ['lighthouse history'], sources: [{ url: 'https://example.org/lighthouses' }] },
    },
    {
      type: 'hosted_tool_call',
      id: 'ci_1',
      tool: 'code_interpreter',
      status: 'completed',
      result: { code: 'print(2 + 2)', containerId: 'cntr_1', outputs: [{ type: 'logs', logs: '4' }] },
    },
    {
      type: 'hosted_tool_call',
      id: 'ig_1',
      tool: 'image_generation',
      status: 'completed',
      result: { storageObjectId: HOSTED_IMAGE_OBJECT_ID, mimeType: 'image/png', revisedPrompt: 'A red lighthouse' },
    },
    {
      type: 'hosted_tool_call',
      id: 'ig_2',
      tool: 'image_generation',
      status: 'completed',
      result: { storageObjectId: null, storageError: 'AI_STORAGE_UNAVAILABLE' },
    },
    {
      type: 'message',
      text: 'The first lighthouse was the Pharos of Alexandria.',
      citations: [
        { url: 'https://example.org/pharos', title: 'Pharos of Alexandria', startIndex: 4, endIndex: 20 },
        { url: 'javascript:alert(1)', title: 'Suspicious source', startIndex: 0, endIndex: 3 },
      ],
    },
  ],
  outputText: 'The first lighthouse was the Pharos of Alexandria.',
  usage: { inputTokens: 30, outputTokens: 12 },
  finishReason: 'stop',
};

// -----------------------------------------------------------------------------
// Audio (#438 transcription, #439 speech contracts; #445 UI)
// -----------------------------------------------------------------------------

export const mockPlaygroundTranscriptionModel: UsableAiModel = {
  provider: 'openai',
  modelId: 'whisper-1',
  displayName: 'Whisper',
  capabilities: { capabilities: ['audio_transcription'], inputModalities: ['audio'], outputModalities: ['text'] },
  keySource: 'user',
};

export const mockPlaygroundSpeechModel: UsableAiModel = {
  provider: 'openai',
  modelId: 'gpt-4o-mini-tts',
  displayName: 'GPT-4o mini TTS',
  capabilities: {
    capabilities: ['audio_speech'],
    inputModalities: ['text'],
    outputModalities: ['audio'],
    voices: ['alloy', 'coral', 'verse'],
  },
  keySource: 'user',
};

export const RECORDING_OBJECT_ID = '99999999-9999-4999-8999-999999999999';
export const SPEECH_OBJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const mockAiTranscriptionRunOutput: AiTranscriptionRunOutput = {
  type: 'transcription',
  provider: 'openai',
  model: 'whisper-1',
  storageObjectId: RECORDING_OBJECT_ID,
  text: 'Hello and welcome. Today we talk about lighthouses.',
  language: 'english',
  durationSeconds: 75.4,
  segments: [
    { startSeconds: 0, endSeconds: 4.2, text: 'Hello and welcome.' },
    { startSeconds: 64.5, endSeconds: 75.4, text: 'Today we talk about lighthouses.' },
  ],
  usage: {},
};

export const mockAiSpeechRunOutput: AiSpeechRunOutput = {
  type: 'speech',
  provider: 'openai',
  model: 'gpt-4o-mini-tts',
  storageObjectId: SPEECH_OBJECT_ID,
  mimeType: 'audio/mpeg',
  size: 48_000,
  format: 'mp3',
  voice: 'coral',
  characters: 11,
  aiGenerated: true,
  usage: {},
};

/** A succeeded run carrying `output` (an image, transcription or speech run). */
export function mockMediaRun(id: string, output: AiRun['output'], status: AiRun['status'] = 'succeeded'): AiRun {
  return {
    id,
    status,
    provider: 'openai',
    modelId: 'media-model',
    output: status === 'succeeded' ? output : null,
    errorCode: null,
    errorMessage: null,
    createdAt: T0,
    completedAt: status === 'succeeded' ? T0 : null,
  };
}
