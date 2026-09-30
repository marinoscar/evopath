import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../common/dto/error.dto';
import {
  ChangeLogPageView,
  ChangeLogQueryDto,
  MarkSeenDto,
  MarkSeenResultView,
  ProgramVersionSummaryView,
  ProgramVersionView,
  ProgramView,
  RevertProgramDto,
} from './dto/program.dto';
import { programEtag, requireIfMatchVersion } from './if-match';
import { IF_MATCH_HEADER, PROGRAM_ID_PARAM, PROGRAM_RESPONSES } from './programs.controller';
import { ProgramsService } from './programs.service';

// =============================================================================
// /api/programs/:id/{versions,revert,change-log}: history of a plan (E5.1)
// =============================================================================
//
// Versions are immutable snapshots; the change log says who changed what and
// why. Revert restores an older tree as a NEW version (history is append-only).
// Owner-scoped: another user's program is a 404.
// =============================================================================

const { UNAUTHENTICATED, NO_READ, NO_WRITE, BAD_ID, NOT_FOUND } = PROGRAM_RESPONSES;

@ApiTags('Programs')
@Controller('programs')
export class ProgramVersionsController {
  constructor(private readonly programs: ProgramsService) {}

  @Get(':id/versions')
  @Auth({ permissions: [PERMISSIONS.PROGRAMS_READ] })
  @ApiOperation({
    summary: 'List versions',
    description: 'Every version of the program, newest first, with its origin and the change-log summary that produced it.',
  })
  @ApiParam(PROGRAM_ID_PARAM)
  @ApiDataResponse(ProgramVersionSummaryView, { isArray: true, description: 'The versions' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  @ApiResponse(NOT_FOUND)
  listVersions(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.programs.listVersions(userId, id);
  }

  @Get(':id/versions/:n')
  @Auth({ permissions: [PERMISSIONS.PROGRAMS_READ] })
  @ApiOperation({ summary: 'Get a version', description: 'One version with its full snapshot (row ids preserved).' })
  @ApiParam(PROGRAM_ID_PARAM)
  @ApiParam({ name: 'n', type: Number, description: 'The version number.' })
  @ApiDataResponse(ProgramVersionView, { description: 'The version' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  @ApiResponse({ status: 404, description: 'No such program for the caller, or no such version', type: ErrorDto })
  getVersion(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('n', ParseIntPipe) n: number,
  ) {
    return this.programs.getVersion(userId, id, n);
  }

  @Post(':id/revert')
  @Auth({ permissions: [PERMISSIONS.PROGRAMS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revert a program',
    description:
      '`{ toVersion }` restores that version\'s tree as a new version (`origin: revert`). ' +
      '`{ changeLogId }` undoes that change, which must be the latest applied one; the entry becomes ' +
      '`reverted`. Rows kept for history are restored with their ids.',
  })
  @ApiParam(PROGRAM_ID_PARAM)
  @ApiHeader(IF_MATCH_HEADER)
  @ApiDataResponse(ProgramView, { description: 'The program at its new version' })
  @ApiResponse({ status: 400, description: 'Validation error, or `details.reason: IF_MATCH_REQUIRED`', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse({ status: 404, description: 'No such program, version or change-log entry for the caller', type: ErrorDto })
  @ApiResponse({
    status: 409,
    description:
      '`details.reason`: `TRAINING_STALE_PLAN` (with `currentVersion`), `NOT_LATEST` (with `latestLogId`; ' +
      'restore a version instead), `NOT_REVERTIBLE` (the entry created the plan), `SNAPSHOT_UNSUPPORTED`, ' +
      '`PROGRAM_ARCHIVED`',
    type: ErrorDto,
  })
  async revert(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: RevertProgramDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const expectedVersion = requireIfMatchVersion(ifMatch);
    const program = await this.programs.revertAndRead(userId, id, expectedVersion, dto);
    reply.header('ETag', programEtag(program.currentVersion));
    return program;
  }

  @Get(':id/change-log')
  @Auth({ permissions: [PERMISSIONS.PROGRAMS_READ] })
  @ApiOperation({
    summary: 'List the change log',
    description: 'Changes to the plan, newest first, keyset-paginated: pass `nextCursor` back as `cursor`.',
  })
  @ApiParam(PROGRAM_ID_PARAM)
  @ApiDataResponse(ChangeLogPageView, { description: 'A page of change-log entries' })
  @ApiResponse({ status: 400, description: 'Invalid filter or cursor', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  @ApiResponse(NOT_FOUND)
  listChangeLog(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ChangeLogQueryDto,
  ) {
    return this.programs.listChangeLog(userId, id, query);
  }

  @Post(':id/change-log/seen')
  @Auth({ permissions: [PERMISSIONS.PROGRAMS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark changes as seen',
    description: 'Marks `upToId` and every older entry as seen (clears the "Plan adjusted" banner).',
  })
  @ApiParam(PROGRAM_ID_PARAM)
  @ApiDataResponse(MarkSeenResultView, { description: 'How many entries were marked' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse({ status: 404, description: 'No such program or entry for the caller', type: ErrorDto })
  markSeen(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MarkSeenDto) {
    return this.programs.markSeen(userId, id, dto.upToId);
  }
}
