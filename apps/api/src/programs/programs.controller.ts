import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../common/dto/error.dto';
import {
  ActivateProgramDto,
  CreateProgramDto,
  ListProgramsQueryDto,
  ProgramListItemView,
  ProgramView,
  ReplaceStructureDto,
  UpdateProgramDto,
} from './dto/program.dto';
import { programEtag, requireIfMatchVersion } from './if-match';
import type { PlanTree } from './contracts/plan-tree.contract';
import { ProgramsService } from './programs.service';

// =============================================================================
// /api/programs: training plans (E5.1)
// =============================================================================
//
// Owner-scoped: another user's program is a 404, never a 403. Content writes
// (`PUT /structure`, and revert in `ProgramVersionsController`) go through
// `ProgramsService.applyChange` and require `If-Match: <currentVersion>`.
// Weights are kilograms. No AI here: manual plans work with AI switched off.
// =============================================================================

export const PROGRAM_ID_PARAM = { name: 'id', type: String, format: 'uuid', description: 'The program id.' } as const;

export const PROGRAM_RESPONSES = {
  UNAUTHENTICATED: { status: 401, description: 'Not authenticated', type: ErrorDto },
  NO_READ: { status: 403, description: 'Missing programs:read', type: ErrorDto },
  NO_WRITE: { status: 403, description: 'Missing programs:write', type: ErrorDto },
  BAD_ID: { status: 400, description: 'Validation error, or an id is not a UUID', type: ErrorDto },
  NOT_FOUND: { status: 404, description: 'The caller has no program with this id', type: ErrorDto },
} as const;

export const IF_MATCH_HEADER = {
  name: 'If-Match',
  required: true,
  description: 'The `currentVersion` the change is based on (bare `4` or the ETag `"4"`).',
} as const;

const { UNAUTHENTICATED, NO_READ, NO_WRITE, BAD_ID, NOT_FOUND } = PROGRAM_RESPONSES;

@ApiTags('Programs')
@Controller('programs')
export class ProgramsController {
  constructor(private readonly programs: ProgramsService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.PROGRAMS_READ] })
  @ApiOperation({
    summary: 'List programs',
    description:
      'The caller\'s programs, header only, newest first, with `currentVersion` and `unseenChangeCount` ' +
      '(AI changes not yet marked seen).',
  })
  @ApiDataResponse(ProgramListItemView, { isArray: true, description: 'The programs' })
  @ApiResponse({ status: 400, description: 'Invalid filter', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  list(@CurrentUser('id') userId: string, @Query() query: ListProgramsQueryDto) {
    return this.programs.list(userId, query.status);
  }

  @Post()
  @Auth({ permissions: [PERMISSIONS.PROGRAMS_WRITE] })
  @ApiOperation({
    summary: 'Create a manual program',
    description: 'Creates a draft with one block and one empty week, version 1 (`origin: initial`).',
  })
  @ApiDataResponse(ProgramView, { status: 201, description: 'The new program' })
  @ApiResponse({ status: 400, description: 'Validation error', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateProgramDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const program = await this.programs.create(userId, dto);
    reply.header('ETag', programEtag(program.currentVersion));
    return program;
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.PROGRAMS_READ] })
  @ApiOperation({
    summary: 'Get a program',
    description:
      'The full tree ordered by `position` (weeks by `weekNumber`), the plan rationale, the current ' +
      'version\'s rationale, evidence and meta, the gym and the intake. `ETag` is `"<currentVersion>"`; ' +
      'send it back as `If-Match`. A prescription whose exercise is no longer available reads ' +
      '`exercise: null` with `exerciseUnavailable: true`.',
  })
  @ApiParam(PROGRAM_ID_PARAM)
  @ApiDataResponse(ProgramView, { description: 'The program' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  @ApiResponse(NOT_FOUND)
  async get(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const program = await this.programs.get(userId, id);
    reply.header('ETag', programEtag(program.currentVersion));
    return program;
  }

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.PROGRAMS_WRITE] })
  @ApiOperation({
    summary: 'Edit program details',
    description:
      'Header only: `name`, `goal`, `notes`, `autonomy`, `gymId`. Does not create a version (a version ' +
      'is tree content).',
  })
  @ApiParam(PROGRAM_ID_PARAM)
  @ApiDataResponse(ProgramView, { description: 'The program as it now stands' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse({ status: 404, description: 'No such program, or `gymId` is not one of the caller\'s gyms', type: ErrorDto })
  update(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProgramDto) {
    return this.programs.update(userId, id, dto);
  }

  @Put(':id/structure')
  @Auth({ permissions: [PERMISSIONS.PROGRAMS_WRITE] })
  @ApiOperation({
    summary: 'Replace the plan tree',
    description:
      'The manual edit path. Rows are matched by `id`: kept, changed, added (no id or a new uuid) or ' +
      'removed. A removed workout that has logged workouts is archived rather than deleted, and so is ' +
      'its week or block if needed. Creates a new version (`origin: manual_edit`) and a change-log ' +
      'entry "Edited by you". Invariants: 1..52 weeks numbered 1..n across the plan, at most 7 workouts ' +
      'per week with distinct weekdays, at most 20 exercises per workout, distinct positions per parent, ' +
      '`1 <= repMin <= repMax <= 100`, `targetSets` 1..20, `targetRpe` 1..10 in 0.5 steps, ' +
      '`targetLoadKg` 0..1000, `restSeconds` 0..900, and every `exerciseId` known.',
  })
  @ApiParam(PROGRAM_ID_PARAM)
  @ApiHeader(IF_MATCH_HEADER)
  @ApiBody({ type: ReplaceStructureDto })
  @ApiDataResponse(ProgramView, { description: 'The program at its new version' })
  @ApiResponse({
    status: 400,
    description:
      'Validation error (`details.issues`), or `details.reason`: `IF_MATCH_REQUIRED`, `INVALID_PLAN`, ' +
      '`UNKNOWN_EXERCISES` (with `exerciseIds`), `ROW_ID_CONFLICT`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '`details.reason: TRAINING_STALE_PLAN` (with `currentVersion`): the plan changed since it was ' +
      'loaded; or `PROGRAM_ARCHIVED`',
    type: ErrorDto,
  })
  async replaceStructure(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: ReplaceStructureDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const expectedVersion = requireIfMatchVersion(ifMatch);
    const program = await this.programs.replaceStructure(userId, id, expectedVersion, dto as unknown as PlanTree);
    reply.header('ETag', programEtag(program.currentVersion));
    return program;
  }

  @Post(':id/activate')
  @Auth({ permissions: [PERMISSIONS.PROGRAMS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Activate a program',
    description:
      'Makes a draft or paused program the caller\'s active one from `startDate`. Any other active ' +
      'program is paused in the same transaction. Needs at least one workout with a weekday.',
  })
  @ApiParam(PROGRAM_ID_PARAM)
  @ApiDataResponse(ProgramView, { description: 'The active program' })
  @ApiResponse({ status: 400, description: 'Validation error, or `details.reason: START_DATE_OUT_OF_RANGE`', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '`details.reason`: `ILLEGAL_TRANSITION` (with `status`), `PLAN_NOT_SCHEDULABLE` (no workout has a ' +
      'weekday), `ACTIVE_PROGRAM_CONFLICT` (a concurrent activation won)',
    type: ErrorDto,
  })
  activate(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ActivateProgramDto) {
    return this.programs.activate(userId, id, dto.startDate);
  }

  @Post(':id/pause')
  @Auth({ permissions: [PERMISSIONS.PROGRAMS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pause a program', description: 'An active program becomes paused.' })
  @ApiParam(PROGRAM_ID_PARAM)
  @ApiDataResponse(ProgramView, { description: 'The paused program' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({ status: 409, description: '`details.reason: ILLEGAL_TRANSITION` (with `status`)', type: ErrorDto })
  pause(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.programs.pause(userId, id);
  }

  @Post(':id/archive')
  @Auth({ permissions: [PERMISSIONS.PROGRAMS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Archive a program',
    description: 'A draft, active, paused or completed program becomes archived (read-only; duplicate it to edit a copy).',
  })
  @ApiParam(PROGRAM_ID_PARAM)
  @ApiDataResponse(ProgramView, { description: 'The archived program' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({ status: 409, description: '`details.reason: ILLEGAL_TRANSITION` (with `status`)', type: ErrorDto })
  archive(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.programs.archive(userId, id);
  }

  @Post(':id/duplicate')
  @Auth({ permissions: [PERMISSIONS.PROGRAMS_WRITE] })
  @ApiOperation({
    summary: 'Duplicate a program',
    description: 'A deep copy of the current tree as a new draft with new ids, named "… (copy)", version 1 (`origin: duplicate`).',
  })
  @ApiParam(PROGRAM_ID_PARAM)
  @ApiDataResponse(ProgramView, { status: 201, description: 'The copy' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  duplicate(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.programs.duplicate(userId, id);
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.PROGRAMS_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a program',
    description: 'Deletes a program with its versions and change log, only when no logged workout links into it.',
  })
  @ApiParam(PROGRAM_ID_PARAM)
  @ApiResponse({ status: 204, description: 'Program deleted' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({ status: 409, description: '`details.reason: PROGRAM_HAS_HISTORY`: archive it instead', type: ErrorDto })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.programs.remove(userId, id);
  }
}
