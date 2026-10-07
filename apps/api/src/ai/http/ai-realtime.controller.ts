import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '@marinoscar/platform-api/core';
import { AiEnabledGuard } from '../config/ai-enabled.guard';
import { AiService } from '../runtime/ai.service';
import type { AiRealtimeRequest } from '../runtime/ai-runtime.types';
import {
  AiRealtimeSessionRequestDto,
  AiRealtimeSessionResponseDto,
  type AiRealtimeSessionHttpResponse,
  type AiRealtimeSessionRequestInput,
} from './dto/ai-realtime.dto';

// =============================================================================
// AiRealtimeController (issue #449, epic #421)
// =============================================================================
//
//   POST /api/ai/realtime/sessions   ai:use   mint a realtime voice session   -> 201
//
// The browser talks to the provider DIRECTLY over WebRTC; this route only
// mints the ephemeral secret it connects with, using the caller's key (or
// the org key, under fallback) server-side. The response carries that
// ephemeral secret — the single, deliberate exception to "no credential
// leaves the server" (docs/specs/ai-platform.md §2.15) — and never the key.
//
// Synchronous: one short provider round trip, no job (the long-running part
// is the call itself, which never touches this server). Refused 403
// `AI_REALTIME_DISABLED` unless an administrator has switched
// `ai.defaults.allowRealtime` on; `GET /api/ai/config`'s `allowRealtime`
// says so in advance.
//
// `AiEnabledGuard` on the CLASS (the kill switch answers before auth).
// =============================================================================

@ApiTags('AI')
@Controller('ai/realtime')
@UseGuards(AiEnabledGuard)
export class AiRealtimeController {
  constructor(private readonly ai: AiService) {}

  @Post('sessions')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Mint a realtime voice session',
    description:
      'Mints a short-lived, single-session **ephemeral** client secret for a realtime (speech-to-' +
      'speech) session, with **your** key for the provider (or the organisation key, when the ' +
      'deployment allows fallback and you have none). The browser then connects to the provider ' +
      'directly: it POSTs its WebRTC SDP offer (`Content-Type: application/sdp`) to `connectUrl` ' +
      'with `Authorization: Bearer <clientSecret>` and reads the SDP answer from the response.\n\n' +
      '`clientSecret` expires at `expiresAt` (about 60 seconds): connect promptly; a call already ' +
      'connected continues. It can open this session and call no other API, and it is **never** ' +
      'your API key. Treat it as a bearer credential: do not log or store it.\n\n' +
      '`model` must be an enabled model with the `realtime` capability; omit it to use the first ' +
      'one available to you. `voice` must be one the model lists (`capabilities.voices` in ' +
      '`GET /api/ai/models`); omit it to use the first. `instructions` are the session\'s initial ' +
      'system prompt. Everything here is initial configuration — the browser can change it over ' +
      'its data channel (`session.update`), e.g. to enable input-audio transcription.\n\n' +
      'Realtime must be switched on by an administrator (`allowRealtime` in `GET /api/ai/config`); ' +
      'otherwise **403** `AI_REALTIME_DISABLED`. Each mint counts as one request against the ' +
      'deployment\'s rate limits and is recorded as usage `operation: "realtime"`, ' +
      '`units: { sessions: 1 }` (the server never sees the audio, so no tokens are recorded).\n\n' +
      'Refusals carry the AI error code in `details.reason`: `AI_DISABLED`, `AI_REALTIME_DISABLED`, ' +
      '`AI_PROVIDER_DISABLED`, `AI_MODEL_NOT_ENABLED`, `AI_KEY_REQUIRED`, `AI_MODEL_NOT_REACHABLE` ' +
      '(403); `AI_CAPABILITY_UNSUPPORTED`, `AI_INVALID_REQUEST`, `AI_KEY_INVALID` (400); ' +
      '`AI_RATE_LIMITED` (429); `AI_PROVIDER_UNAVAILABLE` (503).',
  })
  @ApiDataResponse(AiRealtimeSessionResponseDto, { status: 201, description: 'The session was minted' })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, `AI_INVALID_REQUEST` (including a voice the model does not list, and no ' +
      'realtime model available), `AI_CAPABILITY_UNSUPPORTED`, `AI_KEY_INVALID`',
    type: ErrorDto,
  })
  @ApiResponse({
    status: 403,
    description:
      '`AI_DISABLED`, `AI_REALTIME_DISABLED`, `AI_PROVIDER_DISABLED`, `AI_MODEL_NOT_ENABLED`, ' +
      '`AI_KEY_REQUIRED`, `AI_MODEL_NOT_REACHABLE`, or missing `ai:use`',
    type: ErrorDto,
  })
  @ApiResponse({
    status: 429,
    description:
      '`AI_RATE_LIMITED` — the provider throttled the call, or a deployment rate limit (`ai.limits`, named in `details.limit`) was reached. `details.retryAfterMs` and the `Retry-After` header (seconds) say when to retry',
    type: ErrorDto,
  })
  @ApiResponse({ status: 503, description: '`AI_PROVIDER_UNAVAILABLE`', type: ErrorDto })
  async createSession(
    @Body() dto: AiRealtimeSessionRequestDto,
    @CurrentUser('id') userId: string,
  ): Promise<AiRealtimeSessionHttpResponse> {
    const session = await this.ai.forUser(userId).createRealtimeSession(toRealtimeRequest(dto));

    return {
      provider: session.provider,
      model: session.model,
      voice: session.voice,
      clientSecret: session.clientSecret,
      expiresAt: session.expiresAt.toISOString(),
      connectUrl: session.connectUrl,
    };
  }
}

/** Named fields only — a key added to the DTO later does not reach a provider unexamined. */
function toRealtimeRequest(body: AiRealtimeSessionRequestInput): AiRealtimeRequest {
  const request: AiRealtimeRequest = {};

  if (body.provider !== undefined) request.provider = body.provider;
  if (body.model !== undefined) request.model = body.model;
  if (body.voice !== undefined) request.voice = body.voice;
  if (body.instructions !== undefined) request.instructions = body.instructions;

  return request;
}
