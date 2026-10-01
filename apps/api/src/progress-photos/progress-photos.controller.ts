import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../common/dto/error.dto';
import {
  CreateProgressPhotoDto,
  ListProgressPhotosQueryDto,
  ProgressPhotoPageView,
  ProgressPhotoView,
} from './dto/progress-photo.dto';
import {
  PROGRESS_PHOTO_MAX_BYTES,
  PROGRESS_PHOTO_PAGE_SIZE_DEFAULT,
  PROGRESS_PHOTO_PAGE_SIZE_MAX,
  PROGRESS_PHOTO_POSES,
} from './progress-photos.constants';
import { ProgressPhotosService } from './progress-photos.service';

// =============================================================================
// /api/progress-photos — the caller's private progress photos (E7.9, #249)
// =============================================================================
//
// Owner-scoped: another user's (or an unknown) photo id is a 404. Reads need
// `health_data:read`, writes `health_data:write`. Deliberately NOT behind
// `AiEnabledGuard`: progress photos are health data, not an AI feature, and
// work with AI off. Bytes are read through the existing owner-checked signed
// download, `GET /api/storage/objects/{storageObjectId}/download`.
// =============================================================================

const ID_PARAM = { name: 'id', type: String, format: 'uuid', description: 'The progress photo id.' } as const;

const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;
const NO_READ = { status: 403, description: 'Missing health_data:read', type: ErrorDto } as const;

@ApiTags('Progress Photos')
@Controller('progress-photos')
export class ProgressPhotosController {
  constructor(private readonly photos: ProgressPhotosService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_READ] })
  @ApiOperation({
    summary: 'List progress photos',
    description:
      'The caller\'s progress photos, newest `localDate` first (then newest upload), keyset-paged: pass ' +
      '`nextCursor` back as `cursor`. Metadata only; view a photo through ' +
      '`GET /api/storage/objects/{storageObjectId}/download`.',
  })
  @ApiQuery({ name: 'pose', required: false, enum: PROGRESS_PHOTO_POSES })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: `Default ${PROGRESS_PHOTO_PAGE_SIZE_DEFAULT}, max ${PROGRESS_PHOTO_PAGE_SIZE_MAX}.`,
  })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: 'The `nextCursor` of the previous page.' })
  @ApiDataResponse(ProgressPhotoPageView, { description: 'One page of progress photos' })
  @ApiResponse({ status: 400, description: 'Invalid pose, limit or cursor', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  list(@CurrentUser('id') userId: string, @Query() query: ListProgressPhotosQueryDto) {
    return this.photos.list(userId, query);
  }

  @Post()
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_WRITE] })
  @ApiOperation({
    summary: 'Add a progress photo',
    description:
      'Adds an image the caller already uploaded through `POST /api/storage/objects`. The object must be the ' +
      `caller's, \`ready\`, at most ${PROGRESS_PHOTO_MAX_BYTES / (1024 * 1024)} MiB, and a JPEG, PNG or WebP ` +
      'image by its stored bytes (the declared type alone is not trusted). Never sent to an AI model.',
  })
  @ApiDataResponse(ProgressPhotoView, { status: 201, description: 'The new progress photo' })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, or `details.reason`: `PROGRESS_PHOTO_NOT_IMAGE` (not a JPEG, PNG or WebP by content), ' +
      '`PROGRESS_PHOTO_OBJECT_NOT_READY`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse({
    status: 403,
    description: 'Missing health_data:write, or `details.reason: PROGRESS_PHOTO_OBJECT_NOT_OWNED`',
    type: ErrorDto,
  })
  @ApiResponse({ status: 404, description: 'No such storage object', type: ErrorDto })
  @ApiResponse({
    status: 409,
    description: '`details.reason: PROGRESS_PHOTO_ALREADY_ADDED`: the object is already a progress photo',
    type: ErrorDto,
  })
  @ApiResponse({ status: 413, description: '`details.reason: PROGRESS_PHOTO_TOO_LARGE`', type: ErrorDto })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateProgressPhotoDto) {
    return this.photos.create(userId, dto);
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a progress photo',
    description: 'Removes the photo and deletes its storage object (unless another feature still uses it).',
  })
  @ApiParam(ID_PARAM)
  @ApiResponse({ status: 204, description: 'Photo deleted' })
  @ApiResponse({ status: 400, description: 'The id is not a UUID', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse({ status: 403, description: 'Missing health_data:write', type: ErrorDto })
  @ApiResponse({
    status: 404,
    description: '`details.reason: PROGRESS_PHOTO_NOT_FOUND`: the caller has no progress photo with this id',
    type: ErrorDto,
  })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.photos.remove(userId, id);
  }
}
