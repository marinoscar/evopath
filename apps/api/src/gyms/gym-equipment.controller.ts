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
import { ErrorDto } from '@marinoscar/platform-api/core';
import { CreateGymEquipmentDto, GymEquipmentView, UpdateGymEquipmentDto } from './dto/gym-equipment.dto';
import { GymEquipmentService } from './gym-equipment.service';
import {
  BAD_ID,
  GYM_ID_PARAM,
  NO_GYMS_READ,
  NO_GYMS_WRITE,
  UNAUTHENTICATED,
} from './gyms.controller';

// =============================================================================
// /api/gyms/:id/equipment — equipment of the caller's gyms (E3.3)
// =============================================================================

const EQUIPMENT_ID_PARAM = { name: 'equipmentId', type: String, format: 'uuid', description: 'The equipment row id.' } as const;
const GYM_OR_TYPE_NOT_FOUND = {
  status: 404,
  description: 'No such gym for the caller, or the equipment type is neither a catalog type nor the caller\'s own',
  type: ErrorDto,
} as const;
const EQUIPMENT_NOT_FOUND = {
  status: 404,
  description: 'No such gym for the caller, no such equipment in it, or an equipment type the caller cannot use',
  type: ErrorDto,
} as const;

@ApiTags('Gyms')
@Controller('gyms/:id/equipment')
export class GymEquipmentController {
  constructor(private readonly equipment: GymEquipmentService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.GYMS_READ] })
  @ApiOperation({ summary: 'List a gym\'s equipment', description: 'Oldest first, each with its equipment type.' })
  @ApiParam(GYM_ID_PARAM)
  @ApiDataResponse(GymEquipmentView, { isArray: true, description: 'The gym\'s equipment' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_GYMS_READ)
  @ApiResponse({ status: 404, description: 'No gym with this id for the caller', type: ErrorDto })
  list(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) gymId: string) {
    return this.equipment.list(userId, gymId);
  }

  @Post()
  @Auth({ permissions: [PERMISSIONS.GYMS_WRITE] })
  @ApiOperation({
    summary: 'Add equipment to a gym',
    description:
      'Adds a manual equipment row (`origin: manual`, `userVerified: true`) of a catalog type or ' +
      'one of the caller\'s custom types. Quantity 1 to 99, default 1.',
  })
  @ApiParam(GYM_ID_PARAM)
  @ApiDataResponse(GymEquipmentView, { status: 201, description: 'The new equipment row' })
  @ApiResponse({ status: 400, description: 'Validation error (`details.issues` names each field)', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_GYMS_WRITE)
  @ApiResponse(GYM_OR_TYPE_NOT_FOUND)
  add(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) gymId: string,
    @Body() dto: CreateGymEquipmentDto,
  ) {
    return this.equipment.add(userId, gymId, dto);
  }

  @Patch(':equipmentId')
  @Auth({ permissions: [PERMISSIONS.GYMS_WRITE] })
  @ApiOperation({
    summary: 'Edit a gym\'s equipment row',
    description:
      'Changes quantity, brand, model, notes or equipment type, and marks the row verified. The ' +
      'first edit of an AI-origin row stores what the AI proposed in `originalAiValue`, once.',
  })
  @ApiParam(GYM_ID_PARAM)
  @ApiParam(EQUIPMENT_ID_PARAM)
  @ApiDataResponse(GymEquipmentView, { description: 'The row as it now stands' })
  @ApiResponse({ status: 400, description: 'Validation error (`details.issues` names each field)', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_GYMS_WRITE)
  @ApiResponse(EQUIPMENT_NOT_FOUND)
  update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) gymId: string,
    @Param('equipmentId', ParseUUIDPipe) equipmentId: string,
    @Body() dto: UpdateGymEquipmentDto,
  ) {
    return this.equipment.update(userId, gymId, equipmentId, dto);
  }

  @Delete(':equipmentId')
  @Auth({ permissions: [PERMISSIONS.GYMS_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove equipment from a gym', description: 'Its photo links go with it; the photos stay.' })
  @ApiParam(GYM_ID_PARAM)
  @ApiParam(EQUIPMENT_ID_PARAM)
  @ApiResponse({ status: 204, description: 'Equipment removed' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_GYMS_WRITE)
  @ApiResponse({ status: 404, description: 'No such gym for the caller, or no such equipment in it', type: ErrorDto })
  async remove(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) gymId: string,
    @Param('equipmentId', ParseUUIDPipe) equipmentId: string,
  ): Promise<void> {
    await this.equipment.remove(userId, gymId, equipmentId);
  }
}
