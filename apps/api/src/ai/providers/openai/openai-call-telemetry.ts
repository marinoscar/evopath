// =============================================================================
// Provider-call telemetry for the OpenAI wire family (issue #426, extracted #448)
// =============================================================================
//
// Every provider call an OpenAI-family adapter (OpenAI, Azure OpenAI, a
// generic OpenAI-compatible server) makes runs inside one `ai.provider.call`
// span carrying `ai.provider`, `ai.model`, `ai.operation` and `ai.status`
// (`ok` or the AiErrorCode) — never prompt text, output text or the key. The
// debug log line carries the same four facts plus the request ids and a
// duration. No exception is recorded on the span: an SDK error's message can
// echo a masked key.
//
// Extracted from `openai.adapter.ts` unchanged so the two #448 adapters share
// it rather than copy it; the OpenAI adapter's spans and log lines are
// byte-for-byte what they were.
// =============================================================================

import type { Logger } from '@nestjs/common';
import { Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import type { AiError } from '../../core/ai-error';
import type { AiCallContext } from '../../core/provider-adapter.interface';
import { resolveServiceName } from '../../../common/otel/telemetry-identity';
import { mapOpenAiError, type OpenAiFamily } from './openai-errors';

export const AI_PROVIDER_CALL_SPAN = 'ai.provider.call';

const tracer = trace.getTracer(resolveServiceName());

export class OpenAiCallTelemetry {
  constructor(
    private readonly family: OpenAiFamily,
    private readonly logger: Logger,
    /** Maps a thrown error; the family's own `mapOpenAiError` by default. */
    private readonly mapError: (err: unknown) => AiError = (err) => mapOpenAiError(err, family),
  ) {}

  startSpan(operation: string, model: string | undefined): Span {
    return tracer.startSpan(AI_PROVIDER_CALL_SPAN, {
      kind: SpanKind.CLIENT,
      attributes: {
        'ai.provider': this.family.providerId,
        'ai.operation': operation,
        ...(model ? { 'ai.model': model } : {}),
      },
    });
  }

  endSpan(span: Span, status: string): void {
    span.setAttribute('ai.status', status);
    span.setStatus(status === 'ok' ? { code: SpanStatusCode.OK } : { code: SpanStatusCode.ERROR, message: status });
    span.end();
  }

  /**
   * ⚠ Only ids, the model, the operation, the outcome and a duration. Never
   * `ctx.apiKey`, never the request or response body.
   */
  logCall(
    operation: string,
    model: string | undefined,
    ctx: AiCallContext,
    status: string,
    started: number,
    providerRequestId?: string | null,
  ): void {
    this.logger.debug({
      msg: 'AI provider call',
      provider: this.family.providerId,
      operation,
      model,
      status,
      requestId: ctx.requestId,
      providerRequestId: providerRequestId ?? undefined,
      durationMs: Date.now() - started,
    });
  }

  /** Runs `fn` inside an `ai.provider.call` span, mapping any failure to `AiError`. */
  async call<T>(
    operation: string,
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
      const mapped = this.mapError(err);

      status = mapped.code;
      providerRequestId = mapped.toJSON().details.providerRequestId as string | undefined;

      throw mapped;
    } finally {
      this.endSpan(span, status);
      this.logCall(operation, model, ctx, status, started, providerRequestId);
    }
  }
}
