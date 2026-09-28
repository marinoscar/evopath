// =============================================================================
// Gemini `streamGenerateContent` chunks -> AiStreamEvent (issue #447, epic #421)
// =============================================================================
//
// One `GeminiStreamMapper` per stream. A Gemini stream is a sequence of
// partial `GenerateContentResponse`s (SSE `data:` frames): each carries the
// NEXT parts of the one candidate — a slice of text, a slice of a thought
// summary, or a whole function call — and the last carries the
// `finishReason` and the final `usageMetadata`. There is no terminal event:
// the stream simply ends. The output contract is exactly the other adapters':
// `response.created` first, exactly one terminal event (`response.completed`
// or `error`), and the concatenated `output_text.delta`s equal the completed
// response's `outputText`.
//
//   first chunk              -> response.created (its `responseId`)
//   text part                -> output_text.delta
//   thought part             -> reasoning_summary.delta
//   functionCall part        -> function_call.arguments.delta (the whole
//                               arguments JSON — Gemini sends a call whole)
//                               + output_item.done
//   a change of part kind    -> output_item.done for the item it closes
//   thoughtSignature         -> (kept for replay, never emitted)
//   end of stream            -> response.completed, IF a finish reason (or a
//                               blocked prompt) was seen; a stream that ends
//                               without one is truncated — the adapter's to
//                               fail
//
// Parts are assembled by `GeminiOutputAssembler`, and the completed response
// is built by `finishGeminiResponse` — both shared with `create`, so a
// streamed and a non-streamed call produce the same items and the same
// structured-output validation; if that validation fails, the stream ends
// with an `error` event carrying its code instead.
// =============================================================================

import type { FinishReason, GenerateContentResponse, GenerateContentResponseUsageMetadata } from '@google/genai';

import { AiError } from '../../core/ai-error';
import type { AiResponseRequest, AiStreamEvent } from '../../core/types/responses.types';
import {
  GeminiOutputAssembler,
  finishGeminiResponse,
  geminiFallbackResponseId,
  geminiUsage,
} from './gemini-content.mapper';

export interface GeminiStreamMapperOptions {
  request: AiResponseRequest;
}

export class GeminiStreamMapper {
  private readonly assembler = new GeminiOutputAssembler();
  private id = '';
  private model = '';
  private finishReason: FinishReason | undefined;
  private promptBlocked = false;
  private usage: GenerateContentResponseUsageMetadata | undefined;
  private startedFlag = false;
  private terminalFlag = false;

  constructor(private readonly opts: GeminiStreamMapperOptions) {}

  /** Whether `response.created` has been emitted. */
  get started(): boolean {
    return this.startedFlag;
  }

  /** Whether a terminal event (`response.completed` or `error`) has been emitted. */
  get terminated(): boolean {
    return this.terminalFlag;
  }

  /** Whether the stream has said it is finished (a finish reason, or a blocked prompt). */
  get finished(): boolean {
    return this.finishReason !== undefined || this.promptBlocked;
  }

  /** Maps one chunk to zero or more of our events. Nothing is emitted after a terminal event. */
  map(chunk: GenerateContentResponse): AiStreamEvent[] {
    if (this.terminalFlag) return [];

    const events: AiStreamEvent[] = [];

    if (!this.startedFlag) {
      this.startedFlag = true;
      this.id = chunk.responseId || geminiFallbackResponseId();
      events.push({ type: 'response.created', id: this.id });
    }

    if (chunk.modelVersion) this.model = chunk.modelVersion;
    if (chunk.usageMetadata) this.usage = chunk.usageMetadata;

    const candidate = chunk.candidates?.[0];

    if (!candidate && chunk.promptFeedback?.blockReason) this.promptBlocked = true;

    for (const part of candidate?.content?.parts ?? []) events.push(...this.assembler.push(part));

    if (candidate?.finishReason) this.finishReason = candidate.finishReason;

    return events;
  }

  /** The stream ended: closes the open item and emits `response.completed`. Call only when `finished`. */
  complete(): AiStreamEvent[] {
    if (this.terminalFlag) return [];

    const events = this.assembler.finish();
    let response;

    try {
      response = finishGeminiResponse(
        {
          id: this.id,
          model: this.model || this.opts.request.model,
          output: this.assembler.items,
          finishReason: this.finishReason,
          promptBlocked: this.promptBlocked,
          usage: geminiUsage(this.usage),
        },
        this.opts.request,
      );
    } catch (err) {
      return [...events, ...this.fail(AiError.wrap(err))];
    }

    this.terminalFlag = true;

    return [...events, { type: 'response.completed', response }];
  }

  /** Ends the stream with an `error` event for `err` (idempotent). */
  fail(err: AiError): AiStreamEvent[] {
    if (this.terminalFlag) return [];
    this.terminalFlag = true;

    return [{ type: 'error', code: err.code, message: err.message }];
  }
}
