import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
import { TRAINING_TODAY_VIEWS, TrainingTodayQueryDto } from './dto/training-today.dto';
import { TrainingTodayService } from './training-today.service';

// =============================================================================
// /api/training/today: today's planned workout (E5.7)
// =============================================================================
//
// Read-only over the plan; works with AI off and for manual plans. The
// client sends its local day; the server never guesses it.
// =============================================================================

@ApiTags('Programs')
@Controller('training')
export class TrainingTodayController {
  constructor(private readonly today: TrainingTodayService) {}

  @Get('today')
  @Auth({ permissions: [PERMISSIONS.PROGRAMS_READ] })
  @ApiOperation({
    summary: 'Today\'s planned workout',
    description:
      'Resolves the caller\'s active program for `date` (the client\'s local day). A workout of plan week N ' +
      'occurs on the first day of that week\'s seven-day window (`startDate + 7(N-1)` .. `+7N-1`) whose ISO ' +
      'weekday matches. `kind` is `no_program`, `not_started`, `program_complete` (the plan is then marked ' +
      '`completed`, once), `rest_day` (with the next occurrence within 14 days) or `workout` (with the ' +
      'hydrated `session` and `done` when a completed workout is linked). Missed sessions of earlier weeks ' +
      'are never surfaced. Weights are kilograms.',
  })
  @ApiDataResponse(TRAINING_TODAY_VIEWS, { description: 'What the plan asks for on `date`; read `kind`' })
  @ApiResponse({
    status: 400,
    description: 'Validation error (missing or malformed `date`), or `details.reason`: `TODAY_OUT_OF_RANGE`',
    type: ErrorDto,
  })
  @ApiResponse({ status: 401, description: 'Not authenticated', type: ErrorDto })
  @ApiResponse({ status: 403, description: 'Missing programs:read', type: ErrorDto })
  get(@CurrentUser('id') userId: string, @Query() query: TrainingTodayQueryDto) {
    return this.today.today(userId, query.date);
  }
}
