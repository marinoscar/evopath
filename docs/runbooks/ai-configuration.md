# Runbook: Configure the AI Platform

Use this to turn AI on for a deployment, choose who pays for it, curate which
providers and models users can reach, and turn it off again, calmly or in an
emergency. Audience: administrators holding `ai_config:read`/`ai_config:write`.

Why the platform is shaped this way is
[`docs/specs/ai-platform.md`](../specs/ai-platform.md). Adding AI to a feature,
or a new provider adapter, is
[`apps/api/src/ai/README.md`](../../apps/api/src/ai/README.md).

Everything here happens in the admin UI at `/admin/settings/ai` (and
`/admin/settings/ai/models`, `/admin/settings/ai/usage`) or through
`appctl api` against the same endpoints. There is no environment variable for
any of it, and there must never be one.

Source of truth for every claim below:

- `apps/api/src/ai/config/ai-admin.controller.ts` — every `/api/admin/ai/*`
  route this runbook calls.
- `apps/api/src/ai/config/ai-config-admin.service.ts` — the configuration
  save path and its refusals.
- `apps/api/src/common/schemas/settings.schema.ts` — the `ai` system-settings
  namespace: `enabled`, `keyPolicy`, `providers`, `defaults`, `hostedTools`,
  `limits`.
- `apps/api/src/ai/keys/` — `AiKeyResolver` (the key policy) and the user BYOK
  store.
- `apps/api/src/ai/core/ai-error.ts` — every `AiErrorCode` in the
  troubleshooting table.
- `apps/api/src/ai/providers/<provider>/` — each provider adapter and its
  model classifier.
- `apps/web/src/pages/Admin/AiConfigPage.tsx`, `AiModelsPage.tsx`,
  `AiUsagePage.tsx` — the admin UI.

---

## 1. Before you start

- **`SECRETS_ENCRYPTION_KEY` must be set** on the API process before any key
  (admin/org or a user's own) can be stored. The admin/org key lives in
  `CredentialsService` (`purpose: 'ai'`); BYOK keys live in `user_ai_keys`,
  under a separate cipher purpose (`'ai_user_key'`). If the key is unset,
  saving any AI key fails. See
  [`rotate-secrets-encryption-key.md`](rotate-secrets-encryption-key.md).
- **Admin access**: `ai_config:read`/`ai_config:write`, seeded to Admin only.
- **Decide the key policy first.** Either every user brings their own provider
  key (`byok`, the default and the safer posture), or users with no key fall
  back to a deployment-wide admin/org key (`byok_with_org_fallback`). This is
  a deployment-wide decision (section 7).

## 2. Turn AI off in an emergency

The kill switch (`ai.enabled = false`) is total on the consumer side and
leaves the admin side reachable, so you are never locked out of turning it
back on.

1. **From the UI**: `/admin/settings/ai`, toggle **Enabled** off. It takes
   effect immediately.
2. **From the CLI**, when the UI is unreachable or you are scripting an
   incident response (needs `system_settings:write`):

   ```bash
   appctl api PATCH /api/system-settings --data '{"ai":{"enabled":false}}'
   ```

3. **Verify**: any `/api/ai/*` route except `GET /api/ai/config` answers
   `403` with `details.reason: "AI_DISABLED"`, and `GET /api/ai/config`
   reports `enabled: false`.

`/api/admin/ai/*` and the admin UI stay reachable throughout, so you can
inspect or fix the configuration with the platform off. An in-flight
`ai.response.run` job that has not reached the provider yet fails cleanly: its
run row records `AI_DISABLED`, and the *job* still succeeds, so it does not
fire `jobs.job_failed`. A background run that has already made its provider
call runs to completion.

## 3. Turn AI on

1. Sign in as an Admin and open `/admin/settings/ai`. This card is reachable
   even while AI is off: it is the page that turns AI on, so it carries no
   `feature` gate (unlike every other AI card).
2. Toggle **Enabled**. Until you do, every consumer route under `/api/ai/*`
   (except `GET /api/ai/config`, which is how the web app learns AI is off)
   answers `403` with `details.reason: "AI_DISABLED"`, and no AI card or
   navigation entry appears anywhere else in the app.
3. Enable the provider(s) you intend to use and configure each one
   (section 10). Enabling AI overall does nothing by itself while every
   provider stays disabled.

From the CLI:

```bash
appctl api PATCH /api/system-settings --data '{"ai":{"enabled":true}}'
```

`PATCH /api/system-settings` (`system_settings:write`) and
`PUT /api/admin/ai/config` (`ai_config:write`) both write the same `ai`
namespace. The admin UI uses the dedicated `ai_config:*` route, and the rest
of this runbook assumes it.

## 4. Add and test the admin (org) key

The admin/org key has exactly two uses: discovering and classifying a
provider's models (section 5), and, only under `byok_with_org_fallback`,
serving a request for a user who has not brought their own key. It is
**never** a default key for everyone regardless of policy, and no endpoint
returns it once stored.

### 4.1 Add the key

1. On `/admin/settings/ai`, open the provider's row and paste the key
   (`PUT /api/admin/ai/providers/{provider}/key`).
2. The server verifies it against the provider **before** storing anything.
   A rejected key answers `400 AI_KEY_INVALID` and nothing is saved.
3. Once stored, the UI shows only a masked hint (`keyStatus`), never the key.
   This is true of every AI key surface, admin or user.

### 4.2 Test the key

Use the **Test** action on the provider's row
(`POST /api/admin/ai/providers/{provider}/test`). It always answers `200`; read
`success` and each check's own `status`/`code`. Three checks run, in order:

1. `credentials` — the provider accepts the key.
2. `list_models` — how many catalog models the key can see.
3. `responses_smoke` — one tiny, real, **billed** response call, proving the
   key can answer a request and not merely list models.

The third check is admin-only on purpose: it spends the deployment's money.
The equivalent user test (`POST /api/ai/keys/{provider}/test`, section 8)
stops after the first two and never bills a user's account.

## 5. Refresh the model catalog

Discovery lists a provider's model ids; classification assigns their
capabilities. Beyond the platform's own daily backfill, trigger a refresh on
demand from `/admin/settings/ai/models` (**Refresh from provider**), or:

```bash
appctl api POST /api/admin/ai/models/refresh --data '{"provider":"openai"}'
```

This enqueues the server-only `ai.catalog.refresh` job and answers with its
job id at once; watch the outcome at `/admin/settings/jobs`. It needs an admin
key for that provider (`409` without one), because discovery and
classification always run under the admin/org key, whatever the key policy.
The one exception is a keyless OpenAI-compatible server (section 10.5).

A refresh that ran a sync fires `AI_CATALOG_SYNCED_EVENT`, and the keys module
re-checks affected users' stored keys against the new models right away rather
than waiting for the weekly `ai.keys.recheck` job.

## 6. Classify and enable models

A freshly discovered model starts `enabled: false`, and a model the provider's
classifier did not recognise starts with `capabilitySource: 'unclassified'`.
Discovery alone changes nothing a user can reach. On
`/admin/settings/ai/models`:

1. Find the models to review. The page filters by provider, capability and
   search text; each row shows its capability source. From the CLI, list them
   with `appctl api GET /api/admin/ai/models --query provider=openai --raw`
   and look for `"capabilitySource": "unclassified"`.
2. For each unclassified model, state its capabilities (**Edit
   capabilities**, or `PATCH /api/admin/ai/models/{id}` with
   `{ "capabilities": {...} }`). This sets `capabilitySource:
   'admin_override'`, which nothing automated overwrites.
3. Flip **Enabled** on the models users may call. A model must be both
   admin-enabled and reachable with whichever key resolves for the caller
   before anyone can use it.

Enabling a deprecated model is refused (`409`), and so is enabling an
unclassified model with no capabilities supplied (`400`): an operator makes the
capability decision, the platform does not guess one.

## 7. Choose the key policy

- **`byok` (default)** — every user must bring their own key (`/settings/ai`,
  gated by `ai:use`) before they can call any model. No admin key is ever used
  to serve a user's request under this policy. `AiKeyResolver.resolve` enforces
  this in one place.
- **`byok_with_org_fallback`** — a user with no key of their own is served by
  the admin/org key, for whichever providers have one. Setting this policy
  while a provider has no admin key is refused (`400 AI_KEY_REQUIRED`).

Switch it on `/admin/settings/ai`, or with `PUT /api/admin/ai/config`. `PUT`
replaces the whole non-secret configuration and takes an `If-Match` version
header: read `GET /api/admin/ai/config` first for the current `version`
(section 12 has a full body).

### 7.1 Letting Viewers use AI

`ai:use` is seeded to Admin and Contributor, not Viewer. Viewer is the role
every new signup lands in, and under `byok_with_org_fallback` a default grant
would let a brand-new account spend the org key with no administrator
deciding it. To let a Viewer use AI, either:

- grant `ai:use` to that account's role with `rbac:manage` (a `role_permissions`
  row for `('viewer', 'ai:use')` grants it to every Viewer), or
- promote the account to Contributor, which already has it.

## 8. How users add their own key

Point users at `/settings/ai` (the **AI Keys** card, visible only while AI is
enabled because it declares `feature: 'ai'`). A user can:

- Paste a key for any enabled provider (`PUT /api/ai/keys/{provider}`). It is
  verified first, the models it can reach are computed and stored as
  `reachableModelIds`, and only then is anything saved.
- **Test** a stored or unsaved key (`POST /api/ai/keys/{provider}/test`): two
  checks (`credentials`, `list_models`), never a billed call.
- See which models they can call right now (`GET /api/ai/models`): the
  intersection of admin-enabled models and what their key (or the org key,
  under fallback) reaches.
- Remove a key (`DELETE /api/ai/keys/{provider}`): idempotent, `204` either way.

The weekly `ai.keys.recheck` job re-verifies each key's reachable models, and
so does a catalog sync (section 5). A key's tier or organization restrictions
can change without the user doing anything.

## 9. Rotate or remove the admin key

For a leaked key, a routine rotation, or a move to another provider account:

1. `/admin/settings/ai`, the provider's row, set a new key. It is verified
   before it replaces the old one, so a bad replacement never silently leaves
   you without a working key.
2. To decommission the provider, remove the key
   (`DELETE /api/admin/ai/providers/{provider}/key`, body
   `{"confirmation":"REMOVE"}`). Under `byok_with_org_fallback`, removing the
   only admin key a provider has answers with
   `warnings: ["ORG_FALLBACK_WITHOUT_KEY"]`: users with no key of their own for
   that provider see `AI_KEY_REQUIRED` until you restore an admin key or they
   bring their own.
3. Nothing else needs rotating. User BYOK keys belong to each user and are
   revocable individually from `/settings/ai`.

## 10. Configure a provider

Five providers ship: `openai`, `anthropic`, `gemini`, `azure-openai` and
`openai-compatible`. Each is configured the same way: switch it on under its
row on `/admin/settings/ai` (or `providers.<id>.enabled: true` in
`PUT /api/admin/ai/config`), add and test the admin key (section 4), refresh
the catalog (section 5), and enable models (section 6). Users then add their
own keys (section 8) under the policy you chose (section 7). No provider reads
an environment variable, and none needs a restart.

| Provider | `previousResponseId` | Hosted tools | Capability ports besides `responses` |
|---|---|---|---|
| OpenAI | yes | yes | embeddings, images, audio, realtime |
| Anthropic | no | no | none |
| Google Gemini | no | no | embeddings |
| Azure OpenAI | no | no | embeddings |
| OpenAI-compatible | no | no | embeddings |

Where `previousResponseId` is "no", clients send the conversation as `input`.
`GET /api/ai/config` publishes `supportsPreviousResponseId` per provider;
`runTools()` and the AI Playground (`/ai`) already resend the conversation.

### 10.1 OpenAI

1. Create an API key in the OpenAI platform dashboard.
2. Switch the **OpenAI** provider on. `baseUrl` is optional; leave it empty
   for `https://api.openai.com/v1`.
3. Add and **Test** the admin key (section 4), then refresh the catalog for
   `openai` (section 5) and enable models (section 6).

OpenAI is the only provider with every capability port: responses (including
`previousResponseId` chaining and the hosted tools in section 11),
embeddings, images, audio transcription and speech, and realtime voice
sessions (section 13).

### 10.2 Anthropic

Anthropic is configured exactly like OpenAI:

1. On `/admin/settings/ai`, switch the **Anthropic** provider on (or
   `PUT /api/admin/ai/config` with `providers.anthropic.enabled: true`).
   `baseUrl` is optional and only for a gateway that speaks Anthropic's own
   API; leave it empty for `https://api.anthropic.com`.
2. Add the admin (org) key from the Anthropic Console on the provider's row
   (section 4.1) and **Test** it (section 4.2). The key is verified with `GET /v1/models`
   before anything is stored; the third, billed `responses_smoke` check is
   one tiny Messages call.
3. Refresh the catalog for `anthropic` (section 5). The classifier recognises the
   Claude families (Claude 3 through the current Opus, Sonnet, Haiku, Fable
   and Mythos releases) and marks every other id `unclassified` — enable
   the models users should see (section 6). No Anthropic model declares **Hosted
   tools**, embeddings, images or audio: the adapter implements text,
   reasoning, function tools, structured output, streaming, and image and
   PDF input only.
4. Users add their own Anthropic key on `/settings/ai` exactly as for
   OpenAI (section 8), under the key policy you chose (section 7).

What is different, and worth telling users:

- **No `previousResponseId`.** Anthropic keeps no conversation on its side.
  A request that chains onto an earlier response is refused with
  `AI_CAPABILITY_UNSUPPORTED` (`details.capability:
  "previous_response_id"`); send the conversation so far as `input`
  instead (user and assistant messages). In-process `runTools()` does this
  automatically, and `GET /api/ai/config` publishes
  `supportsPreviousResponseId` per provider so clients know to: the AI
  Playground resends the conversation itself for a Claude model and keeps
  chaining for OpenAI, so multi-turn chat works with both.
- **No hosted tools.** Anthropic's provider row on `/admin/settings/ai`
  does not list **Hosted tools** among its capabilities, and no Claude model
  declares them: web search, file search, code interpreter, image
  generation and MCP are OpenAI-only here.
- **Reasoning.** A reasoning effort becomes Anthropic's extended thinking:
  adaptive thinking with an effort level on Claude 4.6 and later, a fixed
  thinking-token budget on older families. Users see a summary of the
  thinking, never the raw chain of thought. A family without extended
  thinking (Claude 3.5 and earlier) refuses an effort.
- **Temperature.** Newer Claude models reject sampling parameters
  outright, and every Claude model rejects a temperature combined with
  extended thinking; both are refused up front with
  `AI_CAPABILITY_UNSUPPORTED` rather than sent.
- **Errors.** Anthropic's `529 overloaded` answers as
  `AI_PROVIDER_UNAVAILABLE` and its `429` as `AI_RATE_LIMITED`, each with
  the provider's `retry-after`; a background run defers on the latter
  without charging an attempt.

### 10.3 Google Gemini

Gemini is configured exactly like OpenAI and Anthropic. The adapter ignores `GEMINI_API_KEY`,
`GOOGLE_API_KEY`, `GOOGLE_GEMINI_BASE_URL` and `GOOGLE_GENAI_USE_VERTEXAI`
if they happen to be set on the host.

1. Create an API key in Google AI Studio (the **Gemini Developer API** — this
   adapter does not use Vertex AI or a service account).
2. On `/admin/settings/ai`, switch the **Google Gemini** provider on (or
   `PUT /api/admin/ai/config` with `providers.gemini.enabled: true`).
   `baseUrl` is optional and only for a gateway that speaks the Gemini API
   itself; leave it empty for `https://generativelanguage.googleapis.com`.
3. Add the admin (org) key on the provider's row (section 4.1) and **Test** it (section 4.2).
   The key is verified by listing models before anything is stored — Google
   answers a bad key with `400 API_KEY_INVALID`, which the platform reports
   as `AI_KEY_INVALID` like any other provider's rejection. The billed
   `responses_smoke` check is one tiny `generateContent` call.
4. Refresh the catalog for `gemini` (section 5):
   `appctl api POST /api/admin/ai/models/refresh --data '{"provider":"gemini"}'`.
   Gemini's model list says more than the others' — token limits, supported
   methods, whether a model thinks — so the classifier uses it: context
   window and output limit come from Google, and an alias such as
   `gemini-flash-latest` is classified from what the listing says about it.
   Image-output, text-to-speech, Live/native-audio, computer-use and
   robotics variants, and Imagen, Veo and Gemma, stay `unclassified` —
   nothing in this platform drives them. Enable the models users should
   see (section 6), including an embedding model (`gemini-embedding-001`) if
   anything calls `POST /api/ai/embeddings`.
5. Users add their own Gemini key on `/settings/ai` exactly as for OpenAI
   (section 8), under the key policy you chose (section 7).

What is different, and worth telling users:

- **No `previousResponseId`**, exactly as for Anthropic (section 10.2): send the
  conversation as `input`; `runTools()` and the AI Playground already do.
- **No hosted tools.** Google Search grounding and code execution are not
  mapped (their results do not fit the platform's citation and
  code-interpreter shapes honestly); the provider row does not list
  **Hosted tools**, and a request with one is refused with
  `AI_CAPABILITY_UNSUPPORTED`.
- **Reasoning.** A reasoning effort becomes Gemini's thinking config — a
  thinking level on Gemini 3 (Pro has only low and high), a thinking-token
  budget on Gemini 2.5. Users see thought summaries, never the raw
  thoughts. Gemini 2.0 and 1.5 do not think and refuse an effort.
- **Structured output with tools** works on Gemini 3 but not on Gemini
  2.5 (refused up front); Gemini 2.0 and 1.5 are not offered structured
  output at all.
- **Stored files** (`storageObjectId` inputs) are sent inline to Gemini;
  nothing is uploaded to Google's Files API, so nothing is left behind
  there. A very large file may exceed Gemini's own inline request limit —
  that answers `AI_INVALID_REQUEST`.
- **Embeddings** accept `dimensions` (Gemini truncates the vector); Google
  reports no token counts for them, so their usage rows carry none.
- **Errors.** `429 RESOURCE_EXHAUSTED` answers as `AI_RATE_LIMITED` with
  Google's own retry delay; `503 UNAVAILABLE` and other 5xx as
  `AI_PROVIDER_UNAVAILABLE`; a background run defers on a rate limit
  without charging an attempt.

### 10.4 Azure OpenAI

Azure OpenAI serves OpenAI's models from your own Azure resource. The
adapter ignores `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`,
`OPENAI_API_VERSION` and `OPENAI_BASE_URL` if they happen to be set on the
host.

1. In the Azure portal, open the Azure OpenAI resource and note its
   **endpoint** (`https://<resource>.openai.azure.com`) and one of its
   **keys**. Deploy the models you want and note each **deployment name**.
2. On `/admin/settings/ai`, fill in the **Azure OpenAI** provider row and
   switch it on (or `PUT /api/admin/ai/config`):

   | Field | Value |
   |---|---|
   | `baseUrl` | The resource endpoint — **https only**, without `/openai` (added for you; typing it anyway is harmless). Required before the provider can be enabled. |
   | `apiVersion` | The `api-version` to call. Empty means `2025-04-01-preview`. Pin a GA version (e.g. `2024-10-21`) if your governance requires one — then also set `apiStyle` to `chat_completions`, since older versions do not serve the Responses API. |
   | `apiStyle` | `responses` (the default) or `chat_completions`. |
   | `deployments` | `{ "<model id>": "<deployment name>" }` for every deployment users should see, e.g. `{ "gpt-4o": "prod-gpt4o", "text-embedding-3-small": "embed" }`. |

   ```bash
   appctl api put /api/admin/ai/config --data '{
     "enabled": true, "keyPolicy": "byok_with_org_fallback", "logPromptContent": false,
     "defaults": { "allowBackgroundRuns": true },
     "providers": { "azure-openai": {
       "enabled": true,
       "baseUrl": "https://contoso.openai.azure.com",
       "apiStyle": "responses",
       "deployments": { "gpt-4o": "prod-gpt4o", "text-embedding-3-small": "embed" } } } }'
   ```

3. Add the resource key as the admin (org) key on the provider's row
   (section 4.1) and **Test** it (section 4.2). The key travels in Azure's `api-key` header.
4. Refresh the catalog for `azure-openai` (section 5). **With a `deployments` map,
   its keys are the model list** — Azure cannot list a resource's
   deployments, and what it can list is every model the region offers,
   deployed or not. Without a map you get that full regional list; enable
   only what is actually deployed, each under a deployment named after the
   model. Model ids classify like OpenAI's (`gpt-35-turbo` and custom names
   stay unclassified — declare them in section 6). Enable the models users
   should see (section 6).
5. Users add their own Azure key on `/settings/ai` (section 8) — it must be a key
   for **this** resource, since the endpoint is the administrator's.

What is different, and worth telling users:

- **No `previousResponseId`** in either API style (as for Anthropic, section 10.2):
  send the conversation as `input`; `runTools()` and the Playground do.
- **No hosted tools**, and no image or audio generation through Azure:
  responses (text, vision, files, tools, structured output, streaming) and
  embeddings only.
- In the `chat_completions` style there is **no reasoning effort** (it is
  refused) and no reasoning summary.

Troubleshooting Azure OpenAI:

| Symptom | Likely cause |
|---|---|
| Save refused, `AI_PROVIDER_SETTINGS_INVALID` on `baseUrl` | Not `https`, or credentials/a `#fragment` in the URL. |
| Save refused, `AI_BASE_URL_REQUIRED` | Enabling with no endpoint. |
| `AI_KEY_INVALID` on test | A key from another resource, or a regenerated key. |
| `AI_MODEL_NOT_REACHABLE` / `AI_INVALID_REQUEST` naming the deployment | The deployment name in `deployments` is wrong, or the model id has no deployment of the same name. |
| `AI_INVALID_REQUEST` on every response | The `api-version` does not serve the Responses API — set `apiStyle` to `chat_completions`, or use a newer `apiVersion`. |
| `AI_PROVIDER_UNAVAILABLE`, `details.providerCode: "redirect_refused"` | The endpoint answered with a redirect; redirects are never followed. Check the endpoint (a custom domain or gateway in front of Azure). |

### 10.5 OpenAI-compatible server (Ollama, vLLM, LM Studio)

The **OpenAI-compatible** provider talks to any server that
speaks OpenAI's API at a base URL you choose — Ollama, vLLM, LM Studio,
llama.cpp's server, a LiteLLM gateway.

1. Run the server where **this API** can reach it, and note its API root
   **including the version segment**:

   | Server | Typical `baseUrl` |
   |---|---|
   | Ollama | `http://ollama.internal:11434/v1` |
   | vLLM (`vllm serve …`) | `http://vllm.internal:8000/v1` |
   | LM Studio (local server) | `http://lmstudio.internal:1234/v1` |

   `http` is allowed (a private network is the usual setup); credentials or a
   `#fragment` in the URL are not. **Pointing the platform at an internal
   host is your decision as an administrator** — only `ai_config:write` can
   make it, and the server is called with exactly what users send it.
   Redirects are never followed, so the URL must be the final one.
2. On `/admin/settings/ai`, fill in the **OpenAI-compatible** provider row
   and switch it on:

   | Field | Value |
   |---|---|
   | `baseUrl` | The API root above. Required before the provider can be enabled. |
   | `apiStyle` | `chat_completions` (the default — every compatible server serves it) or `responses` if yours also serves the Responses API. |
   | `requiresKey` | Leave on (`true`) for a server that checks a key (vLLM `--api-key`, a gateway). Switch **off** (`false`) for one that authenticates nobody (a default Ollama). |

   ```bash
   appctl api put /api/admin/ai/config --data '{
     "enabled": true, "keyPolicy": "byok", "logPromptContent": false,
     "defaults": { "allowBackgroundRuns": true },
     "providers": { "openai-compatible": {
       "enabled": true, "baseUrl": "http://ollama.internal:11434/v1", "requiresKey": false } } }'
   ```

3. **Keys.** With `requiresKey: false` no key is needed anywhere: calls
   carry no credential at all, no user has to add one, the admin **Test**
   and the catalog refresh work without an admin key, and usage is recorded
   with key source **"No key (keyless server)"** (`keySource: "none"`) — per-user and per-model
   limits still apply, the organization-key limits never do. With
   `requiresKey` on, keys work exactly as for OpenAI (sections 4, 7, 8).
4. Refresh the catalog for `openai-compatible` (section 5). Every model the server
   reports is stored **unclassified** — a local model's name says nothing
   reliable about what it can do. Declare each one's capabilities (section 6):
   typically `responses`, `streaming` and `tools`, plus `structured_output`
   if the server enforces JSON schemas, `vision_input` for a vision model,
   and `embeddings` for an embedding model (`nomic-embed-text`). Then enable
   it.

What is different, and worth telling users:

- **No `previousResponseId`** and **no hosted tools**, in either style.
- In the `chat_completions` style there is **no reasoning effort** (refused)
  and no reasoning summary.
- **Stored files** are sent inline (base64); the server never fetches from
  this deployment's storage.
- Only responses (text, vision, tools, structured output, streaming) and
  embeddings — no images or audio through this provider.

Troubleshooting an OpenAI-compatible server:

| Symptom | Likely cause |
|---|---|
| Save refused, `AI_PROVIDER_SETTINGS_INVALID` on `baseUrl` | Not `http`/`https`, or credentials/a `#fragment` in the URL. |
| Save refused, `AI_BASE_URL_REQUIRED` | Enabling with no `baseUrl`. |
| Test: `AI_KEY_INVALID` with `requiresKey` off | The server does check a key — turn `requiresKey` back on and add one. |
| `AI_PROVIDER_UNAVAILABLE`, `details.transport: "connection"` | The API cannot reach the server (DNS, firewall, the server bound to `127.0.0.1` only — Ollama needs `OLLAMA_HOST=0.0.0.0`). |
| `AI_PROVIDER_UNAVAILABLE`, `details.providerCode: "redirect_refused"` | The URL redirects — usually a missing `/v1` or a trailing-slash rule on a proxy. Use the final URL. |
| `AI_INVALID_REQUEST` (404) on every response | `apiStyle` is `responses` but the server serves only Chat Completions — switch it to `chat_completions`. |
| `AI_CAPABILITY_UNSUPPORTED` | A model not yet classified (section 6), a reasoning effort in the Chat Completions style, or a hosted tool. |
| `AI_STRUCTURED_OUTPUT_INVALID` | The server ignored the JSON schema (many do); do not declare `structured_output` for that model. |

## 11. Hosted tools

Under **Hosted tools** on `/admin/settings/ai` there is one switch per
provider-hosted tool — web search, file search, code interpreter, image
generation and remote MCP servers — all **off** on a fresh deployment. Each
reaches outside this deployment (the open web, a third-party MCP server) and
is billed per use by the provider on whichever key pays for the call (section 7), so
switch on only what users need. A request naming a switched-off tool is
refused with `AI_TOOL_DISABLED`; users also need a model that declares
**Hosted tools** on `/admin/settings/ai/models`.

**Allowed MCP hosts** narrows which servers users may point the model at —
one hostname per line (`mcp.example.com`), or `*.example.com` for its
subdomains. Leave it empty to allow any `https://` server (the page warns
while MCP is on with no list). MCP credentials are never configured here:
users send them per request in the tool's `headers`, which are never stored,
logged or returned — and a background run cannot carry them at all.

## 12. Rate limits and output caps

`ai.limits` protects the deployment from runaway request volume, the
organization key from one user draining it, and budgets from runaway
generation. **Nothing is limited on a fresh deployment** — every field is
optional, and an absent field is no limit at all.

| Setting | What it limits |
|---|---|
| `perUser.requestsPerMinute` | Each user's AI calls in any 60 seconds, whoever's key pays. |
| `perUser.requestsPerDay` | Each user's AI calls per UTC day, whoever's key pays. |
| `orgKey.requestsPerDayPerUser` | Each user's calls **paid by the organization key**, per UTC day. Users on their own key are never counted. |
| `orgKey.tokensPerDayPerUser` | Input + output tokens each user may spend **on the organization key** per UTC day. |
| `perModel["openai:<modelId>"].requestsPerMinutePerUser` | Each user's calls to that one model in any 60 seconds. |
| `perModel["openai:<modelId>"].maxOutputTokens` | Caps every call's output tokens for that model. Combined with **Max output tokens** (the deployment cap) — the smaller wins — and applied even when the caller asked for no limit. |

Configure them in the **Limits** section of `/admin/settings/ai` (per-model
fields are in the model's override dialog on `/admin/settings/ai/models`), or
through the API. `limits` in `PUT /api/admin/ai/config` is sent **whole**:
what you send replaces every stored limit, so leaving a field out lifts it,
and `{}` lifts them all; omitting `limits` from the body keeps what is
stored. A per-model key is the provider id, a colon, and the model id exactly
as the catalog lists it:

```bash
curl -X PUT https://app.example.com/api/admin/ai/config \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H "If-Match: $VERSION" \
  -d '{
    "enabled": true, "keyPolicy": "byok_with_org_fallback", "logPromptContent": false,
    "defaults": { "allowBackgroundRuns": true, "maxOutputTokensCap": 4096 },
    "providers": { "openai": { "enabled": true } },
    "limits": {
      "perUser":  { "requestsPerMinute": 20, "requestsPerDay": 1000 },
      "orgKey":   { "requestsPerDayPerUser": 200, "tokensPerDayPerUser": 500000 },
      "perModel": { "openai:gpt-4.1": { "maxOutputTokens": 2048, "requestsPerMinutePerUser": 5 } }
    }
  }'
```

(`appctl api PUT /api/admin/ai/config --data @body.json` sends the same body.) Changes apply
within about five seconds on every API instance, with no restart.

**What users see.** A call over a limit is refused with **429**,
`details.reason: "AI_RATE_LIMITED"`, `details.limit` naming the limit (for
example `"orgKey.tokensPerDayPerUser"`), and a `Retry-After` header: for a
per-minute limit, until enough earlier calls leave the 60-second window; for a
daily one, until midnight UTC. A queued job (a background response, an image,
a transcription, speech) that meets a limit is **deferred and retried then**,
never failed; the queued request itself is counted only when it runs.

**What counts, and how precise it is.** Every call that reaches a provider
counts once — including each step of a tool-calling loop and failed calls —
and a refused call does not. Per-minute limits are exact within one API
instance; with several instances they can be overshot by the calls still in
flight on the others (there is deliberately no Redis; see
[`docs/specs/ai-platform.md`](../specs/ai-platform.md)). Use the **AI Usage** page, not these limits,
for accounting. Catalog refreshes run on the admin key and never count.

## 13. Realtime voice sessions

`POST /api/ai/realtime/sessions` mints a short-lived **ephemeral** provider
secret (OpenAI `ek_…`, 60 seconds to connect). The user's browser uses it to
talk to the provider **directly** over WebRTC. The user's key (or the org key,
under fallback) is spent on the server to mint it and never reaches the
browser. It is **off by default**: once a session is connected, this server
can no longer see, cap or meter the conversation. Switch it on only if you
accept that. On `/admin/settings/ai`, turn on **Allow realtime voice
sessions** under *Defaults* (it needs `ai_config:write`) and save. Or use the
API:

```bash
curl -X PUT https://app.example.com/api/admin/ai/config \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H "If-Match: $VERSION" \
  -d '{ "enabled": true, "keyPolicy": "byok", "logPromptContent": false,
        "defaults": { "allowBackgroundRuns": true, "allowRealtime": true },
        "providers": { "openai": { "enabled": true } } }'
```

(`allowRealtime` omitted from the body keeps the stored value.) Users also
need an **enabled** realtime model (`gpt-realtime*`, `gpt-4o-realtime-preview*`,
`gpt-4o-mini-realtime*`) on `/admin/settings/ai/models`, and a key that
reaches it. `GET /api/ai/config` publishes `allowRealtime`, so the AI
Playground (`/ai`) hides its **Voice** mode while it is off. Each mint counts
as one request against the section 12 limits and is recorded on the **AI Usage** page as operation `realtime`,
`units.sessions` = 1. No tokens are recorded, because the audio never passes
through this server; see the provider's own dashboard for realtime cost. If a
provider base URL is set (a gateway), browsers are sent to that gateway's
`/realtime/calls` too, so it must be reachable from users' browsers.

## 14. Privacy: prompt logging

`ai.logPromptContent` (default **off**) is a deliberate, named privacy
switch — when off, no prompt text (instructions or input) is ever written
to a debug log line. Turning it on is a real decision, not a debugging
convenience left on by accident: prompt content can include anything a user
typed, and every log line derived from a call already redacts key material
unconditionally regardless of this setting (that part is not optional). Even
with it on, logged text is truncated to `AI_PROMPT_LOG_MAX_CHARS`
(2048 characters, `runtime/ai.service.ts`) and the key is never in scope to
log by construction — but the prompt text itself is the user's, so treat
this switch the same way you would treat verbose request logging anywhere
else in the app: on only for as long as you are actively debugging, and off
by default.

## Troubleshooting

Every failure this platform raises is an `AiError` with a stable `code`,
surfaced as `details.reason` on the HTTP response (the envelope's
top-level `code` is always the ordinary status-derived
`FORBIDDEN`/`BAD_REQUEST`/etc. this API already uses everywhere — the AI
code is specifically in `details.reason`). This table is the quick
reference; the full one is in [`docs/specs/ai-platform.md`](../specs/ai-platform.md).

| `details.reason` | HTTP | What it means | What to check |
|---|---|---|---|
| `AI_DISABLED` | 403 | The kill switch is off. | Section 3 — enable AI at `/admin/settings/ai`. |
| `AI_PROVIDER_DISABLED` | 403 | AI is on, but this specific provider is not. | Enable the provider on `/admin/settings/ai`. |
| `AI_KEY_REQUIRED` | 403 | No key resolves for this user/provider under the active policy. | Under `byok`: the user has no key (section 8). Under `byok_with_org_fallback`: neither the user nor the deployment has one (sections 4, 9). |
| `AI_KEY_INVALID` | 400 | A submitted key was rejected by the provider. | The key is wrong, revoked, or scoped incorrectly at the provider. Nothing was stored. |
| `AI_MODEL_NOT_ENABLED` | 403 | The model is unknown, not admin-enabled, or deprecated. | Enable it (or pick an enabled one) on `/admin/settings/ai/models` (section 6). |
| `AI_MODEL_NOT_REACHABLE` | 403 | The model is enabled, but the resolved key can't reach it. | The key's own tier/org restrictions — try `POST /api/ai/keys/:provider/test`, or refresh reachability by re-testing/re-saving the key. |
| `AI_CAPABILITY_UNSUPPORTED` | 400 | The model or provider lacks a capability the request needs (e.g. structured output, a tool, vision input), or the request chains with `previousResponseId` on a provider that stores no responses (Anthropic, Gemini — `details.capability: "previous_response_id"`). | Pick a model/provider that declares it, or drop that part of the request; for Anthropic, Gemini, Azure OpenAI or an OpenAI-compatible server, send the conversation as `input` instead of chaining (section 10). |
| `AI_REALTIME_DISABLED` | 403 | A realtime voice session was requested, but realtime is switched off (the default). | Section 13 — set `defaults.allowRealtime` on `/admin/settings/ai` if you want voice sessions. |
| `AI_TOOL_DISABLED` | 403 | A hosted tool (web search, file search, code interpreter, image generation, MCP) that is switched off, or an MCP server host outside the allowlist. | Section 11 — switch the tool on, or add the host, under **Hosted tools** on `/admin/settings/ai`. |
| `AI_RATE_LIMITED` | 429 | The provider throttled the call, or one of this deployment's own limits was reached — then `details.limit` names which one. | Transient: wait `Retry-After` seconds (also `details.retryAfterMs`). For a background run this defers automatically rather than charging an attempt. If users hit a limit of yours too often, raise it (section 12). |
| `AI_PROVIDER_UNAVAILABLE` | 503 | The provider is unreachable or erroring at the transport level. | A provider-side outage, or `AI_PROVIDER_UNAVAILABLE` after an aborted/cancelled call. Check the provider's own status page. For Azure OpenAI or an OpenAI-compatible server, also the endpoint itself: `details.providerCode: "redirect_refused"` means it answered with a redirect, which is never followed (usually a wrong `baseUrl`), and `details.missing: "baseUrl"` that none is configured (sections 10.4, 10.5). |
| `AI_CONTENT_FILTERED` | 422 | The provider's own content filter rejected the request or response. | Not a platform bug — the provider refused this specific content. |
| `AI_INVALID_REQUEST` | 400 | The request itself is malformed (no model/provider resolvable, a background run given a function tool, an invalid `maxOutputTokens`). | Check the request shape; function tools cannot run in a background run — use `runTools()` in-process instead. |
| `AI_STRUCTURED_OUTPUT_INVALID` | 502 | The model's output didn't parse against the requested schema. | Usually a model/schema mismatch, or a model too weak to reliably follow the schema; consider `strict: true` or a different model. |

Provider-specific symptoms: Azure OpenAI in section 10.4, an OpenAI-compatible
server in section 10.5.

## Summary checklist

**Turning AI on**

- [ ] `SECRETS_ENCRYPTION_KEY` is set on the API
- [ ] Key policy decided: `byok` or `byok_with_org_fallback`
- [ ] AI **Enabled** on `/admin/settings/ai`
- [ ] Each provider you need switched on and configured (section 10)
- [ ] Admin key added and **Test** shows all three checks passing, where the
      provider needs one
- [ ] Catalog refreshed; unclassified models given capabilities; the models
      users should see enabled
- [ ] `ai:use` granted to whoever should use AI beyond Admin and Contributor
- [ ] Hosted tools, realtime and limits set deliberately (sections 11–13)
- [ ] `logPromptContent` left off unless you are actively debugging

**In an emergency**

- [ ] AI toggled off (UI, or `PATCH /api/system-settings`)
- [ ] `/api/ai/*` answers `403 AI_DISABLED`
- [ ] Leaked admin key replaced or removed (section 9)
