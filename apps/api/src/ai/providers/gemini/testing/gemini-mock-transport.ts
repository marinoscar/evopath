// A mocked Gemini HTTP API for tests (issue #447). Not imported by production code.
//
// Injected into the real SDK as its `fetch` (via `GeminiClientFactory`'s
// options), so tests exercise the SDK's own request building (the
// `GenerateContentConfig` -> REST body translation), error class and SSE
// parsing — only the network is fake. The same approach, and no new
// dependency, as the OpenAI and Anthropic mock transports.
//
// Behaviour:
//   - `x-goog-api-key` not in `validKeys` -> 400 INVALID_ARGUMENT with the
//     `API_KEY_INVALID` ErrorInfo — the real API's answer to a bad key (not a
//     401) — whose message echoes the key, so redaction tests have something
//     to catch;
//   - `GET /v1beta/models` -> the configured models with their metadata,
//     paginated by `pageSize` / `pageToken`;
//   - `POST /v1beta/models/{m}:generateContent` / `:streamGenerateContent`
//     -> whatever `respond(body, model)` returns: a response (streamed as SSE
//     chunks when streaming), an HTTP error, a network failure, or a raw SSE
//     script;
//   - `POST /v1beta/models/{m}:batchEmbedContents` -> one deterministic
//     vector per request (`embeddingFor`), truncated to
//     `outputDimensionality`, or a configured error.
//
// THE MOCK IS STATELESS ON PURPOSE, like the real API, and validates what the
// real API validates about a request, so a test cannot pass by leaning on
// state Gemini does not keep or on a shape Gemini would refuse:
//   - unknown top-level fields are rejected (`previous_response_id` included);
//   - a listed model is required, of the right kind for the method;
//   - `contents` is non-empty, every turn is `user` or `model` with parts, the
//     first is a user turn, and turns alternate;
//   - a function-response turn follows a function-call turn IMMEDIATELY, with
//     exactly one response per call, by name;
//   - on a Gemini 3 model, the first function call of every model step in the
//     current turn carries its `thoughtSignature`;
//   - `thinkingConfig` is refused on a model that does not think, and
//     `thinkingLevel` together with `thinkingBudget` everywhere;
//   - `responseJsonSchema` needs `responseMimeType: application/json`, and
//     Gemini 2.5 refuses a JSON response together with function calling.

import type { GeminiFetch } from '../gemini-client.factory';
import { embeddingFor, streamChunksFor, type GeminiWireResponse } from './gemini-fixtures';

export interface MockGeminiModel {
  id: string;
  kind?: 'generate' | 'embedding';
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  thinking?: boolean;
  /** Embedding models: the native vector length (default 3072). */
  dimensions?: number;
}

export type MockGeminiReply =
  | { kind: 'response'; response: GeminiWireResponse; chunkSize?: number }
  | {
      kind: 'error';
      status: number;
      grpcStatus: string;
      message?: string;
      details?: unknown[];
    }
  | { kind: 'network' }
  /** A hand-written SSE script of `data:` payloads. `hang` keeps the connection open until aborted. */
  | { kind: 'sse'; frames: unknown[]; hang?: boolean }
  /** Raw body chunks, written as given — for a bare JSON error object mid-stream. */
  | { kind: 'raw'; chunks: string[] };

export interface RecordedGeminiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  apiKey: string | null;
  headers: Headers;
  body: Record<string, unknown> | undefined;
  signal: AbortSignal | undefined;
}

export interface GeminiMockServerOptions {
  validKeys: string[];
  models?: Array<string | MockGeminiModel>;
  respond?(body: Record<string, unknown>, model: string): MockGeminiReply;
  /** An error for embedding a model, instead of vectors. */
  embedError?(model: string): MockGeminiReply | null;
}

type WirePart = Record<string, unknown> & {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name?: string; response?: unknown };
};
type WireContent = { role?: string; parts?: WirePart[] };

const GENERATE_BODY_FIELDS = new Set([
  'contents',
  'systemInstruction',
  'generationConfig',
  'tools',
  'toolConfig',
  'safetySettings',
  'cachedContent',
  'serviceTier',
  'labels',
]);

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

export function googleError(status: number, grpcStatus: string, message: string, details?: unknown[]) {
  return { error: { code: status, message, status: grpcStatus, ...(details ? { details } : {}) } };
}

function abortError(): Error {
  const err = new Error('This operation was aborted');

  err.name = 'AbortError';

  return err;
}

function sseResponse(frames: unknown[], hang: boolean, signal?: AbortSignal): Response {
  return rawResponse(
    frames.map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\r\n\r\n`),
    hang,
    signal,
  );
}

function rawResponse(chunks: string[], hang: boolean, signal?: AbortSignal): Response {
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
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

  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function isGemini3(model: string): boolean {
  return /^gemini-3/.test(model);
}

function isGemini25(model: string): boolean {
  return /^gemini-2\.5-/.test(model);
}

function hasFunctionCalls(turn: WireContent): boolean {
  return (turn.parts ?? []).some((part) => part.functionCall);
}

function hasFunctionResponses(turn: WireContent): boolean {
  return (turn.parts ?? []).some((part) => part.functionResponse);
}

/** What the real API would say is wrong with this `generateContent` body, or `null`. */
export function requestProblem(body: Record<string, unknown>, model: MockGeminiModel): string | null {
  for (const key of Object.keys(body)) {
    if (!GENERATE_BODY_FIELDS.has(key)) {
      return `Invalid JSON payload received. Unknown name "${key}": Cannot find field.`;
    }
  }

  const contents = (Array.isArray(body.contents) ? body.contents : []) as WireContent[];

  if (contents.length === 0) return '* GenerateContentRequest.contents: contents is not specified';

  for (const [i, turn] of contents.entries()) {
    if (turn.role !== 'user' && turn.role !== 'model') {
      return `* GenerateContentRequest.contents[${i}].role: Please use a valid role: user, model.`;
    }
    if (!Array.isArray(turn.parts) || turn.parts.length === 0) {
      return `* GenerateContentRequest.contents[${i}].parts: contents.parts must not be empty.`;
    }
    for (const part of turn.parts) {
      if (part.functionCall && (typeof part.functionCall.args !== 'object' || Array.isArray(part.functionCall.args))) {
        return `* GenerateContentRequest.contents[${i}]: functionCall.args must be a JSON object.`;
      }
      if (
        part.functionResponse &&
        (!part.functionResponse.name ||
          typeof part.functionResponse.response !== 'object' ||
          Array.isArray(part.functionResponse.response))
      ) {
        return `* GenerateContentRequest.contents[${i}]: functionResponse needs a name and an object response.`;
      }
    }
  }

  if (contents[0].role !== 'user') return 'Please ensure that multiturn requests start with a user turn.';

  for (let i = 1; i < contents.length; i += 1) {
    if (contents[i].role === contents[i - 1].role) {
      return 'Please ensure that multiturn requests alternate between user and model.';
    }
  }

  for (let i = 0; i < contents.length; i += 1) {
    const turn = contents[i];

    if (hasFunctionResponses(turn)) {
      const previous = contents[i - 1];

      if (!previous || !hasFunctionCalls(previous)) {
        return 'Please ensure that function response turn comes immediately after a function call turn.';
      }

      const calls = (previous.parts ?? []).filter((p) => p.functionCall).map((p) => p.functionCall?.name).sort();
      const responses = (turn.parts ?? []).filter((p) => p.functionResponse).map((p) => p.functionResponse?.name).sort();

      if (calls.length !== responses.length) {
        return 'Please ensure that the number of function response parts is equal to the number of function call parts of the function call turn.';
      }
      if (calls.join(',') !== responses.join(',')) {
        return 'Please ensure that each function response names a function call of the function call turn.';
      }
    }
  }

  if (isGemini3(model.id)) {
    // The current turn: everything after the last user turn that is not
    // just function responses.
    let start = 0;

    contents.forEach((turn, i) => {
      if (turn.role === 'user' && !hasFunctionResponses(turn)) start = i;
    });

    for (let i = start; i < contents.length; i += 1) {
      const turn = contents[i];
      const firstCall = (turn.parts ?? []).find((p) => p.functionCall);

      if (turn.role === 'model' && firstCall && !firstCall.thoughtSignature) {
        return `Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance. Additional data, function call \`default_api:${firstCall.functionCall?.name}\` , position ${i + 1}.`;
      }
    }
  }

  const generation = (body.generationConfig ?? {}) as Record<string, unknown>;
  const thinking = generation.thinkingConfig as Record<string, unknown> | undefined;

  if (thinking) {
    if (model.thinking === false) return 'Thinking is not enabled for this model.';
    if (thinking.thinkingLevel !== undefined && thinking.thinkingBudget !== undefined) {
      return 'thinking_level and thinking_budget cannot both be set.';
    }
  }

  if (generation.responseJsonSchema !== undefined && generation.responseMimeType !== 'application/json') {
    return 'response_json_schema requires response_mime_type to be application/json.';
  }

  const tools = (Array.isArray(body.tools) ? body.tools : []) as Array<Record<string, unknown>>;
  const declares = tools.some((tool) => Array.isArray(tool.functionDeclarations));

  if (isGemini25(model.id) && declares && generation.responseMimeType === 'application/json') {
    return "Function calling with a response mime type: 'application/json' is unsupported";
  }

  return null;
}

export class GeminiMockServer {
  readonly requests: RecordedGeminiRequest[] = [];

  private readonly validKeys: Set<string>;
  private readonly models: MockGeminiModel[];
  private respondFn: (body: Record<string, unknown>, model: string) => MockGeminiReply;
  private readonly embedErrorFn: (model: string) => MockGeminiReply | null;
  private readonly queued: MockGeminiReply[] = [];

  constructor(opts: GeminiMockServerOptions) {
    this.validKeys = new Set(opts.validKeys);
    this.models = (opts.models ?? ['gemini-2.5-flash']).map((model) =>
      typeof model === 'string' ? { id: model } : model,
    );
    this.respondFn =
      opts.respond ??
      (() => ({ kind: 'error', status: 500, grpcStatus: 'INTERNAL', message: 'no responder configured' }));
    this.embedErrorFn = opts.embedError ?? (() => null);
  }

  /** Replace the responder. */
  onGenerate(fn: (body: Record<string, unknown>, model: string) => MockGeminiReply): void {
    this.respondFn = fn;
  }

  /** Answer the next generate call(s) with these replies, in order, before the responder. */
  queue(...replies: MockGeminiReply[]): void {
    this.queued.push(...replies);
  }

  /** `generateContent` / `streamGenerateContent` requests only. */
  get generateRequests(): RecordedGeminiRequest[] {
    return this.requests.filter((r) => /:(?:stream)?[gG]enerateContent$/.test(r.path));
  }

  private kindOf(model: MockGeminiModel): 'generate' | 'embedding' {
    return model.kind ?? (/embedding/.test(model.id) ? 'embedding' : 'generate');
  }

  private find(model: string): MockGeminiModel | undefined {
    return this.models.find((m) => m.id === model);
  }

  private errorResponse(reply: Extract<MockGeminiReply, { kind: 'error' }>): Response {
    return json(reply.status, googleError(reply.status, reply.grpcStatus, reply.message ?? reply.grpcStatus, reply.details));
  }

  readonly fetch: GeminiFetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' && init.body.length > 0
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : undefined;
    const apiKey = headers.get('x-goog-api-key');
    const signal = init?.signal ?? undefined;

    this.requests.push({ method, path: url.pathname, query: url.searchParams, apiKey, headers, body, signal });

    if (signal?.aborted) throw abortError();

    if (!apiKey || !this.validKeys.has(apiKey)) {
      return json(
        400,
        googleError(400, 'INVALID_ARGUMENT', `API key not valid. Please pass a valid API key. (${apiKey ?? ''})`, [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'API_KEY_INVALID',
            domain: 'googleapis.com',
            metadata: { service: 'generativelanguage.googleapis.com' },
          },
        ]),
      );
    }

    if (method === 'GET' && url.pathname === '/v1beta/models') {
      const pageSize = Number(url.searchParams.get('pageSize') ?? 50);
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const page = this.models.slice(start, start + pageSize);
      const next = start + pageSize < this.models.length ? String(start + pageSize) : undefined;

      return json(200, {
        models: page.map((model) => {
          const embedding = this.kindOf(model) === 'embedding';

          return {
            name: `models/${model.id}`,
            version: '001',
            displayName: model.id,
            inputTokenLimit: model.inputTokenLimit ?? (embedding ? 2048 : 1_048_576),
            outputTokenLimit: model.outputTokenLimit ?? (embedding ? 1 : 65_536),
            supportedGenerationMethods: embedding
              ? ['embedContent', 'countTextTokens', 'countTokens']
              : ['generateContent', 'countTokens', 'createCachedContent', 'batchGenerateContent'],
            ...(embedding ? {} : { thinking: model.thinking ?? !/^gemini-(?:2\.0|1\.5)/.test(model.id) }),
          };
        }),
        ...(next ? { nextPageToken: next } : {}),
      });
    }

    const match = /^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent|batchEmbedContents)$/.exec(url.pathname);

    if (method === 'POST' && match && body) {
      const [, modelId, action] = match;
      const model = this.find(modelId);
      const wantKind = action === 'batchEmbedContents' ? 'embedding' : 'generate';

      if (!model || this.kindOf(model) !== wantKind) {
        return json(
          404,
          googleError(404, 'NOT_FOUND', `models/${modelId} is not found for API version v1beta, or is not supported for ${action}.`),
        );
      }

      if (action === 'batchEmbedContents') return this.embed(body, model);

      const problem = requestProblem(body, { ...model, thinking: model.thinking ?? !/^gemini-(?:2\.0|1\.5)/.test(model.id) });

      if (problem) return json(400, googleError(400, 'INVALID_ARGUMENT', problem));

      const reply = this.queued.shift() ?? this.respondFn(body, modelId);
      const streaming = action === 'streamGenerateContent';

      switch (reply.kind) {
        case 'network':
          throw new TypeError('fetch failed');

        case 'error':
          return this.errorResponse(reply);

        case 'sse':
          return sseResponse(reply.frames, reply.hang ?? false, signal);

        case 'raw':
          return rawResponse(reply.chunks, false, signal);

        case 'response':
          if (streaming && url.searchParams.get('alt') !== 'sse') {
            return json(400, googleError(400, 'INVALID_ARGUMENT', 'streaming requires alt=sse in this mock'));
          }

          return streaming
            ? sseResponse(streamChunksFor(reply.response, reply.chunkSize), false, signal)
            : json(200, reply.response);
      }
    }

    return json(404, googleError(404, 'NOT_FOUND', `No route for ${method} ${url.pathname}`));
  };

  private embed(body: Record<string, unknown>, model: MockGeminiModel): Response {
    const failure = this.embedErrorFn(model.id);

    if (failure?.kind === 'error') return this.errorResponse(failure);
    if (failure?.kind === 'network') throw new TypeError('fetch failed');

    const requests = (Array.isArray(body.requests) ? body.requests : []) as Array<Record<string, unknown>>;

    if (requests.length === 0) return json(400, googleError(400, 'INVALID_ARGUMENT', '* BatchEmbedContentsRequest.requests: must not be empty'));
    if (requests.length > 100) {
      return json(400, googleError(400, 'INVALID_ARGUMENT', '* BatchEmbedContentsRequest.requests: at most 100 requests can be in one batch'));
    }

    const embeddings = [];

    for (const request of requests) {
      if (request.model !== `models/${model.id}`) {
        return json(400, googleError(400, 'INVALID_ARGUMENT', 'Model names in the batch must match the model in the URL.'));
      }

      const parts = ((request.content as WireContent | undefined)?.parts ?? []) as WirePart[];
      const text = parts.map((part) => part.text ?? '').join('');
      const dims = typeof request.outputDimensionality === 'number' ? request.outputDimensionality : undefined;

      if (parts.length === 0) return json(400, googleError(400, 'INVALID_ARGUMENT', '* content.parts must not be empty'));

      const full = embeddingFor(text, model.dimensions ?? 3072);

      embeddings.push({ values: dims ? full.slice(0, dims) : full });
    }

    return json(200, { embeddings });
  }
}
