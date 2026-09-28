// =============================================================================
// Anthropic Messages stream events -> AiStreamEvent (issue #446, epic #421)
// =============================================================================
//
// One `AnthropicStreamMapper` per stream: stateful, because a Messages stream
// is a sequence of CONTENT BLOCKS assembled from deltas by index, while our
// contract speaks in output items. The output contract is exactly the OpenAI
// stream mapper's: `response.created` first, exactly one terminal event
// (`response.completed` or `error`), and the concatenated
// `output_text.delta`s equal the completed response's `outputText`.
//
// Event mapping (anything else is dropped):
//
//   message_start                          -> response.created
//   content_block_start                    -> (the block is opened)
//   content_block_delta  text_delta        -> output_text.delta
//                        thinking_delta    -> reasoning_summary.delta
//                        signature_delta   -> (kept for replay, never emitted)
//                        input_json_delta  -> function_call.arguments.delta,
//                                             or output_text.delta for the
//                                             forced structured-output tool
//                        citations_delta   -> (dropped)
//   content_block_stop                     -> output_item.done
//   message_delta                          -> (stop reason and usage kept)
//   message_stop                           -> response.completed
//
// A failure (the SDK raises Anthropic's `event: error` frame as an error) is
// the adapter's to catch; it calls `fail()`, which ends the stream with one
// `error` event carrying OUR generic message, never Anthropic's text.
//
// The completed response is built by `finishAnthropicResponse`, the same
// function `create` uses, so structured-output validation is identical; if
// it fails, the stream ends with an `error` event carrying that code instead.
// =============================================================================

import type { RawMessageStreamEvent, StopReason, Usage } from '@anthropic-ai/sdk/resources/messages/messages';

import { AiError } from '../../core/ai-error';
import type { AiOutputItem, AiResponseRequest, AiStreamEvent } from '../../core/types/responses.types';
import {
  anthropicReasoningItem,
  anthropicUsage,
  finishAnthropicResponse,
} from './anthropic-messages.mapper';

export interface AnthropicStreamMapperOptions {
  request: AiResponseRequest;
  providerRequestId?: string | null;
  /** The forced structured-output tool's name, when the request used that path. */
  structuredToolName?: string;
}

type OpenBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; thinking: string; signature: string }
  | { kind: 'redacted_thinking'; data: string }
  | { kind: 'tool_use'; id: string; name: string; json: string; structured: boolean }
  | { kind: 'other' };

type UsageFields = Partial<
  Pick<Usage, 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens' | 'output_tokens_details'>
>;

function errorEvent(err: AiError): AiStreamEvent {
  return { type: 'error', code: err.code, message: err.message };
}

export class AnthropicStreamMapper {
  private readonly blocks = new Map<number, OpenBlock>();
  /** Finished items by block index — the completed response keeps block order. */
  private readonly items = new Map<number, AiOutputItem>();
  private id = '';
  private model = '';
  private stopReason: StopReason | null = null;
  private usage: UsageFields = {};
  private startedFlag = false;
  private terminalFlag = false;

  constructor(private readonly opts: AnthropicStreamMapperOptions) {}

  /** Whether `response.created` has been emitted. */
  get started(): boolean {
    return this.startedFlag;
  }

  /** Whether a terminal event (`response.completed` or `error`) has been emitted. */
  get terminated(): boolean {
    return this.terminalFlag;
  }

  /** Maps one SDK event to zero or more of ours. Nothing is emitted after a terminal event. */
  map(event: RawMessageStreamEvent): AiStreamEvent[] {
    if (this.terminalFlag) return [];

    switch (event.type) {
      case 'message_start':
        if (this.startedFlag) return [];
        this.startedFlag = true;
        this.id = event.message.id;
        this.model = event.message.model;
        this.usage = { ...event.message.usage };

        return [{ type: 'response.created', id: event.message.id }];

      case 'content_block_start':
        return this.open(event.index, event.content_block);

      case 'content_block_delta':
        return this.delta(event.index, event.delta);

      case 'content_block_stop':
        return this.close(event.index);

      case 'message_delta':
        if (event.delta.stop_reason) this.stopReason = event.delta.stop_reason;
        // Cumulative counts; a null field leaves the message_start value.
        for (const [key, value] of Object.entries(event.usage ?? {})) {
          if (value !== null && value !== undefined) (this.usage as Record<string, unknown>)[key] = value;
        }

        return [];

      case 'message_stop':
        return this.complete();

      default:
        return [];
    }
  }

  /** Ends the stream with an `error` event for `err` (idempotent). */
  fail(err: AiError): AiStreamEvent[] {
    if (this.terminalFlag) return [];
    this.terminalFlag = true;

    return [errorEvent(err)];
  }

  private open(index: number, block: Extract<RawMessageStreamEvent, { type: 'content_block_start' }>['content_block']): AiStreamEvent[] {
    switch (block.type) {
      case 'text':
        this.blocks.set(index, { kind: 'text', text: '' });
        // A start block may already carry text; normally it is empty.
        return this.delta(index, { type: 'text_delta', text: block.text });

      case 'thinking':
        this.blocks.set(index, { kind: 'thinking', thinking: '', signature: block.signature ?? '' });
        return this.delta(index, { type: 'thinking_delta', thinking: block.thinking });

      case 'redacted_thinking':
        this.blocks.set(index, { kind: 'redacted_thinking', data: block.data });
        return [];

      case 'tool_use':
        this.blocks.set(index, {
          kind: 'tool_use',
          id: block.id,
          name: block.name,
          json: '',
          structured: block.name === this.opts.structuredToolName,
        });
        return [];

      default:
        this.blocks.set(index, { kind: 'other' });
        return [];
    }
  }

  private delta(
    index: number,
    delta: Extract<RawMessageStreamEvent, { type: 'content_block_delta' }>['delta'],
  ): AiStreamEvent[] {
    const block = this.blocks.get(index);

    if (!block) return [];

    if (delta.type === 'text_delta' && block.kind === 'text') {
      block.text += delta.text;
      return delta.text ? [{ type: 'output_text.delta', delta: delta.text }] : [];
    }

    if (delta.type === 'thinking_delta' && block.kind === 'thinking') {
      block.thinking += delta.thinking;
      return delta.thinking ? [{ type: 'reasoning_summary.delta', delta: delta.thinking }] : [];
    }

    if (delta.type === 'signature_delta' && block.kind === 'thinking') {
      block.signature += delta.signature;
      return [];
    }

    if (delta.type === 'input_json_delta' && block.kind === 'tool_use') {
      block.json += delta.partial_json;

      if (!delta.partial_json) return [];

      return block.structured
        ? [{ type: 'output_text.delta', delta: delta.partial_json }]
        : [{ type: 'function_call.arguments.delta', callId: block.id, delta: delta.partial_json }];
    }

    return [];
  }

  private close(index: number): AiStreamEvent[] {
    const block = this.blocks.get(index);

    if (!block) return [];

    this.blocks.delete(index);

    let item: AiOutputItem | null = null;

    switch (block.kind) {
      case 'text':
        item = { type: 'message', text: block.text };
        break;

      case 'thinking':
        item = anthropicReasoningItem({ type: 'thinking', thinking: block.thinking, signature: block.signature });
        break;

      case 'redacted_thinking':
        item = anthropicReasoningItem({ type: 'redacted_thinking', data: block.data });
        break;

      case 'tool_use': {
        const json = block.json.length > 0 ? block.json : '{}';

        // The structured tool's streamed JSON IS the text: deltas and the
        // completed `outputText` stay equal (same parsed value as `create`).
        item = block.structured
          ? { type: 'message', text: json }
          : { type: 'function_call', callId: block.id, name: block.name, arguments: json };
        break;
      }

      default:
        return [];
    }

    this.items.set(index, item);

    return [{ type: 'output_item.done', item }];
  }

  private complete(): AiStreamEvent[] {
    const output = [...this.items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
    let response;

    try {
      response = finishAnthropicResponse(
        { id: this.id, model: this.model, output, stopReason: this.stopReason, usage: anthropicUsage(this.usage) },
        { request: this.opts.request, providerRequestId: this.opts.providerRequestId },
      );
    } catch (err) {
      return this.fail(AiError.wrap(err));
    }

    this.terminalFlag = true;

    return [{ type: 'response.completed', response }];
  }
}
