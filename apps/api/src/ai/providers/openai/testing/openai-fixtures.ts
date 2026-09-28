// Test-only builders for OpenAI Responses API payloads (issue #426).
//
// They produce the JSON OpenAI actually sends — trimmed to the fields the
// adapter reads — so the mapper specs and the mocked HTTP transport speak
// the same wire format. Not imported by production code.

import type {
  Response as OpenAiSdkResponse,
  ResponseOutputItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';

let counter = 0;

function nextId(prefix: string): string {
  counter += 1;

  return `${prefix}_${counter.toString().padStart(6, '0')}`;
}

export function messageItem(text: string, extra: { refusal?: string } = {}): ResponseOutputItem {
  return {
    id: nextId('msg'),
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [
      ...(text ? [{ type: 'output_text' as const, text, annotations: [] }] : []),
      ...(extra.refusal ? [{ type: 'refusal' as const, refusal: extra.refusal }] : []),
    ],
  } as ResponseOutputItem;
}

export function reasoningItem(summary: string[]): ResponseOutputItem {
  return {
    id: nextId('rs'),
    type: 'reasoning',
    summary: summary.map((text) => ({ type: 'summary_text' as const, text })),
  } as ResponseOutputItem;
}

export function functionCallItem(name: string, args: string, callId = nextId('call')): ResponseOutputItem {
  return {
    id: nextId('fc'),
    type: 'function_call',
    call_id: callId,
    name,
    arguments: args,
    status: 'completed',
  } as ResponseOutputItem;
}

// ---- hosted tools (#442) -------------------------------------------------------

/** A message whose text carries `url_citation` annotations (web search). */
export function citedMessageItem(
  parts: Array<{ text: string; citations?: Array<{ url: string; title: string; start: number; end: number }> }>,
): ResponseOutputItem {
  return {
    id: nextId('msg'),
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: parts.map((part) => ({
      type: 'output_text' as const,
      text: part.text,
      annotations: (part.citations ?? []).map((c) => ({
        type: 'url_citation' as const,
        url: c.url,
        title: c.title,
        start_index: c.start,
        end_index: c.end,
      })),
    })),
  } as ResponseOutputItem;
}

export function webSearchCallItem(query: string, sources: string[] = []): ResponseOutputItem {
  return {
    id: nextId('ws'),
    type: 'web_search_call',
    status: 'completed',
    action: { type: 'search', query, sources: sources.map((url) => ({ type: 'url', url })) },
  } as ResponseOutputItem;
}

export function fileSearchCallItem(queries: string[], results: Array<Record<string, unknown>> | null): ResponseOutputItem {
  return { id: nextId('fs'), type: 'file_search_call', status: 'completed', queries, results } as ResponseOutputItem;
}

export function codeInterpreterCallItem(code: string, logs: string, imageUrl?: string): ResponseOutputItem {
  return {
    id: nextId('ci'),
    type: 'code_interpreter_call',
    status: 'completed',
    code,
    container_id: 'cntr_1',
    outputs: [{ type: 'logs', logs }, ...(imageUrl ? [{ type: 'image', url: imageUrl }] : [])],
  } as ResponseOutputItem;
}

export function imageGenerationCallItem(bytes: Uint8Array, extra: Record<string, unknown> = {}): ResponseOutputItem {
  return {
    id: nextId('ig'),
    type: 'image_generation_call',
    status: 'completed',
    result: Buffer.from(bytes).toString('base64'),
    output_format: 'png',
    ...extra,
  } as ResponseOutputItem;
}

export function mcpCallItem(name: string, args: string, output: string | null, error: unknown = null): ResponseOutputItem {
  return {
    id: nextId('mcp'),
    type: 'mcp_call',
    server_label: 'docs',
    name,
    arguments: args,
    output,
    error,
    status: error ? 'failed' : 'completed',
  } as ResponseOutputItem;
}

export function mcpListToolsItem(tools: Array<{ name: string; description?: string }>): ResponseOutputItem {
  return {
    id: nextId('mcpl'),
    type: 'mcp_list_tools',
    server_label: 'docs',
    tools: tools.map((tool) => ({ ...tool, input_schema: {} })),
  } as ResponseOutputItem;
}

export interface ResponseFixtureOptions {
  id?: string;
  model?: string;
  output?: ResponseOutputItem[];
  status?: OpenAiSdkResponse['status'];
  incompleteReason?: 'max_output_tokens' | 'content_filter';
  error?: { code: string; message: string } | null;
  usage?: Partial<{
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    cached_tokens: number;
  }> | null;
}

/** A Responses API `Response` object, as JSON. */
export function responseFixture(opts: ResponseFixtureOptions = {}): OpenAiSdkResponse {
  const output = opts.output ?? [messageItem('Hello!')];
  const usage =
    opts.usage === null
      ? null
      : {
          input_tokens: opts.usage?.input_tokens ?? 12,
          input_tokens_details: { cached_tokens: opts.usage?.cached_tokens ?? 0, cache_write_tokens: 0 },
          output_tokens: opts.usage?.output_tokens ?? 7,
          output_tokens_details: { reasoning_tokens: opts.usage?.reasoning_tokens ?? 0 },
          total_tokens: (opts.usage?.input_tokens ?? 12) + (opts.usage?.output_tokens ?? 7),
        };

  return {
    id: opts.id ?? nextId('resp'),
    object: 'response',
    created_at: 1_760_000_000,
    model: opts.model ?? 'gpt-4o-2024-08-06',
    status: opts.status ?? 'completed',
    error: opts.error ?? null,
    incomplete_details: opts.incompleteReason ? { reason: opts.incompleteReason } : null,
    instructions: null,
    metadata: {},
    output,
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    usage,
  } as unknown as OpenAiSdkResponse;
}

function chunks(text: string, size: number): string[] {
  const out: string[] = [];

  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));

  return out;
}

/**
 * The event sequence OpenAI streams for `final`: created, then per output
 * item `output_item.added`, its deltas (text, reasoning summary, function
 * arguments) in `chunkSize` pieces, `output_item.done`, and finally the
 * terminal event matching `final.status`.
 */
export function streamEventsFor(final: OpenAiSdkResponse, chunkSize = 4): ResponseStreamEvent[] {
  let seq = 0;
  const events: Array<Record<string, unknown>> = [];
  const push = (event: Record<string, unknown>) => events.push({ ...event, sequence_number: seq++ });
  const inProgress = { ...final, status: 'in_progress', output: [], usage: null };

  push({ type: 'response.created', response: inProgress });
  push({ type: 'response.in_progress', response: inProgress });

  final.output.forEach((item, outputIndex) => {
    const itemId = (item as { id?: string }).id ?? `item_${outputIndex}`;

    push({ type: 'response.output_item.added', output_index: outputIndex, item: { ...item, status: 'in_progress' } });

    if (item.type === 'message') {
      item.content.forEach((part, contentIndex) => {
        if (part.type !== 'output_text') return;

        for (const delta of chunks(part.text, chunkSize)) {
          push({ type: 'response.output_text.delta', item_id: itemId, output_index: outputIndex, content_index: contentIndex, delta, logprobs: [] });
        }

        push({ type: 'response.output_text.done', item_id: itemId, output_index: outputIndex, content_index: contentIndex, text: part.text, logprobs: [] });
      });
    }

    if (item.type === 'reasoning') {
      item.summary.forEach((part, summaryIndex) => {
        for (const delta of chunks(part.text, chunkSize)) {
          push({ type: 'response.reasoning_summary_text.delta', item_id: itemId, output_index: outputIndex, summary_index: summaryIndex, delta });
        }
      });
    }

    if (item.type === 'function_call') {
      for (const delta of chunks(item.arguments, chunkSize)) {
        push({ type: 'response.function_call_arguments.delta', item_id: itemId, output_index: outputIndex, delta });
      }

      push({ type: 'response.function_call_arguments.done', item_id: itemId, output_index: outputIndex, arguments: item.arguments, name: item.name });
    }

    push({ type: 'response.output_item.done', output_index: outputIndex, item });
  });

  const terminal =
    final.status === 'failed' ? 'response.failed' : final.status === 'incomplete' ? 'response.incomplete' : 'response.completed';

  push({ type: terminal, response: final });

  return events as unknown as ResponseStreamEvent[];
}
