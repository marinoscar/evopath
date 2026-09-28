// =============================================================================
// The Chat Completions call path of the OpenAI family (issue #448, epic #421)
// =============================================================================
//
// `create` and `stream` against `POST /chat/completions`, the counterpart of
// `openai-responses.engine.ts` for servers (and Azure deployments) that do not
// serve the Responses API. Same contracts, same telemetry:
//
//   - every call runs in one `ai.provider.call` span (operations
//     `chat.completions.create` / `chat.completions.stream`);
//   - a failure BEFORE the first chunk is thrown as an `AiError`; once the
//     stream has started, a failure ends it with exactly one `error` event;
//   - `ctx.signal` aborts the request, and a consumer that stops iterating
//     aborts it too.
//
// Streaming asks for `stream_options: { include_usage: true }` so the final
// (choice-less) chunk carries token usage — without it every streamed call
// would record zero tokens.
//
// STORAGE-OBJECT INPUTS (#441). Chat Completions has no file store worth
// uploading to for a call, so only the `presigned_url` and `inline`
// strategies are delivered (an image as its URL or a `data:` URL, a file as
// inline `file_data`); an `upload` strategy is refused. The adapters using
// this engine declare their `fileInputStrategy` accordingly.
// =============================================================================

import type { OpenAI } from 'openai';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions';

import { AiError } from '../../core/ai-error';
import type { AiCallContext } from '../../core/provider-adapter.interface';
import type { AiResponse, AiResponseRequest, AiStreamEvent } from '../../core/types/responses.types';
import type { OpenAiCallTelemetry } from './openai-call-telemetry';
import { ChatCompletionsStreamMapper } from './openai-chat-completions-stream.mapper';
import {
  type ChatCompletionsTokenParameter,
  fromChatCompletion,
  toChatCompletionsRequest,
} from './openai-chat-completions.mapper';
import { mapOpenAiError, type OpenAiFamily } from './openai-errors';
import {
  type OpenAiStorageDeliveries,
  type OpenAiStorageDelivery,
  storageObjectIdsOf,
} from './openai-responses.mapper';

export interface OpenAiChatCompletionsEngineDeps {
  family: OpenAiFamily;
  telemetry: OpenAiCallTelemetry;
  /** The SDK client for one call. */
  client(ctx: AiCallContext): OpenAI;
  /** Which body field carries the output-token limit. */
  tokenParameter: ChatCompletionsTokenParameter;
}

export interface OpenAiChatCompletionsCallOptions {
  /** The `model` to send when it differs from `req.model` (an Azure deployment). */
  wireModel?: string;
}

export class OpenAiChatCompletionsEngine {
  constructor(private readonly deps: OpenAiChatCompletionsEngineDeps) {}

  private get providerId(): string {
    return this.deps.family.providerId;
  }

  private async body(req: AiResponseRequest, ctx: AiCallContext, opts: OpenAiChatCompletionsCallOptions) {
    const body = toChatCompletionsRequest(req, {
      family: this.deps.family,
      storage: await this.deliverStorageInputs(req, ctx),
      tokenParameter: this.deps.tokenParameter,
    });

    return opts.wireModel ? { ...body, model: opts.wireModel } : body;
  }

  create(req: AiResponseRequest, ctx: AiCallContext, opts: OpenAiChatCompletionsCallOptions = {}): Promise<AiResponse> {
    return this.deps.telemetry.call('chat.completions.create', req.model, ctx, async () => {
      const body = await this.body(req, ctx, opts);

      const { data, request_id } = await this.deps
        .client(ctx)
        .chat.completions.create({ ...body, stream: false }, { signal: ctx.signal })
        .withResponse();

      return fromChatCompletion(data, { request: req, providerRequestId: request_id, family: this.deps.family });
    });
  }

  /** Streams one response — see the file header for the contract. */
  async *stream(
    req: AiResponseRequest,
    ctx: AiCallContext,
    opts: OpenAiChatCompletionsCallOptions = {},
  ): AsyncGenerator<AiStreamEvent> {
    const { telemetry, family } = this.deps;
    const operation = 'chat.completions.stream';
    const started = Date.now();
    const span = telemetry.startSpan(operation, req.model);
    let status = 'ok';
    let providerRequestId: string | null = null;
    let sdkStream: (AsyncIterable<ChatCompletionChunk> & { controller: AbortController }) | undefined;
    let terminated = false;

    try {
      const body = await this.body(req, ctx, opts);

      try {
        const { data, request_id } = await this.deps
          .client(ctx)
          .chat.completions.create(
            { ...body, stream: true, stream_options: { include_usage: true } },
            { signal: ctx.signal },
          )
          .withResponse();

        sdkStream = data;
        providerRequestId = request_id;
      } catch (err) {
        throw mapOpenAiError(err, family);
      }

      const mapper = new ChatCompletionsStreamMapper({ request: req, providerRequestId, family });

      try {
        for await (const chunk of sdkStream) {
          for (const out of mapper.map(chunk)) yield out;
        }

        for (const out of mapper.finish()) {
          if (out.type === 'error') status = out.code;
          yield out;
        }
      } catch (err) {
        const mapped = mapOpenAiError(err, family);

        if (!mapper.started) throw mapped;

        status = mapped.code;

        yield* mapper.fail(mapped);
      }

      terminated = mapper.terminated;

      if (!terminated) {
        if (ctx.signal?.aborted) {
          throw new AiError('AI_PROVIDER_UNAVAILABLE', 'The AI request was cancelled.', {
            details: { provider: this.providerId, aborted: true },
          });
        }

        const truncated = new AiError(
          'AI_PROVIDER_UNAVAILABLE',
          `The ${family.label} stream ended before the response completed.`,
          { details: { provider: this.providerId } },
        );

        if (!mapper.started) throw truncated;

        status = truncated.code;
        terminated = true;

        yield* mapper.fail(truncated);
      }
    } catch (err) {
      const mapped = mapOpenAiError(err, family);

      status = mapped.code;

      throw mapped;
    } finally {
      // A consumer that stopped early leaves the HTTP stream open: close it.
      if (!terminated) sdkStream?.controller.abort();

      telemetry.endSpan(span, status);
      telemetry.logCall(operation, req.model, ctx, status, started, providerRequestId);
    }
  }

  /**
   * What each storage-object part becomes on the wire: its presigned URL, or
   * its bytes as a `data:` URL. `undefined` when the request names none.
   */
  private async deliverStorageInputs(
    req: AiResponseRequest,
    ctx: AiCallContext,
  ): Promise<OpenAiStorageDeliveries | undefined> {
    const ids = storageObjectIdsOf(req);

    if (ids.length === 0) return undefined;

    const deliveries = new Map<string, OpenAiStorageDelivery>();

    for (const id of ids) {
      const input = ctx.storageInputs?.get(id);

      if (!input) {
        throw new AiError('AI_INVALID_REQUEST', 'A storage-object input was not resolved by the runtime.', {
          details: { provider: this.providerId },
        });
      }

      const base = { modality: input.modality, filename: input.filename };

      if (input.strategy === 'presigned_url' && input.url) {
        deliveries.set(id, { ...base, url: input.url });
      } else if (input.strategy === 'inline' && input.read) {
        const payload = await input.read();
        const data = Buffer.from(payload.data).toString('base64');

        deliveries.set(id, { ...base, url: `data:${input.mimeType};base64,${data}` });
      } else {
        throw new AiError('AI_INVALID_REQUEST', 'A storage-object input was not prepared for delivery.', {
          details: { provider: this.providerId, strategy: input.strategy },
        });
      }
    }

    return deliveries;
  }
}
