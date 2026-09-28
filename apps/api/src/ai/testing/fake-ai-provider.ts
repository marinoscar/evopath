// =============================================================================
// FakeAiProvider (issue #424, epic #419)
// =============================================================================
//
// A scriptable, in-memory `AiProviderAdapter` for tests. No network, no SDK.
//
// It behaves like a well-mannered real adapter, so tests written against it
// exercise the same contract a real provider must meet — it passes
// `describeAiProviderConformance` itself (`fake-ai-provider.conformance.spec.ts`):
//
//   - every failure is an `AiError` (a raw error thrown by a script is
//     wrapped, exactly as an adapter wraps SDK errors);
//   - a key outside `validKeys` is `AI_KEY_INVALID`;
//   - a request needing a capability the model is not classified with, or a
//     hosted tool the fake was not told it supports, is
//     `AI_CAPABILITY_UNSUPPORTED`;
//   - `structuredOutput` responses are validated into `parsed`;
//   - `stream()` chunks the scripted response into well-ordered events;
//   - with `embeddingsPort: true`, `embeddings.embed()` returns one
//     deterministic vector per input (equal texts embed equally), honours
//     `dimensions`, and refuses a model classified without `embeddings`;
//   - with `imagesPort: true`, `images.generate()`/`images.edit()` return
//     `n` tiny PNGs (as bytes, in the requested `outputFormat`'s MIME type)
//     and refuse a model classified without `image_generation`/`image_edit`;
//   - storage-object inputs (#441) are delivered the way OpenAI's are by
//     default (`fileInputStrategy`: images by presigned URL, files by
//     upload): each is looked up in `ctx.storageInputs` (a part the runtime
//     did not resolve is `AI_INVALID_REQUEST`), an `upload` input's stream is
//     drained into a fake provider-side file that is "deleted" once the
//     response ends, and the call records WHAT it received — a URL or a file
//     id — in `FakeAiCall.storageInputs`, plus `deletedFileIds`;
//   - with `audioPort: true`, `audio.transcribe()` reads the whole input
//     (bytes or a stream), records it, and answers a deterministic transcript
//     whose `durationSeconds` is one second per 1000 bytes; it refuses a
//     model classified without `audio_transcription` and an input larger
//     than its `transcriptionMaxBytes`; its `speech()` (#439) answers
//     deterministic bytes (`FAKE-<format>:<voice>:<input>`) in the format's
//     MIME type and refuses empty/over-long input, a voice outside the
//     model's `voices` (else `FAKE_SPEECH_VOICES`), and a model classified
//     without `audio_speech`;
//   - with `realtimePort: true`, `realtime.createSession()` (#449) answers a
//     DISTINCT ephemeral secret per call (`FAKE_REALTIME_SECRET_PREFIX` + a
//     counter — a sentinel the no-egress suite allows on exactly one route)
//     and refuses a model classified without `realtime` and a voice outside
//     the model's `voices` (else `FAKE_REALTIME_VOICES`).
//
// And it RECORDS every call, including the `apiKey` it was called with —
// that is what lets a test prove the organisation key is never used for a
// user's inference under a BYOK policy (#435). `calls` holds the keys only
// because it is test-only code; nothing under `ai/core` may do the same.
// =============================================================================

import { AiError } from '../core/ai-error';
import { AiCapability, AiModelCapabilities } from '../core/capabilities';
import {
  AiCallContext,
  AiDiscoveredModel,
  AiDiscoveredModelMetadata,
  AiKeyVerification,
  AiProviderAdapter,
  AiResponsesPort,
} from '../core/provider-adapter.interface';
import { parseStructured } from '../core/structured-output';
import {
  AI_SPEECH_FORMAT_MIME,
  AI_SPEECH_INPUT_MAX_CHARS,
  AI_TRANSCRIPTION_DEFAULT_MAX_BYTES,
  AiAudioPort,
  AiEmbeddingRequest,
  AiEmbeddingResult,
  AiEmbeddingsPort,
  AiImageEditRequest,
  AiImageGenerationRequest,
  AiImageResult,
  AiImagesPort,
  AI_REALTIME_CLIENT_SECRET_TTL_SECONDS,
  AiRealtimePort,
  AiRealtimeSession,
  AiRealtimeSessionRequest,
  AiSpeechRequest,
  AiSpeechResult,
  AiTranscriptionRequest,
  AiTranscriptionResult,
  isStreamedPayload,
} from '../core/types/media.types';
import type {
  AiFileInputStrategies,
  AiResolvedStorageInput,
  AiStorageInputModality,
} from '../core/types/file-inputs.types';
import {
  AiContentPart,
  AiHostedToolType,
  AiOutputItem,
  AiResponse,
  AiResponseRequest,
  AiStreamEvent,
} from '../core/types/responses.types';

/**
 * A scripted response. Anything left out is filled in: `id`, `provider`,
 * `model` (from the request), `output` from `outputText` (or the reverse),
 * `usage`, and `finishReason` (`tool_calls` when a function call is present).
 */
export type FakeAiScriptedResponse = Partial<AiResponse>;

export type FakeAiScript =
  | FakeAiScriptedResponse[]
  | ((req: AiResponseRequest, ctx: AiCallContext) => FakeAiScriptedResponse | Promise<FakeAiScriptedResponse>);

export type FakeAiCallMethod =
  | 'listModels'
  | 'verifyKey'
  | 'responses.create'
  | 'responses.stream'
  | 'embeddings.embed'
  | 'images.generate'
  | 'images.edit'
  | 'audio.transcribe'
  | 'audio.speech'
  | 'realtime.createSession';

export interface FakeAiCall {
  method: FakeAiCallMethod;
  apiKey: string;
  requestId: string;
  baseUrl?: string;
  /** The provider slot's other settings the runtime passed through (#448). */
  providerSettings?: Readonly<Record<string, unknown>>;
  request?: AiResponseRequest;
  /** The request an `embeddings.embed` call received. */
  embeddingRequest?: AiEmbeddingRequest;
  /** The request an `images.generate`/`images.edit` call received. */
  imageRequest?: AiImageGenerationRequest | AiImageEditRequest;
  /** The request an `audio.transcribe` call received, without its audio. */
  transcriptionRequest?: Omit<AiTranscriptionRequest, 'audio'> & {
    audio: { mimeType: string; filename?: string; size?: number; streamed: boolean };
  };
  /** The audio bytes an `audio.transcribe` call read. */
  audioBytes?: Buffer;
  /** The request an `audio.speech` call received. */
  speechRequest?: AiSpeechRequest;
  /** The request a `realtime.createSession` call received. */
  realtimeRequest?: AiRealtimeSessionRequest;
  /** Set when the call observed `ctx.signal` aborting. */
  aborted?: boolean;
  /** What a responses call received for each storage-object part (#441), in part order. */
  storageInputs?: FakeAiDeliveredInput[];
}

/** One storage-object input as the fake received it. */
export interface FakeAiDeliveredInput {
  storageObjectId: string;
  modality: AiStorageInputModality;
  strategy: AiResolvedStorageInput['strategy'];
  filename: string;
  mimeType: string;
  /** `presigned_url`: the URL the provider would fetch. */
  url?: string;
  /** `upload`: the fake provider-side file id. */
  fileId?: string;
  /** `upload`/`inline`: how many bytes the fake read. */
  bytes?: number;
}

/** OpenAI's delivery strategies — the fake's default. */
export const FAKE_FILE_INPUT_STRATEGY: AiFileInputStrategies = { image: 'presigned_url', file: 'upload' };

export interface FakeAiProviderOptions {
  /** Registry id. Defaults to `'fake'`; a test may register it as a real id. */
  id?: string;
  displayName?: string;
  /**
   * What `responses.create`/`stream` return. An array is consumed in order
   * (running out is an error); a function is called per request. Defaults to
   * echoing the last user text.
   */
  responses?: FakeAiScript;
  /** Model ids `listModels` reports. Defaults to `['fake-model']`. */
  models?: string[];
  /** Keys accepted as valid. Omitted: any non-empty key is valid. */
  validKeys?: string[];
  /**
   * Classification per model id. Defaults: every id in `models` gets
   * `FAKE_TEXT_MODEL_CAPABILITIES`, anything else is unclassified (`null`).
   */
  classify?:
    | Record<string, AiModelCapabilities>
    | ((modelId: string, metadata?: AiDiscoveredModelMetadata) => AiModelCapabilities | null);
  /** Hosted tools the fake accepts. Defaults to none. */
  hostedTools?: AiHostedToolType[];
  /** `false` omits the responses port entirely. Defaults to `true`. */
  responsesPort?: boolean;
  /**
   * `true` carries the built-in scripted `embeddings` port (see the file
   * header). Defaults to `false`; `ports.embeddings`, when given, wins.
   */
  embeddingsPort?: boolean;
  /**
   * `true` carries the built-in scripted `images` port (generate AND edit).
   * Defaults to `false`; `ports.images`, when given, wins.
   */
  imagesPort?: boolean;
  /**
   * `true` carries the built-in scripted `audio` port (`transcribe`,
   * `speech` and `voices`).
   * Defaults to `false`; `ports.audio`, when given, wins.
   */
  audioPort?: boolean;
  /**
   * `true` carries the built-in scripted `realtime` port (`createSession` and
   * `voices`). Defaults to `false`; `ports.realtime`, when given, wins.
   */
  realtimePort?: boolean;
  /** The built-in audio port's `transcriptionMaxBytes`. Defaults to 25 MiB. */
  transcriptionMaxBytes?: number;
  /** Native vector length of the built-in embeddings port. Defaults to 8. */
  embeddingDimensions?: number;
  /** Extra ports to carry, for registry/runtime tests. */
  ports?: {
    images?: AiImagesPort;
    audio?: AiAudioPort;
    embeddings?: AiEmbeddingsPort;
    realtime?: AiRealtimePort;
  };
  /**
   * How storage-object inputs are delivered (#441). Defaults to
   * `FAKE_FILE_INPUT_STRATEGY`; `false` declares none (the provider then
   * refuses them, as one without file support does).
   */
  fileInputStrategy?: AiFileInputStrategies | false;
  /**
   * The adapter's `supportsPreviousResponseId` (#446). Omitted: the fake
   * declares nothing, which means `true` — `false` makes it behave like a
   * stateless provider for runtime tests of the full-history tool loop.
   */
  supportsPreviousResponseId?: boolean;
  /** The adapter's `supportsHostedTools`. Omitted: declares nothing (`true`). */
  supportsHostedTools?: boolean;
  /** Characters per streamed delta. Defaults to 4. */
  chunkSize?: number;
  /** Delay before a create and between stream events, in ms (abort-aware). Defaults to 0. */
  delayMs?: number;
}

/** The classification the fake gives its models unless told otherwise. */
export const FAKE_TEXT_MODEL_CAPABILITIES: AiModelCapabilities = {
  capabilities: [
    'responses',
    'reasoning',
    'tools',
    'structured_output',
    'streaming',
    'vision_input',
    'file_input',
  ],
  inputModalities: ['text', 'image', 'file'],
  outputModalities: ['text'],
  reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
};

/** The classification a fake embedding model is given in tests. */
export const FAKE_EMBEDDING_MODEL_CAPABILITIES: AiModelCapabilities = {
  capabilities: ['embeddings'],
  inputModalities: ['text'],
  outputModalities: ['embedding'],
};

/** The classification a fake image model is given in tests. */
export const FAKE_IMAGE_MODEL_CAPABILITIES: AiModelCapabilities = {
  capabilities: ['image_generation', 'image_edit'],
  inputModalities: ['text', 'image'],
  outputModalities: ['image'],
};

/** The classification a fake transcription model is given in tests. */
export const FAKE_TRANSCRIPTION_MODEL_CAPABILITIES: AiModelCapabilities = {
  capabilities: ['audio_transcription'],
  inputModalities: ['audio'],
  outputModalities: ['text'],
};

/** The classification a fake speech model is given in tests: two of the fake's voices. */
export const FAKE_SPEECH_MODEL_CAPABILITIES: AiModelCapabilities = {
  capabilities: ['audio_speech'],
  inputModalities: ['text'],
  outputModalities: ['audio'],
  voices: ['alloy', 'echo'],
};

/** The classification a fake realtime model is given in tests: two of the fake's realtime voices. */
export const FAKE_REALTIME_MODEL_CAPABILITIES: AiModelCapabilities = {
  capabilities: ['realtime'],
  inputModalities: ['text', 'audio'],
  outputModalities: ['text', 'audio'],
  voices: ['marin', 'alloy'],
};

/** The built-in realtime port's provider-wide voice list. */
export const FAKE_REALTIME_VOICES = ['marin', 'alloy', 'cedar'] as const;

/**
 * Every ephemeral secret the fake mints starts with this — a sentinel a test
 * can look for. It is NOT key material; `apiKey` is what must never leak.
 */
export const FAKE_REALTIME_SECRET_PREFIX = 'ek_fake_realtime_secret_';

/** The base URL the fake's connect URL is built from when the call names none. */
export const FAKE_REALTIME_BASE_URL = 'https://realtime.fake.invalid/v1';

/** The built-in audio port's provider-wide voice list. */
export const FAKE_SPEECH_VOICES = ['alloy', 'echo', 'nova'] as const;

/** The bytes every fake-generated image carries: a real 1x1 PNG. */
export const FAKE_IMAGE_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const FAKE_IMAGE_MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

/** A deterministic vector for `text` — equal texts embed equally. */
export function fakeEmbeddingVector(text: string, dimensions: number): number[] {
  let seed = 7;

  for (const char of text) seed = (seed * 31 + char.charCodeAt(0)) % 10_007;

  return Array.from({ length: dimensions }, (_, i) => ((seed * (i + 1)) % 1000) / 1000);
}

export class FakeAiProvider implements AiProviderAdapter {
  readonly id: string;
  readonly displayName: string;

  readonly responses?: AiResponsesPort;
  readonly images?: AiImagesPort;
  readonly audio?: AiAudioPort;
  readonly embeddings?: AiEmbeddingsPort;
  readonly realtime?: AiRealtimePort;
  readonly fileInputStrategy?: AiFileInputStrategies;
  readonly supportsPreviousResponseId?: boolean;
  readonly supportsHostedTools?: boolean;

  /** Every call, in order. */
  readonly calls: FakeAiCall[] = [];

  /** Fake provider-side files uploaded for an input and deleted after the response (#441). */
  readonly deletedFileIds: string[] = [];

  private fileCounter = 0;

  private readonly models: string[];
  private readonly validKeys?: Set<string>;
  private readonly script?: FakeAiScript;
  private scriptCursor = 0;
  private responseCounter = 0;
  private readonly options: FakeAiProviderOptions;

  constructor(options: FakeAiProviderOptions = {}) {
    this.options = options;
    this.id = options.id ?? 'fake';
    this.displayName = options.displayName ?? 'Fake AI';
    this.models = options.models ?? ['fake-model'];
    this.validKeys = options.validKeys ? new Set(options.validKeys) : undefined;
    this.script = options.responses;

    if (options.responsesPort !== false) {
      this.responses = {
        create: (req, ctx) => this.create(req, ctx),
        stream: (req, ctx) => this.stream(req, ctx),
      };
    }

    this.images =
      options.ports?.images ??
      (options.imagesPort
        ? {
            generate: (req, ctx) => this.generateImages('images.generate', req, ctx),
            edit: (req, ctx) => this.generateImages('images.edit', req, ctx),
          }
        : undefined);
    this.audio =
      options.ports?.audio ??
      (options.audioPort
        ? {
            transcribe: (req, ctx) => this.transcribe(req, ctx),
            transcriptionMaxBytes: options.transcriptionMaxBytes ?? AI_TRANSCRIPTION_DEFAULT_MAX_BYTES,
            speech: (req, ctx) => this.speak(req, ctx),
            voices: FAKE_SPEECH_VOICES,
          }
        : undefined);
    this.embeddings =
      options.ports?.embeddings ??
      (options.embeddingsPort ? { embed: (req, ctx) => this.embed(req, ctx) } : undefined);
    this.realtime =
      options.ports?.realtime ??
      (options.realtimePort
        ? { createSession: (req, ctx) => this.createRealtimeSession(req, ctx), voices: FAKE_REALTIME_VOICES }
        : undefined);
    this.fileInputStrategy =
      options.fileInputStrategy === false ? undefined : (options.fileInputStrategy ?? FAKE_FILE_INPUT_STRATEGY);

    if (options.supportsPreviousResponseId !== undefined) {
      this.supportsPreviousResponseId = options.supportsPreviousResponseId;
    }

    if (options.supportsHostedTools !== undefined) {
      this.supportsHostedTools = options.supportsHostedTools;
    }
  }

  /** Every distinct key the fake was called with, in first-use order. */
  get apiKeys(): string[] {
    return [...new Set(this.calls.map((call) => call.apiKey))];
  }

  /** Calls for one method. */
  callsTo(method: FakeAiCallMethod): FakeAiCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** Forget recorded calls and fake files, and rewind an array script. */
  reset(): void {
    this.calls.length = 0;
    this.deletedFileIds.length = 0;
    this.fileCounter = 0;
    this.scriptCursor = 0;
  }

  // ---- AiProviderAdapter ----------------------------------------------------

  async listModels(ctx: AiCallContext): Promise<AiDiscoveredModel[]> {
    this.record('listModels', ctx);
    this.assertKey(ctx);

    return this.models.map((id) => ({ id, ownedBy: this.id }));
  }

  async verifyKey(ctx: AiCallContext): Promise<AiKeyVerification> {
    this.record('verifyKey', ctx);

    return this.isValidKey(ctx.apiKey)
      ? { ok: true }
      : { ok: false, code: 'AI_KEY_INVALID', detail: 'The fake provider rejected this key.' };
  }

  classifyModel(modelId: string, metadata?: AiDiscoveredModelMetadata): AiModelCapabilities | null {
    const { classify } = this.options;

    if (typeof classify === 'function') {
      return metadata ? classify(modelId, metadata) : classify(modelId);
    }

    if (classify) {
      return classify[modelId] ?? null;
    }

    return this.models.includes(modelId) ? FAKE_TEXT_MODEL_CAPABILITIES : null;
  }

  // ---- Responses port ---------------------------------------------------------

  private async create(req: AiResponseRequest, ctx: AiCallContext): Promise<AiResponse> {
    const call = this.record('responses.create', ctx, req);
    const uploaded: string[] = [];

    try {
      await this.pause(ctx, call);
      call.storageInputs = await this.receiveStorageInputs(req, ctx, uploaded);

      return await this.produce(req, ctx, false, call.storageInputs);
    } finally {
      this.deleteUploaded(uploaded);
    }
  }

  private async *stream(req: AiResponseRequest, ctx: AiCallContext): AsyncGenerator<AiStreamEvent> {
    const call = this.record('responses.stream', ctx, req);
    const uploaded: string[] = [];

    try {
      yield* this.streamEvents(req, ctx, call, uploaded);
    } finally {
      this.deleteUploaded(uploaded);
    }
  }

  private async *streamEvents(
    req: AiResponseRequest,
    ctx: AiCallContext,
    call: FakeAiCall,
    uploaded: string[],
  ): AsyncGenerator<AiStreamEvent> {
    let response: AiResponse;

    try {
      this.throwIfAborted(ctx, call);
      call.storageInputs = await this.receiveStorageInputs(req, ctx, uploaded);
      response = await this.produce(req, ctx, true, call.storageInputs);
    } catch (err) {
      // A caller's abort is not a provider failure: surface it as-is, the
      // way `fetch` does, rather than as an `error` event.
      if (ctx.signal?.aborted) {
        call.aborted = true;
        throw err;
      }

      const aiError = AiError.wrap(err);
      yield { type: 'error', code: aiError.code, message: aiError.message };
      return;
    }

    const chunkSize = Math.max(1, this.options.chunkSize ?? 4);

    const events: AiStreamEvent[] = [{ type: 'response.created', id: response.id }];

    for (const item of response.output) {
      if (item.type === 'message') {
        for (const delta of chunk(item.text, chunkSize)) {
          events.push({ type: 'output_text.delta', delta });
        }
      } else if (item.type === 'reasoning') {
        for (const summary of item.summary) {
          events.push({ type: 'reasoning_summary.delta', delta: summary });
        }
      } else if (item.type === 'function_call') {
        for (const delta of chunk(item.arguments, chunkSize)) {
          events.push({ type: 'function_call.arguments.delta', callId: item.callId, delta });
        }
      }

      events.push({ type: 'output_item.done', item });
    }

    events.push({ type: 'response.completed', response });

    for (const event of events) {
      await this.pause(ctx, call);
      yield event;
    }
  }

  // ---- Embeddings port ------------------------------------------------------------

  private async embed(req: AiEmbeddingRequest, ctx: AiCallContext): Promise<AiEmbeddingResult> {
    const call = this.record('embeddings.embed', ctx);

    call.embeddingRequest = req;

    await this.pause(ctx, call);
    this.assertKey(ctx);

    const classification = this.classifyModel(req.model);

    if (classification && !classification.capabilities.includes('embeddings')) {
      throw new AiError('AI_CAPABILITY_UNSUPPORTED', `Model "${req.model}" does not support embeddings.`, {
        details: { capability: 'embeddings', model: req.model },
      });
    }

    const inputs = typeof req.input === 'string' ? [req.input] : req.input;
    const dimensions = req.dimensions ?? this.options.embeddingDimensions ?? 8;

    this.responseCounter += 1;

    return {
      provider: this.id,
      model: req.model,
      vectors: inputs.map((text) => fakeEmbeddingVector(text, dimensions)),
      dimensions,
      usage: { inputTokens: inputs.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0) },
      providerRequestId: `fake_req_${this.responseCounter}`,
    };
  }

  // ---- Images port ----------------------------------------------------------------

  private async generateImages(
    method: 'images.generate' | 'images.edit',
    req: AiImageGenerationRequest | AiImageEditRequest,
    ctx: AiCallContext,
  ): Promise<AiImageResult> {
    const call = this.record(method, ctx);

    call.imageRequest = req;

    await this.pause(ctx, call);
    this.assertKey(ctx);

    const capability: AiCapability = method === 'images.edit' ? 'image_edit' : 'image_generation';
    const classification = this.classifyModel(req.model);

    if (classification && !classification.capabilities.includes(capability)) {
      throw new AiError('AI_CAPABILITY_UNSUPPORTED', `Model "${req.model}" does not support ${capability}.`, {
        details: { capability, model: req.model },
      });
    }

    if (method === 'images.edit' && (req as AiImageEditRequest).images.length === 0) {
      throw new AiError('AI_INVALID_REQUEST', 'An image edit needs at least one source image.');
    }

    const n = req.n ?? 1;
    const mimeType = FAKE_IMAGE_MIME[req.outputFormat ?? 'png'];

    this.responseCounter += 1;

    return {
      provider: this.id,
      model: req.model,
      images: Array.from({ length: n }, () => ({ data: Buffer.from(FAKE_IMAGE_BYTES), mimeType })),
      usage: { inputTokens: Math.ceil(req.prompt.length / 4) },
      providerRequestId: `fake_req_${this.responseCounter}`,
    };
  }

  // ---- Audio port -----------------------------------------------------------------

  private async transcribe(req: AiTranscriptionRequest, ctx: AiCallContext): Promise<AiTranscriptionResult> {
    const call = this.record('audio.transcribe', ctx);
    const { audio, ...rest } = req;

    call.transcriptionRequest = {
      ...rest,
      audio: {
        mimeType: audio.mimeType,
        ...(audio.filename !== undefined ? { filename: audio.filename } : {}),
        ...(isStreamedPayload(audio) && audio.size !== undefined ? { size: audio.size } : {}),
        streamed: isStreamedPayload(audio),
      },
    };

    await this.pause(ctx, call);
    this.assertKey(ctx);

    const classification = this.classifyModel(req.model);

    if (classification && !classification.capabilities.includes('audio_transcription')) {
      throw new AiError('AI_CAPABILITY_UNSUPPORTED', `Model "${req.model}" does not support audio_transcription.`, {
        details: { capability: 'audio_transcription', model: req.model },
      });
    }

    const maxBytes = this.options.transcriptionMaxBytes ?? AI_TRANSCRIPTION_DEFAULT_MAX_BYTES;

    // A declared size is refused BEFORE a byte is read, as a real adapter does.
    if (isStreamedPayload(audio) && audio.size !== undefined && audio.size > maxBytes) {
      throw new AiError('AI_INVALID_REQUEST', `The audio is larger than ${maxBytes} bytes.`, {
        details: { size: audio.size, maxBytes },
      });
    }

    let bytes: Buffer;

    try {
      if (isStreamedPayload(audio)) {
        const chunks: Buffer[] = [];

        for await (const chunk of audio.stream) chunks.push(Buffer.from(chunk));

        bytes = Buffer.concat(chunks);
      } else {
        bytes = Buffer.from(audio.data);
      }
    } catch (err) {
      throw AiError.wrap(err);
    }

    call.audioBytes = bytes;

    if (bytes.length === 0 || bytes.length > maxBytes) {
      throw new AiError('AI_INVALID_REQUEST', `The audio must be 1 to ${maxBytes} bytes.`, {
        details: { size: bytes.length, maxBytes },
      });
    }

    const durationSeconds = bytes.length / 1000;
    const text = `fake transcript of ${bytes.length} bytes`;
    const granularities = req.timestampGranularities ?? [];

    this.responseCounter += 1;

    return {
      provider: this.id,
      model: req.model,
      text,
      language: req.language ?? 'en',
      durationSeconds,
      ...(granularities.includes('segment') ? { segments: [{ startSeconds: 0, endSeconds: durationSeconds, text }] } : {}),
      ...(granularities.includes('word')
        ? { words: text.split(' ').map((word, i) => ({ startSeconds: i, endSeconds: i + 1, word })) }
        : {}),
      usage: { outputTokens: Math.ceil(text.length / 4) },
      providerRequestId: `fake_req_${this.responseCounter}`,
    };
  }

  private async speak(req: AiSpeechRequest, ctx: AiCallContext): Promise<AiSpeechResult> {
    const call = this.record('audio.speech', ctx);

    call.speechRequest = req;

    await this.pause(ctx, call);
    this.assertKey(ctx);

    const classification = this.classifyModel(req.model);

    if (classification && !classification.capabilities.includes('audio_speech')) {
      throw new AiError('AI_CAPABILITY_UNSUPPORTED', `Model "${req.model}" does not support audio_speech.`, {
        details: { capability: 'audio_speech', model: req.model },
      });
    }

    if (req.input.length === 0 || req.input.length > AI_SPEECH_INPUT_MAX_CHARS) {
      throw new AiError('AI_INVALID_REQUEST', `Speech input must be 1 to ${AI_SPEECH_INPUT_MAX_CHARS} characters.`);
    }

    const voices: readonly string[] = classification?.voices ?? FAKE_SPEECH_VOICES;

    if (!voices.includes(req.voice)) {
      throw new AiError('AI_INVALID_REQUEST', `Unknown voice "${req.voice}".`, { details: { voice: req.voice } });
    }

    const format = req.format ?? 'mp3';

    this.responseCounter += 1;

    return {
      provider: this.id,
      model: req.model,
      audio: { data: Buffer.from(`FAKE-${format}:${req.voice}:${req.input}`), mimeType: AI_SPEECH_FORMAT_MIME[format] },
      usage: {},
      providerRequestId: `fake_req_${this.responseCounter}`,
    };
  }

  private async createRealtimeSession(req: AiRealtimeSessionRequest, ctx: AiCallContext): Promise<AiRealtimeSession> {
    const call = this.record('realtime.createSession', ctx);

    call.realtimeRequest = req;

    await this.pause(ctx, call);
    this.assertKey(ctx);

    const classification = this.classifyModel(req.model);

    if (classification && !classification.capabilities.includes('realtime')) {
      throw new AiError('AI_CAPABILITY_UNSUPPORTED', `Model "${req.model}" does not support realtime.`, {
        details: { capability: 'realtime', model: req.model },
      });
    }

    const voices: readonly string[] = classification?.voices ?? FAKE_REALTIME_VOICES;
    const voice = req.voice ?? voices[0];

    if (!voices.includes(voice)) {
      throw new AiError('AI_INVALID_REQUEST', `Unknown voice "${voice}".`, { details: { voice } });
    }

    this.responseCounter += 1;

    const ttl = req.expiresInSeconds ?? AI_REALTIME_CLIENT_SECRET_TTL_SECONDS;

    return {
      id: `sess_fake_${this.responseCounter}`,
      provider: this.id,
      model: req.model,
      clientSecret: `${FAKE_REALTIME_SECRET_PREFIX}${this.responseCounter}`,
      expiresAt: new Date(Date.now() + ttl * 1000),
      connectUrl: `${(ctx.baseUrl ?? FAKE_REALTIME_BASE_URL).replace(/\/+$/, '')}/realtime/calls`,
      voice,
      sessionConfig: {
        ...(req.instructions !== undefined ? { instructions: req.instructions } : {}),
        ...(req.turnDetection !== undefined ? { turnDetection: req.turnDetection } : {}),
        ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
      },
      providerRequestId: `fake_req_${this.responseCounter}`,
    };
  }

  // ---- internals ----------------------------------------------------------------

  /**
   * Each storage-object part, delivered as its resolved strategy says: a URL
   * is noted, an upload is drained into a fake file (id pushed to
   * `uploaded`), an inline input is read. Never the key in anything recorded
   * beyond `apiKey` itself.
   */
  private async receiveStorageInputs(
    req: AiResponseRequest,
    ctx: AiCallContext,
    uploaded: string[],
  ): Promise<FakeAiDeliveredInput[] | undefined> {
    const parts = storageParts(req);

    if (parts.length === 0) return undefined;

    this.assertKey(ctx);

    const delivered: FakeAiDeliveredInput[] = [];

    for (const part of parts) {
      const input = ctx.storageInputs?.get(part.storageObjectId);

      if (!input) {
        throw new AiError('AI_INVALID_REQUEST', 'A storage-object input was not resolved by the runtime.', {
          details: { storageObjectId: part.storageObjectId },
        });
      }

      const received: FakeAiDeliveredInput = {
        storageObjectId: input.storageObjectId,
        modality: input.modality,
        strategy: input.strategy,
        filename: input.filename,
        mimeType: input.mimeType,
      };

      if (input.strategy === 'presigned_url') {
        if (!input.url) throw new AiError('AI_INVALID_REQUEST', 'A presigned input carries no url.');
        received.url = input.url;
      } else if (input.strategy === 'upload') {
        let bytes = 0;

        for await (const chunk of await input.open!()) bytes += (chunk as Uint8Array).length;

        this.fileCounter += 1;
        received.fileId = `fake_file_${this.fileCounter}`;
        received.bytes = bytes;
        uploaded.push(received.fileId);
      } else {
        received.bytes = (await input.read!()).data.length;
      }

      delivered.push(received);
    }

    return delivered;
  }

  private deleteUploaded(uploaded: string[]): void {
    this.deletedFileIds.push(...uploaded.splice(0));
  }

  private async produce(
    req: AiResponseRequest,
    ctx: AiCallContext,
    streaming: boolean,
    storageInputs?: FakeAiDeliveredInput[],
  ): Promise<AiResponse> {
    this.assertKey(ctx);
    this.assertSupported(req, streaming, storageInputs);

    let scripted: FakeAiScriptedResponse;

    try {
      scripted = await this.next(req, ctx);
    } catch (err) {
      // What a real adapter does with an SDK error: never let it escape raw.
      throw AiError.wrap(err);
    }

    const response = this.complete(req, scripted);

    if (req.structuredOutput && response.parsed === undefined && response.finishReason === 'stop') {
      response.parsed = parseStructured(req.structuredOutput.schema, response.outputText);
    }

    return response;
  }

  private async next(req: AiResponseRequest, ctx: AiCallContext): Promise<FakeAiScriptedResponse> {
    const script = this.script;

    if (typeof script === 'function') {
      return script(req, ctx);
    }

    if (Array.isArray(script)) {
      if (this.scriptCursor >= script.length) {
        throw new AiError(
          'AI_PROVIDER_UNAVAILABLE',
          `FakeAiProvider: the response script is exhausted (${script.length} scripted).`,
        );
      }

      return script[this.scriptCursor++];
    }

    const files = storageParts(req).map((part) => ctx.storageInputs?.get(part.storageObjectId)?.filename);

    return {
      outputText: files.length > 0 ? `fake: ${lastUserText(req)} [${files.join(', ')}]` : `fake: ${lastUserText(req)}`,
    };
  }

  private complete(req: AiResponseRequest, scripted: FakeAiScriptedResponse): AiResponse {
    this.responseCounter += 1;

    const output: AiOutputItem[] =
      scripted.output ??
      (scripted.outputText !== undefined ? [{ type: 'message', text: scripted.outputText }] : []);

    const outputText =
      scripted.outputText ??
      output
        .filter((item): item is Extract<AiOutputItem, { type: 'message' }> => item.type === 'message')
        .map((item) => item.text)
        .join('');

    const hasCall = output.some((item) => item.type === 'function_call');

    return {
      id: scripted.id ?? `fake_resp_${this.responseCounter}`,
      provider: scripted.provider ?? this.id,
      model: scripted.model ?? req.model,
      output,
      outputText,
      parsed: scripted.parsed,
      usage: scripted.usage ?? {
        inputTokens: Math.ceil(lastUserText(req).length / 4),
        outputTokens: Math.ceil(outputText.length / 4),
      },
      finishReason: scripted.finishReason ?? (hasCall ? 'tool_calls' : 'stop'),
      providerRequestId: scripted.providerRequestId ?? `fake_req_${this.responseCounter}`,
    };
  }

  private assertSupported(
    req: AiResponseRequest,
    streaming: boolean,
    storageInputs: FakeAiDeliveredInput[] = [],
  ): void {
    const hostedAllowed = new Set(this.options.hostedTools ?? []);

    for (const tool of req.tools ?? []) {
      if (tool.type !== 'function' && !hostedAllowed.has(tool.type)) {
        throw new AiError(
          'AI_CAPABILITY_UNSUPPORTED',
          `The ${this.displayName} provider does not support the "${tool.type}" hosted tool.`,
          { details: { capability: 'hosted_tools', tool: tool.type } },
        );
      }
    }

    const classification = this.classifyModel(req.model);

    if (!classification) {
      return;
    }

    for (const capability of requiredCapabilities(req, streaming, storageInputs)) {
      if (capability === 'hosted_tools' && hostedAllowed.size > 0) {
        continue;
      }

      if (!classification.capabilities.includes(capability)) {
        throw new AiError(
          'AI_CAPABILITY_UNSUPPORTED',
          `Model "${req.model}" does not support ${capability}.`,
          { details: { capability, model: req.model } },
        );
      }
    }
  }

  private isValidKey(apiKey: string): boolean {
    if (!apiKey) {
      return false;
    }

    return this.validKeys ? this.validKeys.has(apiKey) : true;
  }

  private assertKey(ctx: AiCallContext): void {
    if (!this.isValidKey(ctx.apiKey)) {
      throw new AiError('AI_KEY_INVALID', 'The AI provider rejected the API key.');
    }
  }

  private record(method: FakeAiCallMethod, ctx: AiCallContext, request?: AiResponseRequest): FakeAiCall {
    const call: FakeAiCall = {
      method,
      apiKey: ctx.apiKey,
      requestId: ctx.requestId,
      baseUrl: ctx.baseUrl,
      ...(ctx.providerSettings ? { providerSettings: ctx.providerSettings } : {}),
      request,
    };

    this.calls.push(call);

    return call;
  }

  private throwIfAborted(ctx: AiCallContext, call: FakeAiCall): void {
    if (ctx.signal?.aborted) {
      call.aborted = true;
      throw abortReason(ctx.signal);
    }
  }

  /** Waits `delayMs` (if any), rejecting as soon as the signal aborts. */
  private async pause(ctx: AiCallContext, call: FakeAiCall): Promise<void> {
    this.throwIfAborted(ctx, call);

    const delayMs = this.options.delayMs ?? 0;

    if (delayMs <= 0) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        call.aborted = true;
        reject(abortReason(ctx.signal as AbortSignal));
      };
      const timer = setTimeout(() => {
        ctx.signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);

      ctx.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

// ---- helpers ------------------------------------------------------------------

/** The capabilities a request needs from its model, as the #431 gates derive them. */
function requiredCapabilities(
  req: AiResponseRequest,
  streaming: boolean,
  storageInputs: FakeAiDeliveredInput[],
): AiCapability[] {
  const needed = new Set<AiCapability>(['responses']);

  if (streaming) needed.add('streaming');
  if (req.structuredOutput) needed.add('structured_output');
  if (req.reasoning?.effort) needed.add('reasoning');

  for (const tool of req.tools ?? []) {
    needed.add(tool.type === 'function' ? 'tools' : 'hosted_tools');
  }

  if (Array.isArray(req.input)) {
    for (const item of req.input) {
      if (item.type !== 'message') continue;

      for (const part of item.content) {
        // A stored object's modality is its MIME type's, not the part's.
        if (part.type !== 'text' && part.storageObjectId !== undefined) continue;
        if (part.type === 'image') needed.add('vision_input');
        if (part.type === 'file') needed.add('file_input');
      }
    }
  }

  for (const input of storageInputs) {
    needed.add(input.modality === 'image' ? 'vision_input' : 'file_input');
  }

  return [...needed];
}

type FakeStoragePart = Extract<AiContentPart, { type: 'image' | 'file' }> & { storageObjectId: string };

function storageParts(req: AiResponseRequest): FakeStoragePart[] {
  if (!Array.isArray(req.input)) return [];

  return req.input.flatMap((item) =>
    item.type === 'message'
      ? item.content.filter(
          (part): part is FakeStoragePart => part.type !== 'text' && part.storageObjectId !== undefined,
        )
      : [],
  );
}

function lastUserText(req: AiResponseRequest): string {
  if (typeof req.input === 'string') {
    return req.input;
  }

  for (let i = req.input.length - 1; i >= 0; i -= 1) {
    const item = req.input[i];

    if (item.type === 'message' && item.role === 'user') {
      return item.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join(' ');
    }
  }

  return '';
}

function chunk(text: string, size: number): string[] {
  const parts: string[] = [];

  for (let i = 0; i < text.length; i += size) {
    parts.push(text.slice(i, i + size));
  }

  return parts;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}
