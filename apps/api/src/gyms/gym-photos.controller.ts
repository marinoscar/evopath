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
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../common/dto/error.dto';
import { AttachGymPhotoDto, GymPhotoView, UpdateGymPhotoDto } from './dto/gym-photo.dto';
import { MAX_PHOTOS_PER_GYM } from './gyms.constants';
import { GymPhotosService } from './gym-photos.service';
import { BAD_ID, GYM_ID_PARAM, NO_GYMS_READ, NO_GYMS_WRITE, UNAUTHENTICATED } from './gyms.controller';

// =============================================================================
// /api/gyms/:id/photos — photos of the caller's gyms (E3.3)
// =============================================================================
//
// Attaching and removing a photo also need `storage:write`: the image is
// uploaded through `POST /api/storage/objects` (which needs it), and removing
// a photo deletes that storage object. Editing a caption or its equipment
// links is `gyms:write` alone.
// =============================================================================

const PHOTO_ID_PARAM = { name: 'photoId', type: String, format: 'uuid', description: 'The gym photo id.' } as const;
const NO_PHOTO_WRITE = { status: 403, description: 'Missing gyms:write or storage:write', type: ErrorDto } as const;
const PHOTO_NOT_FOUND = { status: 404, description: 'No such gym for the caller, or no such photo in it', type: ErrorDto } as const;

@ApiTags('Gyms')
@Controller('gyms/:id/photos')
export class GymPhotosController {
  constructor(private readonly photos: GymPhotosService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.GYMS_READ] })
  @ApiOperation({
    summary: 'List a gym\'s photos',
    description: 'Oldest first, with the equipment each shows. View one through `GET /api/storage/objects/{storageObjectId}/download`.',
  })
  @ApiParam(GYM_ID_PARAM)
  @ApiDataResponse(GymPhotoView, { isArray: true, description: 'The gym\'s photos' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_GYMS_READ)
  @ApiResponse({ status: 404, description: 'No gym with this id for the caller', type: ErrorDto })
  list(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) gymId: string) {
    return this.photos.list(userId, gymId);
  }

  @Post()
  @Auth({ permissions: [PERMISSIONS.GYMS_WRITE, PERMISSIONS.STORAGE_WRITE] })
  @ApiOperation({
    summary: 'Attach a photo to a gym',
    description:
      'Attaches an image the caller already uploaded through `POST /api/storage/objects`. The ' +
      'object must be the caller\'s, `ready`, PNG/JPEG/GIF/WebP and at most 20 MiB. ' +
      `\`equipmentIds\` must be equipment of this gym. At most ${MAX_PHOTOS_PER_GYM} photos per gym.`,
  })
  @ApiParam(GYM_ID_PARAM)
  @ApiDataResponse(GymPhotoView, { status: 201, description: 'The new photo' })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, or `details.reason`: `OBJECT_NOT_READY`, `UNSUPPORTED_MEDIA_TYPE`, ' +
      '`OBJECT_TOO_LARGE`, `PHOTO_LIMIT`, `EQUIPMENT_NOT_IN_GYM`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_PHOTO_WRITE)
  @ApiResponse({ status: 404, description: 'No such gym, or no such storage object, for the caller', type: ErrorDto })
  @ApiResponse({
    status: 409,
    description: '`details.reason: PHOTO_ALREADY_ATTACHED` — the object is already a gym photo',
    type: ErrorDto,
  })
  attach(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) gymId: string,
    @Body() dto: AttachGymPhotoDto,
  ) {
    return this.photos.attach(userId, gymId, dto);
  }

  @Patch(':photoId')
  @Auth({ permissions: [PERMISSIONS.GYMS_WRITE] })
  @ApiOperation({
    summary: 'Edit a gym photo',
    description: 'Changes the caption and `takenAt`, and replaces the set of equipment the photo shows.',
  })
  @ApiParam(GYM_ID_PARAM)
  @ApiParam(PHOTO_ID_PARAM)
  @ApiDataResponse(GymPhotoView, { description: 'The photo as it now stands' })
  @ApiResponse({
    status: 400,
    description: 'Validation error, or `details.reason: EQUIPMENT_NOT_IN_GYM`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_GYMS_WRITE)
  @ApiResponse(PHOTO_NOT_FOUND)
  update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) gymId: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
    @Body() dto: UpdateGymPhotoDto,
  ) {
    return this.photos.update(userId, gymId, photoId, dto);
  }

  @Delete(':photoId')
  @Auth({ permissions: [PERMISSIONS.GYMS_WRITE, PERMISSIONS.STORAGE_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a gym photo', description: 'Removes the photo and deletes its storage object.' })
  @ApiParam(GYM_ID_PARAM)
  @ApiParam(PHOTO_ID_PARAM)
  @ApiResponse({ status: 204, description: 'Photo removed' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_PHOTO_WRITE)
  @ApiResponse(PHOTO_NOT_FOUND)
  async remove(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) gymId: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
  ): Promise<void> {
    await this.photos.remove(userId, gymId, photoId);
  }
}
