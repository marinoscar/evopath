// A mocked Anthropic HTTP API for tests (issue #446). Not imported by production code.
//
// Injected into the real SDK as its `fetch` (via `AnthropicClientFactory`'s
// options), so tests exercise the SDK's own request building, error classes
// and SSE parsing — only the network is fake. The same approach, and no new
// dependency, as `openai-mock-transport.ts`.
//
// Behaviour:
//   - `x-api-key` not in `validKeys` -> 401 `authentication_error` whose
//     message echoes the key, so redaction tests have something to catch;
//   - `GET /v1/models` -> the configured model list, paginated by `limit`;
//   - `POST /v1/messages` -> whatever `respond(body)` returns: a `Message`
//     (streamed as SSE when the body says `stream: true`), an HTTP error, a
//     network failure, or a raw SSE script.
//
// THE MOCK IS STATELESS ON PURPOSE, like the real API, and validates what the
// real API validates about a conversation, so a test cannot pass by leaning
// on state Anthropic does not keep:
//   - `max_tokens` is required;
//   - the first message is a user turn, and roles alternate;
//   - every `tool_result` names a `tool_use` in the IMMEDIATELY preceding
//     assistant turn;
//   - with extended thinking on, an assistant turn that calls a tool must
//     start with a (signed) thinking block;
//   - any `previous_response_id`-like field is rejected as unknown.

import type { Message, RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages';

import type { AnthropicFetch } from '../anthropic-client.factory';
import { streamEventsFor } from './anthropic-fixtures';

export interface MockSseFrame {
  event?: string;
  data: unknown;
}

export type MockAnthropicReply =
  | { kind: 'message'; message: Message; chunkSize?: number }
  | { kind: 'error'; status: number; type: string; message?: string; headers?: Record<string, string> }
  | { kind: 'network' }
  /** A hand-written SSE script. `hang` keeps the connection open after the last frame until aborted. */
  | { kind: 'sse'; frames: MockSseFrame[]; hang?: boolean };

export interface RecordedAnthropicRequest {
  method: string;
  path: string;
  apiKey: string | null;
  headers: Headers;
  body: Record<string, unknown> | undefined;
  signal: AbortSignal | undefined;
}

export interface AnthropicMockServerOptions {
  validKeys: string[];
  models?: string[];
  respond?(body: Record<string, unknown>): MockAnthropicReply;
}

type Block = { type: string; id?: string; tool_use_id?: string; signature?: string };
type Turn = { role: string; content: string | Block[] };

function json(status: number, payload: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function errorBody(type: string, message: string) {
  return { type: 'error', error: { type, message } };
}

function abortError(): Error {
  const err = new Error('This operation was aborted');

  err.name = 'AbortError';

  return err;
}

function sseResponse(frames: MockSseFrame[], headers: Record<string, string>, hang: boolean, signal?: AbortSignal): Response {
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        const lines = [
          ...(frame.event ? [`event: ${frame.event}`] : []),
          `data: ${typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data)}`,
        ];

        controller.enqueue(encoder.encode(`${lines.join('\n')}\n\n`));
      }

      if (!hang) {
        controller.close();

        return;
      }

      const onAbort = () => {
        try {
          controller.error(abortError());
        } catch {
          // already closed
        }
      };

      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    },
  });

  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
}

/** SSE frames for a Messages event list, named the way Anthropic names them. */
export function framesFor(events: RawMessageStreamEvent[]): MockSseFrame[] {
  return events.map((event) => ({ event: event.type, data: event }));
}

/** What the real API would say is wrong with this conversation, or `null`. */
export function conversationProblem(body: Record<string, unknown>): string | null {
  if (typeof body.max_tokens !== 'number') return 'max_tokens: Field required';
  if ('previous_response_id' in body) return 'previous_response_id: Extra inputs are not permitted';

  const messages = (Array.isArray(body.messages) ? body.messages : []) as Turn[];

  if (messages.length === 0) return 'messages: at least one message is required';
  if (messages[0].role !== 'user') return 'messages: first message must use the "user" role';

  const thinking = (body.thinking as { type?: string } | undefined)?.type;
  const thinkingOn = thinking === 'enabled' || thinking === 'adaptive';

  for (let i = 0; i < messages.length; i += 1) {
    const turn = messages[i];
    const blocks: Block[] = typeof turn.content === 'string' ? [{ type: 'text' }] : turn.content;

    if (i > 0 && messages[i - 1].role === turn.role) {
      return `messages.${i}: roles must alternate between "user" and "assistant"`;
    }

    if (turn.role === 'user') {
      const previous = messages[i - 1];
      const calls = new Set(
        previous && Array.isArray(previous.content)
          ? previous.content.filter((b) => b.type === 'tool_use').map((b) => b.id)
          : [],
      );

      for (const block of blocks) {
        if (block.type === 'tool_result' && !calls.has(block.tool_use_id)) {
          return `messages.${i}: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${block.tool_use_id}. Each \`tool_result\` block must have a corresponding \`tool_use\` block in the previous message.`;
        }
      }
    }

    if (turn.role === 'assistant' && thinkingOn && blocks.some((b) => b.type === 'tool_use')) {
      const first = blocks[0];

      if (first.type !== 'thinking' && first.type !== 'redacted_thinking') {
        return `messages.${i}.content.0.type: Expected \`thinking\` or \`redacted_thinking\`, but found \`${first.type}\`.`;
      }
    }
  }

  return null;
}

export class AnthropicMockServer {
  readonly requests: RecordedAnthropicRequest[] = [];

  private readonly validKeys: Set<string>;
  private readonly models: string[];
  private requestCounter = 0;
  private respondFn: (body: Record<string, unknown>) => MockAnthropicReply;
  private readonly queued: MockAnthropicReply[] = [];

  constructor(opts: AnthropicMockServerOptions) {
    this.validKeys = new Set(opts.validKeys);
    this.models = opts.models ?? ['claude-sonnet-4-5'];
    this.respondFn =
      opts.respond ??
      (() => ({ kind: 'error', status: 500, type: 'api_error', message: 'no responder configured' }));
  }

  /** Replace the responder. */
  onMessages(fn: (body: Record<string, unknown>) => MockAnthropicReply): void {
    this.respondFn = fn;
  }

  /** Answer the next `/v1/messages` call(s) with these replies, in order, before the responder. */
  queue(...replies: MockAnthropicReply[]): void {
    this.queued.push(...replies);
  }

  /** `/v1/messages` requests only. */
  get messageRequests(): RecordedAnthropicRequest[] {
    return this.requests.filter((r) => r.path === '/v1/messages');
  }

  readonly fetch: AnthropicFetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const apiKey = headers.get('x-api-key');
    const signal = init?.signal ?? undefined;

    this.requests.push({ method, path: url.pathname, apiKey, headers, body, signal });

    if (signal?.aborted) throw abortError();

    const requestId = `req_mock_${++this.requestCounter}`;
    const base = { 'request-id': requestId };

    if (!apiKey || !this.validKeys.has(apiKey)) {
      return json(401, errorBody('authentication_error', `invalid x-api-key: ${apiKey ?? ''}`), base);
    }

    if (method === 'GET' && url.pathname === '/v1/models') {
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const after = url.searchParams.get('after_id');
      const start = after ? this.models.indexOf(after) + 1 : 0;
      const page = this.models.slice(start, start + limit);

      return json(
        200,
        {
          data: page.map((id, i) => ({
            type: 'model',
            id,
            display_name: id,
            created_at: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
            max_input_tokens: 200000,
            max_tokens: 64000,
            capabilities: null,
          })),
          has_more: start + limit < this.models.length,
          first_id: page[0] ?? null,
          last_id: page[page.length - 1] ?? null,
        },
        base,
      );
    }

    if (method === 'POST' && url.pathname === '/v1/messages' && body) {
      const problem = conversationProblem(body);

      if (problem) return json(400, errorBody('invalid_request_error', problem), base);

      const reply = this.queued.shift() ?? this.respondFn(body);

      switch (reply.kind) {
        case 'network':
          throw new TypeError('fetch failed');

        case 'error':
          return json(reply.status, errorBody(reply.type, reply.message ?? reply.type), {
            ...base,
            ...(reply.headers ?? {}),
          });

        case 'sse':
          return sseResponse(reply.frames, base, reply.hang ?? false, signal);

        case 'message':
          return body.stream === true
            ? sseResponse(framesFor(streamEventsFor(reply.message, reply.chunkSize)), base, false, signal)
            : json(200, reply.message, base);
      }
    }

    return json(404, errorBody('not_found_error', `No route for ${method} ${url.pathname}`), base);
  };
}
