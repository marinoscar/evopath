import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { CheckInDatePipe } from './check-in-date.pipe';
import { CheckInsService } from './check-ins.service';
import {
  CHECK_IN_LIST_DAYS_DEFAULT,
  CHECK_IN_LIST_DAYS_MAX,
  CHECK_IN_MAX_BACK_DAYS,
  CHECK_IN_NOTE_MAX,
  CheckInDto,
  CheckInListDto,
  ListCheckInsQueryDto,
  PutCheckInDto,
  TodayCheckInDto,
} from './dto/check-in.dto';

// =============================================================================
// /api/check-ins — the caller's daily readiness check-ins (E2.4, #56)
// =============================================================================
//
// Owner-scoped: every route acts on the JWT user's rows only. The literal
// `today` route is declared before the parameterised `:date` routes.
// =============================================================================

const DATE_PARAM = {
  name: 'date',
  type: String,
  format: 'date',
  example: '2026-09-29',
  description: 'The local calendar day, `YYYY-MM-DD`.',
} as const;

@ApiTags('Check-ins')
@Controller('check-ins')
export class CheckInsController {
  constructor(private readonly checkIns: CheckInsService) {}

  @Get('today')
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_READ] })
  @ApiOperation({
    summary: "Get today's check-in",
    description:
      "Today's date in the caller's profile time zone (UTC when none is set) and the check-in " +
      'for it, or `checkIn: null`. Clients send this `date` back to `PUT /api/check-ins/{date}` ' +
      'rather than computing "today" themselves.',
  })
  @ApiResponse({ status: 200, description: "Today's date and check-in", type: TodayCheckInDto })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing health_data:read' })
  today(@CurrentUser('id') userId: string) {
    return this.checkIns.getToday(userId);
  }

  @Get()
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_READ] })
  @ApiOperation({
    summary: 'List recent check-ins',
    description:
      'Check-ins of the last `days` local days including today, newest first. Days without a ' +
      'check-in are absent, so there are at most `days` items.',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    description: `1 to ${CHECK_IN_LIST_DAYS_MAX}; default ${CHECK_IN_LIST_DAYS_DEFAULT}.`,
  })
  @ApiResponse({ status: 200, description: 'Check-ins, newest first', type: CheckInListDto })
  @ApiResponse({ status: 400, description: `days is not a whole number from 1 to ${CHECK_IN_LIST_DAYS_MAX}` })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing health_data:read' })
  list(@CurrentUser('id') userId: string, @Query() query: ListCheckInsQueryDto) {
    return this.checkIns.list(userId, query.days);
  }

  // ---------------------------------------------------------------------------
  // Parameterised routes. Nothing literal may be declared below this line.
  // ---------------------------------------------------------------------------

  @Put(':date')
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_WRITE] })
  @ApiOperation({
    summary: "Save a day's check-in",
    description:
      'Replaces the check-in for `date`: four optional scores from 1 to 5 and a note ' +
      `(trimmed, at most ${CHECK_IN_NOTE_MAX} characters). At least one score is required; ` +
      'clearing a whole day is `DELETE`. A score omitted or null is removed from the day. ' +
      `\`date\` must be today in the caller's time zone or at most ${CHECK_IN_MAX_BACK_DAYS} days ` +
      'earlier. Saving what is already stored writes nothing. Scores are stored as entered; no ' +
      'combined readiness score is computed.',
  })
  @ApiParam(DATE_PARAM)
  @ApiResponse({ status: 200, description: 'The check-in as it now stands', type: CheckInDto })
  @ApiResponse({
    status: 400,
    description:
      'Validation error (`details.issues` names each field): no score, a score that is not a ' +
      'whole number from 1 to 5, a note over the limit, an unknown field, or a date that is not ' +
      'a real day, is in the future, or is more than 7 days ago',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing health_data:write' })
  @ApiResponse({ status: 409, description: 'The check-in was saved concurrently by another request' })
  put(
    @CurrentUser('id') userId: string,
    @Param('date', CheckInDatePipe) date: string,
    @Body() dto: PutCheckInDto,
  ) {
    return this.checkIns.put(userId, date, dto);
  }

  @Delete(':date')
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Delete a day's check-in",
    description:
      'Soft-deletes every score of the check-in for `date`. Audited as `check_in:delete` with ' +
      'the score count only.',
  })
  @ApiParam(DATE_PARAM)
  @ApiResponse({ status: 204, description: 'Check-in deleted' })
  @ApiResponse({ status: 400, description: 'date is not a real `YYYY-MM-DD` day' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing health_data:write' })
  @ApiResponse({ status: 404, description: 'No check-in for this date' })
  async remove(
    @CurrentUser('id') userId: string,
    @Param('date', CheckInDatePipe) date: string,
  ): Promise<void> {
    await this.checkIns.remove(userId, date);
  }
}
