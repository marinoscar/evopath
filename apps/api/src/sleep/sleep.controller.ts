import { Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ErrorDto } from '@marinoscar/platform-api/core';
import { ListSleepQueryDto, SLEEP_LIST_MAX_RANGE_DAYS, SleepSessionViewDto } from './dto/sleep.dto';
import { SleepService } from './sleep.service';

// =============================================================================
// /api/sleep — the caller's sleep sessions (epic #276, #278)
// =============================================================================
//
// `health_data:read` for GET, `health_data:write` for DELETE; owner-scoped.
// =============================================================================

@ApiTags('Sleep')
@Controller('sleep')
export class SleepController {
  constructor(private readonly sleep: SleepService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_READ] })
  @ApiOperation({
    summary: 'List sleep sessions',
    description: `Sessions whose day of waking lies in \`from..to\` (at most ${SLEEP_LIST_MAX_RANGE_DAYS} days), newest day first.`,
  })
  @ApiDataResponse(SleepSessionViewDto, { isArray: true })
  @ApiResponse({ status: 400, description: 'Validation error, or `details.reason`: `RANGE_TOO_LARGE`', type: ErrorDto })
  @ApiResponse({ status: 401, description: 'Not authenticated', type: ErrorDto })
  @ApiResponse({ status: 403, description: 'Missing health_data:read', type: ErrorDto })
  list(@CurrentUser('id') userId: string, @Query() query: ListSleepQueryDto) {
    return this.sleep.list(userId, query);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_WRITE] })
  @ApiOperation({
    summary: 'Delete a sleep session',
    description: 'A synced session comes back on the next sync while the phone still holds it in its window.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'The sleep session id.' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 400, description: 'The id is not a UUID', type: ErrorDto })
  @ApiResponse({ status: 401, description: 'Not authenticated', type: ErrorDto })
  @ApiResponse({ status: 403, description: 'Missing health_data:write', type: ErrorDto })
  @ApiResponse({ status: 404, description: 'The caller has no session with this id', type: ErrorDto })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.sleep.remove(userId, id);
  }
}
