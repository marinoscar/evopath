// =============================================================================
// OpenAI realtime mapper (issue #449, epic #421)
// =============================================================================
//
// AiRealtimeSessionRequest <-> `POST /v1/realtime/client_secrets` (the GA
// Realtime API; the beta `POST /v1/realtime/sessions` is not used). Pure
// functions; every failure is an `AiError`, never an SDK error.
//
// WHAT GOES OUT. `expires_after` is ALWAYS sent (60 seconds by default,
// `AI_REALTIME_CLIENT_SECRET_TTL_SECONDS`), so the provider's own default,
// which has changed over time, never decides how long a secret lives. The
// `session` object is the session's initial configuration: model, voice,
// instructions, output modalities, turn detection, tools and an output-token
// cap (at most 4096, the realtime ceiling). `providerOptions.openai` is merged into `session` last, the same
// escape hatch every other mapper offers.
//
// WHAT COMES BACK. `{ value: 'ek_…', expires_at, session }`. `value` is the
// ephemeral client secret; it becomes `clientSecret` and is otherwise
// untouched. ⚠ It is a bearer credential: nothing in this file logs it, and
// `sessionConfig` is rebuilt from named, non-secret fields rather than
// passed through, so a provider that one day echoes a secret inside
// `session` cannot leak it through this mapper.
//
// THE CONNECT URL is `<baseUrl>/realtime/calls`: the browser POSTs its SDP
// offer there with `Authorization: Bearer <clientSecret>`. It follows the
// slot's `baseUrl`, so a deployment behind an OpenAI-compatible gateway
// sends its browsers to the same place the secret was minted.
// =============================================================================

import type {
  ClientSecretCreateParams,
  ClientSecretCreateResponse,
} from 'openai/resources/realtime/client-secrets';
import type {
  RealtimeAudioInputTurnDetection,
  RealtimeSessionCreateRequest,
} from 'openai/resources/realtime/realtime';

import { AiError } from '../../core/ai-error';
import { toJsonSchema } from '../../core/structured-output';
import {
  AI_REALTIME_CLIENT_SECRET_TTL_SECONDS,
  type AiRealtimeSession,
  type AiRealtimeSessionRequest,
  type AiRealtimeTurnDetection,
} from '../../core/types/media.types';
import { OPENAI_DEFAULT_BASE_URL } from './openai-client.factory';
import { OPENAI_PROVIDER_ID } from './openai-errors';

/** The provider's accepted range for `expires_after.seconds`. */
export const OPENAI_REALTIME_TTL_MIN_SECONDS = 10;
export const OPENAI_REALTIME_TTL_MAX_SECONDS = 7200;

/** The largest per-response `max_output_tokens` a realtime session accepts (or `inf`). */
export const OPENAI_REALTIME_MAX_OUTPUT_TOKENS = 4096;

/** The WebRTC SDP endpoint under a base URL. */
export function openAiRealtimeConnectUrl(baseUrl: string | undefined): string {
  return `${(baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '')}/realtime/calls`;
}

/** `AiRealtimeSessionRequest` -> the `client_secrets` body. */
export function toOpenAiClientSecretRequest(req: AiRealtimeSessionRequest): ClientSecretCreateParams {
  const seconds = req.expiresInSeconds ?? AI_REALTIME_CLIENT_SECRET_TTL_SECONDS;

  if (!Number.isInteger(seconds) || seconds < OPENAI_REALTIME_TTL_MIN_SECONDS || seconds > OPENAI_REALTIME_TTL_MAX_SECONDS) {
    throw new AiError(
      'AI_INVALID_REQUEST',
      `A realtime client secret lives ${OPENAI_REALTIME_TTL_MIN_SECONDS}-${OPENAI_REALTIME_TTL_MAX_SECONDS} seconds.`,
      { details: { provider: OPENAI_PROVIDER_ID } },
    );
  }

  const session: RealtimeSessionCreateRequest = { type: 'realtime', model: req.model };

  if (req.instructions !== undefined) session.instructions = req.instructions;
  if (req.modalities !== undefined) session.output_modalities = [...req.modalities];
  // A deployment cap above the realtime ceiling is simply the ceiling —
  // sending it as-is would be a 400 for every mint.
  if (req.maxOutputTokens !== undefined) {
    session.max_output_tokens = Math.min(req.maxOutputTokens, OPENAI_REALTIME_MAX_OUTPUT_TOKENS);
  }

  const audio: NonNullable<RealtimeSessionCreateRequest['audio']> = {};

  if (req.voice !== undefined) audio.output = { voice: req.voice };
  if (req.turnDetection !== undefined) audio.input = { turn_detection: toTurnDetection(req.turnDetection) };
  if (Object.keys(audio).length > 0) session.audio = audio;

  if (req.tools?.length) {
    session.tools = req.tools.map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: toJsonSchema(tool.parameters),
    }));
  }

  const extra = req.providerOptions?.[OPENAI_PROVIDER_ID];

  return {
    expires_after: { anchor: 'created_at', seconds },
    session: (extra ? { ...session, ...extra, type: 'realtime' } : session) as RealtimeSessionCreateRequest,
  };
}

/** The `client_secrets` answer -> `AiRealtimeSession`. */
export function fromOpenAiClientSecretResponse(
  data: ClientSecretCreateResponse,
  context: { request: AiRealtimeSessionRequest; baseUrl?: string; providerRequestId?: string | null },
): AiRealtimeSession {
  const { request } = context;

  if (typeof data?.value !== 'string' || data.value.length === 0 || typeof data.expires_at !== 'number') {
    throw new AiError('AI_PROVIDER_UNAVAILABLE', 'OpenAI returned no realtime client secret.', {
      details: { provider: OPENAI_PROVIDER_ID },
    });
  }

  const session = data.session?.type === 'realtime' ? data.session : undefined;
  const voice = typeof session?.audio?.output?.voice === 'string' ? session.audio.output.voice : request.voice;
  const modalities = session?.output_modalities ?? request.modalities;
  const instructions = session?.instructions ?? request.instructions;
  const maxOutputTokens =
    typeof session?.max_output_tokens === 'number' ? session.max_output_tokens : request.maxOutputTokens;
  const turnDetection =
    request.turnDetection !== undefined ? request.turnDetection : fromTurnDetection(session?.audio?.input?.turn_detection);

  const sessionConfig: NonNullable<AiRealtimeSession['sessionConfig']> = {};

  if (modalities !== undefined) sessionConfig.modalities = [...modalities];
  if (instructions !== undefined) sessionConfig.instructions = instructions;
  if (turnDetection !== undefined) sessionConfig.turnDetection = turnDetection;
  if (maxOutputTokens !== undefined) sessionConfig.maxOutputTokens = maxOutputTokens;

  return {
    ...(session?.id ? { id: session.id } : {}),
    provider: OPENAI_PROVIDER_ID,
    model: typeof session?.model === 'string' && session.model.length > 0 ? session.model : request.model,
    clientSecret: data.value,
    expiresAt: new Date(data.expires_at * 1000),
    connectUrl: openAiRealtimeConnectUrl(context.baseUrl),
    ...(voice !== undefined ? { voice } : {}),
    sessionConfig,
    ...(context.providerRequestId ? { providerRequestId: context.providerRequestId } : {}),
  };
}

function toTurnDetection(value: AiRealtimeTurnDetection | null): RealtimeAudioInputTurnDetection | null {
  if (value === null) return null;

  if (value.type === 'semantic_vad') {
    return { type: 'semantic_vad', ...(value.eagerness !== undefined ? { eagerness: value.eagerness } : {}) };
  }

  return {
    type: 'server_vad',
    ...(value.threshold !== undefined ? { threshold: value.threshold } : {}),
    ...(value.prefixPaddingMs !== undefined ? { prefix_padding_ms: value.prefixPaddingMs } : {}),
    ...(value.silenceDurationMs !== undefined ? { silence_duration_ms: value.silenceDurationMs } : {}),
  };
}

function fromTurnDetection(value: unknown): AiRealtimeTurnDetection | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;

  const raw = value as Record<string, unknown>;

  if (raw.type === 'semantic_vad') {
    const eagerness = raw.eagerness;

    return {
      type: 'semantic_vad',
      ...(eagerness === 'low' || eagerness === 'medium' || eagerness === 'high' || eagerness === 'auto'
        ? { eagerness }
        : {}),
    };
  }

  if (raw.type === 'server_vad') {
    return {
      type: 'server_vad',
      ...(typeof raw.threshold === 'number' ? { threshold: raw.threshold } : {}),
      ...(typeof raw.prefix_padding_ms === 'number' ? { prefixPaddingMs: raw.prefix_padding_ms } : {}),
      ...(typeof raw.silence_duration_ms === 'number' ? { silenceDurationMs: raw.silence_duration_ms } : {}),
    };
  }

  return undefined;
}
