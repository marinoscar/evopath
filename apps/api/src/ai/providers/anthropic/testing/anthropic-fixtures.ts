// Builders for Anthropic Messages API objects in tests (issue #446). Not
// imported by production code.
//
// `messageFixture` builds a complete `Message`; `streamEventsFor` turns one
// into the exact event sequence the Messages API streams for it
// (`message_start`, per block `content_block_start` / `_delta`s /
// `_stop`, `message_delta`, `message_stop`), so a streamed and a
// non-streamed call can be driven from the same fixture.

import type {
  ContentBlock,
  Message,
  RawMessageStreamEvent,
  RedactedThinkingBlock,
  StopReason,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  Usage,
} from '@anthropic-ai/sdk/resources/messages/messages';

let counter = 0;

export function textBlock(text: string): TextBlock {
  return { type: 'text', text, citations: null };
}

export function toolUseBlock(name: string, input: unknown, id = `toolu_${++counter}`): ToolUseBlock {
  return { type: 'tool_use', id, name, input, caller: { type: 'direct' } };
}

export function thinkingBlock(thinking: string, signature = `sig_${++counter}`): ThinkingBlock {
  return { type: 'thinking', thinking, signature };
}

export function redactedThinkingBlock(data = `enc_${++counter}`): RedactedThinkingBlock {
  return { type: 'redacted_thinking', data };
}

export function usageFixture(patch: Partial<Usage> = {}): Usage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: 12,
    output_tokens: 7,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: 'standard',
    ...patch,
  };
}

export interface MessageFixtureOptions {
  id?: string;
  model?: string;
  content: ContentBlock[];
  stopReason?: StopReason | null;
  usage?: Partial<Usage>;
}

/** A complete `Message`. `stop_reason` defaults to `tool_use` when a tool is called, else `end_turn`. */
export function messageFixture(opts: MessageFixtureOptions): Message {
  return {
    id: opts.id ?? `msg_${++counter}`,
    type: 'message',
    role: 'assistant',
    model: opts.model ?? 'claude-sonnet-4-5',
    content: opts.content,
    container: null,
    stop_details: null,
    stop_reason:
      opts.stopReason !== undefined
        ? opts.stopReason
        : opts.content.some((block) => block.type === 'tool_use')
          ? 'tool_use'
          : 'end_turn',
    stop_sequence: null,
    usage: usageFixture(opts.usage),
  };
}

function chunks(text: string, size: number): string[] {
  const out: string[] = [];

  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));

  return out;
}

/** The Messages API event sequence that streams `message`, deltas of `chunkSize` characters. */
export function streamEventsFor(message: Message, chunkSize = 5): RawMessageStreamEvent[] {
  const events: RawMessageStreamEvent[] = [
    {
      type: 'message_start',
      message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 1 } },
    },
  ];

  message.content.forEach((block, index) => {
    switch (block.type) {
      case 'text':
        events.push({ type: 'content_block_start', index, content_block: { ...block, text: '' } });
        for (const text of chunks(block.text, chunkSize)) {
          events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
        }
        break;

      case 'thinking':
        events.push({ type: 'content_block_start', index, content_block: { ...block, thinking: '', signature: '' } });
        for (const thinking of chunks(block.thinking, chunkSize)) {
          events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } });
        }
        events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
        break;

      case 'tool_use':
        events.push({ type: 'content_block_start', index, content_block: { ...block, input: {} } });
        for (const partial_json of chunks(JSON.stringify(block.input), chunkSize)) {
          events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
        }
        break;

      default:
        events.push({ type: 'content_block_start', index, content_block: block });
        break;
    }

    events.push({ type: 'content_block_stop', index });
  });

  events.push({
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: null, stop_details: null, container: null },
    usage: {
      output_tokens: message.usage.output_tokens,
      input_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      output_tokens_details: message.usage.output_tokens_details,
      server_tool_use: null,
    },
  });
  events.push({ type: 'message_stop' });

  return events;
}
