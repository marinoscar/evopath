import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AiEnabledGuard } from '../ai/config/ai-enabled.guard';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../common/dto/error.dto';
import {
  CreateMemoryDto,
  ListMemoriesQueryDto,
  MemoryListView,
  MemoryView,
  UpdateMemoryDto,
} from './dto/memory.dto';
import { MEMORY_CONTENT_MAX } from './memory.constants';
import { MemoryService, toMemoryView } from './memory.service';

// =============================================================================
// /api/memories — the caller's memories (#325; docs/specs/ai-memory.md §3)
// =============================================================================
//
//   GET    /api/memories               list (+ settings, policy, counts)
//   POST   /api/memories               add one (`user_edited`)
//   PATCH  /api/memories/:id           edit content, category, pin, sensitivity
//   DELETE /api/memories/:id           soft delete (undo with restore)
//   POST   /api/memories/:id/restore   undo a delete inside the purge window
//   DELETE /api/memories               soft-delete every active memory
//
// Every route: `@Auth({ permissions: [ai:use] })` and `AiEnabledGuard` (403
// `AI_DISABLED` while AI is off), like every AI consumer route. Owner-scoped
// by construction: the user id is `@CurrentUser('id')`; another user's id is
// a 404 `MEMORY_NOT_FOUND`. NOT gated on the memory switches: with memory off
// a user can still see, edit and delete what is stored about them.
// Settings are written through `PATCH /api/user-settings` (`memory`).
// =============================================================================

const ID_PARAM = { name: 'id', type: String, format: 'uuid', description: 'The memory id.' } as const;
const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;
const FORBIDDEN = { status: 403, description: '`AI_DISABLED`, or missing `ai:use`', type: ErrorDto } as const;
const NOT_FOUND = {
  status: 404,
  description: '`details.reason: MEMORY_NOT_FOUND`: you have no such memory',
  type: ErrorDto,
} as const;
const REJECTED = {
  status: 400,
  description:
    'Validation error; `details.reason: MEMORY_CONTENT_REJECTED` with `details.rule` (`length`, `shape`, ' +
    '`instruction`, `url`, `email`, `code`, `credential`, `financial`, `contact`, `third_party`); or ' +
    '`MEMORY_HEALTH_NOT_ALLOWED` (a health-related memory while `memory.allowHealth` is off)',
  type: ErrorDto,
} as const;

@ApiTags('AI Memory')
@Controller('memories')
@UseGuards(AiEnabledGuard)
export class MemoryController {
  constructor(private readonly memories: MemoryService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'List my memories',
    description:
      'The facts the coach and the plan agents may use about you: pinned first, then newest first. Includes your ' +
      'effective `memory` settings, the deployment policy (`maxPerUser`) and counts per category. ' +
      '`status=deleted` lists soft-deleted memories you can still restore.',
  })
  @ApiDataResponse(MemoryListView, { description: 'Your memories' })
  @ApiResponse({ status: 400, description: 'Invalid category or status', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  list(@CurrentUser('id') userId: string, @Query() query: ListMemoriesQueryDto) {
    return this.memories.list(userId, query);
  }

  @Post()
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'Add a memory',
    description:
      `Adds one fact (at most ${MEMORY_CONTENT_MAX} characters) as \`user_edited\`. A text equal to an existing ` +
      'memory (ignoring case and punctuation) returns that memory; a near-identical one in the same category ' +
      'updates it instead of adding a second.',
  })
  @ApiDataResponse(MemoryView, { status: 201, description: 'The memory' })
  @ApiResponse(REJECTED)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  @ApiResponse({
    status: 409,
    description: '`details.reason: MEMORY_LIMIT_REACHED`: you have `maxPerUser` active memories',
    type: ErrorDto,
  })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateMemoryDto) {
    return this.memories.create(userId, dto);
  }

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'Edit a memory',
    description:
      'Changes the content, category, pin or sensitivity of one of your active memories. A content edit marks ' +
      'it `user_edited`: the coach\'s background learning never changes it afterwards.',
  })
  @ApiParam(ID_PARAM)
  @ApiDataResponse(MemoryView, { description: 'The memory' })
  @ApiResponse(REJECTED)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  @ApiResponse(NOT_FOUND)
  async update(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMemoryDto) {
    return toMemoryView(await this.memories.update(userId, id, dto, 'user'));
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a memory',
    description:
      'Soft-deletes one memory: it is no longer used at once, can be restored with ' +
      '`POST /api/memories/{id}/restore` for `memory.purgeAfterDays` days, and is then erased.',
  })
  @ApiParam(ID_PARAM)
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 400, description: 'The id is not a UUID', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  @ApiResponse(NOT_FOUND)
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.memories.softDelete(userId, id);
  }

  @Post(':id/restore')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restore a deleted memory',
    description: 'Undoes a delete while the memory is inside the purge window. Restoring an active memory returns it.',
  })
  @ApiParam(ID_PARAM)
  @ApiDataResponse(MemoryView, { description: 'The restored memory' })
  @ApiResponse({ status: 400, description: 'The id is not a UUID', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '`details.reason: MEMORY_NOT_RESTORABLE` (replaced, or past the purge window), or `MEMORY_LIMIT_REACHED`',
    type: ErrorDto,
  })
  async restore(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return toMemoryView(await this.memories.restore(userId, id));
  }

  @Delete()
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete all my memories',
    description: 'Soft-deletes every active memory (restorable one by one inside the purge window).',
  })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  async removeAll(@CurrentUser('id') userId: string): Promise<void> {
    await this.memories.deleteAll(userId);
  }
}
