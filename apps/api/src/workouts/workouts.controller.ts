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
  Res,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../common/dto/error.dto';
import { BodyOrEmpty } from './body-or-empty.decorator';
import {
  AddWorkoutExerciseDto,
  CreateSetDto,
  FinishWorkoutDto,
  ListWorkoutsQueryDto,
  SetLogView,
  StartWorkoutDto,
  StartWorkoutResultView,
  UpdateSetDto,
  UpdateWorkoutDto,
  UpdateWorkoutExerciseDto,
  WorkoutExerciseView,
  WorkoutListItemView,
  WorkoutView,
} from './dto/workout.dto';
import { QuickCardioDto, QuickCardioResultView } from './dto/quick-cardio.dto';
import { WorkoutSummaryQueryDto, WorkoutSummaryView } from './dto/workout-summary.dto';
import { QuickCardioService } from './quick-cardio.service';
import { WorkoutEntriesService } from './workout-entries.service';
import {
  MAX_EXERCISES_PER_WORKOUT,
  MAX_SETS_PER_EXERCISE,
  WORKOUT_LIST_PAGE_SIZE_DEFAULT,
  WORKOUT_LIST_PAGE_SIZE_MAX,
} from './workouts.constants';
import { WorkoutsService } from './workouts.service';

// =============================================================================
// /api/workouts — logged workouts, their exercises and sets (E4.2)
// =============================================================================
//
// Owner-scoped: another user's workout, workout exercise or set is a 404,
// never a 403. Weights are kilograms (`weightKg`) and distances metres
// (`distanceMeters`) in and out; the web converts for display from the Health
// Profile `unitSystem`. Refusal reasons are in `details.reason`.
// =============================================================================

const WORKOUT_ID_PARAM = { name: 'id', type: String, format: 'uuid', description: 'The workout id.' } as const;
const WORKOUT_EXERCISE_ID_PARAM = {
  name: 'weId',
  type: String,
  format: 'uuid',
  description: 'The workout-exercise id (an entry of this workout, not the exercise id).',
} as const;
const SET_ID_PARAM = { name: 'setId', type: String, format: 'uuid', description: 'The set id.' } as const;

const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;
const NO_READ = { status: 403, description: 'Missing workouts:read', type: ErrorDto } as const;
const NO_WRITE = { status: 403, description: 'Missing workouts:write', type: ErrorDto } as const;
const BAD_ID = { status: 400, description: 'Validation error, or an id is not a UUID', type: ErrorDto } as const;
const WORKOUT_NOT_FOUND = { status: 404, description: 'The caller has no workout with this id', type: ErrorDto } as const;
const ENTRY_NOT_FOUND = {
  status: 404,
  description: 'The caller has no such workout, or it has no such exercise entry',
  type: ErrorDto,
} as const;
const SET_NOT_FOUND = {
  status: 404,
  description: 'The caller has no such workout, or it has no such set',
  type: ErrorDto,
} as const;

@ApiTags('Workouts')
@Controller('workouts')
export class WorkoutsController {
  constructor(
    private readonly workouts: WorkoutsService,
    private readonly entries: WorkoutEntriesService,
    private readonly quickCardio: QuickCardioService,
  ) {}

  // ---------------------------------------------------------------------------
  // Workouts
  // ---------------------------------------------------------------------------

  @Post()
  @Auth({ permissions: [PERMISSIONS.WORKOUTS_WRITE] })
  @ApiOperation({
    summary: 'Start a workout',
    description:
      'Starts an ad-hoc workout (201). When the caller already has a workout in progress, nothing is ' +
      'created and that workout is returned with status 200 and `existing: true`. `date` defaults to ' +
      'today in the Health Profile time zone (UTC when unset); an omitted `gymId` defaults to the caller\'s ' +
      'default gym, while an explicit `gymId: null` starts a session with no gym. ' +
      '`readinessSnapshot` copies today\'s readiness check-in, when there is one.',
  })
  @ApiBody({ type: StartWorkoutDto, required: false })
  @ApiDataResponse(StartWorkoutResultView, { status: 201, description: 'The new workout (`existing: false`)' })
  @ApiDataResponse(StartWorkoutResultView, {
    status: 200,
    description: 'The workout already in progress (`existing: true`)',
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error, or `details.reason`: `WORKOUT_DATE_OUT_OF_RANGE`, `TIME_IN_FUTURE`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse({ status: 404, description: 'No gym with `gymId` for the caller', type: ErrorDto })
  async start(
    @CurrentUser('id') userId: string,
    @BodyOrEmpty() dto: StartWorkoutDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.workouts.start(userId, dto);
    reply.status(result.existing ? HttpStatus.OK : HttpStatus.CREATED);
    return result;
  }

  // Declared before the `:id` routes so `quick-cardio` is never parsed as a workout id.
  @Post('quick-cardio')
  @HttpCode(HttpStatus.CREATED)
  @Auth({ permissions: [PERMISSIONS.WORKOUTS_WRITE] })
  @ApiOperation({
    summary: 'Log a walk, run or hike',
    description:
      'Logs a gym-free outdoor walk, run or hike in one call: a COMPLETED workout with no gym, one exercise ' +
      'and one completed set carrying `durationSeconds` and/or `distanceMeters` (at least one is required). ' +
      '`performedAt` (default now) is when it ended: `startedAt` is `performedAt` minus the duration, and ' +
      '`date` is the local day of `performedAt` in the Health Profile time zone. It never conflicts with a ' +
      'workout in progress. When the active plan has a planned workout on that local day that holds the ' +
      'exercise, the workout is linked to it (`linkedProgramWorkoutId`, and the workout\'s ' +
      '`programWorkoutId`); otherwise it is an extra session. Emits `workout.finished` like a finish.',
  })
  @ApiBody({ type: QuickCardioDto })
  @ApiDataResponse(QuickCardioResultView, { status: 201, description: 'The completed workout and its plan link' })
  @ApiResponse({
    status: 400,
    description:
      'Validation error (unknown `exerciseKey`, neither `durationSeconds` nor `distanceMeters`, a value out of ' +
      'range), or `details.reason`: `TIME_IN_FUTURE`, `PERFORMED_AT_OUT_OF_RANGE` (more than 7 days ago)',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse({ status: 404, description: 'The exercise is not in the library (database not seeded)', type: ErrorDto })
  logQuickCardio(@CurrentUser('id') userId: string, @Body() dto: QuickCardioDto) {
    return this.quickCardio.log(userId, dto);
  }

  @Get()
  @Auth({ permissions: [PERMISSIONS.WORKOUTS_READ] })
  @ApiOperation({
    summary: 'List workouts',
    description:
      `The caller's workouts, newest \`date\` first, ${WORKOUT_LIST_PAGE_SIZE_DEFAULT} per page by default ` +
      `(at most ${WORKOUT_LIST_PAGE_SIZE_MAX}). \`setCount\` and \`volumeKg\` count completed working ` +
      '(non-warm-up) sets only.',
  })
  @ApiDataResponse(WorkoutListItemView, { pagination: 'flat', description: 'A page of workouts' })
  @ApiResponse({ status: 400, description: 'Invalid filter', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  list(@CurrentUser('id') userId: string, @Query() query: ListWorkoutsQueryDto) {
    return this.workouts.list(userId, query);
  }

  // Declared before `:id` so `summary` is never parsed as a workout id.
  @Get('summary')
  @Auth({ permissions: [PERMISSIONS.WORKOUTS_READ] })
  @ApiOperation({
    summary: 'Training summary for the Today page',
    description:
      'The caller\'s workout in progress (or null), the last completed workout with its totals and up to ' +
      'three top lifts (or null), the number of completed workouts in the ISO week (Monday to Sunday) ' +
      'containing `today`, and the days since the last workout. `today` is the client\'s local day; it must ' +
      'be within 2 days of the server\'s today (the Health Profile time zone, UTC when unset), which is ' +
      'also the default. Totals count completed working (non-warm-up) sets only. No PR data.',
  })
  @ApiDataResponse(WorkoutSummaryView, { description: 'The summary' })
  @ApiResponse({
    status: 400,
    description: 'Validation error, or `details.reason: TODAY_OUT_OF_RANGE`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  summary(@CurrentUser('id') userId: string, @Query() query: WorkoutSummaryQueryDto) {
    return this.workouts.summary(userId, query);
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.WORKOUTS_READ] })
  @ApiOperation({
    summary: 'Get a workout',
    description:
      'The workout with its exercises in `position` order and each exercise\'s sets in `setNumber` order. ' +
      'Each completed working set carries its `prs`; `summary.prs` lists the best set per PR type per exercise.',
  })
  @ApiParam(WORKOUT_ID_PARAM)
  @ApiDataResponse(WorkoutView, { description: 'The workout' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  @ApiResponse(WORKOUT_NOT_FOUND)
  get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.workouts.get(userId, id);
  }

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.WORKOUTS_WRITE] })
  @ApiOperation({
    summary: 'Edit a workout',
    description:
      'Edits name, notes, gym, date and times, in progress or completed. `endedAt` and `durationSeconds` ' +
      'apply to a completed workout only; when `startedAt` or `endedAt` changes without `durationSeconds`, ' +
      'the duration is recomputed.',
  })
  @ApiParam(WORKOUT_ID_PARAM)
  @ApiDataResponse(WorkoutView, { description: 'The workout as it now stands' })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, or `details.reason`: `WORKOUT_DATE_OUT_OF_RANGE`, `TIME_IN_FUTURE`, ' +
      '`ENDED_BEFORE_STARTED`, `WORKOUT_NOT_COMPLETED`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse({ status: 404, description: 'No such workout, or no gym with `gymId`, for the caller', type: ErrorDto })
  update(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWorkoutDto) {
    return this.workouts.update(userId, id, dto);
  }

  @Post(':id/finish')
  @Auth({ permissions: [PERMISSIONS.WORKOUTS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Finish a workout',
    description:
      'Marks the workout completed, sets `endedAt` (default now) and `durationSeconds`. Uncompleted sets ' +
      'without any value are deleted; uncompleted sets with values stay uncompleted. Finishing a ' +
      'completed workout returns it unchanged. `summary` carries the totals and `summary.prs`, the best ' +
      'set per PR type (weight, reps, e1rm, first_time) per exercise.',
  })
  @ApiParam(WORKOUT_ID_PARAM)
  @ApiBody({ type: FinishWorkoutDto, required: false })
  @ApiDataResponse(WorkoutView, { description: 'The completed workout with its `summary`' })
  @ApiResponse({
    status: 400,
    description: 'Validation error, or `details.reason`: `TIME_IN_FUTURE`, `ENDED_BEFORE_STARTED`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(WORKOUT_NOT_FOUND)
  finish(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @BodyOrEmpty() dto: FinishWorkoutDto) {
    return this.workouts.finish(userId, id, dto);
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.WORKOUTS_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a workout', description: 'Deletes the workout with its exercises and sets.' })
  @ApiParam(WORKOUT_ID_PARAM)
  @ApiResponse({ status: 204, description: 'Workout deleted' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(WORKOUT_NOT_FOUND)
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.workouts.remove(userId, id);
  }

  // ---------------------------------------------------------------------------
  // Exercises of a workout
  // ---------------------------------------------------------------------------

  @Post(':id/exercises')
  @Auth({ permissions: [PERMISSIONS.WORKOUTS_WRITE] })
  @ApiOperation({
    summary: 'Add an exercise to a workout',
    description:
      'Adds a library exercise or one of the caller\'s active custom exercises; appended unless ' +
      `\`position\` is given (inserts and shifts). At most ${MAX_EXERCISES_PER_WORKOUT} per workout. ` +
      'An AI-proposed exercise awaiting approval is refused.',
  })
  @ApiParam(WORKOUT_ID_PARAM)
  @ApiDataResponse(WorkoutExerciseView, { status: 201, description: 'The new workout exercise' })
  @ApiResponse({
    status: 400,
    description: 'Validation error, or `details.reason: WORKOUT_EXERCISE_LIMIT`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse({
    status: 404,
    description: 'No such workout, exercise or equipment type visible to the caller',
    type: ErrorDto,
  })
  @ApiResponse({
    status: 409,
    description: '`details.reason: EXERCISE_PENDING_REVIEW` — approve the proposed exercise first',
    type: ErrorDto,
  })
  addExercise(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddWorkoutExerciseDto,
  ) {
    return this.entries.addExercise(userId, id, dto);
  }

  @Patch(':id/exercises/:weId')
  @Auth({ permissions: [PERMISSIONS.WORKOUTS_WRITE] })
  @ApiOperation({
    summary: 'Edit or move a workout exercise',
    description:
      '`position` moves the entry and renumbers every position densely (0..n-1); `notes` and ' +
      '`equipmentTypeId` edit it. Returns the entry; reload the workout to see the new order.',
  })
  @ApiParam(WORKOUT_ID_PARAM)
  @ApiParam(WORKOUT_EXERCISE_ID_PARAM)
  @ApiDataResponse(WorkoutExerciseView, { description: 'The workout exercise as it now stands' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse({ status: 404, description: 'No such workout, entry or equipment type for the caller', type: ErrorDto })
  updateExercise(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('weId', ParseUUIDPipe) weId: string,
    @Body() dto: UpdateWorkoutExerciseDto,
  ) {
    return this.entries.updateExercise(userId, id, weId, dto);
  }

  @Delete(':id/exercises/:weId')
  @Auth({ permissions: [PERMISSIONS.WORKOUTS_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove an exercise from a workout',
    description: 'Removes the entry and its sets; the remaining positions are renumbered.',
  })
  @ApiParam(WORKOUT_ID_PARAM)
  @ApiParam(WORKOUT_EXERCISE_ID_PARAM)
  @ApiResponse({ status: 204, description: 'Removed' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(ENTRY_NOT_FOUND)
  async removeExercise(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('weId', ParseUUIDPipe) weId: string,
  ): Promise<void> {
    await this.entries.removeExercise(userId, id, weId);
  }

  // ---------------------------------------------------------------------------
  // Sets
  // ---------------------------------------------------------------------------

  @Post(':id/exercises/:weId/sets')
  @Auth({ permissions: [PERMISSIONS.WORKOUTS_WRITE] })
  @ApiOperation({
    summary: 'Add a set',
    description:
      'Appends a set (`setNumber` = last + 1). Every field is optional: an omitted `weightKg`, `reps`, ' +
      '`durationSeconds` or `distanceMeters` is copied from the previous set of this exercise. ' +
      `At most ${MAX_SETS_PER_EXERCISE} sets per exercise. A completed set carries the \`prs\` it earns.`,
  })
  @ApiParam(WORKOUT_ID_PARAM)
  @ApiParam(WORKOUT_EXERCISE_ID_PARAM)
  @ApiBody({ type: CreateSetDto, required: false })
  @ApiDataResponse(SetLogView, { status: 201, description: 'The new set' })
  @ApiResponse({ status: 400, description: 'Validation error, or `details.reason: WORKOUT_SET_LIMIT`', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(ENTRY_NOT_FOUND)
  addSet(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('weId', ParseUUIDPipe) weId: string,
    @BodyOrEmpty() dto: CreateSetDto,
  ) {
    return this.entries.addSet(userId, id, weId, dto);
  }

  @Patch(':id/sets/:setId')
  @Auth({ permissions: [PERMISSIONS.WORKOUTS_WRITE] })
  @ApiOperation({
    summary: 'Edit a set',
    description:
      '`completed: true` stamps `completedAt` and, when the set has no `restSeconds`, derives it from the ' +
      'workout\'s previous completion if that was under 15 minutes ago. `completed: false` clears ' +
      '`completedAt`. Null clears a value. A completed set carries the `prs` it earns against earlier ' +
      'workouts and the earlier sets of this one.',
  })
  @ApiParam(WORKOUT_ID_PARAM)
  @ApiParam(SET_ID_PARAM)
  @ApiDataResponse(SetLogView, { description: 'The set as it now stands' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(SET_NOT_FOUND)
  updateSet(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('setId', ParseUUIDPipe) setId: string,
    @Body() dto: UpdateSetDto,
  ) {
    return this.entries.updateSet(userId, id, setId, dto);
  }

  @Delete(':id/sets/:setId')
  @Auth({ permissions: [PERMISSIONS.WORKOUTS_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a set',
    description: 'Deletes the set; the exercise\'s remaining sets are renumbered 1..n.',
  })
  @ApiParam(WORKOUT_ID_PARAM)
  @ApiParam(SET_ID_PARAM)
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(SET_NOT_FOUND)
  async removeSet(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('setId', ParseUUIDPipe) setId: string,
  ): Promise<void> {
    await this.entries.removeSet(userId, id, setId);
  }
}
