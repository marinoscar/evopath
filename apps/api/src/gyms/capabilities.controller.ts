import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { CapabilityView } from './dto/equipment-type.dto';
import { EquipmentTypesService } from './equipment-types.service';
import { NO_GYMS_READ, UNAUTHENTICATED } from './gyms.controller';

// =============================================================================
// /api/capabilities — what equipment lets you train (seeded, read-only)
// =============================================================================

@ApiTags('Capabilities')
@Controller('capabilities')
export class CapabilitiesController {
  constructor(private readonly types: EquipmentTypesService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.GYMS_READ] })
  @ApiOperation({
    summary: 'List capabilities',
    description:
      'Every capability (e.g. `back_squat`, `lat_pulldown`) in sort order, with its movement pattern ' +
      'and primary muscles. Used to pick the capabilities of custom equipment.',
  })
  @ApiDataResponse(CapabilityView, { isArray: true, description: 'All capabilities' })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_GYMS_READ)
  list() {
    return this.types.listCapabilities();
  }
}
