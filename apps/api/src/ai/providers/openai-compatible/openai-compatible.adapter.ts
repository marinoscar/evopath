// =============================================================================
// OpenAI-compatible provider adapter (issue #448, epic #421)
// =============================================================================
//
// Any server speaking OpenAI's wire protocol at an administrator-chosen base
// URL — Ollama, vLLM, LM Studio, llama.cpp's server, a LiteLLM gateway. Like
// the Azure adapter this is composition over the OpenAI adapter's shared
// pieces (`../openai/`), not a new mapping:
//
//   openai-compatible-settings.ts        the slot's apiStyle / requiresKey
//   openai-compatible-client.factory.ts  OpenAI SDK per call at `baseUrl`, no
//                                        redirects, no credential when keyless
//   ../openai/openai-chat-completions.engine.ts  apiStyle 'chat_completions' (default)
//   ../openai/openai-responses.engine.ts         apiStyle 'responses'
//
// GRACEFUL DEGRADATION. Compatible servers almost always serve Chat
// Completions and rarely the Responses API, so `chat_completions` is the
// default and `responses` an opt-in. Chat Completions has no reasoning
// summaries or effort (an effort is refused), no stored responses and no
// hosted tools; the adapter's static flags say so for both styles.
//
// CLASSIFICATION. `GET {baseUrl}/models` returns ids and nothing about what a
// model can do, and the ids are whatever the server was loaded with
// (`llama3.1:8b`, `Qwen/Qwen2.5-7B-Instruct`). `classifyModel` therefore
// answers `null` for EVERY id: each discovered model is stored
// `unclassified`, and an administrator declares its capabilities in the
// Models UI (an `admin_override`) before enabling it. Guessing would be worse.
//
// KEYLESS (`requiresKey: false`). The key resolver answers `keySource:
// 'none'` with the `AI_KEYLESS_API_KEY` marker, and the client factory then
// sends no credential at all. See docs/specs/ai-platform.md §2.24.
//
// PORTS. `responses` and `embeddings` (`POST {baseUrl}/embeddings` — Ollama,
// vLLM and LM Studio all serve it, through the same mapper OpenAI uses).
// Images and audio are absent: compatible servers rarely serve them, and
// presence is the declaration.
//
// STORAGE-OBJECT INPUTS (#441). Both modalities `inline` (a base64 `data:`
// URL): a self-hosted server usually cannot reach this deployment's object
// storage, and `data:` images are what Ollama and vLLM accept.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import type { AiModelCapabilities } from '../../core/capabilities';
import type {
  AiCallContext,
  AiDiscoveredModel,
  AiKeyVerification,
  AiProviderAdapter,
  AiResponsesPort,
} from '../../core/provider-adapter.interface';
import { AiProviderRegistry } from '../../core/provider-registry';
import type { AiFileInputStrategies } from '../../core/types/file-inputs.types';
import type { AiEmbeddingRequest, AiEmbeddingResult, AiEmbeddingsPort } from '../../core/types/media.types';
import type { AiResponse, AiResponseRequest, AiStreamEvent } from '../../core/types/responses.types';
import { OpenAiCallTelemetry } from '../openai/openai-call-telemetry';
import { OpenAiChatCompletionsEngine } from '../openai/openai-chat-completions.engine';
import { fromOpenAiEmbeddingResponse, toOpenAiEmbeddingRequest } from '../openai/openai-embeddings.mapper';
import { mapOpenAiError } from '../openai/openai-errors';
import { assertNoHostedTools } from '../openai/openai-family-guards';
import { OpenAiResponsesEngine } from '../openai/openai-responses.engine';
import { OpenAiCompatibleClientFactory } from './openai-compatible-client.factory';
import {
  OPENAI_COMPATIBLE_FAMILY,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleSettings,
} from './openai-compatible-settings';

@Injectable()
export class OpenAiCompatibleProviderAdapter implements AiProviderAdapter, OnModuleInit {
  readonly id = OPENAI_COMPATIBLE_PROVIDER_ID;
  readonly displayName = 'OpenAI-compatible';

  /** Chat Completions stores nothing; declared for both styles — see the file header. */
  readonly supportsPreviousResponseId = false;

  /** No compatible server is assumed to run hosted tools. */
  readonly supportsHostedTools = false;

  /** Inline for both modalities — see the file header. */
  readonly fileInputStrategy: AiFileInputStrategies = { image: 'inline', file: 'inline' };

  readonly responses: AiResponsesPort = {
    create: (req, ctx) => this.create(req, ctx),
    stream: (req, ctx) => this.stream(req, ctx),
  };

  readonly embeddings: AiEmbeddingsPort = {
    embed: (req, ctx) => this.embed(req, ctx),
  };

  private readonly logger = new Logger(OpenAiCompatibleProviderAdapter.name);
  private readonly telemetry = new OpenAiCallTelemetry(OPENAI_COMPATIBLE_FAMILY, this.logger);
  private readonly responsesEngine: OpenAiResponsesEngine;
  private readonly chatEngine: OpenAiChatCompletionsEngine;

  constructor(
    private readonly registry: AiProviderRegistry,
    private readonly clients: OpenAiCompatibleClientFactory,
  ) {
    const client = (ctx: AiCallContext) => this.clients.create(ctx);

    this.responsesEngine = new OpenAiResponsesEngine({
      family: OPENAI_COMPATIBLE_FAMILY,
      telemetry: this.telemetry,
      logger: this.logger,
      client,
      classify: () => null,
    });
    this.chatEngine = new OpenAiChatCompletionsEngine({
      family: OPENAI_COMPATIBLE_FAMILY,
      telemetry: this.telemetry,
      client,
      // The name every compatible server understands.
      tokenParameter: 'max_tokens',
    });
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** Always unclassified — see the file header. */
  classifyModel(): AiModelCapabilities | null {
    return null;
  }

  async listModels(ctx: AiCallContext): Promise<AiDiscoveredModel[]> {
    return this.telemetry.call('models.list', undefined, ctx, async () => {
      const models: AiDiscoveredModel[] = [];

      for await (const model of this.clients.create(ctx).models.list({ signal: ctx.signal })) {
        models.push({
          id: model.id,
          ...(model.owned_by ? { ownedBy: model.owned_by } : {}),
          ...(typeof model.created === 'number' && model.created > 0
            ? { createdAt: new Date(model.created * 1000) }
            : {}),
        });
      }

      return models;
    });
  }

  /**
   * `GET {baseUrl}/models`. For a keyless server this proves the server is
   * reachable; for any other it also proves the key. Failures are answers.
   */
  async verifyKey(ctx: AiCallContext): Promise<AiKeyVerification> {
    try {
      await this.telemetry.call('verify_key', undefined, ctx, async () => {
        await this.clients.create(ctx).models.list({ signal: ctx.signal });
      });

      return { ok: true };
    } catch (err) {
      const mapped = mapOpenAiError(err, OPENAI_COMPATIBLE_FAMILY);

      return mapped.code === 'AI_KEY_INVALID'
        ? { ok: false, code: 'AI_KEY_INVALID' }
        : { ok: false, code: mapped.code, detail: mapped.message };
    }
  }

  // ---- responses port -------------------------------------------------------

  private create(req: AiResponseRequest, ctx: AiCallContext): Promise<AiResponse> {
    assertNoHostedTools(req, this.id);

    return openAiCompatibleSettings(ctx.providerSettings).apiStyle === 'responses'
      ? this.responsesEngine.create(req, ctx)
      : this.chatEngine.create(req, ctx);
  }

  private stream(req: AiResponseRequest, ctx: AiCallContext): AsyncIterable<AiStreamEvent> {
    const run = () =>
      openAiCompatibleSettings(ctx.providerSettings).apiStyle === 'responses'
        ? this.responsesEngine.stream(req, ctx)
        : this.chatEngine.stream(req, ctx);

    return (async function* () {
      assertNoHostedTools(req, OPENAI_COMPATIBLE_PROVIDER_ID);

      yield* run();
    })();
  }

  // ---- embeddings port ------------------------------------------------------

  /** `POST {baseUrl}/embeddings`, floats on the wire. */
  private embed(req: AiEmbeddingRequest, ctx: AiCallContext): Promise<AiEmbeddingResult> {
    return this.telemetry.call('embeddings.create', req.model, ctx, async () => {
      const { data, request_id } = await this.clients
        .create(ctx)
        .embeddings.create(toOpenAiEmbeddingRequest(req, OPENAI_COMPATIBLE_FAMILY), { signal: ctx.signal })
        .withResponse();

      return fromOpenAiEmbeddingResponse(data, {
        request: req,
        providerRequestId: request_id,
        family: OPENAI_COMPATIBLE_FAMILY,
      });
    });
  }
}
