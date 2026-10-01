import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { AiEnabledGuard } from '../../ai/config/ai-enabled.guard';
import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
import { COACH_LISTEN_LIMIT, COACH_LISTEN_WINDOW_MS } from '../audio/coach-listen-rate-limiter';
import { CoachMessageAudioService } from '../audio/coach-message-audio.service';
import { CoachMessageAudioDto, type CoachMessageAudio } from '../audio/dto/coach-message-audio.dto';
import { CoachMessagesService } from './coach-messages.service';
import { CoachMessageFeedbackDto } from './dto/coach-message-feedback.dto';

// =============================================================================
// /api/coach/messages/:id/{opened,feedback} (E7.5, #245) and
// /api/coach/messages/:id/audio (on-demand Listen, #259; spec §3.6)
// =============================================================================
//
// `AiEnabledGuard` (class level, so the kill switch answers first) plus
// `ai:use`. Caller-scoped: the user id comes from the token, and a message of
// another user is the same 404 as an unknown id.
// =============================================================================

const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;
const FORBIDDEN = { status: 403, description: '`AI_DISABLED` (`details.reason`), or missing `ai:use`', type: ErrorDto } as const;
const NOT_FOUND = {
  status: 404,
  description: '`COACH_MESSAGE_NOT_FOUND` (`details.code`): unknown id, or a message of another user',
  type: ErrorDto,
} as const;
const ID_PARAM = { name: 'id', description: 'The coach message id (`/coach?m=<id>`)', format: 'uuid' } as const;

@ApiTags('AI Coach')
@Controller('coach/messages')
@UseGuards(AiEnabledGuard)
export class CoachMessagesController {
  constructor(
    private readonly messages: CoachMessagesService,
    private readonly messageAudio: CoachMessageAudioService,
  ) {}

  @Post(':id/opened')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'Mark a coach message opened',
    description:
      'Records that the caller opened one of their coach messages. Idempotent: `openedAt` is set the first ' +
      'time and kept afterwards. Any open counts as re-engagement: the ignored-message run resets to 0 and an ' +
      'automatic back-off (`silencedAt`) is cleared.',
  })
  @ApiParam(ID_PARAM)
  @ApiResponse({ status: 204, description: 'Recorded' })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  @ApiResponse(NOT_FOUND)
  async opened(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<void> {
    await this.messages.markOpened(userId, id);
  }

  @Post(':id/feedback')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'Rate a coach message',
    description: 'Stores thumbs up (`up`) or down (`down`) on one of the caller\'s coach messages; `null` clears it.',
  })
  @ApiParam(ID_PARAM)
  @ApiResponse({ status: 204, description: 'Stored' })
  @ApiResponse({ status: 400, description: 'Validation error', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  @ApiResponse(NOT_FOUND)
  async feedback(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: CoachMessageFeedbackDto,
  ): Promise<void> {
    await this.messages.setFeedback(userId, id, dto.feedback);
  }

  @Post(':id/audio')
  @HttpCode(HttpStatus.ACCEPTED)
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'Listen to a coach message',
    description:
      'Speaks one of the caller\'s coach messages on request with the `coach.voice` model: the stored, ' +
      'guard-approved text (its `audioScript`, else the body, links read as their labels), in the caller\'s ' +
      'voice (else the persona\'s for the level the current register allows) and speed. Nothing is ' +
      'regenerated and no notification is sent.\n\n' +
      '- Audio already `ready`: **200** `{ status: "ready", storageObjectId, voice }`, no new run.\n' +
      '- A run already `pending`: **202** `{ status: "pending", runId }`, no new run.\n' +
      '- Otherwise (`none`, `failed`): one speech run is queued (concurrent presses share it) and the ' +
      'answer is **202** `{ status: "pending", runId }`; poll `GET /api/ai/runs/{runId}` or ' +
      '`GET /api/coach/messages/{id}/audio` until `ready` (or `failed`). Should the provider refuse to ' +
      'even queue it: **200** `{ status: "failed" }`.\n\n' +
      'The audio is AI-generated and must be labelled as such. ' +
      `**Rate limit:** ${COACH_LISTEN_LIMIT} new speech runs per ${COACH_LISTEN_WINDOW_MS / 60_000} minutes per ` +
      'user (ready and pending answers do not count); the next is 429 `COACH_AUDIO_RATE_LIMITED` ' +
      '(`details.code`) with `Retry-After`, and no provider call is made.',
  })
  @ApiParam(ID_PARAM)
  @ApiDataResponse(CoachMessageAudioDto, { status: 202, description: 'A speech run is in flight (`pending`)' })
  @ApiDataResponse(CoachMessageAudioDto, { status: 200, description: 'Settled: `ready`, or `failed` to queue' })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse({
    status: 403,
    description:
      '`AI_DISABLED` (`details.reason`), missing `ai:use`, or `COACH_AUDIO_DISABLED` (`details.code`): the ' +
      'deployment\'s `allowAudio` or the caller\'s `audio.enabled` is off',
    type: ErrorDto,
  })
  @ApiResponse(NOT_FOUND)
  @ApiResponse({ status: 409, description: '`AI_FEATURE_UNAVAILABLE`: no usable model for `coach.voice`', type: ErrorDto })
  @ApiResponse({ status: 429, description: '`COACH_AUDIO_RATE_LIMITED`, with `Retry-After`', type: ErrorDto })
  async requestAudio(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CoachMessageAudio> {
    const audio = await this.messageAudio.request(userId, id);
    if (audio.status !== 'pending') reply.status(HttpStatus.OK);
    return audio;
  }

  @Get(':id/audio')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'Get a coach message\'s audio state',
    description:
      'The cheap poll after `POST /api/coach/messages/{id}/audio`: the same shape, no side effects, no ' +
      'rate limit. `storageObjectId` and `voice` only while `ready`; `runId` only while `pending`.',
  })
  @ApiParam(ID_PARAM)
  @ApiDataResponse(CoachMessageAudioDto, { description: 'The message\'s audio state' })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  @ApiResponse(NOT_FOUND)
  getAudio(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<CoachMessageAudio> {
    return this.messageAudio.get(userId, id);
  }
}
