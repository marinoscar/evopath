// =============================================================================
// OpenAI provider adapter (issue #426, epic #419)
// =============================================================================
//
// The first real `AiProviderAdapter`: OpenAI through its Responses API, with
// the official SDK hidden completely behind the neutral contract. Pieces:
//
//   openai-client.factory.ts     one SDK client per call (key, maxRetries 0)
//   openai-call-telemetry.ts     the `ai.provider.call` span + debug line
//   openai-responses.engine.ts   create/stream + storage delivery (#441)
//   openai-responses.mapper.ts   AiResponseRequest <-> Responses API
//   openai-stream.mapper.ts      stream events -> AiStreamEvent
//   openai-errors.ts             SDK error -> AiError
//   openai-model-catalog.ts      classifyModel()'s rule table
//   openai-embeddings.mapper.ts  AiEmbeddingRequest <-> /v1/embeddings
//   openai-images.mapper.ts      AiImage*Request <-> /v1/images/{generations,edits}
//   openai-audio.mapper.ts       AiTranscriptionRequest <-> /v1/audio/transcriptions,
//                                AiSpeechRequest <-> /v1/audio/speech
//   openai-realtime.mapper.ts    AiRealtimeSessionRequest <-> /v1/realtime/client_secrets
//
// PORTS. `responses`, `embeddings` (#440), `images` (#437, generate AND
// edit), `audio` (#438 `transcribe`, #439 `speech` + its static `voices`)
// and `realtime` (#449 `createSession` + its static `voices`) are carried —
// presence is the declaration, so `AiProviderRegistry.supports()` stays
// truthful about what this adapter can actually do.
//
// REALTIME (#449). `createSession` spends the call's key ONCE, as the
// `Authorization` header of `POST /v1/realtime/client_secrets`, and returns
// the EPHEMERAL secret OpenAI mints — the one value this adapter hands back
// that a browser may hold. It is never logged and never put on a span; the
// debug line carries the same ids and outcome every other call's does.
//
// STORAGE-OBJECT INPUTS (#441). `fileInputStrategy` is images by
// `presigned_url` (a 10-minute signed GET the runtime minted, passed as
// `image_url` — OpenAI fetches it, the bytes never pass through the API) and
// files by `upload`: the runtime's capped stream goes to the Files API
// (`purpose: 'user_data'`) under the caller's own resolved key, the request
// names it by `file_id`, and the provider-side copy is DELETED once the
// response completes, fails or its stream ends — best effort, logged by file
// id only. Nothing is cached across calls (or users): each call uploads its
// own copy.
//
// OBSERVABILITY. Every provider call runs inside an `ai.provider.call` span
// carrying `ai.provider`, `ai.model`, `ai.operation` and `ai.status` (`ok` or
// the AiErrorCode) — never prompt text, output text or the key. The debug log
// line carries the same four facts plus the request ids and duration. No
// exception is recorded on the span: an SDK error's message can echo a
// masked key.
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
import type {
  AiAudioPort,
  AiEmbeddingRequest,
  AiEmbeddingResult,
  AiEmbeddingsPort,
  AiImageEditRequest,
  AiImageGenerationRequest,
  AiImageResult,
  AiImagesPort,
  AiRealtimePort,
  AiRealtimeSession,
  AiRealtimeSessionRequest,
  AiSpeechRequest,
  AiSpeechResult,
  AiTranscriptionRequest,
  AiTranscriptionResult,
} from '../../core/types/media.types';
import type { AiFileInputStrategies } from '../../core/types/file-inputs.types';
import {
  fromOpenAiSpeechResponse,
  fromOpenAiTranscriptionResponse,
  OPENAI_TRANSCRIPTION_MAX_BYTES,
  toOpenAiSpeechRequest,
  toOpenAiTranscriptionRequest,
} from './openai-audio.mapper';
import { OpenAiClientFactory } from './openai-client.factory';
import { fromOpenAiEmbeddingResponse, toOpenAiEmbeddingRequest } from './openai-embeddings.mapper';
import { OpenAiCallTelemetry } from './openai-call-telemetry';
import { mapOpenAiError, OPENAI_FAMILY, OPENAI_PROVIDER_ID } from './openai-errors';
import {
  fromOpenAiImagesResponse,
  toOpenAiImageEditRequest,
  toOpenAiImageGenerateRequest,
} from './openai-images.mapper';
import { classifyOpenAiModel, OPENAI_REALTIME_VOICES, OPENAI_SPEECH_VOICES } from './openai-model-catalog';
import { fromOpenAiClientSecretResponse, toOpenAiClientSecretRequest } from './openai-realtime.mapper';
import { OpenAiResponsesEngine } from './openai-responses.engine';

export { AI_PROVIDER_CALL_SPAN } from './openai-call-telemetry';

@Injectable()
export class OpenAiProviderAdapter implements AiProviderAdapter, OnModuleInit {
  readonly id = OPENAI_PROVIDER_ID;
  readonly displayName = 'OpenAI';

  /** Images by presigned URL, files through the Files API — see the file header. */
  readonly fileInputStrategy: AiFileInputStrategies = { image: 'presigned_url', file: 'upload' };

  readonly responses: AiResponsesPort = {
    create: (req, ctx) => this.responsesEngine.create(req, ctx),
    stream: (req, ctx) => this.responsesEngine.stream(req, ctx),
  };

  readonly embeddings: AiEmbeddingsPort = {
    embed: (req, ctx) => this.embed(req, ctx),
  };

  readonly images: AiImagesPort = {
    generate: (req, ctx) => this.generateImages(req, ctx),
    edit: (req, ctx) => this.editImages(req, ctx),
  };

  readonly audio: AiAudioPort = {
    transcribe: (req, ctx) => this.transcribe(req, ctx),
    transcriptionMaxBytes: OPENAI_TRANSCRIPTION_MAX_BYTES,
    speech: (req, ctx) => this.speak(req, ctx),
    voices: OPENAI_SPEECH_VOICES,
  };

  readonly realtime: AiRealtimePort = {
    createSession: (req, ctx) => this.createRealtimeSession(req, ctx),
    voices: OPENAI_REALTIME_VOICES,
  };

  private readonly logger = new Logger(OpenAiProviderAdapter.name);
  private readonly telemetry = new OpenAiCallTelemetry(OPENAI_FAMILY, this.logger);
  private readonly responsesEngine: OpenAiResponsesEngine;

  constructor(
    private readonly registry: AiProviderRegistry,
    private readonly clients: OpenAiClientFactory,
  ) {
    this.responsesEngine = new OpenAiResponsesEngine({
      family: OPENAI_FAMILY,
      telemetry: this.telemetry,
      logger: this.logger,
      client: (ctx) => this.clients.create(ctx),
      classify: (modelId) => this.classifyModel(modelId),
    });
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  classifyModel(modelId: string): AiModelCapabilities | null {
    return classifyOpenAiModel(modelId);
  }

  async listModels(ctx: AiCallContext): Promise<AiDiscoveredModel[]> {
    return this.telemetry.call('models.list', undefined, ctx, async () => {
      const client = this.clients.create(ctx);
      const models: AiDiscoveredModel[] = [];

      for await (const model of client.models.list({ signal: ctx.signal })) {
        models.push({
          id: model.id,
          ownedBy: model.owned_by,
          ...(typeof model.created === 'number' ? { createdAt: new Date(model.created * 1000) } : {}),
        });
      }

      return models;
    });
  }

  /**
   * `GET /v1/models` with the key. A rejected key is an ANSWER
   * (`{ ok: false, code: 'AI_KEY_INVALID' }`), as is any other failure —
   * mapped to its code — so the admin UI never has to catch.
   */
  async verifyKey(ctx: AiCallContext): Promise<AiKeyVerification> {
    try {
      await this.telemetry.call('verify_key', undefined, ctx, async () => {
        const client = this.clients.create(ctx);

        await client.models.list({ signal: ctx.signal });
      });

      return { ok: true };
    } catch (err) {
      const mapped = mapOpenAiError(err);

      return mapped.code === 'AI_KEY_INVALID'
        ? { ok: false, code: 'AI_KEY_INVALID' }
        : { ok: false, code: mapped.code, detail: mapped.message };
    }
  }

  // ---- embeddings port ------------------------------------------------------

  /** `POST /v1/embeddings`, floats on the wire — see `openai-embeddings.mapper.ts`. */
  private embed(req: AiEmbeddingRequest, ctx: AiCallContext): Promise<AiEmbeddingResult> {
    return this.telemetry.call('embeddings.create', req.model, ctx, async () => {
      const body = toOpenAiEmbeddingRequest(req);
      const client = this.clients.create(ctx);

      const { data, request_id } = await client.embeddings.create(body, { signal: ctx.signal }).withResponse();

      return fromOpenAiEmbeddingResponse(data, { request: req, providerRequestId: request_id });
    });
  }

  // ---- images port ------------------------------------------------------------

  /** `POST /v1/images/generations`, always answered as base64 bytes — see `openai-images.mapper.ts`. */
  private generateImages(req: AiImageGenerationRequest, ctx: AiCallContext): Promise<AiImageResult> {
    return this.telemetry.call('images.generate', req.model, ctx, async () => {
      const body = toOpenAiImageGenerateRequest(req);
      const client = this.clients.create(ctx);

      const { data, request_id } = await client.images.generate(body, { signal: ctx.signal }).withResponse();

      return fromOpenAiImagesResponse(data, { request: req, providerRequestId: request_id });
    });
  }

  /** `POST /v1/images/edits` (multipart: the source images and the optional mask). */
  private editImages(req: AiImageEditRequest, ctx: AiCallContext): Promise<AiImageResult> {
    return this.telemetry.call('images.edit', req.model, ctx, async () => {
      const body = await toOpenAiImageEditRequest(req);
      const client = this.clients.create(ctx);

      const { data, request_id } = await client.images.edit(body, { signal: ctx.signal }).withResponse();

      return fromOpenAiImagesResponse(data, { request: req, providerRequestId: request_id });
    });
  }

  // ---- audio port -------------------------------------------------------------

  /**
   * `POST /v1/audio/transcriptions` (multipart). A streamed input is sent as
   * it is read — see `openai-audio.mapper.ts`.
   */
  private transcribe(req: AiTranscriptionRequest, ctx: AiCallContext): Promise<AiTranscriptionResult> {
    return this.telemetry.call('audio.transcribe', req.model, ctx, async () => {
      const body = await toOpenAiTranscriptionRequest(req);
      const client = this.clients.create(ctx);

      const { data, request_id } = await client.audio.transcriptions
        .create(body, { signal: ctx.signal })
        .withResponse();

      return fromOpenAiTranscriptionResponse(data, { request: req, providerRequestId: request_id });
    });
  }

  /** `POST /v1/audio/speech` — the answer is the audio file itself. */
  private speak(req: AiSpeechRequest, ctx: AiCallContext): Promise<AiSpeechResult> {
    return this.telemetry.call('audio.speech', req.model, ctx, async () => {
      const body = toOpenAiSpeechRequest(req);
      const client = this.clients.create(ctx);

      const { data, request_id } = await client.audio.speech.create(body, { signal: ctx.signal }).withResponse();
      const bytes = new Uint8Array(await data.arrayBuffer());

      return fromOpenAiSpeechResponse(bytes, { request: req, providerRequestId: request_id });
    });
  }

  // ---- realtime port -----------------------------------------------------------

  /**
   * `POST /v1/realtime/client_secrets` — mints the ephemeral secret a browser
   * opens one WebRTC session with (`openai-realtime.mapper.ts`). The call's
   * key is the request's `Authorization` header and goes nowhere else.
   */
  private createRealtimeSession(req: AiRealtimeSessionRequest, ctx: AiCallContext): Promise<AiRealtimeSession> {
    return this.telemetry.call('realtime.client_secret', req.model, ctx, async () => {
      const body = toOpenAiClientSecretRequest(req);
      const client = this.clients.create(ctx);

      const { data, request_id } = await client.realtime.clientSecrets
        .create(body, { signal: ctx.signal })
        .withResponse();

      return fromOpenAiClientSecretResponse(data, {
        request: req,
        baseUrl: ctx.baseUrl,
        providerRequestId: request_id,
      });
    });
  }
}
