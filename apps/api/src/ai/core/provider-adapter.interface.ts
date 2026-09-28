// =============================================================================
// AI provider adapter contract (issue #424, epic #419)
// =============================================================================
//
// One class per provider implements this and self-registers with
// `AiProviderRegistry` from its own `onModuleInit()` — the same explicit
// registration `JobHandler` uses (see `jobs/job-handler.registry.ts` for why
// explicit registration beats decorator discovery).
//
// CAPABILITY PORTS: PRESENCE IS THE DECLARATION. An adapter that can generate
// images carries an `images` port; one that cannot leaves it `undefined`.
// There is no `supportsImages: boolean` to disagree with the code — the same
// idiom as `JobHandler.nodeResultSchema` + `persistNodeResult`.
// `AiProviderRegistry.supports()` is the derivation.
//
// NO SDK TYPE CROSSES THIS BOUNDARY. Every method takes and returns the
// neutral types in `./types`, and every failure is an `AiError` — an adapter
// that lets a raw SDK error escape fails the conformance kit.
// =============================================================================

import type { AiErrorCode } from './ai-error';
import type { AiModelCapabilities } from './capabilities';
import type { AiFileInputStrategies, AiResolvedStorageInputs } from './types/file-inputs.types';
import type {
  AiAudioPort,
  AiEmbeddingsPort,
  AiImagesPort,
  AiRealtimePort,
} from './types/media.types';
import type { AiResponse, AiResponseRequest, AiStreamEvent } from './types/responses.types';

/**
 * The `apiKey` a call carries when its provider needs none (#448): an
 * OpenAI-compatible server the administrator marked `requiresKey: false`.
 * The key resolver returns it with `keySource: 'none'`, and an adapter that
 * sees it sends NO credential at all — it is a marker, never put on the wire,
 * in a log line or in a row.
 */
export const AI_KEYLESS_API_KEY = 'not-needed';

/**
 * Per-call context. The key is resolved per call by the runtime (org key or
 * the user's own key, per policy) and handed to the adapter — adapters hold
 * no credentials of their own.
 *
 * ⚠ `apiKey` is secret material: it must never appear in a log line, an
 * `AiError`'s details, or a persisted row.
 */
export interface AiCallContext {
  apiKey: string;
  baseUrl?: string;
  /**
   * The provider's other NON-SECRET settings from its `ai.providers.<id>`
   * slot (#448) — Azure's `apiVersion`/`apiStyle`/`deployments`, an
   * OpenAI-compatible server's `apiStyle`/`requiresKey` — absent when the
   * slot carries none. Each adapter reads it with its own schema; the
   * runtime passes it through without interpreting it.
   */
  providerSettings?: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
  requestId: string;
  /**
   * The request's storage-object inputs (#441), resolved and authorised by the
   * runtime, keyed by `storageObjectId` — present only when the request
   * carries any. ⚠ May hold presigned URLs: the same never-log rule as
   * `apiKey` applies (see `types/file-inputs.types.ts`).
   */
  storageInputs?: AiResolvedStorageInputs;
}

/**
 * What a provider's model listing says about one model, beyond its id
 * (#447). Every field is optional and PROVIDER-REPORTED: an adapter fills
 * what its listing carries (Gemini reports token limits, supported methods
 * and a thinking flag; OpenAI and Anthropic list ids only) and its own
 * `classifyModel` is the only reader. It is never stored as-is — the
 * classifier folds it into `AiModelCapabilities`, which is what the catalog
 * keeps.
 */
export interface AiDiscoveredModelMetadata {
  displayName?: string;
  /** The most input tokens the provider says the model accepts. */
  inputTokenLimit?: number;
  /** The most output tokens the provider says the model produces. */
  outputTokenLimit?: number;
  /** Provider-named operations the model supports (Gemini: `generateContent`, `embedContent`, ...). */
  supportedActions?: string[];
  /** Whether the provider says the model thinks (extended reasoning). */
  thinking?: boolean;
}

export interface AiDiscoveredModel {
  id: string;
  ownedBy?: string;
  createdAt?: Date;
  /** Optional listing metadata the adapter's `classifyModel` may use (#447). */
  metadata?: AiDiscoveredModelMetadata;
}

/**
 * The outcome of `verifyKey`. A rejected key is an ordinary answer
 * (`ok: false, code: 'AI_KEY_INVALID'`), not an exception — the admin UI asks
 * this question precisely when it expects "no" to be possible.
 */
export interface AiKeyVerification {
  ok: boolean;
  code?: AiErrorCode;
  detail?: string;
}

export interface AiResponsesPort {
  create(req: AiResponseRequest, ctx: AiCallContext): Promise<AiResponse>;
  stream(req: AiResponseRequest, ctx: AiCallContext): AsyncIterable<AiStreamEvent>;
}

export interface AiProviderAdapter {
  /** Stable identifier (`'openai'`). PERMANENT — stored in settings, catalog rows and usage rows. */
  readonly id: string;
  readonly displayName: string;

  listModels(ctx: AiCallContext): Promise<AiDiscoveredModel[]>;
  verifyKey(ctx: AiCallContext): Promise<AiKeyVerification>;
  /**
   * `null` means "unclassified": the catalog stores it and an admin decides.
   *
   * `metadata` (#447) is what this adapter's own `listModels` reported for
   * the id, passed back by the catalog sync so a classifier can ENRICH its
   * rule table from provider facts (token limits, supported methods). It is
   * absent everywhere else — a request-time lookup, a test, an adapter whose
   * listing carries ids only — so a classifier must answer from the id alone
   * when it is missing, and an adapter that ignores it stays correct.
   */
  classifyModel(modelId: string, metadata?: AiDiscoveredModelMetadata): AiModelCapabilities | null;

  /**
   * How this adapter wants storage-object image/file inputs delivered (#441).
   * Presence is the declaration that it accepts them at all; absent, a
   * request carrying one is refused with `AI_CAPABILITY_UNSUPPORTED`.
   */
  readonly fileInputStrategy?: AiFileInputStrategies;

  /**
   * Whether this provider stores responses, so a request may chain onto one
   * with `AiResponseRequest.previousResponseId` (#446). ABSENT MEANS `true` —
   * the Responses-shaped default, and what every adapter written before this
   * flag (OpenAI, the fake provider) already does.
   *
   * A stateless provider (Anthropic's Messages API) declares `false`, and the
   * runtime then:
   *   - refuses a caller-supplied `previousResponseId` with
   *     `AI_CAPABILITY_UNSUPPORTED` before any key is resolved (the caller
   *     must send the conversation as `input` instead);
   *   - runs the tool loop by RESENDING THE FULL HISTORY each round — the
   *     original input, the model's own `message`/`reasoning`/`function_call`
   *     items, and the tool outputs — instead of chaining.
   *
   * Unlike a capability port this is a behaviour flag, not a capability: the
   * conversation still works, it just travels differently.
   */
  readonly supportsPreviousResponseId?: boolean;

  /**
   * Whether this provider executes the neutral hosted tools (#442: web
   * search, file search, code interpreter, image generation, MCP) inside a
   * response. ABSENT MEANS `true` — the pre-flag derivation, and what OpenAI
   * and the fake provider rely on.
   *
   * Why a flag and not a port: hosted tools run INSIDE the `responses` port,
   * so there is no separate port whose presence could declare them, and
   * `hosted_tools` used to be derived from the `responses` port alone. A
   * provider with a responses port but none of these tools (Anthropic, whose
   * server tools are a different, unmapped set) declares `false`, so
   * `AiProviderRegistry.supports(id, 'hosted_tools')` — and the admin view's
   * `supportedCapabilities`, and the usable-models gate — stop claiming a
   * capability the adapter's mapper would refuse.
   */
  readonly supportsHostedTools?: boolean;

  // Capability ports — presence IS the declaration.
  readonly responses?: AiResponsesPort;
  readonly images?: AiImagesPort;
  readonly audio?: AiAudioPort;
  readonly embeddings?: AiEmbeddingsPort;
  readonly realtime?: AiRealtimePort;
}
