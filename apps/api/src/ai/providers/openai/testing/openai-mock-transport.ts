// A mocked OpenAI HTTP API for tests (issue #426). Not imported by production code.
//
// Injected into the real SDK as its `fetch` (`new OpenAI({ fetch })`, via
// `OpenAiClientFactory`'s options), so tests exercise the SDK's own request
// building, error classes and SSE parsing — only the network is fake. No new
// dependency (no nock/MockAgent): the SDK accepts a `fetch`, and Node's global
// `Response`/`ReadableStream` build the replies.
//
// Behaviour:
//   - `Authorization: Bearer <key>` not in `validKeys` -> 401 `invalid_api_key`
//     whose message echoes the key, exactly as OpenAI does, so redaction
//     tests have something to catch;
//   - `GET /models` -> the configured model list;
//   - `POST /responses` -> whatever `respond(body)` returns: a Responses API
//     object (streamed as SSE when the body says `stream: true`), an HTTP
//     error, a network failure, or a raw SSE script;
//   - `previous_response_id` must name a response this server issued, or it
//     answers 404 like OpenAI would;
//   - `POST /files` (multipart) stores a file and answers a `FileObject`;
//     `DELETE /files/{id}` removes it (#441). `files` holds what is still
//     stored, so "the provider-side copy was deleted" is `files.size === 0`;
//     `filesWith` injects a failure for either operation.
//   - `POST /chat/completions` (#448) -> whatever `chat(body)` returns: a
//     `ChatCompletion` (streamed as chunks, with a usage chunk when
//     `stream_options.include_usage`), an HTTP error, a network failure or a
//     raw SSE script. Azure's `/deployments/{name}/chat/completions` matches
//     too.
//   - `auth: 'api-key'` (#448) reads Azure's `api-key` header instead of the
//     bearer token; `allowAnonymous` accepts a request carrying no key at all
//     (a keyless OpenAI-compatible server) while still refusing a wrong one.

import type { Response as OpenAiSdkResponse, ResponseStreamEvent } from 'openai/resources/responses/responses';

import type { ChatCompletion } from 'openai/resources/chat/completions/completions';

import type { OpenAiFetch } from '../openai-client.factory';
import { chatChunksFor } from './chat-completions-fixtures';
import { streamEventsFor } from './openai-fixtures';

export interface MockSseFrame {
  /** SSE `event:` name; OpenAI names every frame after its `type`. */
  event?: string;
  data: unknown;
}

export type MockReply =
  | { kind: 'response'; response: OpenAiSdkResponse; chunkSize?: number }
  | { kind: 'error'; status: number; error: Record<string, unknown>; headers?: Record<string, string> }
  | { kind: 'network' }
  /** A hand-written SSE script. `hang` keeps the connection open after the last frame until aborted. */
  | { kind: 'sse'; frames: MockSseFrame[]; hang?: boolean };

export type MockChatReply =
  | { kind: 'completion'; completion: ChatCompletion; chunkSize?: number }
  | { kind: 'error'; status: number; error: Record<string, unknown>; headers?: Record<string, string> }
  | { kind: 'network' }
  /** A hand-written SSE script (`data:` frames only, as Chat Completions sends). */
  | { kind: 'sse'; frames: MockSseFrame[]; hang?: boolean };

export type MockEmbeddingReply =
  /** A `/v1/embeddings` JSON body, sent as-is (so a test can make it malformed). */
  | { kind: 'embeddings'; body: Record<string, unknown> }
  | { kind: 'error'; status: number; error: Record<string, unknown>; headers?: Record<string, string> }
  | { kind: 'network' };

export type MockImagesReply =
  /** A `/v1/images/*` JSON body, sent as-is (so a test can make it malformed). */
  | { kind: 'images'; body: Record<string, unknown> }
  | { kind: 'error'; status: number; error: Record<string, unknown>; headers?: Record<string, string> }
  | { kind: 'network' };

/** A `/v1/files` failure to inject, or `undefined` to answer normally. */
export type MockFilesReply =
  | { kind: 'error'; status: number; error: Record<string, unknown> }
  | { kind: 'network' }
  | undefined;

/** Which files operation a request made. */
export type MockFilesOperation = 'upload' | 'delete';

/** A file the mock holds: what the multipart body carried. */
export interface MockStoredFile {
  id: string;
  filename: string;
  type: string;
  bytes: number;
  purpose: string;
}

export type MockTranscriptionReply =
  /** A `/v1/audio/transcriptions` body: JSON when an object, `text/plain` when a string. */
  | { kind: 'transcription'; body: Record<string, unknown> | string }
  | { kind: 'error'; status: number; error: Record<string, unknown>; headers?: Record<string, string> }
  | { kind: 'network' };

/** The transcript every default mock transcription answers with. */
export const MOCK_TRANSCRIPT = 'Hello from the mock transcription.';

/**
 * The default `/v1/audio/transcriptions` answer for `body`, shaped by its
 * `response_format` exactly as OpenAI shapes it: a bare string for `text`,
 * `{ text, usage }` for `json` (tokens for the GPT-4o family, a duration for
 * Whisper), and the verbose object — language, duration, segments, and
 * words when asked — for `verbose_json`.
 */
export function mockTranscriptionBody(body: Record<string, unknown>): Record<string, unknown> | string {
  const format = String(body.response_format ?? 'json');
  const whisper = String(body.model ?? '').startsWith('whisper-');

  if (format === 'text') return `${MOCK_TRANSCRIPT}\n`;

  if (format === 'verbose_json') {
    const granularities = ([] as unknown[]).concat(body['timestamp_granularities[]'] ?? []);

    return {
      task: 'transcribe',
      language: 'english',
      duration: 3.5,
      text: MOCK_TRANSCRIPT,
      segments: [
        { id: 0, seek: 0, start: 0, end: 1.5, text: ' Hello from', tokens: [1], temperature: 0, avg_logprob: -0.2, compression_ratio: 1, no_speech_prob: 0 },
        { id: 1, seek: 0, start: 1.5, end: 3.5, text: ' the mock transcription.', tokens: [2], temperature: 0, avg_logprob: -0.2, compression_ratio: 1, no_speech_prob: 0 },
      ],
      ...(granularities.includes('word')
        ? { words: [{ word: 'Hello', start: 0, end: 0.4 }, { word: 'from', start: 0.4, end: 0.8 }] }
        : {}),
      usage: { type: 'duration', seconds: 4 },
    };
  }

  return whisper
    ? { text: MOCK_TRANSCRIPT, usage: { type: 'duration', seconds: 4 } }
    : {
        text: MOCK_TRANSCRIPT,
        usage: { type: 'tokens', input_tokens: 40, output_tokens: 8, total_tokens: 48, input_token_details: { audio_tokens: 38, text_tokens: 2 } },
      };
}

export type MockSpeechReply =
  /** The audio bytes, sent as a binary body. */
  | { kind: 'speech'; bytes: Buffer; contentType?: string }
  | { kind: 'error'; status: number; error: Record<string, unknown>; headers?: Record<string, string> }
  | { kind: 'network' };

const MOCK_SPEECH_CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  pcm: 'audio/pcm',
};

/** The default `/v1/audio/speech` bytes for `body`: deterministic, format- and input-dependent. */
export function mockSpeechBytes(body: Record<string, unknown>): Buffer {
  return Buffer.from(`MOCK-${String(body.response_format ?? 'mp3').toUpperCase()}:${String(body.voice)}:${String(body.input)}`);
}

export type MockRealtimeReply =
  /** The `client_secrets` answer body. */
  | { kind: 'client_secret'; body: Record<string, unknown> }
  | { kind: 'error'; status: number; error: Record<string, unknown>; headers?: Record<string, string> }
  | { kind: 'network' };

/** Every ephemeral secret the mock mints starts with this. */
export const MOCK_REALTIME_SECRET_PREFIX = 'ek_mock_';

/**
 * The default `/v1/realtime/client_secrets` answer for `body`: a fresh
 * ephemeral secret, `expires_at` from `expires_after.seconds` (600 when
 * omitted, the SDK-documented default), and the effective session echoed.
 */
export function mockClientSecretBody(body: Record<string, unknown>, counter: number): Record<string, unknown> {
  const session = (body.session ?? {}) as Record<string, any>;
  const seconds = Number((body.expires_after as { seconds?: number } | undefined)?.seconds ?? 600);

  return {
    value: `${MOCK_REALTIME_SECRET_PREFIX}${counter}`,
    expires_at: 1_700_000_000 + seconds,
    session: {
      id: `sess_mock_${counter}`,
      object: 'realtime.session',
      type: 'realtime',
      model: session.model,
      output_modalities: session.output_modalities ?? ['audio'],
      instructions: session.instructions ?? '',
      max_output_tokens: session.max_output_tokens ?? 'inf',
      audio: {
        input: { turn_detection: session.audio?.input?.turn_detection ?? { type: 'server_vad', threshold: 0.5 } },
        output: { voice: session.audio?.output?.voice ?? 'alloy' },
      },
      tools: session.tools ?? [],
    },
  };
}

/** Which images endpoint a request hit. */
export type MockImagesOperation = 'generations' | 'edits';

/** A real, 1x1 transparent PNG — what the mock "generates". */
export const MOCK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** The default `/v1/images/*` answer for `body`: `n` PNGs (1 by default), with token usage. */
export function mockImagesBody(body: Record<string, unknown>): Record<string, unknown> {
  const n = Number(body.n ?? 1) || 1;
  const dallE = String(body.model ?? '').startsWith('dall-e-');

  return {
    created: 1_700_000_000,
    data: Array.from({ length: n }, (_, i) => ({
      b64_json: MOCK_PNG_BASE64,
      ...(dallE ? { revised_prompt: `revised: ${String(body.prompt)} #${i + 1}` } : {}),
    })),
    ...(dallE ? {} : { output_format: body.output_format ?? 'png' }),
    ...(dallE
      ? {}
      : {
          usage: {
            input_tokens: 12,
            input_tokens_details: { image_tokens: 0, text_tokens: 12 },
            output_tokens: 272 * n,
            total_tokens: 12 + 272 * n,
          },
        }),
  };
}

/** A multipart body as a plain record: repeated keys become arrays, files `{ filename, type, size }`. */
async function formDataRecord(form: FormData, uploads?: Buffer[]): Promise<Record<string, unknown>> {
  const record: Record<string, unknown> = {};

  for (const [key, value] of form.entries()) {
    if (typeof value !== 'string' && uploads) uploads.push(Buffer.from(await value.arrayBuffer()));

    const entry: unknown =
      typeof value === 'string' ? value : { filename: value.name, type: value.type, size: value.size };

    if (key in record) {
      const existing = record[key];

      record[key] = Array.isArray(existing) ? [...existing, entry] : [existing, entry];
    } else {
      record[key] = key.endsWith('[]') ? [entry] : entry;
    }
  }

  return record;
}

/** The native vector length the mock gives an embedding model. */
export function mockEmbeddingLength(model: string): number {
  return model.includes('large') ? 3072 : 1536;
}

/** A deterministic, input-dependent vector — equal texts embed equally. */
export function mockEmbeddingVector(text: string, length: number): number[] {
  let seed = 0;

  for (const char of text) seed = (seed * 31 + char.charCodeAt(0)) % 9973;

  return Array.from({ length }, (_, i) => ((seed + i * 7) % 1000) / 1000);
}

/** The default `/v1/embeddings` answer for `body`. */
export function mockEmbeddingsBody(body: Record<string, unknown>): Record<string, unknown> {
  const model = String(body.model);
  const inputs = Array.isArray(body.input) ? (body.input as string[]) : [String(body.input)];
  const length = typeof body.dimensions === 'number' ? body.dimensions : mockEmbeddingLength(model);
  const promptTokens = inputs.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);

  return {
    object: 'list',
    model,
    data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: mockEmbeddingVector(text, length) })),
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  };
}

export interface RecordedRequest {
  method: string;
  path: string;
  /** The full URL, query string included (Azure's `api-version`). */
  url: URL;
  apiKey: string | null;
  headers: Headers;
  body: Record<string, unknown> | undefined;
  signal: AbortSignal | undefined;
}

export interface OpenAiMockServerOptions {
  validKeys: string[];
  models?: string[];
  respond?(body: Record<string, unknown>): MockReply;
  /** `/chat/completions` responder (#448). Defaults to a network failure. */
  chat?(body: Record<string, unknown>): MockChatReply;
  /** Which header carries the key: OpenAI's bearer token (default) or Azure's `api-key`. */
  auth?: 'bearer' | 'api-key';
  /** Accept a request that carries no key at all (a keyless compatible server). */
  allowAnonymous?: boolean;
  /** `/embeddings` responder. Defaults to `mockEmbeddingsBody`. */
  embed?(body: Record<string, unknown>): MockEmbeddingReply;
  /** `/images/*` responder. Defaults to `mockImagesBody`. */
  images?(operation: MockImagesOperation, body: Record<string, unknown>): MockImagesReply;
  /** `/audio/transcriptions` responder. Defaults to `mockTranscriptionBody`. */
  transcribe?(body: Record<string, unknown>): MockTranscriptionReply;
  /** `/audio/speech` responder. Defaults to `mockSpeechBytes`. */
  speech?(body: Record<string, unknown>): MockSpeechReply;
  /** `/realtime/client_secrets` responder. Defaults to `mockClientSecretBody`. */
  realtime?(body: Record<string, unknown>): MockRealtimeReply;
}

function json(status: number, payload: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
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

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

/** Frames for a Responses API event list, named the way OpenAI names them. */
export function framesFor(events: ResponseStreamEvent[]): MockSseFrame[] {
  return events.map((event) => ({ event: event.type, data: event }));
}

export class OpenAiMockServer {
  readonly requests: RecordedRequest[] = [];
  /** The bytes of every uploaded file part, in order (images, audio). */
  readonly uploads: Buffer[] = [];

  private readonly validKeys: Set<string>;
  private readonly models: string[];
  private readonly issuedResponseIds = new Set<string>();
  private requestCounter = 0;
  private respondFn: (body: Record<string, unknown>) => MockReply;
  private chatFn: (body: Record<string, unknown>) => MockChatReply;
  private readonly auth: 'bearer' | 'api-key';
  private readonly allowAnonymous: boolean;
  private readonly queued: MockReply[] = [];
  private embedFn: (body: Record<string, unknown>) => MockEmbeddingReply;
  private imagesFn: (operation: MockImagesOperation, body: Record<string, unknown>) => MockImagesReply;
  private filesFn: (operation: MockFilesOperation, fileId?: string) => MockFilesReply = () => undefined;
  private fileCounter = 0;

  /** Files uploaded and not (yet) deleted, by id. */
  readonly files = new Map<string, MockStoredFile>();

  /** Ids of every file deleted, in order. */
  readonly deletedFileIds: string[] = [];
  private transcribeFn: (body: Record<string, unknown>) => MockTranscriptionReply;
  private speechFn: (body: Record<string, unknown>) => MockSpeechReply;
  private realtimeFn: (body: Record<string, unknown>) => MockRealtimeReply;
  private secretCounter = 0;

  constructor(opts: OpenAiMockServerOptions) {
    this.validKeys = new Set(opts.validKeys);
    this.models = opts.models ?? ['gpt-4o', 'gpt-4o-mini', 'o3', 'text-embedding-3-small'];
    this.respondFn = opts.respond ?? (() => ({ kind: 'network' }));
    this.chatFn = opts.chat ?? (() => ({ kind: 'network' }));
    this.auth = opts.auth ?? 'bearer';
    this.allowAnonymous = opts.allowAnonymous ?? false;
    this.embedFn = opts.embed ?? ((body) => ({ kind: 'embeddings', body: mockEmbeddingsBody(body) }));
    this.imagesFn = opts.images ?? ((_operation, body) => ({ kind: 'images', body: mockImagesBody(body) }));
    this.transcribeFn = opts.transcribe ?? ((body) => ({ kind: 'transcription', body: mockTranscriptionBody(body) }));
    this.speechFn = opts.speech ?? ((body) => ({ kind: 'speech', bytes: mockSpeechBytes(body) }));
    this.realtimeFn =
      opts.realtime ??
      ((body) => {
        this.secretCounter += 1;

        return { kind: 'client_secret', body: mockClientSecretBody(body, this.secretCounter) };
      });
  }

  /** Replaces the `/realtime/client_secrets` responder. */
  realtimeWith(fn: (body: Record<string, unknown>) => MockRealtimeReply): void {
    this.realtimeFn = fn;
  }

  /** Replaces the `/audio/speech` responder. */
  speechWith(fn: (body: Record<string, unknown>) => MockSpeechReply): void {
    this.speechFn = fn;
  }

  /** Replaces the `/audio/transcriptions` responder. */
  transcribeWith(fn: (body: Record<string, unknown>) => MockTranscriptionReply): void {
    this.transcribeFn = fn;
  }

  /** Replaces the `/images/*` responder. */
  imagesWith(fn: (operation: MockImagesOperation, body: Record<string, unknown>) => MockImagesReply): void {
    this.imagesFn = fn;
  }

  /** Injects a `/files` failure (return `undefined` to answer normally). */
  filesWith(fn: (operation: MockFilesOperation, fileId?: string) => MockFilesReply): void {
    this.filesFn = fn;
  }

  /** Replaces the `/embeddings` responder. */
  embedWith(fn: (body: Record<string, unknown>) => MockEmbeddingReply): void {
    this.embedFn = fn;
  }

  /** Replaces the `/chat/completions` responder. */
  chatWith(fn: (body: Record<string, unknown>) => MockChatReply): void {
    this.chatFn = fn;
  }

  /** Replaces the `/responses` responder. */
  respondWith(fn: (body: Record<string, unknown>) => MockReply): void {
    this.respondFn = fn;
  }

  /** Answers the next `/responses` call with `reply`, ahead of the responder. */
  enqueue(reply: MockReply): void {
    this.queued.push(reply);
  }

  /** Requests made to `path` (e.g. `/v1/responses`). */
  requestsTo(path: string): RecordedRequest[] {
    return this.requests.filter((req) => req.path === path);
  }

  readonly fetch: OpenAiFetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

    // The SDK probes a custom `fetch` for FormData support with a `data:` URL
    // before its first multipart request; that is not an API call.
    if (url.protocol === 'data:') return new Response('');

    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization');
    const apiKey =
      this.auth === 'api-key'
        ? headers.get('api-key')
        : auth?.startsWith('Bearer ')
          ? auth.slice('Bearer '.length)
          : null;
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    const contentType = headers.get('content-type') ?? '';
    const body =
      init?.body instanceof FormData
        ? await formDataRecord(init.body, this.uploads)
        : init?.body instanceof ReadableStream && contentType.startsWith('multipart/form-data')
          ? // A lazily streamed multipart body (`toStreamingFile`): read it the way a server would.
            await formDataRecord(
              await new Response(init.body, { headers: { 'content-type': contentType } }).formData(),
              this.uploads,
            )
          : rawBody
            ? (JSON.parse(rawBody) as Record<string, unknown>)
            : undefined;
    const signal = init?.signal ?? undefined;

    this.requests.push({ method: init?.method ?? 'GET', path: url.pathname, url, apiKey, headers, body, signal });

    if (signal?.aborted) throw abortError();

    this.requestCounter += 1;
    const replyHeaders = { 'x-request-id': `req_mock_${this.requestCounter}` };

    const anonymous = apiKey === null && this.allowAnonymous;

    if (!anonymous && (!apiKey || !this.validKeys.has(apiKey))) {
      return json(
        401,
        {
          error: {
            message: `Incorrect API key provided: ${apiKey}. You can find your API key at https://platform.openai.com/account/api-keys.`,
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_api_key',
          },
        },
        replyHeaders,
      );
    }

    if (url.pathname.endsWith('/models') && (init?.method ?? 'GET') === 'GET') {
      return json(
        200,
        {
          object: 'list',
          data: this.models.map((id, index) => ({ id, object: 'model', created: 1_700_000_000 + index, owned_by: 'openai' })),
        },
        replyHeaders,
      );
    }

    if (url.pathname.endsWith('/responses') && init?.method === 'POST' && body) {
      const previous = body.previous_response_id;

      if (typeof previous === 'string' && !this.issuedResponseIds.has(previous)) {
        return json(
          404,
          {
            error: {
              message: `Previous response with id '${previous}' not found.`,
              type: 'invalid_request_error',
              param: 'previous_response_id',
              code: 'previous_response_not_found',
            },
          },
          replyHeaders,
        );
      }

      const reply = this.queued.shift() ?? this.respondFn(body);

      switch (reply.kind) {
        case 'network':
          throw new TypeError('fetch failed');

        case 'error':
          return json(reply.status, { error: reply.error }, { ...replyHeaders, ...(reply.headers ?? {}) });

        case 'sse':
          return sseResponse(reply.frames, replyHeaders, reply.hang ?? false, signal);

        case 'response':
          this.issuedResponseIds.add(reply.response.id);

          return body.stream === true
            ? sseResponse(framesFor(streamEventsFor(reply.response, reply.chunkSize)), replyHeaders, false, signal)
            : json(200, reply.response, replyHeaders);
      }
    }

    if (url.pathname.endsWith('/chat/completions') && init?.method === 'POST' && body) {
      const reply = this.chatFn(body);

      switch (reply.kind) {
        case 'network':
          throw new TypeError('fetch failed');

        case 'error':
          return json(reply.status, { error: reply.error }, { ...replyHeaders, ...(reply.headers ?? {}) });

        case 'sse':
          return sseResponse(reply.frames, replyHeaders, reply.hang ?? false, signal);

        case 'completion': {
          if (body.stream !== true) return json(200, reply.completion, replyHeaders);

          const includeUsage = (body.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true;
          const frames: MockSseFrame[] = [
            ...chatChunksFor(reply.completion, reply.chunkSize, includeUsage).map((chunk) => ({ data: chunk })),
            { data: '[DONE]' },
          ];

          return sseResponse(frames, replyHeaders, false, signal);
        }
      }
    }

    if (url.pathname.endsWith('/embeddings') && init?.method === 'POST' && body) {
      const reply = this.embedFn(body);

      switch (reply.kind) {
        case 'network':
          throw new TypeError('fetch failed');

        case 'error':
          return json(reply.status, { error: reply.error }, { ...replyHeaders, ...(reply.headers ?? {}) });

        case 'embeddings':
          return json(200, reply.body, replyHeaders);
      }
    }

    if (url.pathname.endsWith('/files') && init?.method === 'POST' && body) {
      const injected = this.filesFn('upload');

      if (injected?.kind === 'network') throw new TypeError('fetch failed');
      if (injected?.kind === 'error') return json(injected.status, { error: injected.error }, replyHeaders);

      const file = body.file as { filename: string; type: string; size: number };

      this.fileCounter += 1;

      const stored: MockStoredFile = {
        id: `file-mock${this.fileCounter}`,
        filename: file.filename,
        type: file.type,
        bytes: file.size,
        purpose: String(body.purpose),
      };

      this.files.set(stored.id, stored);

      return json(
        200,
        {
          id: stored.id,
          object: 'file',
          bytes: stored.bytes,
          created_at: 1_700_000_000,
          filename: stored.filename,
          purpose: stored.purpose,
          status: 'processed',
        },
        replyHeaders,
      );
    }

    const fileRoute = /\/files\/([^/]+)$/.exec(url.pathname);

    if (fileRoute && init?.method === 'DELETE') {
      const fileId = decodeURIComponent(fileRoute[1]);
      const injected = this.filesFn('delete', fileId);

      if (injected?.kind === 'network') throw new TypeError('fetch failed');
      if (injected?.kind === 'error') return json(injected.status, { error: injected.error }, replyHeaders);

      if (!this.files.delete(fileId)) {
        return json(
          404,
          { error: { message: `No such File object: ${fileId}`, type: 'invalid_request_error', param: 'id', code: null } },
          replyHeaders,
        );
      }

      this.deletedFileIds.push(fileId);

      return json(200, { id: fileId, object: 'file', deleted: true }, replyHeaders);
    }

    const images = /\/images\/(generations|edits)$/.exec(url.pathname);

    if (images && init?.method === 'POST' && body) {
      const reply = this.imagesFn(images[1] as MockImagesOperation, body);

      switch (reply.kind) {
        case 'network':
          throw new TypeError('fetch failed');

        case 'error':
          return json(reply.status, { error: reply.error }, { ...replyHeaders, ...(reply.headers ?? {}) });

        case 'images':
          return json(200, reply.body, replyHeaders);
      }
    }

    if (url.pathname.endsWith('/audio/transcriptions') && init?.method === 'POST' && body) {
      const reply = this.transcribeFn(body);

      switch (reply.kind) {
        case 'network':
          throw new TypeError('fetch failed');

        case 'error':
          return json(reply.status, { error: reply.error }, { ...replyHeaders, ...(reply.headers ?? {}) });

        case 'transcription':
          return typeof reply.body === 'string'
            ? new Response(reply.body, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', ...replyHeaders } })
            : json(200, reply.body, replyHeaders);
      }
    }

    if (url.pathname.endsWith('/audio/speech') && init?.method === 'POST' && body) {
      const reply = this.speechFn(body);

      switch (reply.kind) {
        case 'network':
          throw new TypeError('fetch failed');

        case 'error':
          return json(reply.status, { error: reply.error }, { ...replyHeaders, ...(reply.headers ?? {}) });

        case 'speech':
          return new Response(new Uint8Array(reply.bytes), {
            status: 200,
            headers: {
              'content-type': reply.contentType ?? MOCK_SPEECH_CONTENT_TYPES[String(body.response_format ?? 'mp3')] ?? 'audio/mpeg',
              ...replyHeaders,
            },
          });
      }
    }

    if (url.pathname.endsWith('/realtime/client_secrets') && init?.method === 'POST' && body) {
      const reply = this.realtimeFn(body);

      switch (reply.kind) {
        case 'network':
          throw new TypeError('fetch failed');

        case 'error':
          return json(reply.status, { error: reply.error }, { ...replyHeaders, ...(reply.headers ?? {}) });

        case 'client_secret':
          return json(200, reply.body, replyHeaders);
      }
    }

    return json(404, { error: { message: 'Not found', type: 'invalid_request_error', param: null, code: null } }, replyHeaders);
  };
}
