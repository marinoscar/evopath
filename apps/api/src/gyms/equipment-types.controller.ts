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
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../common/dto/error.dto';
import {
  CreateEquipmentTypeDto,
  EquipmentTypeView,
  ListEquipmentTypesQueryDto,
  UpdateEquipmentTypeDto,
} from './dto/equipment-type.dto';
import { EquipmentTypesService } from './equipment-types.service';
import {
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_TYPE_CAPABILITIES_MAX,
  EQUIPMENT_TYPE_LIST_LIMIT_DEFAULT,
  EQUIPMENT_TYPE_LIST_LIMIT_MAX,
  MAX_CUSTOM_EQUIPMENT_TYPES_PER_USER,
} from './gyms.constants';
import { BAD_ID, NO_GYMS_READ, NO_GYMS_WRITE, UNAUTHENTICATED } from './gyms.controller';

// =============================================================================
// /api/equipment-types — the equipment catalog plus the caller's custom types
// =============================================================================

const TYPE_ID_PARAM = { name: 'id', type: String, format: 'uuid', description: 'The equipment type id.' } as const;
const NOT_OWN_CUSTOM = {
  status: 404,
  description: 'No custom equipment type with this id belongs to the caller (catalog types are read-only)',
  type: ErrorDto,
} as const;

@ApiTags('Equipment')
@Controller('equipment-types')
export class EquipmentTypesController {
  constructor(private readonly types: EquipmentTypesService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.GYMS_READ] })
  @ApiOperation({
    summary: 'Search equipment types',
    description:
      'The seeded catalog plus the caller\'s custom types, each with its capabilities, in catalog ' +
      'order. `q` matches case-insensitively anywhere in the name or any alias (e.g. `cross` finds ' +
      'Elliptical by its alias "cross trainer").',
  })
  @ApiQuery({ name: 'q', required: false, type: String, description: '1 to 80 characters.' })
  @ApiQuery({ name: 'category', required: false, enum: EQUIPMENT_CATEGORIES })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: `Default ${EQUIPMENT_TYPE_LIST_LIMIT_DEFAULT}, max ${EQUIPMENT_TYPE_LIST_LIMIT_MAX}.`,
  })
  @ApiDataResponse(EquipmentTypeView, { isArray: true, description: 'Matching equipment types' })
  @ApiResponse({ status: 400, description: 'Invalid filter', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_GYMS_READ)
  list(@CurrentUser('id') userId: string, @Query() query: ListEquipmentTypesQueryDto) {
    return this.types.list(userId, query);
  }

  @Post()
  @Auth({ permissions: [PERMISSIONS.GYMS_WRITE] })
  @ApiOperation({
    summary: 'Create custom equipment',
    description:
      'Creates an equipment type only the caller sees (slug `custom-<8 chars>`), with up to ' +
      `${EQUIPMENT_TYPE_CAPABILITIES_MAX} capabilities. At most ${MAX_CUSTOM_EQUIPMENT_TYPES_PER_USER} per user.`,
  })
  @ApiDataResponse(EquipmentTypeView, { status: 201, description: 'The new custom type' })
  @ApiResponse({
    status: 400,
    description: 'Validation error, or `details.reason`: `EQUIPMENT_TYPE_LIMIT`, `UNKNOWN_CAPABILITY`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_GYMS_WRITE)
  create(@CurrentUser('id') userId: string, @Body() dto: CreateEquipmentTypeDto) {
    return this.types.create(userId, dto);
  }

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.GYMS_WRITE] })
  @ApiOperation({
    summary: 'Edit custom equipment',
    description: 'Changes the name, category or (replacing the set) capabilities of one of the caller\'s custom types.',
  })
  @ApiParam(TYPE_ID_PARAM)
  @ApiDataResponse(EquipmentTypeView, { description: 'The type as it now stands' })
  @ApiResponse({
    status: 400,
    description: 'Validation error, or `details.reason: UNKNOWN_CAPABILITY`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_GYMS_WRITE)
  @ApiResponse(NOT_OWN_CUSTOM)
  update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEquipmentTypeDto,
  ) {
    return this.types.update(userId, id, dto);
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.GYMS_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete custom equipment',
    description: 'Deletes one of the caller\'s custom types; refused while any gym equipment uses it.',
  })
  @ApiParam(TYPE_ID_PARAM)
  @ApiResponse({ status: 204, description: 'Type deleted' })
  @ApiResponse(BAD_ID)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_GYMS_WRITE)
  @ApiResponse(NOT_OWN_CUSTOM)
  @ApiResponse({
    status: 409,
    description: '`details.reason: EQUIPMENT_TYPE_IN_USE` — remove it from your gyms first',
    type: ErrorDto,
  })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.types.remove(userId, id);
  }
}
