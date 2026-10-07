import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ErrorDto } from '@marinoscar/platform-api/core';
import { ENTRY_BATCH_MAX, ENTRY_LIST_MAX_RANGE_DAYS, ENTRY_MAX_DAYS_BACK } from './activity.constants';
import { ActivityEntriesService } from './activity-entries.service';
import {
  BatchActivityEntriesDto,
  BatchResultView,
  CreateActivityEntryDto,
  ListActivityEntriesQueryDto,
  UpdateActivityEntryDto,
} from './dto/activity-entry.dto';
import { ActivityEntryView } from './dto/goal.dto';

// =============================================================================
// /api/activity-entries — check-ins toward goals (#267)
// =============================================================================
//
// Owner-scoped: another user's entry is a 404. `goals:read` for GET,
// `goals:write` otherwise. Every entry written here is `source: 'manual'`;
// workout-derived entries are maintained by the server and refuse PATCH and
// DELETE (409 ENTRY_DERIVED).
// =============================================================================

const ENTRY_ID_PARAM = { name: 'id', type: String, format: 'uuid', description: 'The activity entry id.' } as const;

const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;
const NO_READ = { status: 403, description: 'Missing goals:read', type: ErrorDto } as const;
const NO_WRITE = { status: 403, description: 'Missing goals:write', type: ErrorDto } as const;
const NOT_FOUND = { status: 404, description: 'The caller has no entry with this id', type: ErrorDto } as const;
const DAY_REFUSAL = {
  status: 400,
  description: `Validation error, or \`details.reason\`: \`ENTRY_DATE_OUT_OF_RANGE\` (today or up to ${ENTRY_MAX_DAYS_BACK} days back, local)`,
  type: ErrorDto,
} as const;
const DERIVED = {
  status: 409,
  description: '`details.reason`: `ENTRY_DERIVED` (a workout-derived or imported entry)',
  type: ErrorDto,
} as const;

@ApiTags('Activity entries')
@Controller('activity-entries')
export class ActivityEntriesController {
  constructor(private readonly entries: ActivityEntriesService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.GOALS_READ] })
  @ApiOperation({
    summary: 'List activity entries',
    description:
      `The caller's entries with \`occurredOn\` in \`from..to\` (local days, at most ${ENTRY_LIST_MAX_RANGE_DAYS}), ` +
      'oldest first, optionally of one `kind`. Includes workout-derived entries (`source: workout`).',
  })
  @ApiDataResponse(ActivityEntryView, { isArray: true })
  @ApiResponse({ status: 400, description: 'Validation error, or `details.reason`: `RANGE_TOO_LARGE`', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  list(@CurrentUser('id') userId: string, @Query() query: ListActivityEntriesQueryDto) {
    return this.entries.list(userId, query);
  }

  @Post()
  @Auth({ permissions: [PERMISSIONS.GOALS_WRITE] })
  @ApiOperation({
    summary: 'Log an activity entry',
    description:
      '"I did it" `{ activityKind: "walk" }`, minutes `{ activityKind: "walk", durationSeconds: 1800 }` or ' +
      'steps `{ activityKind: "steps", steps: 8000 }`. `occurredOn` defaults to today (local).',
  })
  @ApiDataResponse(ActivityEntryView, { status: 201 })
  @ApiResponse(DAY_REFUSAL)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  create(@CurrentUser('id') userId: string, @Body() dto: CreateActivityEntryDto) {
    return this.entries.create(userId, dto);
  }

  @Post('batch')
  @HttpCode(HttpStatus.OK)
  @Auth({ permissions: [PERMISSIONS.GOALS_WRITE] })
  @ApiOperation({
    summary: 'Log activity entries in bulk',
    description:
      `1..${ENTRY_BATCH_MAX} entries in one transaction. With both \`provider\` and \`externalId\` an entry ` +
      'replaces the caller\'s earlier one with the same pair; otherwise it is inserted. Always stored as ' +
      '`source: manual`.',
  })
  @ApiDataResponse(BatchResultView)
  @ApiResponse(DAY_REFUSAL)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  batch(@CurrentUser('id') userId: string, @Body() dto: BatchActivityEntriesDto) {
    return this.entries.batch(userId, dto);
  }

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.GOALS_WRITE] })
  @ApiOperation({ summary: 'Edit a manual activity entry', description: 'Nullable values are cleared with `null`.' })
  @ApiParam(ENTRY_ID_PARAM)
  @ApiDataResponse(ActivityEntryView)
  @ApiResponse(DAY_REFUSAL)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse(DERIVED)
  update(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateActivityEntryDto) {
    return this.entries.update(userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auth({ permissions: [PERMISSIONS.GOALS_WRITE] })
  @ApiOperation({ summary: 'Delete a manual activity entry' })
  @ApiParam(ENTRY_ID_PARAM)
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 400, description: 'The id is not a UUID', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse(DERIVED)
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.entries.remove(userId, id);
  }
}
