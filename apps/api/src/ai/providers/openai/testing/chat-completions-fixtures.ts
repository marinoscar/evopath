// Test-only builders for Chat Completions payloads (issue #448).
//
// The JSON an OpenAI-compatible server sends for `POST /chat/completions`,
// trimmed to the fields the mapper reads, plus the chunk sequence the same
// answer streams as. Not imported by production code.

import type { ChatCompletion, ChatCompletionChunk } from 'openai/resources/chat/completions/completions';

let counter = 0;

function nextId(prefix: string): string {
  counter += 1;

  return `${prefix}-${counter.toString().padStart(6, '0')}`;
}

export interface ChatToolCallFixture {
  id?: string;
  name: string;
  arguments: string;
}

export interface ChatCompletionFixtureOptions {
  model?: string;
  content?: string | null;
  refusal?: string | null;
  toolCalls?: ChatToolCallFixture[];
  finishReason?: ChatCompletion.Choice['finish_reason'];
  usage?: ChatCompletion['usage'] | null;
  id?: string;
}

export function chatCompletionFixture(opts: ChatCompletionFixtureOptions = {}): ChatCompletion {
  const toolCalls = (opts.toolCalls ?? []).map((call) => ({
    id: call.id ?? nextId('call'),
    type: 'function' as const,
    function: { name: call.name, arguments: call.arguments },
  }));

  return {
    id: opts.id ?? nextId('chatcmpl'),
    object: 'chat.completion',
    created: 1_700_000_000,
    model: opts.model ?? 'llama3.1:8b',
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: opts.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
        message: {
          role: 'assistant',
          content: opts.content === undefined ? 'Hello!' : opts.content,
          refusal: opts.refusal ?? null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
    ...(opts.usage === null
      ? {}
      : { usage: opts.usage ?? { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } }),
  };
}

/**
 * The chunks `completion` streams as: the content in `chunkSize`-character
 * deltas, each tool call's arguments likewise (its id and name in the first
 * fragment), the finish reason on the last choice chunk, and — when
 * `includeUsage` — a final choice-less usage chunk.
 */
export function chatChunksFor(completion: ChatCompletion, chunkSize = 4, includeUsage = true): ChatCompletionChunk[] {
  const choice = completion.choices[0];
  const base = { id: completion.id, object: 'chat.completion.chunk' as const, created: completion.created, model: completion.model };
  const chunks: ChatCompletionChunk[] = [];
  const push = (delta: ChatCompletionChunk.Choice.Delta, finish: ChatCompletionChunk.Choice['finish_reason'] = null) =>
    chunks.push({ ...base, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] });

  push({ role: 'assistant', content: '' });

  const content = choice.message.content ?? '';

  for (let i = 0; i < content.length; i += chunkSize) push({ content: content.slice(i, i + chunkSize) });

  (choice.message.tool_calls ?? []).forEach((call, index) => {
    if (call.type !== 'function') return;

    push({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] });

    for (let i = 0; i < call.function.arguments.length; i += chunkSize) {
      push({ tool_calls: [{ index, function: { arguments: call.function.arguments.slice(i, i + chunkSize) } }] });
    }
  });

  push({}, choice.finish_reason);

  if (includeUsage && completion.usage) chunks.push({ ...base, choices: [], usage: completion.usage });

  return chunks;
}
