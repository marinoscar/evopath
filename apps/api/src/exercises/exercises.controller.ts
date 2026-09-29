import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import {
  EXERCISE_TRACKING_MODES,
  MOVEMENT_PATTERNS,
  MUSCLES,
} from '../common/constants/training.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../common/dto/error.dto';
import {
  CreateExerciseDto,
  ExerciseView,
  ListExercisesQueryDto,
  UpdateExerciseDto,
} from './dto/exercise.dto';
import {
  EXERCISE_LIST_LIMIT_DEFAULT,
  EXERCISE_LIST_LIMIT_MAX,
  EXERCISE_REQUIREMENT_GROUPS_MAX,
  EXERCISE_REQUIREMENT_OPTIONS_MAX,
  MAX_CUSTOM_EXERCISES_PER_USER,
} from './exercises.constants';
import { ExercisesService } from './exercises.service';

// =============================================================================
// /api/exercises — the exercise library plus the caller's custom exercises
// =============================================================================
//
// Owner-scoped: another user's custom exercise is a 404, never a 403. Library
// exercises are readable by everyone holding `exercises:read` and read-only
// (403 `details.reason: LIBRARY_EXERCISE_READ_ONLY` on a write). Refusal
// reasons are in `details.reason`.
// =============================================================================

const EXERCISE_ID_PARAM = { name: 'id', type: String, format: 'uuid', description: 'The exercise id.' } as const;
const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;
const NO_EXERCISES_READ = { status: 403, description: 'Missing exercises:read', type: ErrorDto } as const;
const NO_EXERCISES_WRITE = {
  status: 403,
  description: 'Missing exercises:write, or `details.reason: LIBRARY_EXERCISE_READ_ONLY` (library exercises cannot be changed)',
  type: ErrorDto,
} as const;
const NOT_FOUND = {
  status: 404,
  description: 'No library exercise and no exercise of the caller has this id',
  type: ErrorDto,
} as const;
const BAD_ID = { status: 400, description: 'The id is not a UUID', type: ErrorDto } as const;

@ApiTags('Exercises')
@Controller('exercises')
export class ExercisesController {
  constructor(private readonly exercises: ExercisesService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.EXERCISES_READ] })
  @ApiOperation({
    summary: 'Search exercises',
    description:
      'The library plus the caller\'s custom exercises, by name, each with its requirement groups. ' +
      '`q` matches case-insensitively anywhere in the name or any alias. With `gymId` (one of the ' +
      'caller\'s gyms) every item carries `available` and `missing`; `availableOnly=true` keeps only ' +
      'the exercises that gym supports. AI proposals awaiting approval (`status: pending_review`) ' +
      'are listed only with `includePending=true` and never with `availableOnly`.',
  })
  @ApiQuery({ name: 'q', required: false, type: String, description: '1 to 80 characters.' })
  @ApiQuery({ name: 'muscle', required: false, enum: MUSCLES, description: 'Primary or secondary muscle.' })
  @ApiQuery({ name: 'pattern', required: false, enum: MOVEMENT_PATTERNS })
  @ApiQuery({ name: 'tracking', required: false, enum: EXERCISE_TRACKING_MODES })
  @ApiQuery({
    name: 'custom',
    required: false,
    enum: ['true', 'false'],
    description: '`true`: only the caller\'s custom exercises; `false`: only the library. Default: both.',
  })
  @ApiQuery({
    name: 'includePending',
    required: false,
    enum: ['true', 'false'],
    description: '`true` also lists the caller\'s pending AI proposals. Default `false`.',
  })
  @ApiQuery({ name: 'gymId', required: false, type: String, format: 'uuid', description: 'One of the caller\'s gyms.' })
  @ApiQuery({
    name: 'availableOnly',
    required: false,
    enum: ['true', 'false'],
    description: '`true` keeps only exercises the gym supports; requires `gymId`. Default `false`.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: `Default ${EXERCISE_LIST_LIMIT_DEFAULT}, max ${EXERCISE_LIST_LIMIT_MAX}.`,
  })
  @ApiDataResponse(ExerciseView, { isArray: true, description: 'Matching exercises' })
  @ApiResponse({ status: 400, description: 'Invalid filter, or `availableOnly` without `gymId`', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_EXERCISES_READ)
  @ApiResponse({ status: 404, description: 'No gym with `gymId` for the caller', type: ErrorDto })
  list(@CurrentUser('id') userId: string, @Query() query: ListExercisesQueryDto) {
    return this.exercises.list(userId, query);
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.EXERCISES_READ] })
  @ApiOperation({
    summary: 'Get an exercise',
    description: 'A library exercise or one of the caller\'s own (pending proposals included), with its requirement groups.',
  })
  @ApiParam(EXERCISE_ID_PARAM)
  @ApiDataResponse(ExerciseView, { description: 'The exercise' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_EXERCISES_READ)
  @ApiResponse(NOT_FOUND)
  get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.exercises.get(userId, id);
  }

  @Post()
  @Auth({ permissions: [PERMISSIONS.EXERCISES_WRITE] })
  @ApiOperation({
    summary: 'Create a custom exercise',
    description:
      'Creates an exercise only the caller sees (slug `custom-<8 chars>`), with up to ' +
      `${EXERCISE_REQUIREMENT_GROUPS_MAX} requirement groups of up to ${EXERCISE_REQUIREMENT_OPTIONS_MAX} ` +
      `options each. At most ${MAX_CUSTOM_EXERCISES_PER_USER} per user. A name like a library ` +
      'exercise\'s is allowed.',
  })
  @ApiDataResponse(ExerciseView, { status: 201, description: 'The new custom exercise' })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, or `details.reason`: `EXERCISE_LIMIT`, `UNKNOWN_EQUIPMENT_TYPE`, `UNKNOWN_CAPABILITY`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse({ status: 403, description: 'Missing exercises:write', type: ErrorDto })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateExerciseDto) {
    return this.exercises.create(userId, dto);
  }

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.EXERCISES_WRITE] })
  @ApiOperation({
    summary: 'Edit a custom exercise',
    description: 'Changes one of the caller\'s own exercises; `requirements`, when given, replaces every group.',
  })
  @ApiParam(EXERCISE_ID_PARAM)
  @ApiDataResponse(ExerciseView, { description: 'The exercise as it now stands' })
  @ApiResponse({
    status: 400,
    description: 'Validation error, or `details.reason`: `UNKNOWN_EQUIPMENT_TYPE`, `UNKNOWN_CAPABILITY`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_EXERCISES_WRITE)
  @ApiResponse(NOT_FOUND)
  update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExerciseDto,
  ) {
    return this.exercises.update(userId, id, dto);
  }

  @Post(':id/approve')
  @Auth({ permissions: [PERMISSIONS.EXERCISES_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a proposed exercise',
    description:
      'Makes one of the caller\'s AI-proposed exercises (`status: pending_review`) active, so the ' +
      'picker and `availableOnly` offer it. An already active exercise is returned unchanged. ' +
      'To reject a proposal, delete it.',
  })
  @ApiParam(EXERCISE_ID_PARAM)
  @ApiDataResponse(ExerciseView, { description: 'The exercise, now active' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_EXERCISES_WRITE)
  @ApiResponse(NOT_FOUND)
  approve(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.exercises.approve(userId, id);
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.EXERCISES_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a custom exercise',
    description: 'Deletes (or, for a pending AI proposal, rejects) one of the caller\'s own exercises; refused while a logged workout uses it.',
  })
  @ApiParam(EXERCISE_ID_PARAM)
  @ApiResponse({ status: 204, description: 'Exercise deleted' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_EXERCISES_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description: '`details.reason: EXERCISE_IN_USE` — keep it, or delete the workouts that use it first',
    type: ErrorDto,
  })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.exercises.remove(userId, id);
  }
}
