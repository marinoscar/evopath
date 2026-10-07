import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '@marinoscar/platform-api/core';
import {
  CoachStatsQueryDto,
  CoachStatsView,
  DEFAULT_COACH_STATS_RANGE_DAYS,
  MAX_COACH_STATS_RANGE_DAYS,
  type CoachStats,
} from '../dto/coach-admin-stats.dto';
import { CoachAdminStatsService } from './coach-admin-stats.service';

// =============================================================================
// GET /api/admin/coach/stats — coach engagement aggregates (E7.11, #251)
// =============================================================================
//
// `ai_config:read`, deliberately NOT behind `AiEnabledGuard` (AI rule 4), like
// `/api/admin/coach/settings`: an administrator reads what the coach did even
// while AI is off. Aggregates only: no user id, no message text.
// =============================================================================

@ApiTags('AI Coach Administration')
@Controller('admin/coach')
export class CoachAdminStatsController {
  constructor(private readonly stats: CoachAdminStatsService) {}

  @Get('stats')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_READ] })
  @ApiOperation({
    summary: 'Coach engagement stats (Admin only)',
    description:
      'Send, open and conversion counts and rates of delivered coach messages, in total and by angle, persona ' +
      'and moment, plus the epic KPIs (weekly actives, chat sessions per weekly active user, photo cadence ' +
      `adherence, opt-out rate). UTC days, both inclusive; default the last ${DEFAULT_COACH_STATS_RANGE_DAYS} days, ` +
      `at most ${MAX_COACH_STATS_RANGE_DAYS}. Aggregates only: the answer never carries a user id or message text. ` +
      'Reachable while AI is off. Refused with **400** (`details.reason: "COACH_STATS_RANGE_INVALID"`) for a ' +
      'reversed or over-long range.',
  })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'First UTC day included, `YYYY-MM-DD`.' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'Last UTC day included, `YYYY-MM-DD`. Default today.' })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    description: `Window length when \`from\` is omitted. Default ${DEFAULT_COACH_STATS_RANGE_DAYS}.`,
  })
  @ApiDataResponse(CoachStatsView, { description: 'The engagement stats' })
  @ApiResponse({ status: 400, description: 'Invalid query, or `COACH_STATS_RANGE_INVALID`', type: ErrorDto })
  @ApiResponse({ status: 401, description: 'Not authenticated', type: ErrorDto })
  @ApiResponse({ status: 403, description: 'Missing `ai_config:read`', type: ErrorDto })
  view(@Query() query: CoachStatsQueryDto): Promise<CoachStats> {
    return this.stats.stats(query);
  }
}
