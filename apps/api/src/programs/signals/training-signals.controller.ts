import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
import { PlanSignalsView, TrainingSignalsQueryDto } from './dto/training-signals.dto';
import { TrainingSignalsService } from './signals.service';

// =============================================================================
// GET /api/training/signals (E5.9)
// =============================================================================
//
// Facts about the caller's plan: planned versus done, frequency, hard sets
// per muscle, lifts, effort, pain, readiness and body weight. Deterministic,
// computed on read, caller-scoped. Works with AI off (no `AiEnabledGuard`).
// =============================================================================

@ApiTags('Programs')
@Controller('training')
export class TrainingSignalsController {
  constructor(private readonly signals: TrainingSignalsService) {}

  @Get('signals')
  @Auth({ permissions: [PERMISSIONS.PROGRAMS_READ] })
  @ApiOperation({
    summary: 'Plan signals (adherence and progress)',
    description:
      'Deterministic facts about one of the caller\'s programs over a range of local days: planned versus done ' +
      'per ISO week (a planned session counts once its day is before `asOf` or it was started; partial below 60 ' +
      'percent of its planned sets; extra = completed workouts linked to no plan), frequency, weekly hard sets per ' +
      'primary muscle against planned sets, lift trends and PRs, effort, pain flags of the last 28 days (counts ' +
      'only, never note text), readiness from the last 7 days of check-ins and the 8-week body-weight trend. ' +
      '`programId` defaults to the active program; without one, adherence is empty and the rest still describes ' +
      'the caller\'s training. At most 26 weeks; a very large history shrinks the range from the old end and ' +
      'sets `truncated`. Weights are kilograms.',
  })
  @ApiDataResponse(PlanSignalsView, { description: 'The signals' })
  @ApiResponse({
    status: 400,
    description:
      'Validation error (malformed dates, `from` after `to`, a range over 26 weeks), or `details.reason`: ' +
      '`SIGNALS_AS_OF_OUT_OF_RANGE` (`asOf` more than 2 days from the server\'s today) or `SIGNALS_RANGE_INVALID`',
    type: ErrorDto,
  })
  @ApiResponse({ status: 401, description: 'Not authenticated', type: ErrorDto })
  @ApiResponse({ status: 403, description: 'Missing programs:read', type: ErrorDto })
  @ApiResponse({ status: 404, description: 'The caller has no such program', type: ErrorDto })
  get(@CurrentUser('id') userId: string, @Query() query: TrainingSignalsQueryDto) {
    return this.signals.forUser(userId, query);
  }
}
