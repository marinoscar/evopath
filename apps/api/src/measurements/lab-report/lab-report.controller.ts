import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { LabReportDuplicatesDto } from './dto/lab-report-duplicates.dto';
import { LabReportDuplicatesService } from './lab-report-duplicates.service';

// =============================================================================
// /api/measurements/lab-reports — lab-report review helpers (H4, #188)
// =============================================================================
//
// The `lab_report` intake itself uses the generic `/api/intakes/*` routes.
// This controller adds what only a lab report needs: the duplicate warning
// the review shows before apply. It reads an intake (`intakes:read`) and the
// caller's lab results (`health_data:read`), so it requires both.
// =============================================================================

@ApiTags('Measurements')
@Controller('measurements/lab-reports')
export class LabReportController {
  constructor(private readonly duplicates: LabReportDuplicatesService) {}

  @Get(':intakeId/duplicates')
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_READ, PERMISSIONS.INTAKES_READ] })
  @ApiOperation({
    summary: 'Find saved results a lab report would duplicate',
    description:
      'For a `lab_report` intake under review: each draft result that is not rejected, is matched to a ' +
      'catalog analyte and has a number, and equals an active saved lab result of the caller with the ' +
      "same analyte, on the same UTC day (the result's own `collectionDate`, else the intake's `context.collectionDate`, else today) and with the " +
      'same canonical value. A warning for the review only; `POST /api/intakes/:id/apply` never ' +
      'de-duplicates. Results applied from this intake are not reported.',
  })
  @ApiParam({ name: 'intakeId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The duplicates (possibly none)', type: LabReportDuplicatesDto })
  @ApiResponse({ status: 400, description: 'intakeId is not a UUID' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing health_data:read or intakes:read' })
  @ApiResponse({ status: 404, description: 'No lab_report intake with this id for the caller' })
  findDuplicates(@CurrentUser('id') userId: string, @Param('intakeId', ParseUUIDPipe) intakeId: string) {
    return this.duplicates.find(userId, intakeId);
  }
}
