// =============================================================================
// Google Gemini provider adapter (issue #447, epic #421)
// =============================================================================
//
// The third real `AiProviderAdapter`, and the third API shape the neutral
// contract has to fit unchanged: Gemini's `generateContent` has a separate
// `systemInstruction`, content PARTS in `user`/`model` turns, function calls
// matched to their responses by NAME, opaque `thoughtSignature`s on parts,
// thinking configured by budget or level, and no server-side conversation
// state. It fits with the two flags #446 introduced and no change to the
// conformance kit's requests or to any `AiService` caller. Pieces:
//
//   gemini-client.factory.ts      one SDK client per call (key, v1beta, no retries)
//   gemini-content.mapper.ts      AiResponseRequest <-> generateContent
//   gemini-stream.mapper.ts       stream chunks -> AiStreamEvent
//   gemini-embeddings.mapper.ts   AiEmbeddingRequest <-> embedContent
//   gemini-errors.ts              SDK / HTTP error -> AiError
//   gemini-model-catalog.ts       classifyModel()'s rule table, enriched by the
//                                 listing's own metadata
//
// PORTS. `responses` and `embeddings`. Images, audio and realtime are ABSENT
// (Gemini's image/speech/Live models are a different API surface this
// adapter does not map) — presence is the declaration.
//
// STATELESS (#446). `supportsPreviousResponseId: false`: the facade refuses a
// caller's `previousResponseId` and the tool loop resends the full history.
// `thoughtSignature`s — required back on a Gemini 3 function-call turn — ride
// on reasoning items as `AI_PROVIDER_STATE`, like Anthropic's thinking
// signatures (see `gemini-content.mapper.ts`, REPLAY).
//
// NO HOSTED TOOLS (#442), `supportsHostedTools: false`. Google Search
// grounding and code execution exist, but neither maps cleanly onto the
// neutral result types, and a lossy mapping is worse than an honest refusal:
//   - grounding cites sources through `vertexaisearch.cloud.google.com`
//     REDIRECT links, not the source URLs `AiWebSearchCallResult.sources`
//     and `AiUrlCitation.url` promise, and locates citations by UTF-8 BYTE
//     offsets per part where `AiUrlCitation` means character offsets into
//     the message text;
//   - code execution has no container (`AiCodeInterpreterCallResult
//     .containerId` is required) and returns plots as inline bytes where the
//     neutral type carries a URL; and Gemini 2.5 cannot combine either tool
//     with function calling.
// A follow-up can map both once the neutral types can say so honestly.
//
// STORAGE-OBJECT INPUTS (#441). `fileInputStrategy` is `inline` for both
// modalities: the runtime reads the bytes (under its 20 MiB image / 50 MiB
// file caps) and they are sent as base64 `inlineData`. A presigned URL is not
// usable as `fileData` (Gemini expects a Files API or Cloud Storage URI
// there), and the Files API would need an upload, a wait for the file to
// become ACTIVE, and a delete — for bytes that fit inline anyway. Nothing is
// uploaded, so nothing is left behind to delete. Gemini's own inline request
// limit is the authority for a very large file: its 400 maps to
// `AI_INVALID_REQUEST`.
//
// OBSERVABILITY. Every provider call runs inside an `ai.provider.call` span
// carrying `ai.provider`, `ai.model`, `ai.operation` and `ai.status` (`ok` or
// the AiErrorCode) — never prompt text, output text or the key — exactly as
// the other adapters' do. No exception is recorded on the span.
// =============================================================================

import type { GenerateContentResponse, GoogleGenAI } from '@google/genai';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import { AiError } from '../../core/ai-error';
import type { AiModelCapabilities } from '../../core/capabilities';
import type {
  AiCallContext,
  AiDiscoveredModel,
  AiDiscoveredModelMetadata,
  AiKeyVerification,
  AiProviderAdapter,
  AiResponsesPort,
} from '../../core/provider-adapter.interface';
import { AiProviderRegistry } from '../../core/provider-registry';
import type { AiFileInputStrategies } from '../../core/types/file-inputs.types';
import type { AiEmbeddingRequest, AiEmbeddingResult, AiEmbeddingsPort } from '../../core/types/media.types';
import type { AiResponse, AiResponseRequest, AiStreamEvent } from '../../core/types/responses.types';
import { resolveServiceName } from '../../../common/otel/service-name';
import { GeminiClientFactory } from './gemini-client.factory';
import {
  type GeminiRequest,
  type GeminiStorageDeliveries,
  type GeminiStorageDelivery,
  fromGeminiResponse,
  geminiStorageObjectIds,
  toGeminiRequest,
} from './gemini-content.mapper';
import { fromGeminiEmbeddingResponse, toGeminiEmbeddingRequest } from './gemini-embeddings.mapper';
import { GEMINI_PROVIDER_ID, mapGeminiError } from './gemini-errors';
import { classifyGeminiModel, geminiModelProfile } from './gemini-model-catalog';
import { GeminiStreamMapper } from './gemini-stream.mapper';

/** The span name every provider adapter uses. */
export const GEMINI_PROVIDER_CALL_SPAN = 'ai.provider.call';

/** Page size for `GET /v1beta/models` — the API's maximum, so a catalog is one request. */
const MODELS_PAGE_SIZE = 1000;

type GeminiOperation = 'models.list' | 'verify_key' | 'generate_content' | 'generate_content.stream' | 'embed_content';

const tracer = trace.getTracer(resolveServiceName());

/** `models/gemini-2.5-flash` -> `gemini-2.5-flash`. */
function stripModelsPrefix(name: string): string {
  return name.startsWith('models/') ? name.slice('models/'.length) : name;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

@Injectable()
export class GeminiProviderAdapter implements AiProviderAdapter, OnModuleInit {
  readonly id = GEMINI_PROVIDER_ID;
  readonly displayName = 'Google Gemini';

  /** Stateless: the runtime resends history instead of chaining (#446). */
  readonly supportsPreviousResponseId = false;

  /** Google Search grounding and code execution are not mapped yet — see the file header. */
  readonly supportsHostedTools = false;

  /** Both modalities inline (base64) — see the file header. */
  readonly fileInputStrategy: AiFileInputStrategies = { image: 'inline', file: 'inline' };

  readonly responses: AiResponsesPort = {
    create: (req, ctx) => this.createResponse(req, ctx),
    stream: (req, ctx) => this.streamResponse(req, ctx),
  };

  readonly embeddings: AiEmbeddingsPort = {
    embed: (req, ctx) => this.embed(req, ctx),
  };

  private readonly logger = new Logger(GeminiProviderAdapter.name);

  constructor(
    private readonly registry: AiProviderRegistry,
    private readonly clients: GeminiClientFactory,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  classifyModel(modelId: string, metadata?: AiDiscoveredModelMetadata): AiModelCapabilities | null {
    return classifyGeminiModel(modelId, metadata);
  }

  /**
   * `GET /v1beta/models`, every page. Each model carries its listing metadata
   * (token limits, supported methods, thinking) for `classifyModel`.
   */
  async listModels(ctx: AiCallContext): Promise<AiDiscoveredModel[]> {
    return this.call('models.list', undefined, ctx, async () => {
      const client = this.clients.create(ctx);
      const pager = await client.models.list({ config: { pageSize: MODELS_PAGE_SIZE, abortSignal: ctx.signal } });
      const models: AiDiscoveredModel[] = [];

      for await (const model of pager) {
        if (!model.name) continue;

        const metadata: AiDiscoveredModelMetadata = {};
        const input = positiveInt(model.inputTokenLimit);
        const output = positiveInt(model.outputTokenLimit);

        if (model.displayName) metadata.displayName = model.displayName;
        if (input !== undefined) metadata.inputTokenLimit = input;
        if (output !== undefined) metadata.outputTokenLimit = output;
        if (Array.isArray(model.supportedActions)) metadata.supportedActions = [...model.supportedActions];
        if (typeof model.thinking === 'boolean') metadata.thinking = model.thinking;

        models.push({ id: stripModelsPrefix(model.name), ownedBy: 'google', metadata });
      }

      return models;
    });
  }

  /**
   * `GET /v1beta/models?pageSize=1` with the key. A rejected key is an ANSWER
   * (`{ ok: false, code: 'AI_KEY_INVALID' }`), as is any other failure.
   */
  async verifyKey(ctx: AiCallContext): Promise<AiKeyVerification> {
    try {
      await this.call('verify_key', undefined, ctx, async () => {
        const client = this.clients.create(ctx);

        await client.models.list({ config: { pageSize: 1, abortSignal: ctx.signal } });
      });

      return { ok: true };
    } catch (err) {
      const mapped = mapGeminiError(err, { signal: ctx.signal });

      return mapped.code === 'AI_KEY_INVALID'
        ? { ok: false, code: 'AI_KEY_INVALID' }
        : { ok: false, code: mapped.code, detail: mapped.message };
    }
  }

  // ---- responses port -------------------------------------------------------

  private async plan(req: AiResponseRequest, ctx: AiCallContext): Promise<GeminiRequest> {
    return toGeminiRequest(req, geminiModelProfile(req.model), await this.deliverStorageInputs(req, ctx));
  }

  private createResponse(req: AiResponseRequest, ctx: AiCallContext): Promise<AiResponse> {
    return this.call('generate_content', req.model, ctx, async () => {
      const plan = await this.plan(req, ctx);
      const client = this.clients.create(ctx);

      const response = await client.models.generateContent({
        model: plan.model,
        contents: plan.contents,
        config: { ...plan.config, abortSignal: ctx.signal },
      });

      return fromGeminiResponse(response, req);
    });
  }

  /**
   * Streams one response. A failure BEFORE `response.created` (a rejected
   * key, a 429, an unsupported request) is thrown as an `AiError`; once the
   * stream has started, a failure ends it with exactly one `error` event.
   *
   * `ctx.signal` aborts the request; a consumer that stops iterating
   * (`break`) aborts it too — the SDK's own iterator only releases its reader,
   * so the adapter holds an abort controller of its own for that.
   */
  private async *streamResponse(req: AiResponseRequest, ctx: AiCallContext): AsyncGenerator<AiStreamEvent> {
    const started = Date.now();
    const span = this.startSpan('generate_content.stream', req.model);
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    let status = 'ok';
    let terminated = false;

    if (ctx.signal?.aborted) controller.abort();
    else ctx.signal?.addEventListener('abort', onCallerAbort, { once: true });

    try {
      const plan = await this.plan(req, ctx);
      const client: GoogleGenAI = this.clients.create(ctx);
      let chunks: AsyncGenerator<GenerateContentResponse>;

      try {
        chunks = await client.models.generateContentStream({
          model: plan.model,
          contents: plan.contents,
          config: { ...plan.config, abortSignal: controller.signal },
        });
      } catch (err) {
        throw mapGeminiError(err, { signal: ctx.signal });
      }

      const mapper = new GeminiStreamMapper({ request: req });

      try {
        for await (const chunk of chunks) {
          for (const out of mapper.map(chunk)) {
            if (out.type === 'error') status = out.code;
            yield out;
          }

          if (mapper.terminated) break;
        }
      } catch (err) {
        const mapped = mapGeminiError(err, { signal: ctx.signal });

        if (!mapper.started) throw mapped;

        status = mapped.code;

        yield* mapper.fail(mapped);
      }

      if (!mapper.terminated) {
        if (ctx.signal?.aborted) {
          throw new AiError('AI_PROVIDER_UNAVAILABLE', 'The AI request was cancelled.', {
            details: { provider: GEMINI_PROVIDER_ID, aborted: true },
          });
        }

        if (mapper.finished) {
          for (const out of mapper.complete()) {
            if (out.type === 'error') status = out.code;
            yield out;
          }
        } else {
          const truncated = new AiError(
            'AI_PROVIDER_UNAVAILABLE',
            'The Gemini stream ended before the response completed.',
            { details: { provider: GEMINI_PROVIDER_ID } },
          );

          if (!mapper.started) throw truncated;

          status = truncated.code;

          yield* mapper.fail(truncated);
        }
      }

      terminated = mapper.terminated;
    } catch (err) {
      const mapped = mapGeminiError(err, { signal: ctx.signal });

      status = mapped.code;

      throw mapped;
    } finally {
      ctx.signal?.removeEventListener('abort', onCallerAbort);
      // A consumer that stopped early leaves the HTTP stream open: close it.
      if (!terminated) controller.abort();

      this.endSpan(span, status);
      this.logCall('generate_content.stream', req.model, ctx, status, started);
    }
  }

  // ---- embeddings port ------------------------------------------------------

  /** `embedContent` (`batchEmbedContents` on the wire), one content per input. */
  private embed(req: AiEmbeddingRequest, ctx: AiCallContext): Promise<AiEmbeddingResult> {
    return this.call('embed_content', req.model, ctx, async () => {
      const params = toGeminiEmbeddingRequest(req, geminiModelProfile(req.model));
      const client = this.clients.create(ctx);

      const response = await client.models.embedContent({
        model: params.model,
        contents: params.contents,
        config: { ...params.config, abortSignal: ctx.signal },
      });

      return fromGeminiEmbeddingResponse(response, req);
    });
  }

  // ---- storage-object inputs (#441) ------------------------------------------

  /**
   * The bytes of each storage-object part of `req`, read under the runtime's
   * cap for inline delivery. `undefined` when the request names no storage
   * object.
   */
  private async deliverStorageInputs(
    req: AiResponseRequest,
    ctx: AiCallContext,
  ): Promise<GeminiStorageDeliveries | undefined> {
    const ids = geminiStorageObjectIds(req);

    if (ids.length === 0) return undefined;

    const deliveries = new Map<string, GeminiStorageDelivery>();

    for (const id of ids) {
      const input = ctx.storageInputs?.get(id);

      if (!input) {
        throw new AiError('AI_INVALID_REQUEST', 'A storage-object input was not resolved by the runtime.', {
          details: { provider: GEMINI_PROVIDER_ID },
        });
      }

      if (input.strategy !== 'inline' || !input.read) {
        throw new AiError('AI_INVALID_REQUEST', 'A storage-object input was not prepared for delivery.', {
          details: { provider: GEMINI_PROVIDER_ID, strategy: input.strategy },
        });
      }

      const payload = await input.read();

      deliveries.set(id, {
        modality: input.modality,
        mimeType: input.mimeType,
        filename: input.filename,
        data: payload.data,
      });
    }

    return deliveries;
  }

  // ---- telemetry ------------------------------------------------------------

  private startSpan(operation: GeminiOperation, model: string | undefined): Span {
    return tracer.startSpan(GEMINI_PROVIDER_CALL_SPAN, {
      kind: SpanKind.CLIENT,
      attributes: {
        'ai.provider': GEMINI_PROVIDER_ID,
        'ai.operation': operation,
        ...(model ? { 'ai.model': model } : {}),
      },
    });
  }

  private endSpan(span: Span, status: string): void {
    span.setAttribute('ai.status', status);
    span.setStatus(status === 'ok' ? { code: SpanStatusCode.OK } : { code: SpanStatusCode.ERROR, message: status });
    span.end();
  }

  /** ⚠ Only ids, the model, the operation, the outcome and a duration. Never the key or a body. */
  private logCall(
    operation: GeminiOperation,
    model: string | undefined,
    ctx: AiCallContext,
    status: string,
    started: number,
  ): void {
    this.logger.debug({
      msg: 'AI provider call',
      provider: GEMINI_PROVIDER_ID,
      operation,
      model,
      status,
      requestId: ctx.requestId,
      durationMs: Date.now() - started,
    });
  }

  /** Runs `fn` inside an `ai.provider.call` span, mapping any failure to `AiError`. */
  private async call<T>(
    operation: GeminiOperation,
    model: string | undefined,
    ctx: AiCallContext,
    fn: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    const span = this.startSpan(operation, model);
    let status = 'ok';

    try {
      return await fn();
    } catch (err) {
      const mapped = mapGeminiError(err, { signal: ctx.signal });

      status = mapped.code;

      throw mapped;
    } finally {
      this.endSpan(span, status);
      this.logCall(operation, model, ctx, status, started);
    }
  }
}
