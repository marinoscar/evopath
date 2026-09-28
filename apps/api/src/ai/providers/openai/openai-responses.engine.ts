// =============================================================================
// The Responses API call path, shared by the OpenAI family (#426, extracted #448)
// =============================================================================
//
// `create` and `stream` against `POST /responses`, including the #441
// storage-object delivery (presigned URL, Files API upload + delete, inline
// `data:` URL). Extracted from `openai.adapter.ts` unchanged so the Azure
// OpenAI adapter and the generic OpenAI-compatible adapter — both of which
// can speak the Responses API — run exactly the code OpenAI runs, differing
// only in their `OpenAiFamily` (provider id and message label), their client
// (endpoint, auth header) and, for Azure, the `model` put on the wire (a
// deployment name rather than the model id).
//
// STREAMING CONTRACT. A failure BEFORE `response.created` (a rejected key, a
// 429, an unsupported request) is thrown as an `AiError`; once the stream has
// started, a failure ends it with exactly one `error` event, so a consumer
// that has begun rendering always sees a terminal event. `ctx.signal` aborts
// the SDK request; a consumer that stops iterating (`break`) aborts it too.
// =============================================================================

import type { Logger } from '@nestjs/common';
import { type OpenAI, toFile } from 'openai';
import type { ResponseStreamEvent } from 'openai/resources/responses/responses';

import { AiError } from '../../core/ai-error';
import type { AiModelCapabilities } from '../../core/capabilities';
import type { AiCallContext } from '../../core/provider-adapter.interface';
import type { AiResponse, AiResponseRequest, AiStreamEvent } from '../../core/types/responses.types';
import type { OpenAiCallTelemetry } from './openai-call-telemetry';
import { mapOpenAiError, type OpenAiFamily } from './openai-errors';
import {
  fromOpenAiResponse,
  type OpenAiStorageDeliveries,
  type OpenAiStorageDelivery,
  storageObjectIdsOf,
  toOpenAiRequest,
} from './openai-responses.mapper';
import { OpenAiStreamMapper } from './openai-stream.mapper';

export interface OpenAiResponsesEngineDeps {
  family: OpenAiFamily;
  telemetry: OpenAiCallTelemetry;
  logger: Logger;
  /** The SDK client for one call. */
  client(ctx: AiCallContext): OpenAI;
  /** The model's classified capabilities, or null when unclassified. */
  classify(modelId: string): AiModelCapabilities | null;
}

/** Per-call overrides. */
export interface OpenAiResponsesCallOptions {
  /**
   * The `model` to send on the wire when it differs from `req.model` (an
   * Azure deployment name). The request's own model id still drives
   * classification, telemetry and the neutral response.
   */
  wireModel?: string;
}

export class OpenAiResponsesEngine {
  constructor(private readonly deps: OpenAiResponsesEngineDeps) {}

  private get providerId(): string {
    return this.deps.family.providerId;
  }

  private body(req: AiResponseRequest, storage: OpenAiStorageDeliveries | undefined, opts: OpenAiResponsesCallOptions) {
    const body = toOpenAiRequest(req, this.deps.classify(req.model), storage, this.deps.family);

    return opts.wireModel ? { ...body, model: opts.wireModel } : body;
  }

  create(req: AiResponseRequest, ctx: AiCallContext, opts: OpenAiResponsesCallOptions = {}): Promise<AiResponse> {
    return this.deps.telemetry.call('responses.create', req.model, ctx, async () => {
      const uploaded: string[] = [];
      let client: OpenAI | undefined;
      const lazyClient = () => (client ??= this.deps.client(ctx));

      try {
        const storage = await this.deliverStorageInputs(req, ctx, lazyClient, uploaded);
        const body = this.body(req, storage, opts);

        const { data, request_id } = await lazyClient()
          .responses.create({ ...body, stream: false }, { signal: ctx.signal })
          .withResponse();

        if (data.status === 'cancelled') {
          throw new AiError('AI_PROVIDER_UNAVAILABLE', `The ${this.deps.family.label} response was cancelled.`, {
            details: { provider: this.providerId, ...(request_id ? { providerRequestId: request_id } : {}) },
          });
        }

        return fromOpenAiResponse(data, { request: req, providerRequestId: request_id, family: this.deps.family });
      } finally {
        await this.deleteUploaded(client, uploaded, ctx);
      }
    });
  }

  /** Streams one response — see the file header for the contract. */
  async *stream(
    req: AiResponseRequest,
    ctx: AiCallContext,
    opts: OpenAiResponsesCallOptions = {},
  ): AsyncGenerator<AiStreamEvent> {
    const { telemetry, family } = this.deps;
    const started = Date.now();
    const span = telemetry.startSpan('responses.stream', req.model);
    let status = 'ok';
    let providerRequestId: string | null = null;
    let sdkStream: AsyncIterable<ResponseStreamEvent> & { controller: AbortController } | undefined;
    let terminated = false;
    const uploaded: string[] = [];
    let client: OpenAI | undefined;
    const lazyClient = () => (client ??= this.deps.client(ctx));

    try {
      const storage = await this.deliverStorageInputs(req, ctx, lazyClient, uploaded);
      const body = this.body(req, storage, opts);

      try {
        const { data, request_id } = await lazyClient().responses
          .create({ ...body, stream: true }, { signal: ctx.signal })
          .withResponse();

        sdkStream = data;
        providerRequestId = request_id;
      } catch (err) {
        throw mapOpenAiError(err, family);
      }

      const mapper = new OpenAiStreamMapper({ request: req, providerRequestId, family });

      try {
        for await (const event of sdkStream) {
          for (const out of mapper.map(event)) {
            if (out.type === 'error') status = out.code;
            yield out;
          }

          if (mapper.terminated) break;
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

      await this.deleteUploaded(client, uploaded, ctx);

      telemetry.endSpan(span, status);
      telemetry.logCall('responses.stream', req.model, ctx, status, started, providerRequestId);
    }
  }

  // ---- storage-object inputs (#441) ------------------------------------------

  /**
   * What each storage-object part of `req` becomes on the wire, by the
   * strategy the runtime prepared it for: a presigned (or inline `data:`)
   * URL, or a Files API id — uploaded here, with the call's own key, and
   * pushed onto `uploaded` so the caller deletes it whatever happens next.
   * `undefined` when the request names no storage object.
   */
  private async deliverStorageInputs(
    req: AiResponseRequest,
    ctx: AiCallContext,
    client: () => OpenAI,
    uploaded: string[],
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
      } else if (input.strategy === 'upload' && input.open) {
        const file = await toFile(await input.open(), input.filename, { type: input.mimeType });
        const created = await client().files.create({ file, purpose: 'user_data' }, { signal: ctx.signal });

        uploaded.push(created.id);
        deliveries.set(id, { ...base, fileId: created.id });
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

  /**
   * Deletes the provider-side copies of this call's uploaded inputs. Best
   * effort: a failure is logged (file id and outcome only — never the key)
   * and never replaces the call's own result. Deliberately not bound to
   * `ctx.signal`: a cancelled call still cleans up.
   */
  private async deleteUploaded(client: OpenAI | undefined, uploaded: string[], ctx: AiCallContext): Promise<void> {
    if (!client) return;

    for (const fileId of uploaded.splice(0)) {
      try {
        await client.files.delete(fileId);
        this.deps.logger.debug({ msg: 'AI input file deleted', provider: this.providerId, fileId, requestId: ctx.requestId });
      } catch (err) {
        this.deps.logger.warn({
          msg: 'Could not delete an AI input file from the provider',
          provider: this.providerId,
          fileId,
          requestId: ctx.requestId,
          status: mapOpenAiError(err, this.deps.family).code,
        });
      }
    }
  }
}
