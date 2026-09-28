# AI Platform

> **Status:** shipped · **Code:** `apps/api/src/ai/`, `apps/web/src/pages/AiPlaygroundPage.tsx`, `apps/web/src/pages/Admin/AiConfigPage.tsx`, `AiModelsPage.tsx`, `AiUsagePage.tsx` · **API:** `/api/ai/*`, `/api/admin/ai/*` (see `/api/docs`) · **Admin UI:** `/admin/settings/ai`, `/admin/settings/ai/models`, `/admin/settings/ai/usage`; user `/settings/ai`; Playground `/ai` · **Runbook:** [ai-configuration.md](../runbooks/ai-configuration.md) · **Recipe:** [apps/api/src/ai/README.md](../../apps/api/src/ai/README.md)

The AI platform gives an app built from this template one admin-governed,
bring-your-own-key (BYOK), multi-provider AI capability. Feature code injects
`AiService`, calls `forUser(userId)`, and gets responses, streaming,
structured output, tool calling, embeddings, images, audio and realtime voice
sessions. Every call runs one gate pipeline that enforces the kill switch,
provider and model enablement, capabilities, the key policy and rate limits,
and records a usage row. Provider keys never leave the server. Five providers
ship: `openai`, `anthropic`, `gemini`, `azure-openai` and `openai-compatible`.

## 1. Purpose

A fork gets AI it can switch on per deployment without writing SDK code,
storing keys, or building governance. Configuration happens at runtime in the
admin UI, with no restart. There are no AI environment variables.

Seven gates govern every call, in this order:

1. **The platform is off by default.** `ai.enabled` starts `false` (§2.19).
2. **The operator chooses a key policy:** `byok` (default) or
   `byok_with_org_fallback` (§2.2).
3. **The operator enables providers.** A registered adapter is not reachable
   until `providers.<id>.enabled` is true.
4. **The operator may store an admin (org) key per provider.** It discovers
   models, and serves users only under the fallback policy.
5. **The operator curates the model catalog.** Discovery never enables a
   model; only an administrator does (§2.17).
6. **Each user brings their own key**, verified and checked for which models
   it can reach (§2.18).
7. **A user calls only what they may and can use:** they hold `ai:use`, and
   the model is admin-enabled and reachable with the resolved key.

What it is not:

- **No browser-to-provider calls** and no keys in the browser. The one
  exception is a realtime session's ephemeral secret (§2.15).
- **No vector storage or search.** `embed` returns vectors; storing and
  querying them (for example with `pgvector`) is the fork's job.
- **No worker-node execution.** Every `ai.*` job is server-only, permanently.
- **No function tools over HTTP.** They run server code, so only in-process
  `runTools()` accepts them.

## 2. How it works

### 2.1 Configuration model

Configuration lives in four places, split by sensitivity:

| Where | Holds |
|---|---|
| `ai` namespace of `system_settings` | Everything non-secret (below) |
| `CredentialsService`, purpose `'ai'`, name `<providerId>` | The admin (org) key per provider, encrypted, with a masked hint |
| `user_ai_keys` table | One BYOK key per `(userId, provider)`, encrypted under cipher purpose `'ai_user_key'`, cascade-deleted with the user |
| `user_settings.ai` | `{ defaultModel: { provider, modelId } \| null }` |

```ts
// ai namespace (defaults in comments)
{ enabled: boolean /*false*/,
  keyPolicy: 'byok' | 'byok_with_org_fallback' /*'byok'*/,   // AI_KEY_POLICIES
  providers: {
    openai:    { enabled /*false*/, baseUrl? },
    anthropic: { enabled /*false*/, baseUrl? },
    gemini:    { enabled /*false*/, baseUrl? },
    'azure-openai': { enabled, baseUrl? /*https*/, apiVersion?, apiStyle?: 'responses'|'chat_completions',
                      deployments?: Record<modelId, deploymentName> },
    'openai-compatible': { enabled, baseUrl? /*http(s)*/, apiStyle?, requiresKey?: boolean /*true*/ } },
  defaults: { maxOutputTokensCap?: number, allowBackgroundRuns: boolean /*true*/,
              allowRealtime: boolean /*false*/ },
  logPromptContent: boolean /*false*/,
  usageRetentionDays: number /*180, 1–3650*/,
  hostedTools: { web_search, file_search, code_interpreter, image_generation, mcp /*all false*/,
                 mcpAllowedHosts: string[] },
  limits: { perUser?, orgKey?, perModel? } /*{} — unlimited, §2.22*/ }
```

- Provider ids are `AI_PROVIDER_IDS` in
  `apps/api/src/common/schemas/settings.schema.ts`.
- The admin key is never in `system_settings`, because
  `GET /api/system-settings` returns the whole document.
- The two cipher purposes (`'ai'`, `'ai_user_key'`) derive different
  sub-keys, so neither store can decrypt the other's ciphertext.
- `providerCallSettings(slot)` (`ai-config.service.ts`) hands every
  provider-specific field to the adapter as `AiCallContext.providerSettings`.

### 2.2 Keys and key resolution

Two keys can pay for a call:

- **Admin (org) key:** one per provider. Catalog discovery and the admin
  connection test use it. It serves user requests **only** under
  `byok_with_org_fallback`.
- **User (BYOK) key:** one per user and provider, verified and checked for
  reachable models when it is set.

`AiKeyResolver.resolve(userId, provider)` is the only implementation of the
rule. Every caller goes through it:

```ts
resolve(userId, provider): Promise<{ apiKey: string; keySource: 'user' | 'org' | 'none' }>
// 0. provider slot has requiresKey: false            -> { none }  (AI_KEYLESS_API_KEY marker)
// 1. user key exists                                 -> { user }
// 2. 'byok_with_org_fallback' AND org key exists     -> { org }
// 3. otherwise                                       -> throw AiError('AI_KEY_REQUIRED')
```

- **Under `byok` the org key is never returned.** This is the platform's
  core security invariant.
- **Rule 0 is an administrator's opt-in**, only on the `openai-compatible`
  slot, for a self-hosted server that authenticates nobody. No key is read,
  the adapter sends no credential, and usage records `keySource: 'none'`. It
  holds under either policy, since nothing is billed.
- `ai_usage_events.keySource` also has `'admin_discovery'` for the platform's
  own catalog calls. The resolver never returns it.

**Keys never leave the server.** No route, log line, span, `AiError`,
`ai_usage_events` row or `ai_runs.request` row carries key material.
`apiKey` exists in `ai.service.ts` only between key resolution and the adapter
call. The single exception to "no credential reaches the browser" is the
realtime session's **ephemeral** secret (§2.15), minted with the key and
never the key itself.

### 2.3 Capabilities and ports

```ts
export const AI_CAPABILITIES = ['responses','reasoning','tools','hosted_tools','structured_output','streaming',
  'vision_input','file_input','image_generation','image_edit','audio_transcription','audio_speech',
  'embeddings','realtime'] as const;
```

A model has capabilities (stored per `ai_models` row). A provider has
**ports**: optional members of `AiProviderAdapter`.

```ts
export interface AiProviderAdapter {
  readonly id: string;                       // permanent once referenced
  readonly displayName: string;
  listModels(ctx): Promise<AiDiscoveredModel[]>;
  verifyKey(ctx): Promise<AiKeyVerification>;
  classifyModel(modelId, metadata?): AiModelCapabilities | null;   // null => unclassified
  readonly responses?: AiResponsesPort;
  readonly images?: AiImagesPort;
  readonly audio?: AiAudioPort;
  readonly embeddings?: AiEmbeddingsPort;
  readonly realtime?: AiRealtimePort;
  readonly supportsPreviousResponseId?: boolean;   // absent = true (§2.10)
  readonly supportsHostedTools?: boolean;          // absent = true
  readonly fileInputStrategy?: { image, file };    // absent = no stored inputs (§2.9)
}
```

- **Presence is the declaration.** There is no `supportedCapabilities`
  array. `AiProviderRegistry.supports(id, cap)` derives the answer from port
  presence, the same idiom as `JobHandler.nodeResultSchema`.
- A call needs the capability on the model **and** the port on the provider.
- `AiModelCapabilities` also carries `reasoningEfforts`, `contextWindow`,
  `maxOutputTokens`, `inputModalities` and `voices` (for `audio_speech` and
  `realtime` models). When a model lists no voices, the port's static
  `voices` is the fallback.

### 2.4 The gate pipeline

`AiService` (`apps/api/src/ai/runtime/ai.service.ts`) runs every call through
the same steps. Each operation has its own `prepare…` step and shares the key
and usage steps.

| Step | Gate | Refusal |
|---|---|---|
| 1 | Kill switch | `AI_DISABLED` |
| 2 | Provider enabled and registered; `previousResponseId` on a provider that cannot chain | `AI_PROVIDER_DISABLED`, `AI_CAPABILITY_UNSUPPORTED` |
| 2b | Hosted tools: shape, admin switch, MCP host allowlist | `AI_TOOL_DISABLED` |
| 3 | `UsableModelsService.assertUsable`: model enabled, capabilities the request's shape needs, key exists, key reaches model | `AI_MODEL_NOT_ENABLED`, `AI_CAPABILITY_UNSUPPORTED`, `AI_KEY_REQUIRED`, `AI_MODEL_NOT_REACHABLE` |
| 4 | Reasoning effort offered by the model; then storage-object inputs (§2.9) | `AI_CAPABILITY_UNSUPPORTED`, `AI_INVALID_REQUEST` |
| 5 | Clamp `maxOutputTokens` to the smallest of `defaults.maxOutputTokensCap`, `limits.perModel[…].maxOutputTokens` and the model's limit | — |
| 6 | Resolve the key (§2.2) | `AI_KEY_REQUIRED` |
| 6b | Rate limits (§2.22) | `AI_RATE_LIMITED` |
| 7 | Call the adapter with `{ apiKey, baseUrl, providerSettings, signal, requestId }` | adapter's `AiError` |
| 8 | Record one `ai_usage_events` row per round trip (success, failure or cancellation) | — |
| 9 | Trace an `ai.request` span (provider, model, operation, key source, status, tokens) | — |

With no `model` in the request, the caller's `user_settings.ai.defaultModel`
applies (chat operations only). Queued operations run steps 1–4 when they
enqueue and the whole pipeline again when the job executes.

### 2.5 Normalized request and response

Requests and responses follow the OpenAI Responses API shape. It is the
richest widely used shape, and mapping down to a simpler provider is
tractable where mapping up is not. Types live in
`apps/api/src/ai/core/types/`.

```ts
export type AiInputItem =
  | { type: 'message'; role: 'user'|'assistant'|'system'|'developer'; content: AiContentPart[] }
  | { type: 'function_call'; callId: string; name: string; arguments: string }   // replayed (§2.10)
  | { type: 'function_call_output'; callId: string; output: string }
  | AiReasoningItem;                                   // summary + symbol-keyed AI_PROVIDER_STATE
export type AiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url?: string; storageObjectId?: string; detail?: 'low'|'high'|'auto' }
  | { type: 'file'; storageObjectId?: string; url?: string; filename?: string };
export interface AiResponseRequest {
  model: string; instructions?: string; input: string | AiInputItem[];
  tools?: Array<AiFunctionTool | AiHostedTool>;
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; name: string };
  structuredOutput?: { name: string; schema: ZodType; strict?: boolean };
  reasoning?: { effort?: 'minimal'|'low'|'medium'|'high'; summary?: 'auto'|'concise'|'detailed' };
  maxOutputTokens?: number; temperature?: number; previousResponseId?: string;
  metadata?: Record<string, string>;
  providerOptions?: Record<string, Record<string, unknown>>;   // keyed by provider id
}
export interface AiResponse<T = unknown> {
  id: string; provider: string; model: string;
  output: AiOutputItem[];      // message (with citations) | reasoning | function_call | hosted_tool_call
  outputText: string; parsed?: T;
  usage: { inputTokens?, outputTokens?, reasoningTokens?, cachedInputTokens? };
  finishReason: 'stop'|'length'|'tool_calls'|'content_filter'|'error';
  providerRequestId?: string;
}
export type AiStreamEvent =
  | { type: 'response.created'; id: string } | { type: 'output_text.delta'; delta: string }
  | { type: 'reasoning_summary.delta'; delta: string }
  | { type: 'function_call.arguments.delta'; callId: string; delta: string }
  | { type: 'output_item.done'; item: AiOutputItem }
  | { type: 'response.completed'; response: AiResponse }
  | { type: 'error'; code: AiErrorCode; message: string };
```

- `providerOptions` is the escape hatch for one provider's own knob. It is
  never needed for the contract's guarantees.
- Binary results from media ports are **bytes plus a MIME type**, never a
  provider URL. The runtime stores them as the user's storage objects.

### 2.6 Responses and streaming

The client from `forUser(userId)` offers `respond(req, opts?)`,
`stream(req, opts?)` (lazy: failures surface on first iteration) and
`openStream(req, opts?)` (eager: pre-stream failures reject the promise).
`opts.signal` aborts the provider call.

`POST /api/ai/responses/stream` is Server-Sent Events over a plain `POST`:

- Frames are `event: <type>\ndata: <json>\n\n`, with a `: ping` comment
  every 15 seconds. Headers: `Content-Type: text/event-stream`,
  `Cache-Control: no-cache`, `X-Accel-Buffering: no`. No `stream` flag in the
  body.
- **Every failure before the first event is an ordinary JSON error** with its
  HTTP status. Only a failure after streaming starts is an in-band
  `error` frame, then the stream closes.
- The handler is a hand-written `@Res()` handler (`ai/http/ai-sse.ts`), not
  `@Sse()`, which would commit to `200` before the gates run.
- A client disconnect is detected on the **response's** `close` event and
  aborts the provider call; the usage row records `cancelled`. The
  non-streaming route threads the same signal.
- Known gap: a throttle an adapter reports as an in-band first `error` event
  yields a JSON `429` without `details.retryAfterMs`.
- The request DTO (`ai/http/dto/ai-response-request.dto.ts`) is `.strict()`:
  unknown keys are a `400`. The body limit is 1 MB. `structuredOutput.jsonSchema`
  is converted with `z.fromJSONSchema`, bounded at 64 KB, local `$ref`s only.

nginx buffers `/api` with a 60-second timeout, so `infra/nginx/nginx.conf`
has a dedicated `location /api/ai/responses/stream` block (before the general
`/api` block) with `proxy_buffering off`, `proxy_cache off`,
`chunked_transfer_encoding off` and 600-second timeouts. `gzip_types` must not
include `text/event-stream`. The `appctl deploy` host vhost
(`apps/cli/src/deploy/proxy.ts`) carries the same block, because nginx
consumes `X-Accel-Buffering` instead of forwarding it.

### 2.7 Structured output and function tools

- **`respondStructured({ schema, schemaName?, strict?, ...req })`**: `schema`
  is a Zod schema. `parsed` is typed and always present, or the call throws
  `AI_STRUCTURED_OUTPUT_INVALID` (502).
- **`runTools({ input, tools, maxSteps? })`**: the function-calling loop,
  up to 8 gated round trips by default, 20 at most, each with its own usage
  row. Define a tool with `defineTool` (`ai/core/tools.ts`); one Zod schema is
  both the provider-facing JSON Schema and the validation of the model's
  arguments.
- On a provider that cannot chain, the loop resends the full conversation
  each round (§2.10).

### 2.8 Hosted tools and MCP

Hosted tools run **inside the provider** during one response: `web_search`,
`file_search`, `code_interpreter`, `image_generation` and `mcp`.

- **Two gates.** The type must be switched on in `ai.hostedTools.<type>`
  (all off by default; each reaches outside the deployment and bills per use),
  else `AI_TOOL_DISABLED` (403). The model must declare `hosted_tools`, else
  `AI_CAPABILITY_UNSUPPORTED`. Only OpenAI supports them today.
- **MCP.** `serverUrl` must be `https://` with no credentials in it.
  `ai.hostedTools.mcpAllowedHosts` (hostnames, or `*.example.com`) narrows
  the allowed hosts; empty means any. `headers` are secret: passed to the
  adapter only, never logged, traced, stored or put in an error. A
  background run carrying them is refused (`AI_INVALID_REQUEST`). Echoed
  header values are replaced with `[REDACTED]`.
- **Outputs** are `hosted_tool_call` items with a typed `result` per tool.
  Web search citations are on the message item as
  `citations[{ url, title, startIndex, endIndex }]`.
- **Generated images** become the caller's storage objects under
  `ai-outputs/<userId>/<runId or responseId>/`; only `storageObjectId` is
  published. If storage is unavailable the response still succeeds, with
  `storageObjectId: null, storageError: 'AI_STORAGE_UNAVAILABLE'`.
- `GET /api/ai/config` publishes the five switches as `hostedTools` booleans,
  never the allowlist.

### 2.9 Storage-object inputs

An `image` or `file` part may name a `storageObjectId` instead of a `url`
(exactly one). Every responses entry point accepts it, including
`POST /api/ai/runs`.

- **Checks** (`AiStorageInputResolver`): the object must be the caller's own
  and `ready` — ownership only, no permission grants access to another
  user's object here. Unknown is `404`; another user's is `403`.
- **Modality follows the MIME type.** PNG/JPEG/GIF/WebP is an image and needs
  `vision_input`; anything else needs `file_input`, both in the model's
  capabilities and `inputModalities`. Otherwise `AI_CAPABILITY_UNSUPPORTED`.
- **Caps:** images 20 MiB, files 50 MiB, at most 16 distinct objects per
  request, else `AI_INVALID_REQUEST`. Storage that cannot presign or read is
  `503 AI_STORAGE_UNAVAILABLE`.
- **Delivery** follows the adapter's `fileInputStrategy` (`presigned_url`,
  `upload` or `inline` per modality): a 10-minute presigned GET URL, a
  provider upload deleted after the response, or a capped byte stream.
- **The request is never rewritten.** It keeps the id, so logs,
  `ai_runs.request` and errors carry no URL or bytes. A presigned URL is a
  bearer capability and is never logged, stored, traced or returned.
- A background run resolves the object again when it executes.
- Sending a file to a model sends its contents to that provider. That egress
  is what an administrator opts into by enabling the provider.

### 2.10 Conversation state and `previousResponseId`

`previousResponseId` chains a request onto a stored response. Only OpenAI
stores responses. Every other adapter declares
`supportsPreviousResponseId: false`.

- For those providers a caller's `previousResponseId` is **refused** with
  `AI_CAPABILITY_UNSUPPORTED` and `details.capability: "previous_response_id"`,
  before any key is resolved. Send the conversation as `input` instead.
- `runTools` resends the full history each round for such a provider:
  original input, then each round's output replayed (`message` as assistant,
  `function_call` and `reasoning` as themselves), then tool outputs.
  `core/conversation.ts` (`asInputItems`, `replayOutput`) is the single
  definition.
- **Opaque provider state** (Anthropic thinking signatures, Gemini
  thought signatures) rides on a `reasoning` item under the
  `AI_PROVIDER_STATE` **symbol** key. `JSON.stringify` skips symbols, so no
  HTTP body, SSE frame, log line or run row can carry it. A stored background
  run drops replayed `reasoning` items.
- `GET /api/ai/config` publishes `supportsPreviousResponseId` per provider.

### 2.11 Embeddings

`embed({ model, input, dimensions? })` →
`{ provider, model, dimensions, vectors, usage }`, synchronous, one vector per
input in order. Route: `POST /api/ai/embeddings`.

- `model` is required. Vectors compare only within one model, so store
  `model` and `dimensions` beside each vector.
- At most 256 inputs (`AI_EMBEDDINGS_MAX_INPUTS`); more is `AI_INVALID_REQUEST`,
  never silently split.
- `dimensions` shortens vectors where the model supports it.
- Usage: `operation: 'embeddings'`, `inputTokens` where reported.
- **Backfills are a fork's own job:** a server-only job type, one job per
  chunk of ≤ 256 row **ids**, calling `embed` once per run and throwing
  `err.toRateLimitError() ?? err`.

### 2.12 Images

`generateImage({ model, prompt, size?, quality?, background?, outputFormat?, n? })`
and `editImage({ …, imageStorageObjectIds, maskStorageObjectId? })` →
`{ runId, jobId }`. Routes: `POST /api/ai/images`, `POST /api/ai/images/edits`
(202).

- Always queued (`ai.image.generate`); not subject to `allowBackgroundRuns`.
- `model` required; `n` is 1–4; an edit takes 1–16 source images, each
  `ready`, PNG/JPEG/WebP (mask PNG), ≤ 25 MiB.
- The job checks storage is writable **before** calling the provider, then
  writes each image as a `ready` storage object under
  `ai-outputs/<userId>/<runId>/`. Output:
  `{ type: 'images', provider, model, storageObjectIds, images: [{ storageObjectId, mimeType, size, revisedPrompt? }], usage }`.
- Usage: `operation: 'images'`, `units: { images: n }`.
- Download through `GET /api/storage/objects/{id}/download`.

### 2.13 Audio transcription

`transcribe({ storageObjectId, model?, language?, prompt?, timestampGranularities? })`
→ `{ runId, jobId }`. Route: `POST /api/ai/audio/transcriptions` (202).

- Always queued (`ai.audio.transcribe`). `model` defaults to the first usable
  `audio_transcription` model, never the chat default.
- The recording is the caller's storage object: `ready`, `audio/*`,
  `video/mp4` or `video/webm`, at most the port's `transcriptionMaxBytes`
  (25 MiB for OpenAI). Checked at queue time from the row.
- The job **streams** the recording through a size-capped reader.
- Output: `{ type: 'transcription', provider, model, storageObjectId, text, language?, durationSeconds?, segments?, words?, usage }`.
  Nothing is written to storage.
- Usage: `operation: 'audio.transcribe'`, `units: { audioSeconds }` when
  reported.

### 2.14 Speech synthesis

`speak({ input, voice?, model?, format?, instructions?, speed? })` →
`{ runId, jobId }`. Route: `POST /api/ai/audio/speech` (202).

- Always queued (`ai.audio.speech`). `input` is 1–4096 characters
  (`AI_SPEECH_INPUT_MAX_CHARS`).
- `model` defaults to the first usable `audio_speech` model; `voice` to that
  model's first voice and must be one it lists. `format` defaults to `mp3`
  (`mp3|wav|opus|aac|flac|pcm`); `speed` is 0.25–4.
- The audio is written to `ai-outputs/<userId>/<runId>/speech.<ext>`. Output:
  `{ type: 'speech', provider, model, storageObjectId, mimeType, size, format, voice, characters, aiGenerated: true, usage }`.
- **Disclosure:** provider policies require telling listeners a voice is
  AI-generated. The output carries `aiGenerated: true` and the stored object's
  metadata `aiGenerated: 'true'`. A client that plays it must show this.
- Usage: `operation: 'audio.speech'`, `units: { characters }`.

### 2.15 Realtime voice sessions

Speech-to-speech audio flows **browser ↔ provider** over WebRTC. The server
spends the key once to mint a short-lived secret, and only that secret goes to
the browser.

`createRealtimeSession({ provider?, model?, voice?, instructions?, turnDetection?, tools? })`
→ `{ provider, model, voice, clientSecret, expiresAt, connectUrl }`. Route:
`POST /api/ai/realtime/sessions` (201), body `{ provider?, model?, voice?, instructions? }`.

Gates, in order: kill switch → `ai.defaults.allowRealtime` (default `false`,
else `AI_REALTIME_DISABLED` 403) → target (default: first usable `realtime`
model) → provider → model with `realtime` and a reachable key → voice →
key → rate limits (one mint is one request) → mint.

- **OpenAI mint:** `POST /v1/realtime/client_secrets` with the real key and
  the initial session configuration. The secret's TTL is always 60 seconds
  (`AI_REALTIME_CLIENT_SECRET_TTL_SECONDS`), enough to finish the SDP
  exchange. A connected call outlives it.
- **Browser:** POSTs its SDP offer to `connectUrl` (derived from the slot's
  `baseUrl`, default `https://api.openai.com/v1/realtime/calls`) with
  `Authorization: Bearer <clientSecret>`.
- **What the secret can do:** open sessions with that configuration until it
  expires, and reconfigure its own session over the data channel. It cannot
  call any other API. Server-sent instructions and caps are initial
  configuration, not enforcement.
- **The one credential any AI route returns.** Treat it as a bearer token:
  never logged, stored or traced.
- **Usage:** one row per mint, `operation: 'realtime'`,
  `units: { sessions: 1 }`, no tokens. The server never sees the media.
- **No job:** minting is one short round trip; the long-running call runs off
  the server. Tools are not accepted over HTTP.

### 2.16 Background runs

`startRun(req)` queues an `ai.response.run` job and returns `{ runId, jobId }`.
Route: `POST /api/ai/runs` (202). Poll `GET /api/ai/runs/{id}`, cancel with
`POST /api/ai/runs/{id}/cancel` (idempotent; a finished run is returned
unchanged).

- Refused with `AI_INVALID_REQUEST` when `ai.defaults.allowBackgroundRuns` is
  off, or when the request carries a function tool or MCP headers.
- `ai_runs.request` stores the **full normalized request**
  (`toStoredRunRequest`, `runtime/ai-run-request.ts`), untruncated, never a
  key. The executor resolves the key at run time.
- Images, transcription and speech runs share `ai_runs`, told apart by
  `request.operation` (absent means a response run).
- Run status: `pending | running | succeeded | failed | cancelled`. A run is
  scoped to its owner; another user's is `404`. The response never includes
  the stored prompt or the job id.

### 2.17 Model discovery and classification

Two steps, both under the admin key (or keyless), both server-only:

1. **Discovery:** `listModels` returns `{ id, ownedBy?, createdAt?, metadata? }`.
   `metadata` (`displayName`, `inputTokenLimit`, `outputTokenLimit`,
   `supportedActions`, `thinking`) is filled only where the listing says more
   than ids (Gemini).
2. **Classification:** `classifyModel(modelId, metadata?)` applies a curated,
   per-provider rule table and returns `AiModelCapabilities` or `null`. It
   must answer from the id alone when `metadata` is absent, because
   request-time callers pass only the id.

Each `ai_models` row has `capabilitySource: 'catalog' | 'admin_override' | 'unclassified'`.
Catalog refresh is safe to run unattended because:

- New models are inserted with `enabled: false`. Discovery never enables.
- A refresh updates `capabilities` only when the source is not
  `admin_override`.
- A refresh never writes `enabled` for a model still listed.
- A model no longer listed gets `deprecatedAt` and is force-disabled. If it
  reappears, `deprecatedAt` clears but it stays disabled.
- Rows are never deleted; runs and usage reference model ids by value.

A successful sync emits `AI_CATALOG_SYNCED_EVENT`
(`ai/catalog/ai-catalog.events.ts`). A listener in the keys module enqueues
`ai.keys.recheck` for that provider's users. The listener only enqueues.

### 2.18 Usable models

```
usable(user) = { enabled AND not deprecated } ∩ { reachable with the user's key }
             ∪ { enabled AND not deprecated }   when org fallback or a keyless provider applies
```

- With a user key: enabled models whose id is in the key's
  `reachableModelIds` (computed when the key is set, on the weekly
  `ai.keys.recheck`, and after a catalog sync).
- With no user key under `byok_with_org_fallback`: every enabled model of a
  provider with an org key, `keySource: 'org'`.
- On a keyless provider: every enabled model, `keySource: 'none'`.
- `GET /api/ai/models` returns `{ provider, modelId, displayName, capabilities, keySource }[]`.

`UsableModelsService.assertUsable(userId, provider, modelId, capability?)`
is the single-model check and the one origin of `AI_MODEL_NOT_ENABLED`,
`AI_MODEL_NOT_REACHABLE`, `AI_KEY_REQUIRED` and `AI_CAPABILITY_UNSUPPORTED`.

### 2.19 Kill switch

`ai.enabled = false` shuts the consumer side and leaves the admin side open:

- `AiEnabledGuard` (`ai/config/ai-enabled.guard.ts`), applied at controller
  level, answers `403` with `details.reason: 'AI_DISABLED'` on every
  `/api/ai/*` route except `GET /api/ai/config`. It runs before `@Auth()`, so
  it denies even unauthenticated callers.
- `GET /api/ai/config` stays open: it is how the browser learns AI is off.
- **`/api/admin/ai/*` is deliberately outside the guard**, so an
  administrator can always switch AI back on.
- AI job handlers check `ai.enabled` when they run and end without retry if
  it went off. `ai.usage.purge` is not gated (retention is data hygiene).
- The catalog cron enqueues nothing while disabled.
- The web app hides every AI card, route and navigation entry.

### 2.20 Jobs

Every `ai.*` job type is **server-only, forever**. None carries
`nodeResultSchema` or `persistNodeResult`, because both the user's key and the
org key must never be brokered to a worker node.

| Type | Payload | Profile | Notes |
|---|---|---|---|
| `ai.catalog.refresh` | `{ providerId }` | 5 min, 3 attempts | Admin key. Daily cron at 04:00, and `POST /api/admin/ai/models/refresh`. |
| `ai.response.run` | `{ runId }` | 30 min, 1 attempt | A model call is not safe to retry blindly. |
| `ai.image.generate` | `{ runId }` | 10 min, 1 attempt | Billed per image. |
| `ai.audio.transcribe` | `{ runId }` | 15 min, 2 attempts | Idempotent. |
| `ai.audio.speech` | `{ runId }` | 5 min, 2 attempts | A retry rewrites the same key. |
| `ai.keys.recheck` | `{ provider }` | 30 min, 3 attempts | Weekly cron, and on catalog sync. |
| `ai.usage.purge` | none | 30 min, 3 attempts | Daily at 05:00 via `enqueueHousekeepingJob`; 5000 ids per batch. |

- Media jobs extend `AiMediaRunHandler` (claim, cancel, deadline, outcomes,
  retries, settle safety net).
- Every AI cron only enqueues.
- **Expected refusals end the run, not the job.** `AI_RUN_TERMINAL_CODES`
  (`runtime/ai-response-run.handler.ts`): `AI_DISABLED`,
  `AI_PROVIDER_DISABLED`, `AI_KEY_REQUIRED`, `AI_KEY_INVALID`,
  `AI_MODEL_NOT_ENABLED`, `AI_MODEL_NOT_REACHABLE`,
  `AI_CAPABILITY_UNSUPPORTED`, `AI_TOOL_DISABLED`, `AI_INVALID_REQUEST`,
  `AI_CONTENT_FILTERED`, `AI_STRUCTURED_OUTPUT_INVALID`,
  `AI_STORAGE_UNAVAILABLE`. The run fails with the code; the job returns
  normally (no retry, no `jobs.job_failed`).
- `AI_RATE_LIMITED` returns the run to `pending` and defers the job through
  `toRateLimitError()`. Any other error throws and retries normally.
- Embeddings and realtime ship no job type.

### 2.21 Usage, audit and retention

Every provider round trip writes one `ai_usage_events` row:
`{ userId?, provider, modelId, operation, keySource, inputTokens?, outputTokens?, reasoningTokens?, cachedInputTokens?, units?, latencyMs, status, errorCode?, providerRequestId?, jobId? }`.

- `operation`: `responses | images | audio.transcribe | audio.speech | embeddings | realtime | catalog`.
  `catalog` has no user and `keySource: 'admin_discovery'`.
- `units` holds non-token meters: `{ images }`, `{ audioSeconds }`,
  `{ characters }`, `{ sessions: 1 }`.

**Reports.** `GET /api/admin/ai/usage` and `GET /api/ai/usage/me` return one
shape:

```ts
{ range: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' },   // UTC days, inclusive
  groupBy: 'day' | 'user' | 'model' | 'provider' | 'keySource',
  totals: Bucket, series: Array<Bucket & { key: string; label: string }> }
// Bucket = { requests, failed, inputTokens, outputTokens, reasoningTokens, cachedInputTokens,
//            units: Record<string, number>, orgKeyRequests, orgKeyInputTokens, orgKeyOutputTokens }
```

- Default range 30 days; more than 90, or `from` after `to`, is
  `400 AI_USAGE_RANGE_INVALID`. `day` series are zero-filled; others are
  ordered by `requests`. The `user` label is the email.
- The admin report is not behind `AiEnabledGuard`. `/me` allows `groupBy`
  `day` or `model` only and is scoped to the caller in SQL.
- Rows are purged after `ai.usageRetentionDays` (default 180) by
  `ai.usage.purge`.
- UI: the admin **AI Usage** card, and a Usage section inside `/settings/ai`.

**Audit.** Admin and key acts write audit rows with codes, counts or field
names only: `ai_config:replace`, `ai_config:set_key`, `ai_config:delete_key`,
`ai_config:test`, `ai_model:update`, `ai_catalog:refresh_requested`,
`ai_catalog:refresh`, `ai_key:set`, `ai_key:delete`.

**Prompt content** is never logged unless `ai.logPromptContent = true`; then
only at debug level, truncated to 2 KB, never in a column or audit row. Spans
never carry prompt text or keys.

### 2.22 Rate limits and output caps

`ai.limits` is optional throughout; absent means unlimited, and an empty
`{}` costs no query.

| Field | Window | Counts |
|---|---|---|
| `perUser.requestsPerMinute` | sliding 60 s | every inference call, whoever's key pays |
| `perUser.requestsPerDay` | UTC day | the same |
| `orgKey.requestsPerDayPerUser` | UTC day | calls the org key paid for |
| `orgKey.tokensPerDayPerUser` | UTC day | input + output tokens of those calls |
| `perModel['<provider>:<modelId>'].requestsPerMinutePerUser` | sliding 60 s | the user's calls to that model |
| `perModel['<provider>:<modelId>'].maxOutputTokens` | — | an output cap (gate step 5) |

- Numbers are positive integers ≤ 10⁹. `perModel` keys match
  `^[a-z0-9-]+:.+$`, at most 500 entries.
- `limits` is **one value**: a `PUT` that sends it replaces it whole (`{}`
  lifts all limits); omitting it keeps it. `GET /api/ai/config` does not
  publish it.
- `AiLimitsService` is gate step 6b, after key resolution. It runs on every
  round trip, including each `runTools` step and each queued run **when it
  executes**, never at enqueue. A queued run over a limit is deferred.
- **What counts:** one `ai_usage_events` row with `keySource` `user`, `org`
  or `none`. `none` never counts against `orgKey.*`. Failed and cancelled
  calls count. A refused call writes no row.
- **Minute windows** take the larger of an in-process log (reserved
  synchronously, exact within one replica) and a `COUNT(*)` over
  `ai_usage_events` for the last 60 s (agreement across replicas). Overshoot is
  bounded by calls in flight on other replicas. Daily windows read the
  database only.
- **Refusal:** `429 AI_RATE_LIMITED` with
  `details: { limit, max, window: 'minute'|'day', keySource?, provider, model, retryAfterMs }`.
  The filter adds `Retry-After` in whole seconds.

### 2.23 Errors

Every failure is an `AiError` (`ai/core/ai-error.ts`) with a stable code. No
raw SDK error escapes an adapter. The envelope's top-level `code` stays the
status-derived value (`FORBIDDEN`, …); **the AI code travels in
`details.reason`**. Switch on `details.reason`, never on `message`.

| Code | HTTP | Meaning |
|---|---|---|
| `AI_DISABLED` | 403 | Kill switch is off. |
| `AI_PROVIDER_DISABLED` | 403 | Provider not enabled or not registered. |
| `AI_KEY_REQUIRED` | 403 | No key resolves under the active policy. |
| `AI_KEY_INVALID` | 400 | A submitted key failed `verifyKey`. |
| `AI_MODEL_NOT_ENABLED` | 403 | Model not enabled, or deprecated. |
| `AI_MODEL_NOT_REACHABLE` | 403 | Enabled, but the resolved key cannot reach it. |
| `AI_CAPABILITY_UNSUPPORTED` | 400 | Model or provider lacks a needed capability (including `previous_response_id`). |
| `AI_TOOL_DISABLED` | 403 | Hosted tool switched off, or MCP host not allowed. |
| `AI_REALTIME_DISABLED` | 403 | `ai.defaults.allowRealtime` is off. |
| `AI_RATE_LIMITED` | 429 | Provider throttle or an `ai.limits` limit; `details.retryAfterMs` when known. |
| `AI_PROVIDER_UNAVAILABLE` | 503 | Transport failure, timeout, abort (`details.aborted`), refused redirect (`details.providerCode: "redirect_refused"`), or no endpoint (`details.missing: "baseUrl"`). |
| `AI_CONTENT_FILTERED` | 422 | The provider's content filter refused. |
| `AI_INVALID_REQUEST` | 400 | The request is malformed or over a limit. |
| `AI_STRUCTURED_OUTPUT_INVALID` | 502 | Output did not parse against the schema. |
| `AI_STORAGE_UNAVAILABLE` | 503 | Object storage unconfigured or unusable for a storage-backed input or output. |

`AiError.cause` is non-enumerable, so an SDK error echoing headers never
reaches `JSON.stringify`. In a job, `throw err.toRateLimitError() ?? err`
defers on a throttle instead of spending an attempt.

`PUT /api/admin/ai/config` validates each provider against its own slot. Its
refusals are plain `400`s with `details.reason` and `details.provider`:

| `details.reason` | When |
|---|---|
| `AI_UNKNOWN_PROVIDER` | No settings slot for that id. |
| `AI_PROVIDER_NOT_REGISTERED` | Enabling a provider with no registered adapter. |
| `AI_KEY_REQUIRED` | Fallback policy while an enabled, key-requiring provider has no admin key. |
| `AI_PROVIDER_FIELD_UNSUPPORTED` | A field the slot does not have (`details.field`). |
| `AI_PROVIDER_SETTINGS_INVALID` | The slot fails its schema (`details.fields`). |
| `AI_BASE_URL_REQUIRED` | Enabling `azure-openai` or `openai-compatible` without `baseUrl`. |

### 2.24 The five providers

**`openai`** (`providers/openai/`). The Responses API with every port:
`responses`, `images`, `audio`, `embeddings`, `realtime`. The only provider
that stores responses (`previousResponseId` works) and the only one with
hosted tools. Stored images go by presigned URL; files are uploaded to the
Files API (`purpose: 'user_data'`) and deleted after the response. The
folder also holds the OpenAI wire family's shared pieces (errors, Responses
and Chat Completions engines, pinned client options, `noRedirectFetch`)
reused by the next two adapters.

**`anthropic`** (`providers/anthropic/`). The Messages API, `responses` port
only, stateless (`supportsPreviousResponseId: false`), no hosted tools
(`supportsHostedTools: false`). `max_tokens` is required, defaulting to
16,000 (`ANTHROPIC_DEFAULT_MAX_TOKENS`) capped at the model's limit.
Reasoning uses adaptive thinking (Claude 4.6+) or a thinking budget
(Claude 3.7–4.5); a thinking signature travels only as `AI_PROVIDER_STATE`.
Structured output uses native `output_config.format` or a forced tool on
older models. Stored images by presigned URL, documents inline.

**`gemini`** (`providers/gemini/`). `generateContent` on the Gemini Developer
API (`v1beta`, `vertexai: false`, no SDK environment reads), `responses` and
`embeddings` ports, stateless, no hosted tools. Thought signatures on
response parts replay through `AI_PROVIDER_STATE`. The classifier is enriched
by the listing's `metadata`. Every stored input is sent inline. Embeddings
report no token count.

**`azure-openai`** (`providers/azure-openai/`). A composition of the OpenAI
pieces: one `AzureOpenAI` client per call with `<baseUrl>/openai`, the slot's
`apiVersion` (default `2025-04-01-preview`) and the key in the `api-key`
header. `apiStyle` picks Responses (default) or Chat Completions.
`deployments` maps model ids to deployment names (falling back to the id);
when set, its keys are the model list. Classified with OpenAI's table minus
`hosted_tools`. `responses` and `embeddings`, stateless flags.

**`openai-compatible`** (`providers/openai-compatible/`). Ollama, vLLM, LM
Studio, llama.cpp or a gateway at `baseUrl` (including its `/v1`), key as a
bearer token. `apiStyle` defaults to Chat Completions, which refuses
reasoning effort, `previousResponseId` and hosted tools. **Every model is
unclassified**; an administrator declares capabilities before enabling it.
`requiresKey: false` makes it keyless (§2.2). Stored inputs are inline.

**Endpoint safety** for the last two: `baseUrl` must be `https` (Azure) or
`http`/`https` (compatible), with no credentials and no fragment. Internal
hosts are allowed; pointing at one is an administrator decision.
`noRedirectFetch` refuses **every** 3xx and never follows or echoes
`Location`.

### 2.25 The Playground

`/ai` (`apps/web/src/pages/AiPlaygroundPage.tsx`) is the reference browser
client. It calls only the HTTP surface.

- **Modes:** Chat, Image, Transcribe, Speech, Embeddings, Voice, each tied to
  one capability and listing only usable models that declare it
  (`components/ai/playground/aiPlaygroundModes.ts`). A mode no model serves is
  `aria-disabled` with a reason.
- **Chat** streams or queues a run, attaches storage objects per the model's
  modalities, and offers hosted tools that are switched on (not MCP). For a
  provider that cannot chain it resends the conversation as `input`.
- **Image, Transcribe, Speech** poll their runs. The speech player always
  shows "AI-generated audio".
- **Embeddings** shows vectors and, for ≤ 10 inputs, a cosine similarity
  matrix.
- **Voice** is hidden unless `allowRealtime` is true. `useAiRealtimeSession`
  (`apps/web/src/hooks/useAiRealtimeSession.ts`) asks for the microphone
  first, mints, and keeps `clientSecret` in a local variable only. The
  deployment must allow the microphone via `Permissions-Policy:
  microphone=(self)` and `connect-src` must be able to reach the
  runtime-configured provider host, since the browser posts the WebRTC SDP
  offer straight there; see [SECURITY-ARCHITECTURE.md
  §9](../SECURITY-ARCHITECTURE.md#security-headers).
- Errors render through one `AiErrorAlert` mapping.

## 3. Configuration and permissions

**Settings:** the `ai` namespace (§2.1). **Environment:** none. Do not add
`OPENAI_API_KEY` or any equivalent.

**Permissions** (matrix in [ARCHITECTURE.md](../ARCHITECTURE.md)):

- `ai_config:read` / `ai_config:write` — deployment-wide AI configuration.
  Seeded Admin only.
- `ai:use` — call AI with one's own key (or the org fallback). Seeded to
  Admin and Contributor, **not Viewer**. Viewer is the default role for new
  signups; an administrator grants `ai:use` to a Viewer explicitly or promotes
  the account.

**Settings UI:** the admin `AI` group has **AI** (`/admin/settings/ai`, no
`feature`, so it stays reachable to switch AI on), **AI Models** and **AI
Usage** (both `feature: 'ai'`), all gated on `ai_config:read`. The user card
**AI Keys** (`/settings/ai`) is gated on `ai:use` with `feature: 'ai'`.

**Admin API** (`/api/admin/ai/*`, tag `AI Administration`, not behind
`AiEnabledGuard`):

| Route | Purpose | Permission |
|---|---|---|
| `GET /api/admin/ai/config` | Namespace plus per-provider `enabled`, `baseUrl`, `settingsFields`, slot fields, masked `keyStatus`, `supportedCapabilities`; never the key | `ai_config:read` |
| `PUT /api/admin/ai/config` | Replace config; `If-Match` (409 on mismatch); omitted `usageRetentionDays`/`hostedTools`/`limits` kept | `ai_config:write` |
| `PUT /api/admin/ai/providers/{provider}/key` | Set admin key; verified first, 400 `AI_KEY_INVALID` stores nothing | `ai_config:write` |
| `DELETE /api/admin/ai/providers/{provider}/key` | Remove admin key; body `{"confirmation":"REMOVE"}`; warns `ORG_FALLBACK_WITHOUT_KEY` | `ai_config:write` |
| `POST /api/admin/ai/providers/{provider}/test` | `credentials`, `list_models`, `responses_smoke` (billed); always 200 | `ai_config:write` |
| `GET /api/admin/ai/models` | Paginated catalog, filterable | `ai_config:read` |
| `PATCH /api/admin/ai/models/{id}` | Enable/disable, override capabilities (`admin_override`); 409 for deprecated, 400 unclassified without capabilities | `ai_config:write` |
| `POST /api/admin/ai/models/refresh` | Enqueue `ai.catalog.refresh`; 409 without admin key unless keyless | `ai_config:write` |
| `GET /api/admin/ai/usage` | Usage report, any `groupBy`, filters `userId`/`provider`/`model` | `ai_config:read` |

**Consumer API** (`/api/ai/*`, tag `AI`, `AiEnabledGuard` + `ai:use` unless
noted):

| Route | Purpose |
|---|---|
| `GET /api/ai/config` | Any signed-in user, open while AI is off: `enabled`, `keyPolicy`, `allowBackgroundRuns`, `allowRealtime`, `hostedTools`, providers with `hasOrgKey`, `supportsPreviousResponseId`, `requiresKey` |
| `GET /api/ai/keys` | Caller's keys, masked, one per enabled provider |
| `PUT /api/ai/keys/{provider}` | Set key (8–512 chars): verify, compute reachable models, store |
| `DELETE /api/ai/keys/{provider}` | Remove key; 204, idempotent |
| `POST /api/ai/keys/{provider}/test` | `credentials`, `list_models` only (no billed call); always 200 |
| `GET /api/ai/models` | Usable models (§2.18) |
| `POST /api/ai/responses` | One response |
| `POST /api/ai/responses/stream` | Same, as SSE (§2.6) |
| `POST /api/ai/embeddings` | Embeddings (§2.11) |
| `POST /api/ai/images`, `/images/edits` | Queue image generation or edit; 202 |
| `POST /api/ai/audio/transcriptions` | Queue transcription; 202 |
| `POST /api/ai/audio/speech` | Queue speech; 202 |
| `POST /api/ai/realtime/sessions` | Mint a realtime session; 201 |
| `POST /api/ai/runs` | Queue a background response; 202 |
| `GET /api/ai/runs/{id}` | One run, caller's only |
| `POST /api/ai/runs/{id}/cancel` | Cancel a run; idempotent |
| `GET /api/ai/usage/me` | Caller's usage, `groupBy` `day` or `model` |

## 4. Extending it in a fork

To **use** AI in a feature, follow the recipe in
[apps/api/src/ai/README.md](../../apps/api/src/ai/README.md): import
`AiModule`, inject `AiService`, call `forUser(userId)`.

To **add a provider**, implement an adapter against the existing contract.
Nothing in the registry, the gate pipeline, the admin API or the HTTP
surface changes. Copy the closest worked example: `providers/openai/`
(Responses API, every port), `providers/anthropic/` (Messages API,
stateless), `providers/gemini/` (`generateContent`, metadata-enriched
classifier), or compose the OpenAI pieces as `providers/azure-openai/` and
`providers/openai-compatible/` do for an OpenAI-wire server.

1. **Implement `AiProviderAdapter`** (`ai/core/provider-adapter.interface.ts`)
   in `apps/api/src/ai/providers/<provider>/`: `id` (permanent once jobs,
   usage or keys reference it), `displayName`, `listModels`, `verifyKey`,
   `classifyModel`, and only the ports the provider genuinely supports.
   Declare `supportsPreviousResponseId: false` if it stores no responses and
   `supportsHostedTools: false` if it has none of the hosted tools. Declare
   `fileInputStrategy` if it accepts stored inputs. Import the provider's SDK
   only in this folder.
2. **Self-register** from `onModuleInit()`:

   ```ts
   onModuleInit(): void {
     this.registry.register(this);
   }
   ```

   The last registration wins, with a warning, as in `JobHandlerRegistry`.
3. **Write a classifier**: a curated rule table over known model-id shapes,
   returning `AiModelCapabilities` (`ai/core/capabilities.ts`) or `null` for
   an unknown id. If the listing carries facts, return them as
   `AiDiscoveredModel.metadata` and use `classifyModel`'s optional second
   argument to enrich the table.
4. **Map every error onto `AiErrorCode`** (`ai/core/ai-error.ts`) with
   `AiError.wrap(err, code, message)` or a specific `AiError`. Put only
   status, provider error type and request id in `details`, never provider
   text.
5. **Run the conformance kit** (`describeAiProviderConformance`,
   `apps/api/src/ai/testing/conformance.ts`) over a mocked transport that
   validates what the real API validates (the real SDK with an injected
   `fetch`). It asserts: `listModels` returns ids; `verifyKey` maps ok and
   invalid correctly; `classifyModel` returns schema-valid capabilities or
   `null`; if `responses` exists, `create` returns `outputText`, `stream`
   emits `response.created … response.completed` with deltas that equal the
   final text, structured output yields a valid `parsed`, a function-tool
   round trip works (chained, or replayed per the declared flag), and an
   unsupported capability is `AI_CAPABILITY_UNSUPPORTED`; and every error is
   an `AiError`.
6. **Register the provider id**: add it to `AI_PROVIDER_IDS`
   (`common/schemas/settings.schema.ts`), give it a `providers.<id>` slot
   everywhere the namespace is declared (`settings-parity.spec.ts` checks
   one slot per id), add `<provider>.module.ts` to `AiModule`'s imports, and
   add an SDK boundary spec like `providers/gemini/gemini-sdk-boundary.spec.ts`.

A new AI route needs `AiEnabledGuard` plus `ai:use` (consumer) or
`ai_config:*` (admin, no guard). A new AI job type must stay server-only.
A new AI settings page follows the
[Settings UI Pattern](settings-ui.md) and declares `feature: 'ai'`. The
guardrails below discover all of these automatically.

## 5. Guardrails

| Invariant | Test |
|---|---|
| Every `/api/ai/*` route except `GET /api/ai/config` answers `403 AI_DISABLED` while off; every `/api/admin/ai/*` route stays reachable; every `ai.*` job makes zero provider calls while off (routes and job types discovered, not listed) | `apps/api/test/ai/ai-kill-switch.integration.spec.ts` |
| Every discovered route × Admin/Contributor/Viewer/anonymous, expected permission read from `@Auth()` metadata and grants from `prisma/seed-data.ts` | `apps/api/test/ai/ai-rbac-matrix.integration.spec.ts` |
| Sentinel keys (admin, this user, another user) never appear in bodies, headers, logs, audit `meta`, usage rows, run rows or errors; the ephemeral secret only in `data.clientSecret` | `apps/api/test/ai/ai-secret-egress.integration.spec.ts` |
| The byok/fallback/keyless resolution rule over every inference route, sync and queued | `apps/api/test/ai/ai-key-policy.integration.spec.ts` |
| Every `ai.*` job type is in `JobHandlerRegistry.serverOnlyTypes()` | `apps/api/test/ai/ai-jobs-server-only.spec.ts` |
| No file outside `ai/providers/<provider>/` imports a provider SDK, in `apps/api/src` or `apps/web/src` | `apps/api/test/ai/ai-no-sdk-leak.spec.ts` |
| No provider SDK in `ai/core` | `apps/api/src/ai/core/no-provider-sdk.spec.ts` |
| Each SDK confined to its folder(s) | `apps/api/src/ai/providers/openai/openai-sdk-boundary.spec.ts`, `anthropic/anthropic-sdk-boundary.spec.ts`, `gemini/gemini-sdk-boundary.spec.ts` |
| AI registry cards carry the exact permission their controller enforces | `apps/web/src/__tests__/config/aiSettingsRegistry.test.ts` |
| Resolution matrix; org key never returned under `byok` | `apps/api/src/ai/keys/ai-key-resolver.service.spec.ts` |
| Capability support derived from ports only | `apps/api/src/ai/core/provider-registry.spec.ts` |
| `AiError` never serializes key material | `apps/api/src/ai/core/ai-error.spec.ts` |
| Catalog sync never overwrites `admin_override`, never enables, deprecates without deleting | `apps/api/src/ai/catalog/ai-catalog.service.spec.ts` |
| AI crons only enqueue | `apps/api/test/jobs/cron-enqueue-only.spec.ts` |
| Streaming nginx location unbuffered | `apps/api/test/ai/ai-stream-nginx.spec.ts` |
| Seed grants (Viewer lacks `ai:use`) | `apps/api/test/prisma/seed-data.spec.ts` |
| One provider slot per id | `apps/api/src/common/schemas/settings-parity.spec.ts` |
| Each adapter passes the conformance kit | `apps/api/src/ai/testing/fake-ai-provider.conformance.spec.ts`, `apps/api/src/ai/providers/*/*.adapter.conformance.spec.ts` |

## 6. Design decisions

- **Owned contract, not the Vercel AI SDK or LangChain.** The governance
  model (two keys, a resolution invariant, per-user reachability, kill
  switch, audit) is this template's. An adapter may use any SDK internally.
- **Responses-shaped, not lowest-common-denominator chat.** A bare
  `chat(messages)` cannot express reasoning, hosted tools, structured output
  or background semantics.
- **Ports declare capabilities.** A `supportedCapabilities` list could drift
  from what the adapter implements; port presence cannot.
- **User keys in `user_ai_keys`, not `CredentialsService` or `user_settings`.**
  The credential store has no user ownership or cascade; `user_settings` is
  returned whole on read.
- **No environment variables.** Two sources of truth for the live credential
  is the ambiguity this design removes, and a per-user key has no
  environment shape.
- **No browser-side provider calls.** The key would reach the browser, and
  every gate and usage row would become optional.
- **AI jobs never run on nodes.** Neither key may be brokered to a remote
  machine. This is permanent.
- **`ai:use` separate from `ai_config:*`.** "May use AI" can be granted
  broadly while "may reconfigure AI" stays Admin-only. Viewer is excluded
  because a default grant let a new account spend the org key.
- **`ai_config:*`, not `system_settings:*`.** A wrong key policy or enabled
  model has a blast radius specific to AI.
- **Refuse `previousResponseId` on stateless providers.** Ignoring it gives
  a wrong answer that looks right; an in-process response cache breaks across
  replicas and holds conversations with no retention.
- **Provider state on a symbol key.** A normal field would need every
  serializer to remember to strip it.
- **Realtime via an ephemeral secret, not a media relay.** Relaying puts the
  API in the data path of every second of audio. Client-reported usage was
  rejected as untrustworthy; sessions are counted instead.
- **Rate limits without Redis.** A shared cache for abuse protection that
  tolerates a small overshoot is the wrong trade. A fork needing exact limits
  can put one behind `AiLimitsService`.
- **Count at execution, not enqueue.** Counting both would double-count and
  lock users out for work not yet run.
- **Refuse all redirects on admin-typed endpoints.** A same-origin redirect is
  usually a misconfigured `baseUrl`, and "same origin" is what a hostile DNS
  answer would target.
- **Static stateless flags for Azure and compatible servers.** Resolving the
  flag per call from `apiStyle` buys little; resending history works in both
  styles.
- **Hosted tools not mapped for Gemini.** Its grounding citations and code
  execution results do not fit the neutral result types; an honest refusal
  beats a lossy mapping.

## 7. Verification

```bash
cd apps/api
npm test -- src/ai test/ai
npm run test:db -- ai-usage
cd ../web && npm test -- ai
```

By hand, following the [runbook](../runbooks/ai-configuration.md):

1. At `/admin/settings/ai`, switch AI on, enable a provider and store an admin
   key. **Test** should pass all three checks.
2. Refresh the catalog, then enable a model at `/admin/settings/ai/models`.
3. As a Contributor, add a key at `/settings/ai`, open `/ai` and send a chat
   message. The answer streams.
4. `/admin/settings/ai/usage` shows the request.
5. Switch AI off. `/ai` disappears and `POST /api/ai/responses` answers
   `403` with `details.reason: "AI_DISABLED"`.

## History

- Epic #418 (umbrella). Epic #419 (phase 1): #422 spec, #423 database, #424
  core contracts, #425 settings cards, #426 OpenAI adapter, #427 catalog,
  #428 admin API, #431 user keys, #432 runtime facade, #433 HTTP and SSE,
  #434–#435 web UI and guardrail suites, #436 recipe and runbook.
- Epic #420 (phase 2): #437 images, #438 transcription, #439 speech, #440
  embeddings, #441 storage-object inputs, #442 hosted tools, #443 usage
  reports, #444 usage UI, #445 Playground media modes.
- Epic #421 (phase 3): #446 Anthropic, #447 Gemini, #448 Azure OpenAI and
  OpenAI-compatible, #449 realtime sessions, #450 rate limits.
- #499 removed `ai:use` from Viewer. #509 made `AI_STORAGE_UNAVAILABLE` a
  terminal run code.
- #516: removed the unseeded `storage:read_any` bypass from the storage-input
  resolver; it is ownership-only.
