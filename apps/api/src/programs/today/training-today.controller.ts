import { Body, Controller, Get, HttpStatus, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
import {
  StartProgramWorkoutDto,
  StartProgramWorkoutResultView,
  TRAINING_TODAY_VIEWS,
  TrainingTodayQueryDto,
} from './dto/training-today.dto';
import { TrainingTodayService } from './training-today.service';

// =============================================================================
// /api/training/today and /api/program-workouts/:id/start (E5.7)
// =============================================================================
//
// Today's planned workout, and starting it into the E4 logger. Works with AI
// off and for manual plans. The client sends its local day; the server never
// guesses it. Owner-scoped: another user's ids are a 404.
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

@ApiTags('Programs')
@Controller('program-workouts')
export class ProgramWorkoutsController {
  constructor(private readonly today: TrainingTodayService) {}

  @Post(':id/start')
  @Auth({ permissions: [PERMISSIONS.PROGRAMS_READ, PERMISSIONS.WORKOUTS_WRITE] })
  @ApiOperation({
    summary: 'Start a planned workout',
    description:
      'Starts the planned workout of the caller\'s ACTIVE program into the workout logger (201): one ' +
      'workout with `programWorkoutId` set, an exercise per planned exercise and `sets` uncompleted sets ' +
      'prefilled with `reps = repMin` and the suggested load (`fixed`: the target load, `from_history`: the ' +
      'last top set, `choose_start`: none). A `program_sessions` row records the plan version and a snapshot ' +
      'of the prescription, in the same transaction. When the caller\'s in-progress workout is already this ' +
      'planned workout it is returned with status 200 and `existing: true`. `gymId` defaults to the plan\'s gym.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'The planned (program) workout id.' })
  @ApiBody({ type: StartProgramWorkoutDto })
  @ApiDataResponse(StartProgramWorkoutResultView, { status: 201, description: 'The new workout (`existing: false`)' })
  @ApiDataResponse(StartProgramWorkoutResultView, {
    status: 200,
    description: 'The workout already in progress for this planned workout (`existing: true`)',
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error, or `details.reason`: `TODAY_OUT_OF_RANGE`',
    type: ErrorDto,
  })
  @ApiResponse({ status: 401, description: 'Not authenticated', type: ErrorDto })
  @ApiResponse({ status: 403, description: 'Missing programs:read or workouts:write', type: ErrorDto })
  @ApiResponse({
    status: 404,
    description: 'The caller has no such planned workout, or `gymId` is not one of the caller\'s gyms',
    type: ErrorDto,
  })
  @ApiResponse({
    status: 409,
    description:
      '`details.reason`: `PROGRAM_NOT_ACTIVE` (paused, archived or completed; with `status`), ' +
      '`WORKOUT_IN_PROGRESS` (another workout is in progress; `details.workoutId` to resume) or ' +
      '`PROGRAM_WORKOUT_EMPTY`',
    type: ErrorDto,
  })
  async start(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartProgramWorkoutDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.today.start(userId, id, dto);
    reply.status(result.existing ? HttpStatus.OK : HttpStatus.CREATED);
    return result;
  }
}
