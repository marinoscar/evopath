import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { LAB_PANELS } from '../metric-registry';
import { BiomarkerSummaryDto, BiomarkerSummaryQueryDto } from './dto/biomarker-summary.dto';
import { BiomarkersService } from './biomarkers.service';

// =============================================================================
// /api/health/biomarkers — the caller's lab results per analyte (H5, #189)
// =============================================================================
//
// Owner-scoped and read-only. The per-result detail (every value with its
// range, flag, origin and source document) is `GET /api/measurements` with a
// lab `metricKey`; the chart is `GET /api/measurements/series`.
// =============================================================================

@ApiTags('Measurements')
@Controller('health/biomarkers')
export class BiomarkersController {
  constructor(private readonly biomarkers: BiomarkersService) {}

  @Get('summary')
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_READ] })
  @ApiOperation({
    summary: 'Get the latest and previous lab result per analyte',
    description:
      'One item per lab analyte with at least one active result, in catalog order (panel, then ' +
      'analyte): the latest and previous result with the lab\'s range and flag, the change ' +
      'between them and the result count. Values and limits are canonical. `panel` keeps one ' +
      'panel; `outOfRange=true` keeps analytes whose latest result is flagged `low`, `high` or ' +
      '`critical`.',
  })
  @ApiQuery({ name: 'panel', required: false, enum: LAB_PANELS })
  @ApiQuery({ name: 'outOfRange', required: false, enum: ['true', 'false'] })
  @ApiResponse({ status: 200, description: 'Biomarker summary', type: BiomarkerSummaryDto })
  @ApiResponse({ status: 400, description: 'Invalid filter' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing health_data:read' })
  summary(@CurrentUser('id') userId: string, @Query() query: BiomarkerSummaryQueryDto) {
    return this.biomarkers.summary(userId, query);
  }
}
