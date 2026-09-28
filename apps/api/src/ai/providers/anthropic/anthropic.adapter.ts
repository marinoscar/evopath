// =============================================================================
// Anthropic provider adapter (issue #446, epic #421)
// =============================================================================
//
// The second real `AiProviderAdapter`, and the one that proves the contract
// is provider-neutral: Anthropic's Messages API differs from the Responses
// API in almost every respect that matters (a separate system prompt,
// content blocks, signed `thinking` blocks, `tool_use`/`tool_result`, a
// required `max_tokens`, and no server-side conversation state), and it fits
// the neutral types with one declared flag and no change to the conformance
// kit's requests or to any `AiService` caller. Pieces:
//
//   anthropic-client.factory.ts     one SDK client per call (key, maxRetries 0)
//   anthropic-messages.mapper.ts    AiResponseRequest <-> Messages API
//   anthropic-stream.mapper.ts      stream events -> AiStreamEvent
//   anthropic-errors.ts             SDK error -> AiError
//   anthropic-model-catalog.ts      classifyModel()'s rule table + per-family profile
//
// PORTS. `responses` only. Anthropic has no embeddings, image-generation or
// audio endpoints, so `embeddings`, `images`, `audio` and `realtime` are
// ABSENT — presence is the declaration, and `AiProviderRegistry.supports()`
// stays truthful. `supportsHostedTools: false` keeps it truthful for the one
// capability that rides on the responses port without a port of its own:
// Anthropic's server tools are a different set, and none is mapped yet.
//
// STATELESS (#446). `supportsPreviousResponseId: false`: Anthropic stores no
// response to chain onto. The facade refuses a caller's `previousResponseId`
// and the tool loop resends the full history instead — see
// `AiProviderAdapter.supportsPreviousResponseId`. The request mapper refuses
// it too, as defence in depth for a direct port caller.
//
// STORAGE-OBJECT INPUTS (#441). `fileInputStrategy` is images by
// `presigned_url` (a 10-minute signed GET the runtime minted, passed as an
// `image` URL source — Anthropic fetches it) and files `inline` (the bytes,
// read under the runtime's cap, sent as a base64 PDF or plain-text
// `document`). Nothing is uploaded to Anthropic, so there is nothing to
// delete afterwards.
//
// OBSERVABILITY. Every provider call runs inside an `ai.provider.call` span
// carrying `ai.provider`, `ai.model`, `ai.operation` and `ai.status` (`ok` or
// the AiErrorCode) — never prompt text, output text or the key — exactly as
// the OpenAI adapter's do. No exception is recorded on the span.
// =============================================================================

import type { Anthropic } from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import { AiError } from '../../core/ai-error';
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
import type { AiResponse, AiResponseRequest, AiStreamEvent } from '../../core/types/responses.types';
import { resolveServiceName } from '../../../common/otel/service-name';
import { AnthropicClientFactory } from './anthropic-client.factory';
import { ANTHROPIC_PROVIDER_ID, mapAnthropicError } from './anthropic-errors';
import {
  type AnthropicRequestPlan,
  type AnthropicStorageDeliveries,
  type AnthropicStorageDelivery,
  anthropicStorageObjectIds,
  fromAnthropicMessage,
  toAnthropicRequest,
} from './anthropic-messages.mapper';
import { anthropicModelProfile, classifyAnthropicModel } from './anthropic-model-catalog';
import { AnthropicStreamMapper } from './anthropic-stream.mapper';

/** The span name every provider adapter uses (`OpenAiProviderAdapter`'s too). */
export const ANTHROPIC_PROVIDER_CALL_SPAN = 'ai.provider.call';

/** Page size for `GET /v1/models` — Anthropic's maximum, so a catalog is one or two requests. */
const MODELS_PAGE_SIZE = 1000;

type AnthropicOperation = 'models.list' | 'verify_key' | 'messages.create' | 'messages.stream';

const tracer = trace.getTracer(resolveServiceName());

@Injectable()
export class AnthropicProviderAdapter implements AiProviderAdapter, OnModuleInit {
  readonly id = ANTHROPIC_PROVIDER_ID;
  readonly displayName = 'Anthropic';

  /** Stateless: the runtime resends history instead of chaining (#446). */
  readonly supportsPreviousResponseId = false;

  /** None of the neutral hosted tools are mapped — the mapper refuses them. */
  readonly supportsHostedTools = false;

  /** Images by presigned URL, documents inline — see the file header. */
  readonly fileInputStrategy: AiFileInputStrategies = { image: 'presigned_url', file: 'inline' };

  readonly responses: AiResponsesPort = {
    create: (req, ctx) => this.createResponse(req, ctx),
    stream: (req, ctx) => this.streamResponse(req, ctx),
  };

  private readonly logger = new Logger(AnthropicProviderAdapter.name);

  constructor(
    private readonly registry: AiProviderRegistry,
    private readonly clients: AnthropicClientFactory,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  classifyModel(modelId: string): AiModelCapabilities | null {
    return classifyAnthropicModel(modelId);
  }

  /** `GET /v1/models`, every page. */
  async listModels(ctx: AiCallContext): Promise<AiDiscoveredModel[]> {
    return this.call('models.list', undefined, ctx, async () => {
      const client = this.clients.create(ctx);
      const models: AiDiscoveredModel[] = [];

      for await (const model of client.models.list({ limit: MODELS_PAGE_SIZE }, { signal: ctx.signal })) {
        const created = model.created_at ? new Date(model.created_at) : undefined;

        models.push({
          id: model.id,
          ownedBy: ANTHROPIC_PROVIDER_ID,
          ...(created && !Number.isNaN(created.getTime()) ? { createdAt: created } : {}),
        });
      }

      return models;
    });
  }

  /**
   * `GET /v1/models?limit=1` with the key. A rejected key is an ANSWER
   * (`{ ok: false, code: 'AI_KEY_INVALID' }`), as is any other failure.
   */
  async verifyKey(ctx: AiCallContext): Promise<AiKeyVerification> {
    try {
      await this.call('verify_key', undefined, ctx, async () => {
        const client = this.clients.create(ctx);

        await client.models.list({ limit: 1 }, { signal: ctx.signal });
      });

      return { ok: true };
    } catch (err) {
      const mapped = mapAnthropicError(err);

      return mapped.code === 'AI_KEY_INVALID'
        ? { ok: false, code: 'AI_KEY_INVALID' }
        : { ok: false, code: mapped.code, detail: mapped.message };
    }
  }

  // ---- responses port -------------------------------------------------------

  private plan(req: AiResponseRequest, storage: AnthropicStorageDeliveries | undefined): AnthropicRequestPlan {
    return toAnthropicRequest(req, anthropicModelProfile(req.model), storage);
  }

  private createResponse(req: AiResponseRequest, ctx: AiCallContext): Promise<AiResponse> {
    return this.call('messages.create', req.model, ctx, async () => {
      const plan = this.plan(req, await this.deliverStorageInputs(req, ctx));
      const client = this.clients.create(ctx);

      const { data, request_id } = await client.messages
        .create({ ...plan.body, stream: false }, { signal: ctx.signal })
        .withResponse();

      return fromAnthropicMessage(data, {
        request: req,
        providerRequestId: request_id,
        structuredToolName: plan.structuredToolName,
      });
    });
  }

  /**
   * Streams one response. A failure BEFORE `response.created` (a rejected
   * key, a 429, an unsupported request) is thrown as an `AiError`; once the
   * stream has started, a failure ends it with exactly one `error` event.
   *
   * `ctx.signal` aborts the SDK request; a consumer that stops iterating
   * (`break`) aborts it too.
   */
  private async *streamResponse(req: AiResponseRequest, ctx: AiCallContext): AsyncGenerator<AiStreamEvent> {
    const started = Date.now();
    const span = this.startSpan('messages.stream', req.model);
    let status = 'ok';
    let providerRequestId: string | null = null;
    let sdkStream: (AsyncIterable<RawMessageStreamEvent> & { controller: AbortController }) | undefined;
    let terminated = false;

    try {
      const plan = this.plan(req, await this.deliverStorageInputs(req, ctx));
      const client: Anthropic = this.clients.create(ctx);

      try {
        const { data, request_id } = await client.messages
          .create({ ...plan.body, stream: true }, { signal: ctx.signal })
          .withResponse();

        sdkStream = data;
        providerRequestId = request_id ?? null;
      } catch (err) {
        throw mapAnthropicError(err);
      }

      const mapper = new AnthropicStreamMapper({
        request: req,
        providerRequestId,
        structuredToolName: plan.structuredToolName,
      });

      try {
        for await (const event of sdkStream) {
          for (const out of mapper.map(event)) {
            if (out.type === 'error') status = out.code;
            yield out;
          }

          if (mapper.terminated) break;
        }
      } catch (err) {
        const mapped = mapAnthropicError(err);

        if (!mapper.started) throw mapped;

        status = mapped.code;

        yield* mapper.fail(mapped);
      }

      terminated = mapper.terminated;

      if (!terminated) {
        if (ctx.signal?.aborted) {
          throw new AiError('AI_PROVIDER_UNAVAILABLE', 'The AI request was cancelled.', {
            details: { provider: ANTHROPIC_PROVIDER_ID, aborted: true },
          });
        }

        const truncated = new AiError(
          'AI_PROVIDER_UNAVAILABLE',
          'The Anthropic stream ended before the response completed.',
          { details: { provider: ANTHROPIC_PROVIDER_ID } },
        );

        if (!mapper.started) throw truncated;

        status = truncated.code;
        terminated = true;

        yield* mapper.fail(truncated);
      }
    } catch (err) {
      const mapped = mapAnthropicError(err);

      status = mapped.code;

      throw mapped;
    } finally {
      // A consumer that stopped early leaves the HTTP stream open: close it.
      if (!terminated) sdkStream?.controller.abort();

      this.endSpan(span, status);
      this.logCall('messages.stream', req.model, ctx, status, started, providerRequestId);
    }
  }

  // ---- storage-object inputs (#441) ------------------------------------------

  /**
   * What each storage-object part of `req` becomes on the wire, by the
   * strategy the runtime prepared it for: a presigned URL, or the bytes read
   * (under the runtime's cap) for an inline document. `undefined` when the
   * request names no storage object.
   */
  private async deliverStorageInputs(
    req: AiResponseRequest,
    ctx: AiCallContext,
  ): Promise<AnthropicStorageDeliveries | undefined> {
    const ids = anthropicStorageObjectIds(req);

    if (ids.length === 0) return undefined;

    const deliveries = new Map<string, AnthropicStorageDelivery>();

    for (const id of ids) {
      const input = ctx.storageInputs?.get(id);

      if (!input) {
        throw new AiError('AI_INVALID_REQUEST', 'A storage-object input was not resolved by the runtime.', {
          details: { provider: ANTHROPIC_PROVIDER_ID },
        });
      }

      const base = { modality: input.modality, mimeType: input.mimeType, filename: input.filename };

      if (input.strategy === 'presigned_url' && input.url) {
        deliveries.set(id, { ...base, url: input.url });
      } else if (input.strategy === 'inline' && input.read) {
        const payload = await input.read();

        deliveries.set(id, { ...base, data: payload.data });
      } else {
        throw new AiError('AI_INVALID_REQUEST', 'A storage-object input was not prepared for delivery.', {
          details: { provider: ANTHROPIC_PROVIDER_ID, strategy: input.strategy },
        });
      }
    }

    return deliveries;
  }

  // ---- telemetry ------------------------------------------------------------

  private startSpan(operation: AnthropicOperation, model: string | undefined): Span {
    return tracer.startSpan(ANTHROPIC_PROVIDER_CALL_SPAN, {
      kind: SpanKind.CLIENT,
      attributes: {
        'ai.provider': ANTHROPIC_PROVIDER_ID,
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
    operation: AnthropicOperation,
    model: string | undefined,
    ctx: AiCallContext,
    status: string,
    started: number,
    providerRequestId?: string | null,
  ): void {
    this.logger.debug({
      msg: 'AI provider call',
      provider: ANTHROPIC_PROVIDER_ID,
      operation,
      model,
      status,
      requestId: ctx.requestId,
      providerRequestId: providerRequestId ?? undefined,
      durationMs: Date.now() - started,
    });
  }

  /** Runs `fn` inside an `ai.provider.call` span, mapping any failure to `AiError`. */
  private async call<T>(
    operation: AnthropicOperation,
    model: string | undefined,
    ctx: AiCallContext,
    fn: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    const span = this.startSpan(operation, model);
    let status = 'ok';
    let providerRequestId: string | undefined;

    try {
      const result = await fn();

      if (result && typeof result === 'object' && 'providerRequestId' in result) {
        providerRequestId = (result as { providerRequestId?: string }).providerRequestId;
      }

      return result;
    } catch (err) {
      const mapped = mapAnthropicError(err);

      status = mapped.code;
      providerRequestId = mapped.toJSON().details.providerRequestId as string | undefined;

      throw mapped;
    } finally {
      this.endSpan(span, status);
      this.logCall(operation, model, ctx, status, started, providerRequestId);
    }
  }
}
