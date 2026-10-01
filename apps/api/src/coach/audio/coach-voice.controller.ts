import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AiEnabledGuard } from '../../ai/config/ai-enabled.guard';
import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
import { COACH_PREVIEW_LIMIT, COACH_PREVIEW_WINDOW_MS } from './coach-preview-rate-limiter';
import { CoachVoicePreviewService } from './coach-voice-preview.service';
import {
  COACH_PREVIEW_DEFAULT_MOMENT,
  CoachVoicePreviewRequestDto,
  CoachVoicePreviewStartedDto,
  type CoachVoicePreviewStarted,
} from './dto/coach-voice-preview.dto';

// =============================================================================
// POST /api/coach/voice-preview (E7.6, #246; docs/specs/ai-coach.md §3.6)
// =============================================================================
//
// `ai:use` behind `AiEnabledGuard`, like every coach consumer route. Owner-
// scoped: the run belongs to the caller. Static registry lines only.
// =============================================================================

@ApiTags('AI Coach')
@Controller('coach')
@UseGuards(AiEnabledGuard)
export class CoachVoiceController {
  constructor(private readonly preview: CoachVoicePreviewService) {}

  @Post('voice-preview')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Preview a coach voice',
    description:
      'Speaks a persona\'s fixed sample line (the `moment` line at the given intensity, default ' +
      `\`${COACH_PREVIEW_DEFAULT_MOMENT}\`; placeholders filled with demo values, never your data) with the ` +
      '`coach.voice` model, in `voice` (default: the persona\'s voice for the level) at `speed` (default: your ' +
      'saved speed). Adult language follows your register: a locked Sarge intensity 3 speaks the intensity-2 ' +
      'line and answers `censored: true`.\n\n' +
      'Queued like every speech run: **202** with `runId`; poll `GET /api/ai/runs/{runId}` and play ' +
      '`output.storageObjectId` (download with `GET /api/storage/objects/{id}/download`). The audio is ' +
      'AI-generated (`output.aiGenerated: true`) and must be labelled as such.\n\n' +
      `**Rate limit:** ${COACH_PREVIEW_LIMIT} previews per ${COACH_PREVIEW_WINDOW_MS / 60_000} minutes per user; ` +
      'the next is 429 `COACH_PREVIEW_RATE_LIMITED` (`details.code`) with `Retry-After`, and no provider call ' +
      'is made. 403 `COACH_AUDIO_DISABLED` while the deployment disallows coach audio; 409 ' +
      '`AI_FEATURE_UNAVAILABLE` (`details.reason`) when `coach.voice` has no usable model with `audio_speech`.',
  })
  @ApiDataResponse(CoachVoicePreviewStartedDto, { status: 202, description: 'The preview speech run was queued' })
  @ApiResponse({
    status: 400,
    description: 'Validation error, `COACH_PERSONA_UNKNOWN`, or `AI_INVALID_REQUEST` (a voice the model does not speak)',
    type: ErrorDto,
  })
  @ApiResponse({ status: 401, description: 'Not authenticated', type: ErrorDto })
  @ApiResponse({
    status: 403,
    description: '`AI_DISABLED`, missing `ai:use`, `COACH_AUDIO_DISABLED`, or an AI key refusal',
    type: ErrorDto,
  })
  @ApiResponse({ status: 409, description: '`AI_FEATURE_UNAVAILABLE`: no usable model for `coach.voice`', type: ErrorDto })
  @ApiResponse({ status: 429, description: '`COACH_PREVIEW_RATE_LIMITED`, with `Retry-After`', type: ErrorDto })
  voicePreview(
    @Body() dto: CoachVoicePreviewRequestDto,
    @CurrentUser('id') userId: string,
  ): Promise<CoachVoicePreviewStarted> {
    return this.preview.preview(userId, dto);
  }
}
