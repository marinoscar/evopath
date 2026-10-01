import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AiEnabledGuard } from '../../ai/config/ai-enabled.guard';
import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ErrorDto } from '../../common/dto/error.dto';
import { CoachMessagesService } from './coach-messages.service';
import { CoachMessageFeedbackDto } from './dto/coach-message-feedback.dto';

// =============================================================================
// /api/coach/messages/:id/{opened,feedback} (E7.5, #245; spec §3.6)
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
  constructor(private readonly messages: CoachMessagesService) {}

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
}
