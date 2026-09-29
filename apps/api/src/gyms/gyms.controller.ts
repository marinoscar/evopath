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
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../common/dto/error.dto';
import {
  CreateGymDto,
  GymDetail,
  GymSummary,
  ListGymsQueryDto,
  UpdateGymDto,
} from './dto/gym.dto';
import { GymLocationResult, SetGymLocationDto } from './dto/gym-location.dto';
import { GYM_LOCATION_ACCURACY_MAX_METERS, MAX_GYMS_PER_USER } from './gyms.constants';
import { GymsService } from './gyms.service';

// =============================================================================
// /api/gyms — the caller's gyms (E3.3)
// =============================================================================
//
// Owner-scoped: every route acts on the JWT user's gyms only; another user's
// gym is a 404, never a 403. Refusal reasons are in `details.reason`.
// Equipment and photo sub-resources live in their own controllers on the same
// prefix (`gym-equipment.controller.ts`, `gym-photos.controller.ts`).
// =============================================================================

export const GYM_ID_PARAM = { name: 'id', type: String, format: 'uuid', description: 'The gym id.' } as const;
export const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;
export const NO_GYMS_READ = { status: 403, description: 'Missing gyms:read', type: ErrorDto } as const;
export const NO_GYMS_WRITE = { status: 403, description: 'Missing gyms:write', type: ErrorDto } as const;
export const GYM_NOT_FOUND = { status: 404, description: 'No gym with this id for the caller', type: ErrorDto } as const;
export const BAD_ID = { status: 400, description: 'An id is not a UUID', type: ErrorDto } as const;

@ApiTags('Gyms')
@Controller('gyms')
export class GymsController {
  constructor(private readonly gyms: GymsService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.GYMS_READ] })
  @ApiOperation({
    summary: 'List my gyms',
    description:
      'The caller\'s gyms, the default first and then by name, each with its equipment and ' +
      'photo counts and a cover photo (the oldest photo, or null).',
  })
  @ApiQuery({
    name: 'includeTemporary',
    required: false,
    enum: ['true', 'false'],
    description: '`false` hides temporary gyms. Default `true`.',
  })
  @ApiDataResponse(GymSummary, { isArray: true, description: 'The caller\'s gyms' })
  @ApiResponse({ status: 400, description: 'includeTemporary is not `true` or `false`', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_GYMS_READ)
  list(@CurrentUser('id') userId: string, @Query() query: ListGymsQueryDto) {
    return this.gyms.list(userId, query);
  }

  @Post()
  @Auth({ permissions: [PERMISSIONS.GYMS_WRITE] })
  @ApiOperation({
    summary: 'Create a gym',
    description:
      'Creates a gym. The caller\'s first gym becomes their default automatically. Names need ' +
      `not be unique. At most ${MAX_GYMS_PER_USER} gyms per user.`,
  })
  @ApiDataResponse(GymDetail, { status: 201, description: 'The new gym (with empty equipment and photos)' })
  @ApiResponse({
    status: 400,
    description:
      'Validation error (`details.issues` names each field), or `details.reason: GYM_LIMIT`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_GYMS_WRITE)
  create(@CurrentUser('id') userId: string, @Body() dto: CreateGymDto) {
    return this.gyms.create(userId, dto);
  }

  // ---------------------------------------------------------------------------
  // Parameterised routes
  // ---------------------------------------------------------------------------

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.GYMS_READ] })
  @ApiOperation({
    summary: 'Get a gym',
    description: 'The gym with its equipment (each with its equipment type and capabilities) and its photos.',
  })
  @ApiParam(GYM_ID_PARAM)
  @ApiDataResponse(GymDetail, { description: 'The gym' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_GYMS_READ)
  @ApiResponse(GYM_NOT_FOUND)
  get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.gyms.get(userId, id);
  }

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.GYMS_WRITE] })
  @ApiOperation({
    summary: 'Edit a gym',
    description:
      'Changes any of name, type, description, notes, isTemporary, latitude and longitude. ' +
      'Latitude and longitude are given together (both numbers, or both null to clear). ' +
      'The default moves only through `POST /api/gyms/{id}/default`.',
  })
  @ApiParam(GYM_ID_PARAM)
  @ApiDataResponse(GymDetail, { description: 'The gym as it now stands' })
  @ApiResponse({ status: 400, description: 'Validation error (`details.issues` names each field)', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_GYMS_WRITE)
  @ApiResponse(GYM_NOT_FOUND)
  update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGymDto,
  ) {
    return this.gyms.update(userId, id, dto);
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.GYMS_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a gym',
    description:
      'Deletes the gym with its equipment and photos, then deletes the photos\' storage objects. ' +
      'When it was the default, the oldest remaining gym becomes the default in the same transaction.',
  })
  @ApiParam(GYM_ID_PARAM)
  @ApiResponse({ status: 204, description: 'Gym deleted' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_GYMS_WRITE)
  @ApiResponse(GYM_NOT_FOUND)
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.gyms.remove(userId, id);
  }

  @Post(':id/default')
  @Auth({ permissions: [PERMISSIONS.GYMS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Make a gym my default',
    description:
      'Atomically makes this gym the caller\'s default and clears the previous one. Already the ' +
      'default is a no-op.',
  })
  @ApiParam(GYM_ID_PARAM)
  @ApiDataResponse(GymDetail, { description: 'The gym, now the default' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_GYMS_WRITE)
  @ApiResponse(GYM_NOT_FOUND)
  @ApiResponse({
    status: 409,
    description: '`details.reason: DEFAULT_CONFLICT` — the default changed concurrently twice; retry',
    type: ErrorDto,
  })
  setDefault(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.gyms.setDefault(userId, id);
  }

  // ---------------------------------------------------------------------------
  // Location (E3.5). Coordinates are personal data: stored rounded to 5
  // decimals, returned to their owner, never logged or sent to AI.
  // ---------------------------------------------------------------------------

  @Put(':id/location')
  @Auth({ permissions: [PERMISSIONS.GYMS_WRITE] })
  @ApiOperation({
    summary: 'Set my gym\'s location',
    description:
      'Sets the gym\'s GPS position without resending the gym. Both coordinates are required and ' +
      'are stored rounded to 5 decimals (about 1 m). `accuracyMeters` (0..' +
      `${GYM_LOCATION_ACCURACY_MAX_METERS}) is validated and echoed in the response, never stored. ` +
      'Coordinates are never logged and never sent to an AI provider.',
  })
  @ApiParam(GYM_ID_PARAM)
  @ApiDataResponse(GymLocationResult, { description: 'The gym with its stored (rounded) position' })
  @ApiResponse({
    status: 400,
    description: 'Validation error (`details.issues` names each field), or the id is not a UUID',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_GYMS_WRITE)
  @ApiResponse(GYM_NOT_FOUND)
  setLocation(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetGymLocationDto,
  ) {
    return this.gyms.setLocation(userId, id, dto);
  }

  @Delete(':id/location')
  @Auth({ permissions: [PERMISSIONS.GYMS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clear my gym\'s location',
    description: 'Sets both coordinates to null. Clearing a gym with no position is a no-op.',
  })
  @ApiParam(GYM_ID_PARAM)
  @ApiDataResponse(GymLocationResult, { description: 'The gym, now without a position (`accuracyMeters` null)' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_GYMS_WRITE)
  @ApiResponse(GYM_NOT_FOUND)
  clearLocation(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.gyms.clearLocation(userId, id);
  }
}
