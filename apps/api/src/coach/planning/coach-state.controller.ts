import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AiEnabledGuard } from '../../ai/config/ai-enabled.guard';
import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
import { CoachStateService } from './coach-state.service';
import { CoachStateViewDto } from './dto/coach-state.dto';

// =============================================================================
// GET /api/coach/state (E7.4; docs/specs/ai-coach.md §3.6)
// =============================================================================
//
// The `/coach` header: weekly target ring, streak, passes, next session,
// pause and silence state, unread count. `AiEnabledGuard` (class level, so the
// kill switch answers before anything else) plus `ai:use`, and `programs:read`
// because the ring and next session are plan signals. Caller-scoped: the user
// id comes from the token, never from the request.
// =============================================================================

@ApiTags('AI Coach')
@Controller('coach')
@UseGuards(AiEnabledGuard)
export class CoachStateController {
  constructor(private readonly state: CoachStateService) {}

  @Get('state')
  @Auth({ permissions: [PERMISSIONS.AI_USE, PERMISSIONS.PROGRAMS_READ] })
  @ApiOperation({
    summary: 'Coach header state',
    description:
      'The caller\'s coach header: whether the coach is on, `pausedUntil` and `silencedAt`, the current ISO ' +
      'week\'s target ring (planned sessions and how many are done), the weekly streak and passes left, the next ' +
      'planned session not done yet (within 7 days) and the number of delivered, unopened coach messages. ' +
      'Every number comes from the training signals and the coach state, never a model. Defaults (zero ' +
      'streak, nothing paused) before the coach has planned anything for the caller.',
  })
  @ApiDataResponse(CoachStateViewDto, { description: 'The header state' })
  @ApiResponse({ status: 401, description: 'Not authenticated', type: ErrorDto })
  @ApiResponse({ status: 403, description: '`AI_DISABLED`, or missing `ai:use` or `programs:read`', type: ErrorDto })
  get(@CurrentUser('id') userId: string) {
    return this.state.view(userId);
  }
}
