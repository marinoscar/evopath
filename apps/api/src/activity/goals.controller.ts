import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../common/dto/error.dto';
import { GOAL_LOOKBACK_DAYS, MAX_ACTIVE_GOALS, type GoalTransition } from './activity.constants';
import {
  CreateGoalDto,
  GoalHistoryPeriodView,
  GoalHistoryQueryDto,
  GoalProgressQueryDto,
  GoalProgressView,
  GoalTemplateView,
  GoalView,
  ListGoalsQueryDto,
  UpdateGoalDto,
} from './dto/goal.dto';
import { GoalProgressService, toProgressView } from './goal-progress.service';
import { goalEtag, GoalsService, requireGoalIfMatch } from './goals.service';

// =============================================================================
// /api/goals — activity goals and their progress (#266, #268)
// =============================================================================
//
// Owner-scoped: another user's goal is a 404, never a 403. `goals:read` for
// GET, `goals:write` otherwise. Static routes (`templates`, `progress`) are
// declared before `:id`, which is a UUID. Refusal reasons are in
// `details.reason`.
// =============================================================================

const GOAL_ID_PARAM = { name: 'id', type: String, format: 'uuid', description: 'The goal id.' } as const;

const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;
const NO_READ = { status: 403, description: 'Missing goals:read', type: ErrorDto } as const;
const NO_WRITE = { status: 403, description: 'Missing goals:write', type: ErrorDto } as const;
const NOT_FOUND = { status: 404, description: 'The caller has no goal with this id', type: ErrorDto } as const;
const BAD_ID = { status: 400, description: 'Validation error, or the id is not a UUID', type: ErrorDto } as const;

@ApiTags('Goals')
@Controller('goals')
export class GoalsController {
  constructor(
    private readonly goals: GoalsService,
    private readonly progress: GoalProgressService,
  ) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.GOALS_READ] })
  @ApiOperation({ summary: 'List goals', description: 'The caller\'s goals with one status (default `active`), oldest first.' })
  @ApiDataResponse(GoalView, { isArray: true })
  @ApiResponse({ status: 400, description: 'Invalid status', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  list(@CurrentUser('id') userId: string, @Query() query: ListGoalsQueryDto) {
    return this.goals.list(userId, query.status);
  }

  @Get('templates')
  @Auth({ permissions: [PERMISSIONS.GOALS_READ] })
  @ApiOperation({ summary: 'Goal templates', description: 'Ready-made goals to create from (fixed list).' })
  @ApiDataResponse(GoalTemplateView, { isArray: true })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  templates() {
    return this.goals.templates();
  }

  @Get('progress')
  @Auth({ permissions: [PERMISSIONS.GOALS_READ] })
  @ApiOperation({
    summary: 'Progress of active goals',
    description:
      'Each ACTIVE goal\'s progress in the period (Monday..Sunday week, or the day) holding `date` ' +
      '(default today in the Health Profile time zone). Per local day the highest source present counts ' +
      '(integration > workout > manual); the others are returned with `superseded: true`. `daysLeft` ' +
      'includes `date`. `streakPeriods` counts hit periods right before this one (at most ' +
      `${GOAL_LOOKBACK_DAYS} days back).`,
  })
  @ApiDataResponse(GoalProgressView, { isArray: true })
  @ApiResponse({ status: 400, description: 'Validation error, or `details.reason`: `DATE_OUT_OF_RANGE`', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  async progressList(@CurrentUser('id') userId: string, @Query() query: GoalProgressQueryDto) {
    return (await this.progress.progressForUser(userId, query.date)).map(toProgressView);
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.GOALS_READ] })
  @ApiOperation({ summary: 'Get a goal', description: 'The goal, with its `version` also as the `ETag` header.' })
  @ApiParam(GOAL_ID_PARAM)
  @ApiDataResponse(GoalView)
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  @ApiResponse(NOT_FOUND)
  async get(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const goal = await this.goals.get(userId, id);
    reply.header('ETag', goalEtag(goal.version));
    return goal;
  }

  @Get(':id/history')
  @Auth({ permissions: [PERMISSIONS.GOALS_READ] })
  @ApiOperation({
    summary: 'Goal history',
    description:
      'Up to `limit` periods (default 12), newest first, starting with the one holding `date` (default ' +
      'today, local) and going back no further than the period holding `startsOn`.',
  })
  @ApiParam(GOAL_ID_PARAM)
  @ApiDataResponse(GoalHistoryPeriodView, { isArray: true })
  @ApiResponse({ status: 400, description: 'Validation error, or `details.reason`: `DATE_OUT_OF_RANGE`', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  @ApiResponse(NOT_FOUND)
  history(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Query() query: GoalHistoryQueryDto) {
    return this.progress.historyForGoal(userId, id, query.limit, query.date);
  }

  @Post()
  @Auth({ permissions: [PERMISSIONS.GOALS_WRITE] })
  @ApiOperation({
    summary: 'Create a goal',
    description:
      'A `sessions` goal needs `period: week`; a `custom` goal needs `customLabel` (ignored on other kinds); ' +
      '`steps` is a metric, never a kind. `startsOn` defaults to today (local). At most ' +
      `${MAX_ACTIVE_GOALS} active goals.`,
  })
  @ApiDataResponse(GoalView, { status: 201 })
  @ApiResponse({
    status: 400,
    description: 'Validation error, or `details.reason`: `INVALID_GOAL`, `START_DATE_OUT_OF_RANGE`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse({ status: 409, description: '`details.reason`: `GOAL_LIMIT_REACHED`', type: ErrorDto })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateGoalDto) {
    return this.goals.create(userId, dto);
  }

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.GOALS_WRITE] })
  @ApiOperation({
    summary: 'Edit a goal',
    description:
      'Partial update, judged on the merged goal. Requires `If-Match` with the goal `version` ' +
      '(bare `4` or the ETag `"4"`). Bumps `version`.',
  })
  @ApiParam(GOAL_ID_PARAM)
  @ApiHeader({ name: 'If-Match', required: true, description: 'The goal version you loaded.' })
  @ApiDataResponse(GoalView)
  @ApiResponse({
    status: 400,
    description: 'Validation error, or `details.reason`: `INVALID_GOAL`, `START_DATE_OUT_OF_RANGE`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({ status: 409, description: '`details.reason`: `GOAL_ARCHIVED`', type: ErrorDto })
  @ApiResponse({
    status: 412,
    description: 'Stale `If-Match`: `details.reason` `GOAL_VERSION_MISMATCH`, `details.currentVersion`',
    type: ErrorDto,
  })
  @ApiResponse({ status: 428, description: 'Missing `If-Match`: `details.reason` `IF_MATCH_REQUIRED`', type: ErrorDto })
  async update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: UpdateGoalDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const goal = await this.goals.update(userId, id, requireGoalIfMatch(ifMatch), dto);
    reply.header('ETag', goalEtag(goal.version));
    return goal;
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @Auth({ permissions: [PERMISSIONS.GOALS_WRITE] })
  @ApiOperation({ summary: 'Pause a goal', description: 'active -> paused (a paused goal is a no-op).' })
  @ApiParam(GOAL_ID_PARAM)
  @ApiDataResponse(GoalView)
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({ status: 409, description: '`details.reason`: `GOAL_ILLEGAL_TRANSITION`', type: ErrorDto })
  pause(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.transition(userId, id, 'pause');
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @Auth({ permissions: [PERMISSIONS.GOALS_WRITE] })
  @ApiOperation({
    summary: 'Resume a goal',
    description: `paused -> active (an active goal is a no-op), within the ${MAX_ACTIVE_GOALS}-active cap.`,
  })
  @ApiParam(GOAL_ID_PARAM)
  @ApiDataResponse(GoalView)
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description: '`details.reason`: `GOAL_ILLEGAL_TRANSITION` (archived), `GOAL_LIMIT_REACHED`',
    type: ErrorDto,
  })
  resume(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.transition(userId, id, 'resume');
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @Auth({ permissions: [PERMISSIONS.GOALS_WRITE] })
  @ApiOperation({ summary: 'Archive a goal', description: 'active | paused -> archived. Final.' })
  @ApiParam(GOAL_ID_PARAM)
  @ApiDataResponse(GoalView)
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  archive(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.transition(userId, id, 'archive');
  }

  private transition(userId: string, id: string, action: GoalTransition) {
    return this.goals.transition(userId, id, action);
  }
}
