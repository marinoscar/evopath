// =============================================================================
// Chat Completions stream chunks -> AiStreamEvent (issue #448, epic #421)
// =============================================================================
//
// One mapper per stream. Chat Completions streams DELTAS only — there is no
// `response.created`, no per-item `done`, and no final object — so this
// mapper accumulates what the Responses API would have announced:
//
//   first chunk                      -> response.created (the chunk's id)
//   choices[0].delta.content         -> output_text.delta
//   choices[0].delta.tool_calls[i]   -> function_call.arguments.delta, keyed by
//                                       the call id the i-th call announced in
//                                       its first fragment
//   choices[0].finish_reason         -> remembered
//   a usage-only chunk (no choices)  -> remembered (stream_options.include_usage)
//
// `finish()`, called once the SDK stream is exhausted, emits the
// `output_item.done` events (the message, then each function call) and the
// terminal `response.completed`, built by handing a synthetic `ChatCompletion`
// to `fromChatCompletion` — the same function `create` uses, so structured
// output is validated identically; if that fails the stream ends with an
// `error` event instead. A stream that ends WITHOUT a finish reason was cut
// short: `finish()` returns nothing and the engine fails it as truncated.
//
// Error events carry OUR generic message for the code, never the server's.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { ChatCompletion, ChatCompletionChunk } from 'openai/resources/chat/completions/completions';

import { AiError } from '../../core/ai-error';
import type { AiResponseRequest, AiStreamEvent } from '../../core/types/responses.types';
import { fromChatCompletion } from './openai-chat-completions.mapper';
import { OPENAI_FAMILY, type OpenAiFamily } from './openai-errors';

export interface ChatCompletionsStreamMapperOptions {
  request: AiResponseRequest;
  providerRequestId?: string | null;
  family?: OpenAiFamily;
}

interface PendingCall {
  id: string;
  name: string;
  arguments: string;
}

export class ChatCompletionsStreamMapper {
  private id: string | null = null;
  private model: string | null = null;
  private created = 0;
  private text = '';
  private refusal = '';
  private readonly calls = new Map<number, PendingCall>();
  private finishReason: ChatCompletion.Choice['finish_reason'] | null = null;
  private usage: ChatCompletion['usage'] | undefined;
  private startedFlag = false;
  private terminalFlag = false;

  constructor(private readonly opts: ChatCompletionsStreamMapperOptions) {}

  private get family(): OpenAiFamily {
    return this.opts.family ?? OPENAI_FAMILY;
  }

  /** Whether `response.created` has been emitted. */
  get started(): boolean {
    return this.startedFlag;
  }

  /** Whether a terminal event (`response.completed` or `error`) has been emitted. */
  get terminated(): boolean {
    return this.terminalFlag;
  }

  /** Whether the server has said why the turn ended — i.e. whether `finish()` can complete. */
  get finished(): boolean {
    return this.finishReason !== null;
  }

  /** Maps one SDK chunk to zero or more of ours. Nothing is emitted after a terminal event. */
  map(chunk: ChatCompletionChunk): AiStreamEvent[] {
    if (this.terminalFlag) return [];

    const events: AiStreamEvent[] = [];

    if (!this.startedFlag) {
      this.startedFlag = true;
      // Some compatible servers omit the id; the neutral contract needs one.
      this.id = chunk.id || `chatcmpl-${randomUUID()}`;
      events.push({ type: 'response.created', id: this.id });
    }

    if (chunk.model) this.model = chunk.model;
    if (typeof chunk.created === 'number') this.created = chunk.created;
    if (chunk.usage) this.usage = chunk.usage;

    const choice = chunk.choices?.[0];

    if (!choice) return events;

    const delta = choice.delta ?? {};

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      this.text += delta.content;
      events.push({ type: 'output_text.delta', delta: delta.content });
    }

    if (typeof delta.refusal === 'string') this.refusal += delta.refusal;

    for (const fragment of delta.tool_calls ?? []) {
      let call = this.calls.get(fragment.index);

      if (!call) {
        call = { id: fragment.id || `call_${randomUUID()}`, name: '', arguments: '' };
        this.calls.set(fragment.index, call);
      }

      if (fragment.function?.name) call.name += fragment.function.name;

      const args = fragment.function?.arguments;

      if (args) {
        call.arguments += args;
        events.push({ type: 'function_call.arguments.delta', callId: call.id, delta: args });
      }
    }

    if (choice.finish_reason) this.finishReason = choice.finish_reason;

    return events;
  }

  /**
   * The closing events, once the SDK stream is exhausted: each output item's
   * `output_item.done`, then `response.completed` — or nothing when the
   * server never gave a finish reason (see the file header).
   */
  finish(): AiStreamEvent[] {
    if (this.terminalFlag || !this.startedFlag || this.finishReason === null) return [];

    const completion: ChatCompletion = {
      id: this.id ?? '',
      object: 'chat.completion',
      created: this.created,
      model: this.model ?? this.opts.request.model,
      choices: [
        {
          index: 0,
          finish_reason: this.finishReason,
          logprobs: null,
          message: {
            role: 'assistant',
            content: this.text.length > 0 ? this.text : null,
            refusal: this.refusal.length > 0 ? this.refusal : null,
            ...(this.calls.size > 0
              ? {
                  tool_calls: [...this.calls.entries()]
                    .sort(([a], [b]) => a - b)
                    .map(([, call]) => ({
                      id: call.id,
                      type: 'function' as const,
                      function: { name: call.name, arguments: call.arguments },
                    })),
                }
              : {}),
          },
        },
      ],
      ...(this.usage ? { usage: this.usage } : {}),
    };

    let response;

    try {
      response = fromChatCompletion(completion, {
        request: this.opts.request,
        providerRequestId: this.opts.providerRequestId,
        family: this.family,
      });
    } catch (err) {
      return this.fail(AiError.wrap(err));
    }

    this.terminalFlag = true;

    return [
      ...response.output.map((item): AiStreamEvent => ({ type: 'output_item.done', item })),
      { type: 'response.completed', response },
    ];
  }

  /** Ends the stream with an `error` event for `err` (idempotent). */
  fail(err: AiError): AiStreamEvent[] {
    if (this.terminalFlag) return [];
    this.terminalFlag = true;

    return [{ type: 'error', code: err.code, message: err.message }];
  }
}
