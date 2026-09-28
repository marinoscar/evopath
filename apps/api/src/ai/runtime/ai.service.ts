// =============================================================================
// AiService — THE runtime facade (issue #432, epic #419)
// =============================================================================
//
// The one injectable a fork uses to add AI to a feature:
//
//   constructor(private readonly ai: AiService) {}
//   ...
//   const res = await this.ai.forUser(userId).respond({ input: 'Summarise …' });
//
// No SDK, no key, no policy check of the caller's own. Every call runs the same
// gate pipeline, in this order (docs/specs/ai-platform.md §2.18, §2.19, §2.23):
//
//   1. kill switch                     AI_DISABLED
//   2. provider enabled + registered   AI_PROVIDER_DISABLED
//      previousResponseId on a provider AI_CAPABILITY_UNSUPPORTED
//      that cannot chain (#446)
//   3. model enabled / capabilities /  AI_MODEL_NOT_ENABLED,
//      key exists / key reaches model  AI_CAPABILITY_UNSUPPORTED,
//                                      AI_KEY_REQUIRED, AI_MODEL_NOT_REACHABLE
//      (UsableModelsService.assertUsable, with the capabilities the request's
//      SHAPE needs — structured output, tools, reasoning, images, streaming)
//   4. reasoning effort offered by the model
//   5. clamp maxOutputTokens to the deployment cap, the model's
//      `ai.limits.perModel` cap and the model's own limit (smallest wins)
//   6. resolve the key (AiKeyResolver — the byok invariant lives there)
//   6b. rate limits (#450, AiLimitsService) — now that whose key pays is
//      known; AI_RATE_LIMITED (429) with `retryAfterMs` and `details.limit`
//   7. call the adapter with { apiKey, baseUrl, signal, requestId }
//   8. record ONE `ai_usage_events` row per round-trip (success, failure or
//      cancellation) with whose key paid (AiUsageRecorder)
//   9. trace it as an `ai.request` span (provider, model, operation, key
//      source, status, token counts — never prompt text, never the key)
//
// NON-RESPONSES OPERATIONS (Phase 2, epic #420) run the SAME pipeline with
// the steps that apply to them: `embed` (#440) is kill switch -> provider ->
// model/capability/key/reach (with `embeddings` as the one capability
// needed) -> key -> adapter -> usage row (`operation: 'embeddings'`) ->
// span. Each operation has a `prepare…` of its own and shares `context()`
// and `track()`; a later port (images, audio) is one more `prepare…`, one
// more `TRACKED_OPERATIONS` entry and one more client method — never a
// second pipeline.
//
// IMAGES (#437) are that shape plus a queue hop: `generateImage`/`editImage`
// run `prepareImage` (kill switch -> shape -> provider -> model with
// `image_generation`/`image_edit` -> an edit's input storage objects,
// ownership included) and queue an `ai.image.generate` run; the job calls
// `executeImageRun`, which runs `prepareImage` AGAIN, reads the inputs'
// bytes, resolves the key, calls the port and records one usage row
// (`operation: 'images'`, `units: { images: n }`).
//
// STORAGE-OBJECT INPUTS (#441). An `image`/`file` part naming a
// `storageObjectId` is resolved INSIDE `prepare`, after step 4: the object
// must be the caller's own (ownership only, like `ObjectsService`) and `ready`;
// its MIME type decides its modality (an image type needs `vision_input`,
// anything else `file_input`, both in the model's capabilities AND
// `inputModalities`) and its size cap (`AI_STORAGE_INPUT_*_MAX_BYTES`); and
// the provider must declare a `fileInputStrategy`. Only then — after the
// gates, before the key — does `materializeStorageInputs` prepare what that
// strategy needs (a 10-minute presigned GET URL, or a capped byte stream),
// handed to the adapter in `ctx.storageInputs`. The REQUEST is never
// rewritten: it keeps the id, so the prompt log, `ai_runs.request` and every
// error carry no URL. `startRun` runs the checks now and the job resolves
// again when it executes, with a fresh URL.
//
// HOSTED TOOLS (#442) add one gate between steps 2 and 3: every hosted
// tool's shape is validated, its type must be switched on by an
// administrator (`ai.hostedTools.<type>`) and an MCP server's host must pass
// `mcpAllowedHosts` — else AI_TOOL_DISABLED (403); the model's
// `hosted_tools` capability is then step 3's (AI_CAPABILITY_UNSUPPORTED).
// Every result leaves through an `AiHostedOutputSettler`
// (`ai-hosted-outputs.ts`): generated image bytes are stored by
// `persistHostedImage` as the user's own storage objects (`AiOutputWriter`)
// and never passed onward, and MCP header values are scrubbed from
// everything returned. A hosted image counts as `units: { images: n }`.
//
// ⚠ MCP HEADERS are secret like the key: never logged (the prompt preview
// shows instructions and input only), never on a span (`ai.hosted_tools`
// names tool TYPES), never in a usage row, never stored with a background
// run (`toStoredRunRequest` refuses them).
//
// TRANSCRIPTION (#438) is the same shape: `transcribe` runs
// `prepareTranscription` (kill switch -> shape -> target, defaulting to the
// first usable `audio_transcription` model -> provider -> model -> the
// recording's storage object: ownership, readiness, `audio/*`/`video/mp4|webm`
// and the port's `transcriptionMaxBytes`, all from the row) and queues an
// `ai.audio.transcribe` run; `executeTranscriptionRun` gates again, STREAMS
// the recording to the adapter through a size-capped reader (or, when the
// row does not know the size yet, reads it with the cap enforced before the
// call) and records one usage row (`operation: 'audio.transcribe'`,
// `units: { audioSeconds }` when the provider reports a duration).
//
// SPEECH (#439): `speak` runs `prepareSpeech` (kill switch -> shape, input
// at most 4096 characters -> target, defaulting to the first usable
// `audio_speech` model -> provider -> model -> the voice, checked against
// the model's catalog `voices` or the port's own list) and queues an
// `ai.audio.speech` run; `executeSpeechRun` gates again, calls the port and
// records one usage row (`operation: 'audio.speech'`, `units: { characters }`).
// The handler stores the audio as the user's storage object.
//
// REALTIME (#449, docs/specs/ai-platform.md §2.15): `createRealtimeSession`
// runs `prepareRealtime` (kill switch -> `ai.defaults.allowRealtime`
// (AI_REALTIME_DISABLED) -> shape -> target, defaulting to the first usable
// `realtime` model -> provider -> model with `realtime` -> the voice) and
// then, synchronously, the shared key + rate-limit step and ONE adapter
// call that mints an ephemeral client secret; one usage row
// (`operation: 'realtime'`, `units: { sessions: 1 }`, no tokens — the media
// never passes through here). No job: the long-running part is the call
// between the browser and the provider.
//
// ⚠ THE EPHEMERAL SECRET is the one credential this facade returns. It
// leaves through the result and nowhere else — no log line, no span, no
// usage row — exactly like the key it was minted with, which never leaves
// at all.
//
// ⚠ THE KEY. `apiKey` exists in this file only between step 6 and the
// adapter call. It is never logged, never put on a span, never persisted and
// never part of an error. A presigned input URL gets the same treatment.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';
import { type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import { resolveServiceName } from '../../common/otel/service-name';
import { userAiSettingsSchema } from '../../common/schemas/settings.schema';
import { PrismaService } from '../../prisma/prisma.service';
import { AiConfigService, providerCallSettings } from '../config/ai-config.service';
import { AiError } from '../core/ai-error';
import type { AiCapability } from '../core/capabilities';
import type { AiCallContext, AiResponsesPort } from '../core/provider-adapter.interface';
import {
  AI_STORAGE_INPUT_URL_TTL_SECONDS,
  AI_STORAGE_INPUTS_MAX,
  type AiFileInputStrategy,
  type AiResolvedStorageInput,
  type AiResolvedStorageInputs,
  type AiStorageInputModality,
  storageInputMaxBytes,
  storageInputModality,
} from '../core/types/file-inputs.types';
import {
  assertHostedToolShapes,
  assertHostedToolsAllowed,
  hostedToolsOf,
  mcpHeaderValues,
} from '../core/hosted-tools';
import { AiProviderRegistry } from '../core/provider-registry';
import { parseStructured } from '../core/structured-output';
import {
  AI_SPEECH_FORMATS,
  AI_SPEECH_INPUT_MAX_CHARS,
  AI_SPEECH_INSTRUCTIONS_MAX_CHARS,
  AI_SPEECH_SPEED_MAX,
  AI_SPEECH_SPEED_MIN,
  AI_TRANSCRIPTION_DEFAULT_MAX_BYTES,
  AI_TRANSCRIPTION_INPUT_MIME_TYPES,
  AI_TRANSCRIPTION_PROMPT_MAX_CHARS,
  AI_TRANSCRIPTION_TIMESTAMP_GRANULARITIES,
  AI_EMBEDDINGS_MAX_INPUTS,
  AI_IMAGE_EDIT_MAX_INPUTS,
  AI_IMAGE_INPUT_MAX_BYTES,
  AI_IMAGE_INPUT_MIME_TYPES,
  AI_IMAGE_MASK_MIME_TYPES,
  AI_IMAGE_PROMPT_MAX_CHARS,
  AI_IMAGES_MAX_N,
  AI_REALTIME_INSTRUCTIONS_MAX_CHARS,
  type AiBinaryPayload,
  type AiEmbeddingRequest,
  type AiEmbeddingResult,
  type AiAudioPort,
  type AiEmbeddingsPort,
  type AiImageResult,
  type AiImagesPort,
  type AiMediaInput,
  type AiRealtimePort,
  type AiRealtimeSessionRequest,
  type AiSpeechRequest,
  type AiSpeechResult,
  type AiTranscriptionRequest,
  type AiTranscriptionResult,
} from '../core/types/media.types';
import type {
  AiContentPart,
  AiHostedToolCallItem,
  AiImageGenerationCallResult,
  AiResponse,
  AiResponseRequest,
  AiStreamEvent,
  AiUsage,
} from '../core/types/responses.types';
import { AiKeyResolver, type AiKeySource } from '../keys/ai-key-resolver.service';
import type { UsableAiModel } from '../keys/dto/usable-ai-model.dto';
import { UsableModelsService } from '../keys/usable-models.service';
import { AiOutputWriter } from '../storage/ai-output-writer';
import { aiErrorFromStorage } from '../storage/ai-storage-errors';
import { AiStorageInputResolver, type AiStorageInput } from '../storage/ai-storage-input.resolver';
import {
  AI_LANGUAGE_CODE,
  AI_SPEECH_OPERATION,
  AI_TRANSCRIBE_OPERATION,
  storedAiSpeechRunRequestSchema,
  storedAiTranscriptionRunRequestSchema,
  type StoredAiSpeechRunRequest,
  type StoredAiTranscriptionRunRequest,
} from './ai-audio-run-request';
import {
  type AiImageOperation,
  storedAiImageRunRequestSchema,
  type StoredAiImageRunRequest,
  toImageGenerationRequest,
} from './ai-image-run-request';
import { toStoredRunRequest } from './ai-run-request';
import { type AiHostedOutputOwner, AiHostedOutputSettler, discardHostedImage } from './ai-hosted-outputs';
import {
  AI_AUDIO_SPEECH_TYPE,
  AI_AUDIO_TRANSCRIBE_TYPE,
  AI_IMAGE_GENERATE_TYPE,
  AiRunsService,
} from './ai-runs.service';
import type {
  AiCallOptions,
  AiEditImageRequest,
  AiEmbedRequest,
  AiGenerateImageRequest,
  AiRealtimeRequest,
  AiRealtimeSessionResult,
  AiRequest,
  AiRunHandle,
  AiSpeakRequest,
  AiStructuredRequest,
  AiTranscribeRequest,
  AiStructuredResponse,
  AiToolLoopRequest,
  AiToolLoopResult,
} from './ai-runtime.types';
import { AiLimitsService, effectiveOutputTokensCap } from './ai-limits.service';
import { runToolLoop } from './ai-tool-loop';
import {
  AiUsageRecorder,
  type AiUsageOperation,
  type AiUsageStatus,
  type AiUsageUnits,
} from './ai-usage.recorder';

/** The facade's span — one per provider round-trip. The adapter's own `ai.provider.call` nests inside it. */
export const AI_REQUEST_SPAN = 'ai.request';

const tracer = trace.getTracer(resolveServiceName());

/** Prompt text is logged (only when `ai.logPromptContent`) truncated to this many characters. */
export const AI_PROMPT_LOG_MAX_CHARS = 2048;

/**
 * One user's AI client. Obtain it with `AiService.forUser(userId)`; every
 * method runs the full gate pipeline, resolves the right key, records one
 * usage row per provider round-trip, and traces the call.
 */
export interface AiUserClient {
  /** The user this client acts for. */
  readonly userId: string;

  /** One response. */
  respond(req: AiRequest, opts?: AiCallOptions): Promise<AiResponse>;

  /**
   * A streamed response. Lazy: gate and pre-stream provider errors surface on
   * the first iteration. A caller that must answer them BEFORE committing to
   * a stream (an SSE route) uses `openStream` instead.
   */
  stream(req: AiRequest, opts?: AiCallOptions): AsyncIterable<AiStreamEvent>;

  /**
   * A streamed response whose gates and provider connection are settled
   * EAGERLY: the promise rejects with an `AiError` for every failure that
   * happens before the first event; after that, a failure is an in-band
   * `error` event and the iterable ends.
   */
  openStream(req: AiRequest, opts?: AiCallOptions): Promise<AsyncIterable<AiStreamEvent>>;

  /**
   * A response validated against `schema` — `parsed` is typed and always
   * present. Output that is not JSON or does not match is
   * `AiError('AI_STRUCTURED_OUTPUT_INVALID')` (502).
   */
  respondStructured<S extends z.ZodTypeAny>(
    req: AiStructuredRequest<S>,
    opts?: AiCallOptions,
  ): Promise<AiStructuredResponse<z.output<S>>>;

  /**
   * The function-calling agent loop (`ai-tool-loop.ts`): up to `maxSteps`
   * (default 8, max 20) gated round-trips, each with its own usage row.
   */
  runTools(req: AiToolLoopRequest, opts?: AiCallOptions): Promise<AiToolLoopResult>;

  /**
   * Queues the request as a background run (an `ai.response.run` job) and
   * returns at once; poll `AiRunsService.get(userId, runId)`. The gates run
   * now — an unusable request fails fast — and again when the job executes.
   *
   * @throws AiError('AI_INVALID_REQUEST') when `ai.defaults.allowBackgroundRuns`
   *   is off, or the request carries a function tool (in-process code cannot
   *   survive the queue hop; use `runTools`).
   */
  startRun(req: AiRequest): Promise<AiRunHandle>;

  /**
   * Embeddings for one text or a batch of up to `AI_EMBEDDINGS_MAX_INPUTS`
   * (256) texts, one vector per input in input order. Synchronous — no job:
   * a large backfill enqueues a job type of its own that calls this per
   * chunk. `model` is REQUIRED (vectors are only comparable within one
   * model, so it is never inferred from `ai.defaultModel`).
   *
   * @throws AiError('AI_INVALID_REQUEST') for an empty or oversized batch,
   *   an empty text, or a non-positive `dimensions`;
   *   AiError('AI_CAPABILITY_UNSUPPORTED') for a model without `embeddings`.
   */
  embed(req: AiEmbedRequest, opts?: AiCallOptions): Promise<AiEmbeddingResult>;

  /**
   * Queues an image generation (an `ai.image.generate` job) and returns at
   * once; poll `AiRunsService.get(userId, runId)` — a succeeded run's
   * `output.storageObjectIds` are storage objects the user owns. Always
   * asynchronous, and not subject to `ai.defaults.allowBackgroundRuns` (there
   * is no synchronous form to fall back to). The gates run now and again
   * when the job executes. `model` is REQUIRED.
   *
   * @throws AiError('AI_CAPABILITY_UNSUPPORTED') for a model without
   *   `image_generation`; AiError('AI_INVALID_REQUEST') for an empty prompt
   *   or `n` outside 1-4.
   */
  generateImage(req: AiGenerateImageRequest): Promise<AiRunHandle>;

  /**
   * As `generateImage`, editing the caller's own images (by storage object
   * id — see `AiEditImageRequest`), with capability `image_edit`.
   *
   * @throws NotFoundException / ForbiddenException for an unknown input or
   *   another user's (the same answers `ObjectsService` gives);
   *   AiError('AI_INVALID_REQUEST') for an input that is not ready, not an
   *   allowed image type, or too large.
   */
  editImage(req: AiEditImageRequest): Promise<AiRunHandle>;

  /**
   * Queues a transcription of one of the caller's recordings (an
   * `ai.audio.transcribe` job) and returns at once; poll
   * `AiRunsService.get(userId, runId)` — a succeeded run's `output.text` is
   * the transcript. Always asynchronous, and not subject to
   * `ai.defaults.allowBackgroundRuns`. The gates run now and again when the
   * job executes. See `AiTranscribeRequest` for the input's rules and how an
   * omitted `model` is chosen.
   *
   * @throws NotFoundException / ForbiddenException for an unknown recording
   *   or another user's; AiError('AI_INVALID_REQUEST') for one that is not
   *   ready, not audio (or MP4/WebM video), or larger than the provider
   *   accepts; AiError('AI_CAPABILITY_UNSUPPORTED') for a model without
   *   `audio_transcription`.
   */
  transcribe(req: AiTranscribeRequest): Promise<AiRunHandle>;

  /**
   * Queues text-to-speech (an `ai.audio.speech` job) and returns at once;
   * poll `AiRunsService.get(userId, runId)` — a succeeded run's
   * `output.storageObjectId` is the audio, a storage object the user owns
   * (`aiGenerated: true`: disclose it). Always asynchronous, and not subject
   * to `ai.defaults.allowBackgroundRuns`. See `AiSpeakRequest` for how an
   * omitted model or voice is chosen.
   *
   * @throws AiError('AI_INVALID_REQUEST') for empty input or more than 4096
   *   characters, a voice the model does not speak, a speed outside 0.25-4;
   *   AiError('AI_CAPABILITY_UNSUPPORTED') for a model without `audio_speech`.
   */
  speak(req: AiSpeakRequest): Promise<AiRunHandle>;

  /**
   * Mints a realtime voice session (#449): an EPHEMERAL provider secret the
   * browser opens one WebRTC session with, directly to the provider. The
   * caller's key is spent server-side on the mint and never returned.
   * Synchronous — no job. Counts as one request against the rate limits and
   * records one usage row (`operation: 'realtime'`, `units: { sessions: 1 }`).
   * See `AiRealtimeRequest` for how an omitted model or voice is chosen.
   *
   * @throws AiError('AI_REALTIME_DISABLED') when `ai.defaults.allowRealtime`
   *   is off; AiError('AI_CAPABILITY_UNSUPPORTED') for a model without
   *   `realtime`; AiError('AI_KEY_REQUIRED') with no key;
   *   AiError('AI_INVALID_REQUEST') for a voice the model does not list or
   *   over-long instructions.
   */
  createRealtimeSession(req: AiRealtimeRequest, opts?: AiCallOptions): Promise<AiRealtimeSessionResult>;
}

/** Internal: who a client acts for, and under which job (for usage rows). */
export interface AiClientScope {
  userId: string;
  jobId?: string;
  /** The background run being executed — names the folder its outputs are stored in. */
  runId?: string;
}

/**
 * Who pays and where a provider round-trip goes, whatever the operation —
 * what the key/context step and the usage/span step need, and nothing more.
 */
export interface AiCallTarget {
  provider: string;
  /** The resolved model id. */
  modelId: string;
  baseUrl?: string;
  /** The provider slot's other non-secret settings (#448), passed to the adapter as-is. */
  providerSettings?: Readonly<Record<string, unknown>>;
  logPromptContent: boolean;
  /** Hosted tool TYPES the request carries (for the span) — never their options. */
  hostedTools?: string[];
}

/** The facade operations that are traced and recorded, and the usage `operation` each is billed as. */
const TRACKED_OPERATIONS = {
  'responses.create': 'responses',
  'responses.stream': 'responses',
  'embeddings.create': 'embeddings',
  'images.generate': 'images',
  'images.edit': 'images',
  'audio.transcribe': 'audio.transcribe',
  'audio.speech': 'audio.speech',
  'realtime.session': 'realtime',
} as const satisfies Record<string, AiUsageOperation>;

type AiTrackedOperation = keyof typeof TRACKED_OPERATIONS;

/** Everything the gate pipeline settled for one `responses` call. */
export interface PreparedAiCall extends AiCallTarget {
  port: AiResponsesPort;
  /** The request the adapter receives — model resolved, tokens clamped. */
  request: AiResponseRequest;
  model: UsableAiModel;
  /**
   * The request's storage-object inputs (#441), authorised and checked from
   * their rows — nothing read, nothing presigned yet. Empty when it has none.
   */
  storageInputs: PlannedStorageInput[];
}

/** One storage-object input `prepare` accepted, and how its provider wants it. */
export interface PlannedStorageInput {
  input: AiStorageInput;
  modality: AiStorageInputModality;
  strategy: AiFileInputStrategy;
}

/** Everything the gate pipeline settled for one `embeddings` call. */
export interface PreparedAiEmbeddingCall extends AiCallTarget {
  port: AiEmbeddingsPort;
  /** The request the adapter receives — model resolved, named fields only. */
  request: AiEmbeddingRequest;
}

/** Everything the gate pipeline settled for one image generation or edit. */
export interface PreparedAiImageCall extends AiCallTarget {
  operation: AiImageOperation;
  port: AiImagesPort;
  /** The request as it is stored in `ai_runs.request` — named fields only, never a key. */
  stored: StoredAiImageRunRequest;
  /** An edit's resolved inputs (metadata only — bytes are read when the job runs). */
  inputs: { images: AiStorageInput[]; mask?: AiStorageInput };
}

/** Everything the gate pipeline settled for one transcription. */
export interface PreparedAiTranscriptionCall extends AiCallTarget {
  transcribe: NonNullable<AiAudioPort['transcribe']>;
  /** The request as it is stored in `ai_runs.request` — named fields only, never a key. */
  stored: StoredAiTranscriptionRunRequest;
  /** The recording (metadata only — bytes are read when the job runs). */
  input: AiStorageInput;
  /** The largest recording the provider accepts. */
  maxBytes: number;
}

/** Everything the gate pipeline settled for one speech synthesis. */
export interface PreparedAiSpeechCall extends AiCallTarget {
  speech: NonNullable<AiAudioPort['speech']>;
  /** The request as it is stored in `ai_runs.request` — voice and format resolved, never a key. */
  stored: StoredAiSpeechRunRequest;
}

/** Everything the gate pipeline settled for one realtime session mint. */
export interface PreparedAiRealtimeCall extends AiCallTarget {
  port: AiRealtimePort;
  /** The request the adapter receives — model and voice resolved, named fields only. */
  request: AiRealtimeSessionRequest & { voice: string };
}

/** `executeImageRun`'s (and the audio runs') options. */
export interface AiImageRunExecutionOptions extends AiCallOptions {
  /** The job the round-trip is incurred under, for its usage row. */
  jobId?: string;
  /**
   * Runs after the gates pass and before the key is resolved or the provider
   * called — the handler checks there is storage to keep the output in, so a
   * call whose images could not be stored is never paid for.
   */
  beforeCall?: () => Promise<void>;
}

interface PrepareOptions {
  streaming: boolean;
}

/** How one round-trip ended, for its usage row and span. */
interface CallOutcome {
  status: AiUsageStatus;
  /** What the provider billed and how it named the request — any operation's result. */
  result?: { usage?: AiUsage; providerRequestId?: string };
  /** Non-token units of the round-trip, e.g. `{ images: 2 }`. */
  units?: AiUsageUnits;
  errorCode?: string;
}

/** Records a round-trip's usage row and ends its span — exactly once. */
interface CallTracker {
  finish(outcome: CallOutcome): Promise<void>;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly registry: AiProviderRegistry,
    private readonly usableModels: UsableModelsService,
    private readonly keyResolver: AiKeyResolver,
    private readonly prisma: PrismaService,
    private readonly usage: AiUsageRecorder,
    private readonly runs: AiRunsService,
    private readonly inputs: AiStorageInputResolver,
    private readonly outputs: AiOutputWriter,
    private readonly limits: AiLimitsService,
  ) {}

  /**
   * The AI client for `userId`. Cheap — create one per request.
   *
   * `jobId` is internal plumbing for the background-run handler, so its
   * usage rows name the job they were incurred under.
   */
  forUser(userId: string, scope: { jobId?: string; runId?: string } = {}): AiUserClient {
    const bound: AiClientScope = { userId, jobId: scope.jobId, runId: scope.runId };

    return {
      userId,
      respond: (req, opts) => this.respond(bound, req, opts),
      stream: (req, opts) => this.lazyStream(bound, req, opts),
      openStream: (req, opts) => this.openStream(bound, req, opts),
      respondStructured: (req, opts) => this.respondStructured(bound, req, opts),
      runTools: (req, opts = {}) =>
        runToolLoop((next, callOpts) => this.respond(bound, next, callOpts), req, {
          userId,
          signal: opts.signal,
          supportsPreviousResponseId: (provider) => this.registry.supportsPreviousResponseId(provider),
        }),
      startRun: (req) => this.startRun(bound, req),
      embed: (req, opts) => this.embed(bound, req, opts),
      generateImage: (req) => this.startImageRun(bound, 'images.generate', req),
      editImage: (req) => this.startImageRun(bound, 'images.edit', req),
      transcribe: (req) => this.startTranscriptionRun(bound, req),
      speak: (req) => this.startSpeechRun(bound, req),
      createRealtimeSession: (req, opts) => this.createRealtimeSession(bound, req, opts),
    };
  }

  // ---- respond ----------------------------------------------------------------

  private async respond(scope: AiClientScope, req: AiRequest, opts: AiCallOptions = {}): Promise<AiResponse> {
    const call = await this.prepare(scope.userId, req, { streaming: false });

    return this.invoke(scope, call, opts);
  }

  private async respondStructured<S extends z.ZodTypeAny>(
    scope: AiClientScope,
    req: AiStructuredRequest<S>,
    opts: AiCallOptions = {},
  ): Promise<AiStructuredResponse<z.output<S>>> {
    const { schema, schemaName, strict, ...rest } = req;
    const response = await this.respond(
      scope,
      { ...rest, structuredOutput: { name: schemaName ?? 'response', schema, strict: strict ?? true } },
      opts,
    );

    return response as AiStructuredResponse<z.output<S>>;
  }

  private async startRun(scope: AiClientScope, req: AiRequest): Promise<AiRunHandle> {
    await this.aiConfig.assertEnabled();

    if (!(await this.aiConfig.resolve()).defaults.allowBackgroundRuns) {
      throw new AiError('AI_INVALID_REQUEST', 'Background AI runs are disabled in this deployment.');
    }

    const call = await this.prepare(scope.userId, req, { streaming: false });

    return this.runs.create({
      userId: scope.userId,
      provider: call.provider,
      modelId: call.request.model,
      // Named fields only, and never a key — see `ai-run-request.ts`.
      request: toStoredRunRequest(call.provider, call.request),
    });
  }

  /** Steps 6-7 for an already-gated call. */
  private async invoke(scope: AiClientScope, call: PreparedAiCall, opts: AiCallOptions): Promise<AiResponse> {
    const storageInputs = await this.materializeStorageInputs(call);
    const { ctx, keySource } = await this.context(scope, call, opts, () => responsePrompt(call.request), storageInputs);
    const tracker = this.track(scope, call, keySource, 'responses.create');

    let response: AiResponse;

    try {
      response = await call.port.create(call.request, ctx);
    } catch (err) {
      const error = toAiError(err, opts.signal);

      await tracker.finish(failure(error, opts.signal));
      throw error;
    }

    // Adapters validate structured output themselves; a response they left
    // unparsed (a truncated answer, say) is validated here, so a caller that
    // asked for a schema never receives an unvalidated result.
    const spec = call.request.structuredOutput;

    if (spec && response.parsed === undefined) {
      try {
        response = { ...response, parsed: parseStructured(spec.schema, response.outputText) };
      } catch (err) {
        const error = toAiError(err, opts.signal);

        // The round-trip happened (and was billed): keep its tokens.
        await tracker.finish({ status: 'failed', result: response, errorCode: error.code });
        throw error;
      }
    }

    await tracker.finish({ status: 'succeeded', result: response, units: hostedImageUnits(response) });

    return this.hostedOutputs(scope, call).response(response);
  }

  // ---- hosted-tool outputs ---------------------------------------------------------

  /** The settler every result of `call` leaves through (see `ai-hosted-outputs.ts`). */
  private hostedOutputs(scope: AiClientScope, call: PreparedAiCall): AiHostedOutputSettler {
    return new AiHostedOutputSettler(
      {
        userId: scope.userId,
        ...(scope.jobId ? { jobId: scope.jobId } : {}),
        ...(scope.runId ? { runId: scope.runId } : {}),
      },
      mcpHeaderValues(call.request.tools),
      (owner, item, responseId) => this.persistHostedImage(owner, item, responseId),
    );
  }

  /**
   * Persists one hosted `image_generation` result (#442) through the AI
   * output writer (#437): the bytes become a `ready` storage object OWNED BY
   * THE USER under `ai-outputs/<userId>/<runId or responseId>/`, and the
   * published result carries its `storageObjectId` — never the bytes. Called
   * once per image, even when a stream shows the item twice.
   *
   * STORAGE UNAVAILABLE IS NOT A FAILED RESPONSE. The provider call already
   * happened (and was billed), and the rest of the answer — text, citations,
   * other tool calls — is intact, so the image is published with
   * `storageObjectId: null` and `storageError: 'AI_STORAGE_UNAVAILABLE'`
   * instead, and a warning is logged (never the bytes). A dedicated image
   * run (`generateImage`) refuses up front instead; a hosted tool cannot,
   * because whether the model draws anything is only known afterwards.
   */
  protected async persistHostedImage(
    owner: AiHostedOutputOwner,
    item: Extract<AiHostedToolCallItem, { tool: 'image_generation' }>,
    responseId: string | undefined,
  ): Promise<AiImageGenerationCallResult> {
    const image = item.result?.image;
    const published = await discardHostedImage(owner, item);

    if (!image) return published;

    const folder = owner.runId ?? outputFolder(responseId);

    try {
      await this.outputs.assertWritable();

      const [stored] = await this.outputs.write({
        userId: owner.userId,
        runId: folder,
        files: [{ data: image.data, mimeType: image.mimeType }],
        namePrefix: 'ai-image',
        metadata: { tool: 'image_generation', ...(responseId ? { responseId } : {}) },
      });

      return { ...published, storageObjectId: stored.storageObjectId, mimeType: stored.mimeType };
    } catch (err) {
      const reason = aiErrorFromStorage(err)?.code ?? 'AI_STORAGE_UNAVAILABLE';

      this.logger.warn(
        `Hosted image ${item.id ?? '(no id)'} for user ${owner.userId} was not stored (${reason}); ` +
          'the response is returned without it',
      );

      return { ...published, storageObjectId: null, storageError: 'AI_STORAGE_UNAVAILABLE' };
    }
  }

  // ---- embed ---------------------------------------------------------------------

  private async embed(
    scope: AiClientScope,
    req: AiEmbedRequest,
    opts: AiCallOptions = {},
  ): Promise<AiEmbeddingResult> {
    const call = await this.prepareEmbedding(scope.userId, req);
    const { ctx, keySource } = await this.context(scope, call, opts, () => call.request.input);
    const tracker = this.track(scope, call, keySource, 'embeddings.create');

    let result: AiEmbeddingResult;

    try {
      result = await call.port.embed(call.request, ctx);
    } catch (err) {
      const error = toAiError(err, opts.signal);

      await tracker.finish(failure(error, opts.signal));
      throw error;
    }

    await tracker.finish({ status: 'succeeded', result });

    return result;
  }

  // ---- realtime ---------------------------------------------------------------------

  private async createRealtimeSession(
    scope: AiClientScope,
    req: AiRealtimeRequest,
    opts: AiCallOptions = {},
  ): Promise<AiRealtimeSessionResult> {
    const call = await this.prepareRealtime(scope.userId, req);
    const { ctx, keySource } = await this.context(scope, call, opts, () => ({
      instructions: call.request.instructions,
    }));
    const tracker = this.track(scope, call, keySource, 'realtime.session');

    let session;

    try {
      session = await call.port.createSession(call.request, ctx);
    } catch (err) {
      const error = toAiError(err, opts.signal);

      await tracker.finish(failure(error, opts.signal));
      throw error;
    }

    // ⚠ Only the request id reaches the tracker — never the secret.
    await tracker.finish({
      status: 'succeeded',
      result: { providerRequestId: session.providerRequestId },
      units: { sessions: 1 },
    });

    return {
      provider: call.provider,
      model: session.model || call.modelId,
      voice: session.voice ?? call.request.voice,
      clientSecret: session.clientSecret,
      expiresAt: session.expiresAt,
      connectUrl: session.connectUrl,
    };
  }

  // ---- images ---------------------------------------------------------------------

  private async startImageRun(
    scope: AiClientScope,
    operation: AiImageOperation,
    req: AiGenerateImageRequest | AiEditImageRequest,
  ): Promise<AiRunHandle> {
    const call = await this.prepareImage(scope.userId, operation, req);

    return this.runs.create({
      userId: scope.userId,
      provider: call.provider,
      modelId: call.modelId,
      request: call.stored,
      jobType: AI_IMAGE_GENERATE_TYPE,
    });
  }

  /**
   * Executes one stored image run for `userId` — the `ai.image.generate`
   * handler's entry point, not a fork's (a fork calls `generateImage`/
   * `editImage`, which queue). Re-runs every gate, reads an edit's input
   * bytes, then makes ONE provider round-trip with one usage row.
   */
  async executeImageRun(
    userId: string,
    stored: StoredAiImageRunRequest,
    opts: AiImageRunExecutionOptions = {},
  ): Promise<AiImageResult> {
    const scope: AiClientScope = { userId, jobId: opts.jobId };
    const edit = stored.operation === 'images.edit';
    const call = await this.prepareImage(userId, stored.operation, {
      ...toImageGenerationRequest(stored),
      provider: stored.provider,
      ...(edit
        ? {
            imageStorageObjectIds: stored.imageStorageObjectIds ?? [],
            ...(stored.maskStorageObjectId ? { maskStorageObjectId: stored.maskStorageObjectId } : {}),
          }
        : {}),
    });

    await opts.beforeCall?.();

    const images: AiBinaryPayload[] = [];

    for (const input of call.inputs.images) {
      images.push(await this.inputs.read(input, { maxBytes: AI_IMAGE_INPUT_MAX_BYTES, label: 'image' }));
    }

    const mask = call.inputs.mask
      ? await this.inputs.read(call.inputs.mask, { maxBytes: AI_IMAGE_INPUT_MAX_BYTES, label: 'mask' })
      : undefined;

    const request = toImageGenerationRequest(call.stored);
    const { ctx, keySource } = await this.context(scope, call, opts, () => ({ prompt: request.prompt }));
    const tracker = this.track(scope, call, keySource, call.operation);

    let result: AiImageResult;

    try {
      if (edit) {
        // `prepareImage` refused a port without `edit`; this narrows the type.
        const editPort = call.port.edit as NonNullable<AiImagesPort['edit']>;

        result = await editPort({ ...request, images, ...(mask ? { mask } : {}) }, ctx);
      } else {
        result = await call.port.generate(request, ctx);
      }
    } catch (err) {
      const error = toAiError(err, opts.signal);

      await tracker.finish(failure(error, opts.signal));
      throw error;
    }

    await tracker.finish({ status: 'succeeded', result, units: { images: result.images.length } });

    return result;
  }

  // ---- transcription ------------------------------------------------------------------

  private async startTranscriptionRun(scope: AiClientScope, req: AiTranscribeRequest): Promise<AiRunHandle> {
    const call = await this.prepareTranscription(scope.userId, req);

    return this.runs.create({
      userId: scope.userId,
      provider: call.provider,
      modelId: call.modelId,
      request: call.stored,
      jobType: AI_AUDIO_TRANSCRIBE_TYPE,
    });
  }

  /**
   * Executes one stored transcription run for `userId` — the
   * `ai.audio.transcribe` handler's entry point, not a fork's (a fork calls
   * `transcribe`, which queues). Re-runs every gate, opens the recording,
   * then makes ONE provider round-trip with one usage row.
   */
  async executeTranscriptionRun(
    userId: string,
    stored: StoredAiTranscriptionRunRequest,
    opts: AiImageRunExecutionOptions = {},
  ): Promise<AiTranscriptionResult> {
    const scope: AiClientScope = { userId, jobId: opts.jobId };
    const call = await this.prepareTranscription(userId, {
      storageObjectId: stored.storageObjectId,
      provider: stored.provider,
      model: stored.model,
      ...transcriptionFields(stored),
    });

    await opts.beforeCall?.();

    const audio = await this.openRecording(call);

    let result: AiTranscriptionResult;

    try {
      const { ctx, keySource } = await this.context(scope, call, opts, () => ({
        language: call.stored.language,
        prompt: call.stored.prompt,
      }));
      const tracker = this.track(scope, call, keySource, 'audio.transcribe');
      const request: AiTranscriptionRequest = { model: call.modelId, audio: audio.payload, ...transcriptionFields(call.stored) };

      try {
        result = await call.transcribe(request, ctx);
      } catch (err) {
        // A recording that turned out larger than its row said: the cap
        // stopped the upload, and THAT is the answer, not the transport
        // failure the SDK saw.
        const error = audio.exceeded() ?? toAiError(err, opts.signal);

        await tracker.finish(failure(error, opts.signal));
        throw error;
      }

      await tracker.finish({
        status: 'succeeded',
        result,
        ...(result.durationSeconds !== undefined ? { units: { audioSeconds: result.durationSeconds } } : {}),
      });
    } finally {
      audio.close();
    }

    return result;
  }

  /**
   * The recording as the adapter receives it. A row that knows its size
   * (already checked against the cap) is STREAMED through a reader that
   * fails past `maxBytes`; a simple upload whose size is not recorded yet
   * (`0`) is read with the cap enforced first, so an oversized file is
   * refused before the provider is called either way.
   */
  private async openRecording(call: PreparedAiTranscriptionCall): Promise<{
    payload: AiMediaInput;
    exceeded(): AiError | undefined;
    close(): void;
  }> {
    const { input, maxBytes } = call;

    if (input.size > 0) {
      const capped = await this.inputs.openCapped(input, { maxBytes, label: 'audio' });

      return {
        payload: { stream: capped.stream, mimeType: input.mimeType, filename: input.name, size: input.size },
        exceeded: capped.exceeded,
        close: capped.close,
      };
    }

    const bytes = await this.inputs.read(input, { maxBytes, label: 'audio' });

    return { payload: bytes, exceeded: () => undefined, close: () => undefined };
  }

  // ---- speech -------------------------------------------------------------------------

  private async startSpeechRun(scope: AiClientScope, req: AiSpeakRequest): Promise<AiRunHandle> {
    const call = await this.prepareSpeech(scope.userId, req);

    return this.runs.create({
      userId: scope.userId,
      provider: call.provider,
      modelId: call.modelId,
      request: call.stored,
      jobType: AI_AUDIO_SPEECH_TYPE,
    });
  }

  /**
   * Executes one stored speech run for `userId` — the `ai.audio.speech`
   * handler's entry point, not a fork's (a fork calls `speak`, which
   * queues). Re-runs every gate, then makes ONE provider round-trip with one
   * usage row (`units: { characters }`).
   */
  async executeSpeechRun(
    userId: string,
    stored: StoredAiSpeechRunRequest,
    opts: AiImageRunExecutionOptions = {},
  ): Promise<AiSpeechResult> {
    const scope: AiClientScope = { userId, jobId: opts.jobId };
    const call = await this.prepareSpeech(userId, {
      input: stored.input,
      voice: stored.voice,
      provider: stored.provider,
      model: stored.model,
      format: stored.format,
      ...speechFields(stored),
    });

    await opts.beforeCall?.();

    const { ctx, keySource } = await this.context(scope, call, opts, () => ({
      input: call.stored.input,
      instructions: call.stored.instructions,
    }));
    const tracker = this.track(scope, call, keySource, 'audio.speech');
    const request: AiSpeechRequest = {
      model: call.modelId,
      input: call.stored.input,
      voice: call.stored.voice,
      format: call.stored.format,
      ...speechFields(call.stored),
    };

    let result: AiSpeechResult;

    try {
      result = await call.speech(request, ctx);
    } catch (err) {
      const error = toAiError(err, opts.signal);

      await tracker.finish(failure(error, opts.signal));
      throw error;
    }

    await tracker.finish({ status: 'succeeded', result, units: { characters: request.input.length } });

    return result;
  }

  // ---- stream -------------------------------------------------------------------

  private async *lazyStream(
    scope: AiClientScope,
    req: AiRequest,
    opts: AiCallOptions = {},
  ): AsyncGenerator<AiStreamEvent> {
    yield* await this.openStream(scope, req, opts);
  }

  private async openStream(
    scope: AiClientScope,
    req: AiRequest,
    opts: AiCallOptions = {},
  ): Promise<AsyncIterable<AiStreamEvent>> {
    const call = await this.prepare(scope.userId, req, { streaming: true });
    const storageInputs = await this.materializeStorageInputs(call);
    const { ctx, keySource } = await this.context(scope, call, opts, () => responsePrompt(call.request), storageInputs);
    const tracker = this.track(scope, call, keySource, 'responses.stream');
    const settler = this.hostedOutputs(scope, call);
    let iterator: AsyncIterator<AiStreamEvent>;

    // Prime the first event so a provider refusal that happens before the
    // stream starts (a rejected key, a throttle) rejects THIS promise — the
    // caller can still answer it as an ordinary error, not an in-band frame.
    let first: IteratorResult<AiStreamEvent>;

    try {
      iterator = call.port.stream(call.request, ctx)[Symbol.asyncIterator]();
      first = await iterator.next();
    } catch (err) {
      const error = toAiError(err, opts.signal);

      await tracker.finish(failure(error, opts.signal));
      throw error;
    }

    // An adapter that reports a failure as its very FIRST event has streamed
    // nothing yet: that is a refusal, not a mid-stream failure, and it is
    // answered the same way as one that threw.
    if (!first.done && first.value.type === 'error') {
      const { code, message } = first.value;

      await iterator.return?.();
      await tracker.finish({ status: 'failed', errorCode: code });
      throw new AiError(code, message);
    }

    return this.relay(first, iterator, tracker, settler, opts);
  }

  private async *relay(
    first: IteratorResult<AiStreamEvent>,
    iterator: AsyncIterator<AiStreamEvent>,
    tracker: CallTracker,
    settler: AiHostedOutputSettler,
    opts: AiCallOptions,
  ): AsyncGenerator<AiStreamEvent> {
    let finished = false;
    // Until a terminal event arrives, the stream ending means the consumer
    // walked away (or the adapter broke the contract — also not a success).
    let outcome: CallOutcome = { status: 'cancelled' };

    try {
      let result = first;

      while (!result.done) {
        const event = result.value;

        if (event.type === 'response.completed') {
          outcome = { status: 'succeeded', result: event.response, units: hostedImageUnits(event.response) };
        } else if (event.type === 'error') {
          outcome = { status: 'failed', errorCode: event.code };
        }

        yield await settler.event(event);
        result = await iterator.next();
      }

      finished = true;

      if (outcome.status === 'cancelled' && !opts.signal?.aborted) {
        outcome = { status: 'failed', errorCode: 'AI_PROVIDER_UNAVAILABLE' };
      }
    } catch (err) {
      finished = true;

      const error = toAiError(err, opts.signal);

      outcome = failure(error, opts.signal);
      throw error;
    } finally {
      // A consumer that stopped early: let the adapter close its connection.
      if (!finished) await iterator.return?.();

      await tracker.finish(outcome);
    }
  }

  // ---- usage + tracing --------------------------------------------------------------

  /** Opens the `ai.request` span and returns the once-only finisher for it. */
  private track(
    scope: AiClientScope,
    call: AiCallTarget,
    keySource: AiKeySource,
    operation: AiTrackedOperation,
  ): CallTracker {
    const started = Date.now();
    const span: Span = tracer.startSpan(AI_REQUEST_SPAN, {
      kind: SpanKind.INTERNAL,
      attributes: {
        'ai.provider': call.provider,
        'ai.model': call.modelId,
        'ai.operation': operation,
        'ai.key_source': keySource,
        ...(call.hostedTools?.length ? { 'ai.hosted_tools': call.hostedTools.join(',') } : {}),
      },
    });
    let done = false;

    return {
      finish: async (outcome) => {
        if (done) return;
        done = true;

        const latencyMs = Date.now() - started;
        const usage = outcome.result?.usage;

        span.setAttribute('ai.status', outcome.status);
        if (outcome.errorCode) span.setAttribute('ai.error_code', outcome.errorCode);
        if (usage?.inputTokens !== undefined) span.setAttribute('ai.usage.input_tokens', usage.inputTokens);
        if (usage?.outputTokens !== undefined) span.setAttribute('ai.usage.output_tokens', usage.outputTokens);
        if (usage?.reasoningTokens !== undefined) {
          span.setAttribute('ai.usage.reasoning_tokens', usage.reasoningTokens);
        }
        span.setStatus(
          outcome.status === 'failed'
            ? { code: SpanStatusCode.ERROR, message: outcome.errorCode ?? 'failed' }
            : { code: SpanStatusCode.OK },
        );
        span.end();

        this.logger.debug(
          `AI ${operation} ${call.provider}/${call.modelId} key=${keySource} ` +
            `${outcome.status}${outcome.errorCode ? ` (${outcome.errorCode})` : ''} in ${latencyMs}ms`,
        );

        await this.usage.record({
          userId: scope.userId,
          provider: call.provider,
          modelId: call.modelId,
          operation: TRACKED_OPERATIONS[operation],
          keySource,
          usage,
          ...(outcome.units ? { units: outcome.units } : {}),
          latencyMs,
          status: outcome.status,
          errorCode: outcome.errorCode ?? null,
          providerRequestId: outcome.result?.providerRequestId ?? null,
          jobId: scope.jobId ?? null,
        });
      },
    };
  }

  // ---- the gate pipeline -----------------------------------------------------------

  /**
   * Steps 1-5 of the pipeline: everything but the key. Throws the exact
   * `AiError` for the first gate that refuses. Decrypts nothing.
   */
  async prepare(userId: string, req: AiRequest, opts: PrepareOptions): Promise<PreparedAiCall> {
    // 1. Kill switch — before anything else is read.
    await this.aiConfig.assertEnabled();

    const { provider, model } = await this.resolveTarget(userId, req);

    // 2. Provider enabled in settings AND registered in this process.
    const slot = await this.aiConfig.assertProviderEnabled(provider);
    const port = this.registry.get(provider)?.responses;
    const policy = await this.aiConfig.resolve();

    // 2a. Response chaining (#446): a stateless provider stores no response
    // to chain onto. Refused, not silently dropped — ignoring it would answer
    // as if the conversation had just begun.
    if (req.previousResponseId !== undefined && !this.registry.supportsPreviousResponseId(provider)) {
      throw new AiError(
        'AI_CAPABILITY_UNSUPPORTED',
        `Provider "${provider}" does not support previousResponseId; send the conversation history as input instead.`,
        { details: { provider, model, capability: 'previous_response_id' } },
      );
    }

    // 2b. Hosted tools (#442): well-formed, switched on by an administrator,
    // and an MCP server on an allowed host.
    assertHostedToolShapes(req.tools);
    assertHostedToolsAllowed(req.tools, policy.hostedTools);

    // 3. Model enabled, capabilities (model AND provider port), key reach.
    const needed = requiredCapabilities(req, opts.streaming);
    const { model: usable } = await this.usableModels.assertUsable(userId, provider, model, needed);

    if (!port) {
      // assertUsable already refused a provider without a responses port
      // (`responses` is always in `needed`); this narrows the type.
      throw capabilityUnsupported(provider, model, 'responses');
    }

    // 4. Reasoning effort must be one the model offers, when it says.
    const effort = req.reasoning?.effort;
    const efforts = usable.capabilities.reasoningEfforts;

    if (effort && efforts && !efforts.includes(effort)) {
      throw new AiError(
        'AI_CAPABILITY_UNSUPPORTED',
        `Model "${model}" does not offer reasoning effort "${effort}".`,
        { details: { provider, model, capability: 'reasoning', effort } },
      );
    }

    // 4b. Storage-object inputs: ownership, readiness, modality, size, strategy.
    const storageInputs = await this.planStorageInputs(userId, provider, model, usable, req.input);

    // 5. Clamp output tokens: the deployment cap and the model's own
    // `ai.limits.perModel` cap (#450) combine — the smaller wins — and bound
    // the call even when the request named no limit of its own.
    const maxOutputTokens = clampOutputTokens(
      req.maxOutputTokens,
      effectiveOutputTokensCap(policy.defaults.maxOutputTokensCap, policy.limits, provider, model),
      usable.capabilities.maxOutputTokens,
    );

    const { provider: _provider, model: _model, ...rest } = req;
    const request: AiResponseRequest = { ...rest, model };

    if (maxOutputTokens !== undefined) {
      request.maxOutputTokens = maxOutputTokens;
    }

    const hostedTools = [...new Set(hostedToolsOf(request.tools).map((tool) => tool.type))];

    return {
      provider,
      modelId: model,
      port,
      request,
      model: usable,
      storageInputs,
      ...(hostedTools.length > 0 ? { hostedTools } : {}),
      ...providerCallSettings(slot),
      logPromptContent: policy.logPromptContent,
    };
  }

  /**
   * The gate pipeline for `embed`: kill switch, request shape, target,
   * provider, then model/capability/key/reach with `embeddings` as the one
   * capability needed. Decrypts nothing.
   */
  async prepareEmbedding(userId: string, req: AiEmbedRequest): Promise<PreparedAiEmbeddingCall> {
    // 1. Kill switch — before anything else is read.
    await this.aiConfig.assertEnabled();

    assertEmbeddingShape(req);

    if (!req.model?.trim()) {
      throw new AiError(
        'AI_INVALID_REQUEST',
        'Name the embedding model explicitly: vectors are only comparable within one model.',
      );
    }

    const { provider, model } = await this.resolveTarget(userId, req);

    // 2. Provider enabled in settings AND registered in this process.
    const slot = await this.aiConfig.assertProviderEnabled(provider);
    const port = this.registry.get(provider)?.embeddings;

    // 3. Model enabled, `embeddings` declared (model AND provider port), key reach.
    await this.usableModels.assertUsable(userId, provider, model, ['embeddings']);

    if (!port) {
      // assertUsable already refused a provider without the port; this narrows the type.
      throw capabilityUnsupported(provider, model, 'embeddings');
    }

    const policy = await this.aiConfig.resolve();
    // Named fields only: whatever else the caller's object carried stays here.
    const request: AiEmbeddingRequest = { model, input: req.input };

    if (req.dimensions !== undefined) request.dimensions = req.dimensions;
    if (req.providerOptions !== undefined) request.providerOptions = req.providerOptions;

    return {
      provider,
      modelId: model,
      port,
      request,
      ...providerCallSettings(slot),
      logPromptContent: policy.logPromptContent,
    };
  }

  /**
   * The gate pipeline for an image generation or edit: kill switch, request
   * shape, target, provider, model with `image_generation`/`image_edit` (model
   * AND provider port), then — for an edit — every input storage object,
   * checked for ownership, readiness, type and size from its row alone.
   * Decrypts nothing and reads no bytes.
   */
  async prepareImage(
    userId: string,
    operation: AiImageOperation,
    req: AiGenerateImageRequest | AiEditImageRequest,
  ): Promise<PreparedAiImageCall> {
    // 1. Kill switch — before anything else is read.
    await this.aiConfig.assertEnabled();

    const edit = operation === 'images.edit';

    assertImageShape(req, edit);

    if (!req.model?.trim()) {
      throw new AiError('AI_INVALID_REQUEST', 'Name the image model explicitly.');
    }

    const { provider, model } = await this.resolveTarget(userId, req);

    // 2. Provider enabled in settings AND registered in this process.
    const slot = await this.aiConfig.assertProviderEnabled(provider);
    const port = this.registry.get(provider)?.images;
    const capability: AiCapability = edit ? 'image_edit' : 'image_generation';

    // 3. Model enabled, the capability declared (model AND provider port), key reach.
    await this.usableModels.assertUsable(userId, provider, model, [capability]);

    if (!port || (edit && !port.edit)) {
      // assertUsable already refused a provider without the port; this narrows the type.
      throw capabilityUnsupported(provider, model, capability);
    }

    // 4. An edit's inputs: the caller's own, ready, and the right kind.
    const inputs: PreparedAiImageCall['inputs'] = { images: [] };

    if (edit) {
      const { imageStorageObjectIds, maskStorageObjectId } = req as AiEditImageRequest;

      for (const id of imageStorageObjectIds) {
        inputs.images.push(
          await this.inputs.resolve(userId, id, {
            mimeTypes: AI_IMAGE_INPUT_MIME_TYPES,
            maxBytes: AI_IMAGE_INPUT_MAX_BYTES,
            label: 'image',
          }),
        );
      }

      if (maskStorageObjectId) {
        inputs.mask = await this.inputs.resolve(userId, maskStorageObjectId, {
          mimeTypes: AI_IMAGE_MASK_MIME_TYPES,
          maxBytes: AI_IMAGE_INPUT_MAX_BYTES,
          label: 'mask',
        });
      }
    }

    const policy = await this.aiConfig.resolve();
    // Named fields only: whatever else the caller's object carried stays here.
    const stored = storedAiImageRunRequestSchema.parse({
      operation,
      provider,
      ...toImageGenerationRequest({ operation, provider, ...req, model }),
      ...(edit
        ? {
            imageStorageObjectIds: inputs.images.map((input) => input.id),
            ...(inputs.mask ? { maskStorageObjectId: inputs.mask.id } : {}),
          }
        : {}),
    });

    return {
      operation,
      provider,
      modelId: model,
      port,
      stored,
      inputs,
      ...providerCallSettings(slot),
      logPromptContent: policy.logPromptContent,
    };
  }

  /**
   * Step 4b: every storage-object part of `input`, authorised and checked
   * from its row alone (see the file header). Reads no bytes and presigns
   * nothing — `startRun` calls this too, and must not.
   *
   * @throws NotFoundException / ForbiddenException for an unknown object or
   *   another user's (the answers `ObjectsService` gives);
   *   AiError('AI_INVALID_REQUEST') for a part with both `url` and
   *   `storageObjectId`, too many parts, an object not ready, an image part
   *   that is not an image, or an object over its modality's cap;
   *   AiError('AI_CAPABILITY_UNSUPPORTED') when the model lacks the
   *   modality or the provider declares no `fileInputStrategy`.
   */
  private async planStorageInputs(
    userId: string,
    provider: string,
    model: string,
    usable: UsableAiModel,
    input: AiResponseRequest['input'],
  ): Promise<PlannedStorageInput[]> {
    const parts = storageParts(input);

    if (parts.length === 0) return [];

    for (const part of parts) {
      if (part.url !== undefined) {
        throw new AiError('AI_INVALID_REQUEST', `An ${part.type} part takes a url OR a storageObjectId, not both.`, {
          details: { part: part.type, storageObjectId: part.storageObjectId },
        });
      }
    }

    const distinct = new Set(parts.map((part) => part.storageObjectId));

    if (distinct.size > AI_STORAGE_INPUTS_MAX) {
      throw new AiError('AI_INVALID_REQUEST', `At most ${AI_STORAGE_INPUTS_MAX} stored files per request.`, {
        details: { storageInputs: distinct.size, max: AI_STORAGE_INPUTS_MAX },
      });
    }

    const strategies = this.registry.get(provider)?.fileInputStrategy;

    if (!strategies) {
      throw new AiError(
        'AI_CAPABILITY_UNSUPPORTED',
        `The "${provider}" provider does not accept stored files as inputs; pass a url.`,
        { details: { provider, model, capability: 'file_input' } },
      );
    }

    const planned = new Map<string, PlannedStorageInput>();

    for (const part of parts) {
      const id = part.storageObjectId;
      let plan = planned.get(id);

      if (!plan) {
        const resolved = await this.inputs.resolve(userId, id, { label: part.type });
        const modality = storageInputModality(resolved.mimeType);
        const maxBytes = storageInputMaxBytes(modality);

        if (resolved.size > maxBytes) {
          throw new AiError(
            'AI_INVALID_REQUEST',
            `The ${modality} storage object is larger than ${maxBytes} bytes (${maxBytes / 1024 / 1024} MiB).`,
            { details: { storageObjectId: id, size: resolved.size, maxBytes } },
          );
        }

        const capability: AiCapability = modality === 'image' ? 'vision_input' : 'file_input';
        const caps = usable.capabilities;

        if (!caps.capabilities.includes(capability) || !caps.inputModalities.includes(modality)) {
          throw new AiError(
            'AI_CAPABILITY_UNSUPPORTED',
            `Model "${model}" does not accept ${modality} inputs (${resolved.mimeType}).`,
            { details: { provider, model, capability, storageObjectId: id, mimeType: resolved.mimeType } },
          );
        }

        plan = { input: resolved, modality, strategy: strategies[modality] };
        planned.set(id, plan);
      }

      if (part.type === 'image' && plan.modality !== 'image') {
        throw new AiError(
          'AI_INVALID_REQUEST',
          `An image part must reference an image (PNG, JPEG, GIF or WebP); this object is ` +
            `${plan.input.mimeType} — send it as a file part.`,
          { details: { storageObjectId: id, mimeType: plan.input.mimeType } },
        );
      }
    }

    return [...planned.values()];
  }

  /**
   * After the gates, before the key: what each planned input's delivery
   * strategy needs, for ONE provider call — a fresh presigned URL, or a
   * capped byte stream. A storage failure here is `AI_STORAGE_UNAVAILABLE`
   * (nothing was sent, so no usage row).
   *
   * ⚠ The URLs exist only in the returned map, which only `ctx` carries.
   */
  private async materializeStorageInputs(call: PreparedAiCall): Promise<AiResolvedStorageInputs | undefined> {
    if (call.storageInputs.length === 0) return undefined;

    const resolved = new Map<string, AiResolvedStorageInput>();

    for (const { input, modality, strategy } of call.storageInputs) {
      const base = {
        storageObjectId: input.id,
        modality,
        mimeType: input.mimeType,
        filename: input.name,
        strategy,
      };

      if (strategy === 'presigned_url') {
        let url: string;

        try {
          url = await this.inputs.presign(input, AI_STORAGE_INPUT_URL_TTL_SECONDS);
        } catch (err) {
          throw storageInputFailure(err);
        }

        resolved.set(input.id, { ...base, url });
      } else {
        const limits = { maxBytes: storageInputMaxBytes(modality), label: modality };

        resolved.set(input.id, {
          ...base,
          open: () => this.inputs.open(input, limits).catch((err: unknown) => Promise.reject(storageInputFailure(err))),
          read: () => this.inputs.read(input, limits).catch((err: unknown) => Promise.reject(storageInputFailure(err))),
        });
      }
    }

    return resolved;
  }

  /**
   * The gate pipeline for a transcription: kill switch, request shape,
   * target (an omitted model is the first usable `audio_transcription`
   * model), provider, model with `audio_transcription` (model AND provider
   * port), then the recording's storage object — ownership, readiness, an
   * audio (or MP4/WebM video) type, and the port's size limit — from its row
   * alone. Decrypts nothing and reads no bytes.
   */
  async prepareTranscription(userId: string, req: AiTranscribeRequest): Promise<PreparedAiTranscriptionCall> {
    // 1. Kill switch — before anything else is read.
    await this.aiConfig.assertEnabled();

    assertTranscriptionShape(req);

    const { provider, model } = req.model?.trim()
      ? await this.resolveTarget(userId, req)
      : await this.firstUsableModel(userId, 'audio_transcription', req.provider);

    // 2. Provider enabled in settings AND registered in this process.
    const slot = await this.aiConfig.assertProviderEnabled(provider);
    const port = this.registry.get(provider)?.audio;

    // 3. Model enabled, `audio_transcription` declared (model AND port), key reach.
    await this.usableModels.assertUsable(userId, provider, model, ['audio_transcription']);

    const transcribe = port?.transcribe?.bind(port);

    if (!port || !transcribe) {
      // assertUsable already refused a provider without the method; this narrows the type.
      throw capabilityUnsupported(provider, model, 'audio_transcription');
    }

    // 4. The recording: the caller's own, ready, audio, within the provider's limit.
    const maxBytes = port.transcriptionMaxBytes ?? AI_TRANSCRIPTION_DEFAULT_MAX_BYTES;
    const input = await this.inputs.resolve(userId, req.storageObjectId, {
      mimeTypes: AI_TRANSCRIPTION_INPUT_MIME_TYPES,
      maxBytes,
      label: 'audio',
    });

    const policy = await this.aiConfig.resolve();
    // Named fields only: whatever else the caller's object carried stays here.
    const stored = storedAiTranscriptionRunRequestSchema.parse({
      operation: AI_TRANSCRIBE_OPERATION,
      provider,
      model,
      storageObjectId: input.id,
      ...transcriptionFields(req),
    });

    return {
      provider,
      modelId: model,
      transcribe,
      stored,
      input,
      maxBytes,
      ...providerCallSettings(slot),
      logPromptContent: policy.logPromptContent,
    };
  }

  /**
   * The gate pipeline for speech: kill switch, request shape (input at most
   * `AI_SPEECH_INPUT_MAX_CHARS`), target (an omitted model is the first
   * usable `audio_speech` model), provider, model with `audio_speech` (model
   * AND provider port), then the voice — the request's, else the model's
   * first — checked against the model's catalog `voices`, else the port's.
   * Decrypts nothing.
   */
  async prepareSpeech(userId: string, req: AiSpeakRequest): Promise<PreparedAiSpeechCall> {
    // 1. Kill switch — before anything else is read.
    await this.aiConfig.assertEnabled();

    assertSpeechShape(req);

    const { provider, model } = req.model?.trim()
      ? await this.resolveTarget(userId, req)
      : await this.firstUsableModel(userId, 'audio_speech', req.provider);

    // 2. Provider enabled in settings AND registered in this process.
    const slot = await this.aiConfig.assertProviderEnabled(provider);
    const port = this.registry.get(provider)?.audio;

    // 3. Model enabled, `audio_speech` declared (model AND port), key reach.
    const { model: usable } = await this.usableModels.assertUsable(userId, provider, model, ['audio_speech']);

    const speech = port?.speech?.bind(port);

    if (!port || !speech) {
      // assertUsable already refused a provider without the method; this narrows the type.
      throw capabilityUnsupported(provider, model, 'audio_speech');
    }

    // 4. The voice: one this model speaks.
    const voices: readonly string[] | undefined = usable.capabilities.voices ?? port.voices;
    const voice = req.voice ?? voices?.[0];

    if (!voice) {
      throw new AiError('AI_INVALID_REQUEST', `Name a voice: model "${model}" lists none.`, {
        details: { provider, model },
      });
    }

    if (voices && !voices.includes(voice)) {
      throw new AiError('AI_INVALID_REQUEST', `Model "${model}" does not speak in voice "${voice}".`, {
        details: { provider, model, voice, voices: [...voices] },
      });
    }

    const policy = await this.aiConfig.resolve();
    // Named fields only: whatever else the caller's object carried stays here.
    const stored = storedAiSpeechRunRequestSchema.parse({
      operation: AI_SPEECH_OPERATION,
      provider,
      model,
      input: req.input,
      voice,
      format: req.format ?? 'mp3',
      ...speechFields(req),
    });

    return {
      provider,
      modelId: model,
      speech,
      stored,
      ...providerCallSettings(slot),
      logPromptContent: policy.logPromptContent,
    };
  }

  /**
   * The gate pipeline for a realtime session (#449): kill switch,
   * `ai.defaults.allowRealtime`, request shape, target (an omitted model is
   * the first usable `realtime` model), provider, model with `realtime`
   * (model AND provider port), then the voice — the request's, else the
   * model's first — checked against the model's catalog `voices`, else the
   * port's. The deployment's output-token cap becomes the session's initial
   * `maxOutputTokens`. Decrypts nothing.
   */
  async prepareRealtime(userId: string, req: AiRealtimeRequest): Promise<PreparedAiRealtimeCall> {
    // 1. Kill switch — before anything else is read.
    await this.aiConfig.assertEnabled();

    // 1b. The realtime switch: minting hands the browser a provider secret
    // and the server stops seeing the call, so it is opt-in (§2.15).
    const policy = await this.aiConfig.resolve();

    if (!policy.defaults.allowRealtime) {
      throw new AiError('AI_REALTIME_DISABLED', 'Realtime voice sessions are disabled in this deployment.');
    }

    assertRealtimeShape(req);

    const { provider, model } = req.model?.trim()
      ? await this.resolveTarget(userId, req)
      : await this.firstUsableModel(userId, 'realtime', req.provider);

    // 2. Provider enabled in settings AND registered in this process.
    const slot = await this.aiConfig.assertProviderEnabled(provider);
    const port = this.registry.get(provider)?.realtime;

    // 3. Model enabled, `realtime` declared (model AND port), key reach.
    const { model: usable } = await this.usableModels.assertUsable(userId, provider, model, ['realtime']);

    if (!port) {
      // assertUsable already refused a provider without the port; this narrows the type.
      throw capabilityUnsupported(provider, model, 'realtime');
    }

    // 4. The voice: one this model speaks.
    const voices: readonly string[] | undefined = usable.capabilities.voices ?? port.voices;
    const voice = req.voice ?? voices?.[0];

    if (!voice) {
      throw new AiError('AI_INVALID_REQUEST', `Name a voice: model "${model}" lists none.`, {
        details: { provider, model },
      });
    }

    if (voices && !voices.includes(voice)) {
      throw new AiError('AI_INVALID_REQUEST', `Model "${model}" does not speak in voice "${voice}".`, {
        details: { provider, model, voice, voices: [...voices] },
      });
    }

    // 5. The deployment's output cap as the session's initial default — the
    // client may change it over its data channel, so it bounds nothing the
    // user cannot lift; it is a sensible starting point, not an enforcement.
    const maxOutputTokens = clampOutputTokens(
      undefined,
      effectiveOutputTokensCap(policy.defaults.maxOutputTokensCap, policy.limits, provider, model),
      usable.capabilities.maxOutputTokens,
    );

    // Named fields only: whatever else the caller's object carried stays here.
    const request: PreparedAiRealtimeCall['request'] = { model, voice };

    if (req.instructions !== undefined) request.instructions = req.instructions;
    if (req.turnDetection !== undefined) request.turnDetection = req.turnDetection;
    if (req.tools !== undefined) request.tools = req.tools;
    if (req.providerOptions !== undefined) request.providerOptions = req.providerOptions;
    if (maxOutputTokens !== undefined) request.maxOutputTokens = maxOutputTokens;

    return {
      provider,
      modelId: model,
      port,
      request,
      ...providerCallSettings(slot),
      logPromptContent: policy.logPromptContent,
    };
  }

  /**
   * The first model `userId` can use right now that declares `capability`
   * (on `provider`, when given) — in `GET /api/ai/models` order. For an
   * operation whose model is never the chat `ai.defaultModel`.
   */
  private async firstUsableModel(
    userId: string,
    capability: AiCapability,
    provider?: string,
  ): Promise<{ provider: string; model: string }> {
    const usable = await this.usableModels.listForUser(userId);
    const match = usable.find(
      (m) =>
        (provider === undefined || m.provider === provider) &&
        m.capabilities.capabilities.includes(capability) &&
        this.registry.supports(m.provider, capability),
    );

    if (!match) {
      throw new AiError(
        'AI_INVALID_REQUEST',
        `No model selected, and no model available to you supports ${capability}.`,
        { details: { capability, ...(provider ? { provider } : {}) } },
      );
    }

    return { provider: match.provider, model: match.modelId };
  }

  /**
   * Step 6: resolve the key, apply the rate limits (6b) and build the
   * adapter context. `prompt` is the
   * request's content, rendered only for the opt-in debug line.
   */
  private async context(
    scope: AiClientScope,
    call: AiCallTarget,
    opts: AiCallOptions,
    prompt: () => unknown,
    storageInputs?: AiResolvedStorageInputs,
  ): Promise<{ ctx: AiCallContext; keySource: AiKeySource }> {
    if (opts.signal?.aborted) {
      throw cancelled(call.provider);
    }

    const { apiKey, keySource } = await this.keyResolver.resolve(scope.userId, call.provider);

    // 6b. Rate limits (#450) — here because the org-key limits need to know
    // whose key pays. A refusal records no usage row: nothing was sent.
    await this.limits.enforce({
      userId: scope.userId,
      provider: call.provider,
      modelId: call.modelId,
      keySource,
    });

    const requestId = randomUUID();

    if (call.logPromptContent) {
      this.logger.debug(
        `AI prompt ${requestId} (${call.provider}/${call.modelId}): ${promptPreview(prompt())}`,
      );
    }

    return {
      ctx: {
        apiKey,
        requestId,
        ...(call.baseUrl ? { baseUrl: call.baseUrl } : {}),
        ...(call.providerSettings ? { providerSettings: call.providerSettings } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(storageInputs ? { storageInputs } : {}),
      },
      keySource,
    };
  }

  /**
   * Which (provider, model) the request targets. See `AiRequest` for the
   * fallback order.
   */
  private async resolveTarget(
    userId: string,
    req: { provider?: string; model?: string },
  ): Promise<{ provider: string; model: string }> {
    const requested = req.model?.trim();

    if (requested) {
      const provider = req.provider ?? (await this.defaultModel(userId))?.provider ?? this.soleProvider();

      if (!provider) {
        throw new AiError('AI_INVALID_REQUEST', 'No provider selected.', { details: { model: requested } });
      }

      return { provider, model: requested };
    }

    const fallback = await this.defaultModel(userId);

    if (!fallback || (req.provider !== undefined && req.provider !== fallback.provider)) {
      throw new AiError('AI_INVALID_REQUEST', 'No model selected.');
    }

    return { provider: fallback.provider, model: fallback.modelId };
  }

  /**
   * The user's `ai.defaultModel`, read RAW from `user_settings.value` — not
   * through `UserSettingsService.getSettings`, which creates a row when none
   * exists (see `NotificationsService.loadRecipient` for the full argument).
   */
  private async defaultModel(userId: string): Promise<{ provider: string; modelId: string } | null> {
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { value: true },
    });
    const value = row?.value as { ai?: unknown } | null | undefined;
    const parsed = userAiSettingsSchema.safeParse(value?.ai);

    return parsed.success ? parsed.data.defaultModel : null;
  }

  private soleProvider(): string | undefined {
    const ids = this.registry.ids();

    return ids.length === 1 ? ids[0] : undefined;
  }
}

// ---- helpers ---------------------------------------------------------------------------

/**
 * The model capabilities a request's SHAPE needs. `responses` always; the
 * rest follow from what the request carries.
 */
export function requiredCapabilities(
  req: Pick<AiResponseRequest, 'structuredOutput' | 'tools' | 'reasoning' | 'input'>,
  streaming: boolean,
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
        // A stored object's modality follows its MIME type, not the part's
        // type; `planStorageInputs` checks it once the row is read.
        if (part.type !== 'text' && part.storageObjectId !== undefined) continue;
        if (part.type === 'image') needed.add('vision_input');
        if (part.type === 'file') needed.add('file_input');
      }
    }
  }

  return [...needed];
}

/**
 * The effective `maxOutputTokens`: the caller's value bounded by the
 * deployment cap and the model's own limit. With no caller value, the
 * deployment cap still bounds the call (it "bounds every call"); the model's
 * limit alone does not invent one.
 */
export function clampOutputTokens(
  requested: number | undefined,
  deploymentCap: number | undefined,
  modelMax: number | undefined,
): number | undefined {
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1)) {
    throw new AiError('AI_INVALID_REQUEST', 'maxOutputTokens must be a positive integer.', {
      details: { maxOutputTokens: requested },
    });
  }

  const bounds = [requested ?? deploymentCap, deploymentCap, modelMax].filter(
    (value): value is number => value !== undefined,
  );

  if (requested === undefined && deploymentCap === undefined) {
    return undefined;
  }

  return Math.min(...bounds);
}

/**
 * An embedding request's shape, checked before any gate reads a table: 1 to
 * `AI_EMBEDDINGS_MAX_INPUTS` non-empty texts, and a positive integer
 * `dimensions` when given. An oversized batch is refused, never split — the
 * caller decides how to chunk (and, for a backfill, queues its own job).
 */
function assertEmbeddingShape(req: Pick<AiEmbedRequest, 'input' | 'dimensions'>): void {
  const inputs = typeof req.input === 'string' ? [req.input] : req.input;

  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new AiError('AI_INVALID_REQUEST', 'Embeddings need at least one input text.');
  }

  if (inputs.length > AI_EMBEDDINGS_MAX_INPUTS) {
    throw new AiError(
      'AI_INVALID_REQUEST',
      `At most ${AI_EMBEDDINGS_MAX_INPUTS} inputs per embeddings call; split the batch into chunks ` +
        '(for a large backfill, enqueue a job that embeds one chunk at a time).',
      { details: { inputs: inputs.length, max: AI_EMBEDDINGS_MAX_INPUTS } },
    );
  }

  const empty = inputs.findIndex((text) => typeof text !== 'string' || text.length === 0);

  if (empty !== -1) {
    throw new AiError('AI_INVALID_REQUEST', 'Embedding inputs must be non-empty strings.', {
      details: { index: empty },
    });
  }

  if (req.dimensions !== undefined && (!Number.isInteger(req.dimensions) || req.dimensions < 1)) {
    throw new AiError('AI_INVALID_REQUEST', 'dimensions must be a positive integer.', {
      details: { dimensions: req.dimensions },
    });
  }
}

/**
 * An image request's shape, checked before any gate reads a table: a
 * non-empty prompt within `AI_IMAGE_PROMPT_MAX_CHARS`, `n` in 1-4, and — for
 * an edit — 1 to `AI_IMAGE_EDIT_MAX_INPUTS` distinct source images.
 */
function assertImageShape(req: AiGenerateImageRequest | AiEditImageRequest, edit: boolean): void {
  if (typeof req.prompt !== 'string' || req.prompt.trim().length === 0) {
    throw new AiError('AI_INVALID_REQUEST', 'An image request needs a non-empty prompt.');
  }

  if (req.prompt.length > AI_IMAGE_PROMPT_MAX_CHARS) {
    throw new AiError('AI_INVALID_REQUEST', `The prompt is longer than ${AI_IMAGE_PROMPT_MAX_CHARS} characters.`, {
      details: { max: AI_IMAGE_PROMPT_MAX_CHARS },
    });
  }

  if (req.n !== undefined && (!Number.isInteger(req.n) || req.n < 1 || req.n > AI_IMAGES_MAX_N)) {
    throw new AiError('AI_INVALID_REQUEST', `n must be an integer from 1 to ${AI_IMAGES_MAX_N}.`, {
      details: { n: req.n, max: AI_IMAGES_MAX_N },
    });
  }

  if (!edit) return;

  const ids = (req as AiEditImageRequest).imageStorageObjectIds;

  if (!Array.isArray(ids) || ids.length === 0 || ids.length > AI_IMAGE_EDIT_MAX_INPUTS) {
    throw new AiError(
      'AI_INVALID_REQUEST',
      `An image edit needs 1 to ${AI_IMAGE_EDIT_MAX_INPUTS} source images (imageStorageObjectIds).`,
      { details: { max: AI_IMAGE_EDIT_MAX_INPUTS } },
    );
  }

  if (new Set(ids).size !== ids.length) {
    throw new AiError('AI_INVALID_REQUEST', 'imageStorageObjectIds must not repeat an id.');
  }
}

type StoragePart = Extract<AiContentPart, { type: 'image' | 'file' }> & { storageObjectId: string };

/** Every image/file part of `input` that names a storage object, in order. */
function storageParts(input: AiResponseRequest['input']): StoragePart[] {
  if (!Array.isArray(input)) return [];

  const parts: StoragePart[] = [];

  for (const item of input) {
    if (item.type !== 'message') continue;

    for (const part of item.content) {
      if (part.type !== 'text' && part.storageObjectId !== undefined) parts.push(part as StoragePart);
    }
  }

  return parts;
}

/**
 * A storage failure while preparing or reading an input, as an `AiError`:
 * the input resolver's own `AiError` (a too-large stream) unchanged,
 * unconfigured storage (and a vanished object) as `aiErrorFromStorage` maps
 * them, anything else `AI_STORAGE_UNAVAILABLE`. Never the URL.
 */
function storageInputFailure(err: unknown): AiError {
  if (err instanceof AiError) return err;

  return (
    aiErrorFromStorage(err) ??
    new AiError('AI_STORAGE_UNAVAILABLE', 'A stored input could not be read from object storage.', { cause: err })
  );
}

/** `{ images: n }` for the hosted images a response generated, or nothing when it drew none. */
function hostedImageUnits(response: AiResponse): AiUsageUnits | undefined {
  const images = response.output.filter(
    (item) => item.type === 'hosted_tool_call' && item.tool === 'image_generation' && !!item.result?.image,
  ).length;

  return images > 0 ? { images } : undefined;
}

/**
 * The storage folder for a response's hosted outputs outside a background
 * run: the provider's response id, reduced to key-safe characters, or a fresh
 * id when there is none.
 */
function outputFolder(responseId: string | undefined): string {
  const safe = (responseId ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);

  return safe || randomUUID();
}

/**
 * A transcription request's shape, checked before any gate reads a table: a
 * storage object id, an ISO-639 language code, a prompt within
 * `AI_TRANSCRIPTION_PROMPT_MAX_CHARS`, and known, distinct timestamp
 * granularities.
 */
function assertTranscriptionShape(req: AiTranscribeRequest): void {
  if (typeof req.storageObjectId !== 'string' || req.storageObjectId.trim().length === 0) {
    throw new AiError('AI_INVALID_REQUEST', 'A transcription needs the recording\'s storageObjectId.');
  }

  if (req.language !== undefined && !AI_LANGUAGE_CODE.test(req.language)) {
    throw new AiError('AI_INVALID_REQUEST', 'language must be an ISO-639-1 code such as "en".', {
      details: { language: req.language },
    });
  }

  if (req.prompt !== undefined && (req.prompt.length === 0 || req.prompt.length > AI_TRANSCRIPTION_PROMPT_MAX_CHARS)) {
    throw new AiError('AI_INVALID_REQUEST', `prompt must be 1 to ${AI_TRANSCRIPTION_PROMPT_MAX_CHARS} characters.`, {
      details: { max: AI_TRANSCRIPTION_PROMPT_MAX_CHARS },
    });
  }

  const granularities = req.timestampGranularities;

  if (
    granularities !== undefined &&
    (!Array.isArray(granularities) ||
      granularities.length === 0 ||
      new Set(granularities).size !== granularities.length ||
      granularities.some((g) => !(AI_TRANSCRIPTION_TIMESTAMP_GRANULARITIES as readonly string[]).includes(g)))
  ) {
    throw new AiError(
      'AI_INVALID_REQUEST',
      `timestampGranularities must be distinct values of ${AI_TRANSCRIPTION_TIMESTAMP_GRANULARITIES.join(', ')}.`,
    );
  }
}

/** The optional, provider-facing fields of a transcription request (named fields only). */
function transcriptionFields(
  req: Pick<AiTranscribeRequest, 'language' | 'prompt' | 'timestampGranularities' | 'providerOptions'>,
): Pick<AiTranscriptionRequest, 'language' | 'prompt' | 'timestampGranularities' | 'providerOptions'> {
  return {
    ...(req.language !== undefined ? { language: req.language } : {}),
    ...(req.prompt !== undefined ? { prompt: req.prompt } : {}),
    ...(req.timestampGranularities !== undefined ? { timestampGranularities: [...req.timestampGranularities] } : {}),
    ...(req.providerOptions !== undefined ? { providerOptions: req.providerOptions } : {}),
  };
}

/**
 * A speech request's shape, checked before any gate reads a table: 1 to
 * `AI_SPEECH_INPUT_MAX_CHARS` characters of input, a non-empty voice when
 * given, a known format, instructions within their limit, and a speed in
 * range.
 */
/**
 * A realtime request's shape, checked before any gate reads a table:
 * instructions within `AI_REALTIME_INSTRUCTIONS_MAX_CHARS`, and only function
 * tools (a hosted tool has no meaning in a browser-held session).
 */
function assertRealtimeShape(req: AiRealtimeRequest): void {
  if (req.instructions !== undefined && req.instructions.length > AI_REALTIME_INSTRUCTIONS_MAX_CHARS) {
    throw new AiError(
      'AI_INVALID_REQUEST',
      `Realtime instructions may be at most ${AI_REALTIME_INSTRUCTIONS_MAX_CHARS} characters.`,
    );
  }

  if (req.tools?.some((tool) => tool.type !== 'function')) {
    throw new AiError('AI_INVALID_REQUEST', 'A realtime session takes function tools only.');
  }
}

function assertSpeechShape(req: AiSpeakRequest): void {
  if (typeof req.input !== 'string' || req.input.trim().length === 0) {
    throw new AiError('AI_INVALID_REQUEST', 'Speech needs non-empty input text.');
  }

  if (req.input.length > AI_SPEECH_INPUT_MAX_CHARS) {
    throw new AiError(
      'AI_INVALID_REQUEST',
      `Speech input is longer than ${AI_SPEECH_INPUT_MAX_CHARS} characters; split the text into several runs.`,
      { details: { length: req.input.length, max: AI_SPEECH_INPUT_MAX_CHARS } },
    );
  }

  if (req.voice !== undefined && (typeof req.voice !== 'string' || req.voice.trim().length === 0 || req.voice.length > 64)) {
    throw new AiError('AI_INVALID_REQUEST', 'voice must be a voice name.');
  }

  if (req.format !== undefined && !(AI_SPEECH_FORMATS as readonly string[]).includes(req.format)) {
    throw new AiError('AI_INVALID_REQUEST', `format must be one of ${AI_SPEECH_FORMATS.join(', ')}.`, {
      details: { format: req.format },
    });
  }

  if (
    req.instructions !== undefined &&
    (req.instructions.length === 0 || req.instructions.length > AI_SPEECH_INSTRUCTIONS_MAX_CHARS)
  ) {
    throw new AiError('AI_INVALID_REQUEST', `instructions must be 1 to ${AI_SPEECH_INSTRUCTIONS_MAX_CHARS} characters.`);
  }

  if (
    req.speed !== undefined &&
    !(typeof req.speed === 'number' && req.speed >= AI_SPEECH_SPEED_MIN && req.speed <= AI_SPEECH_SPEED_MAX)
  ) {
    throw new AiError('AI_INVALID_REQUEST', `speed must be from ${AI_SPEECH_SPEED_MIN} to ${AI_SPEECH_SPEED_MAX}.`, {
      details: { speed: req.speed },
    });
  }
}

/** The optional, provider-facing fields of a speech request (named fields only). */
function speechFields(
  req: Pick<AiSpeakRequest, 'instructions' | 'speed' | 'providerOptions'>,
): Pick<AiSpeechRequest, 'instructions' | 'speed' | 'providerOptions'> {
  return {
    ...(req.instructions !== undefined ? { instructions: req.instructions } : {}),
    ...(req.speed !== undefined ? { speed: req.speed } : {}),
    ...(req.providerOptions !== undefined ? { providerOptions: req.providerOptions } : {}),
  };
}

/** The outcome of a round-trip that threw. An abort is a cancellation, not a failure. */
function failure(error: AiError, signal?: AbortSignal): CallOutcome {
  return signal?.aborted
    ? { status: 'cancelled', errorCode: error.code }
    : { status: 'failed', errorCode: error.code };
}

function capabilityUnsupported(provider: string, model: string, capability: AiCapability): AiError {
  return new AiError('AI_CAPABILITY_UNSUPPORTED', `Model "${model}" does not support ${capability}.`, {
    details: { provider, model, capability },
  });
}

function cancelled(provider: string): AiError {
  return new AiError('AI_PROVIDER_UNAVAILABLE', 'The AI request was cancelled.', {
    details: { provider, aborted: true },
  });
}

/**
 * Normalises anything a provider call threw. An abort is reported as a
 * cancellation (never as the raw `AbortError`), everything else via
 * `AiError.wrap` — so nothing raw escapes the facade.
 */
export function toAiError(err: unknown, signal?: AbortSignal): AiError {
  if (err instanceof AiError) return err;

  if (signal?.aborted) {
    return new AiError('AI_PROVIDER_UNAVAILABLE', 'The AI request was cancelled.', {
      cause: err,
      details: { aborted: true },
    });
  }

  return AiError.wrap(err);
}

/** What of a responses request the opt-in debug line shows. */
function responsePrompt(req: AiResponseRequest): unknown {
  return { instructions: req.instructions, input: req.input };
}

/** Prompt text for the opt-in debug log line, truncated. Never the key. */
function promptPreview(content: unknown): string {
  const text = JSON.stringify(content);

  return text.length > AI_PROMPT_LOG_MAX_CHARS
    ? `${text.slice(0, AI_PROMPT_LOG_MAX_CHARS)}… (truncated)`
    : text;
}
