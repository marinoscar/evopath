import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
import { LabReportDuplicatesDto } from './dto/lab-report-duplicates.dto';
import { LabResultMapView, MapLabResultDto } from './dto/lab-report-map.dto';
import { LabReportDuplicatesService } from './lab-report-duplicates.service';
import { LabReportMapService } from './lab-report-map.service';

// =============================================================================
// /api/measurements/lab-reports — lab-report review helpers (H4, #188)
// =============================================================================
//
// The `lab_report` intake itself uses the generic `/api/intakes/*` routes.
// This controller adds what only a lab report needs:
//
//   - the duplicate warning the review shows before apply. It reads an intake
//     (`intakes:read`) and the caller's lab results (`health_data:read`), so
//     it requires both;
//   - "map once" (#307): correcting one result's analyte or unit corrects
//     every same-named result of the report (`LabReportMapService`). It edits draft
//     items as `PATCH /api/intakes/:id/items/:itemId` does, so it requires
//     what that route requires for a lab report: `intakes:write` and the
//     kind's `health_data:write`.
// =============================================================================

@ApiTags('Measurements')
@Controller('measurements/lab-reports')
export class LabReportController {
  constructor(
    private readonly duplicates: LabReportDuplicatesService,
    private readonly mapping: LabReportMapService,
  ) {}

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

  @Post(':intakeId/map')
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_WRITE, PERMISSIONS.INTAKES_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apply a lab result correction (analyte, unit) to every result printed with the same name',
    description:
      'For a `lab_report` intake under review. Body `{ itemId, analyteKey?, unit? }`, at least one of the two. ' +
      '`analyteKey`: sets the analyte on the given result and on every other result of the intake whose printed ' +
      'name is the same (ignoring case, accents, spaces and punctuation), except rejected results and results the ' +
      'user already mapped to a different analyte. `unit` (applied after the analyte): re-reads the printed number ' +
      'of the given result, and of every same-named, not rejected result of the same analyte that was printed with ' +
      'the same unit and that nobody re-read or re-numbered since, in that unit. Each changed result is written as ' +
      '`PATCH /api/intakes/:id/items/:itemId` would write it (converted to the canonical unit, `match` recomputed, ' +
      '`userVerified` set, `originalAiValue` kept on the first edit); `status` is unchanged. A result already ' +
      'carrying the correction (the given one after its own PATCH) is unchanged but still listed. A same-named ' +
      'result the edit would refuse (e.g. a unit its analyte does not allow, a value outside its bounds) is left ' +
      'unchanged and listed in `skipped`; a refusal of the given result itself is the 400. One transaction.',
  })
  @ApiParam({ name: 'intakeId', type: String, format: 'uuid' })
  @ApiBody({ type: MapLabResultDto })
  @ApiDataResponse(LabResultMapView, { description: 'The results now corrected, and the same-named ones left unchanged' })
  @ApiResponse({
    status: 400,
    description:
      'Validation error: intakeId or itemId is not a UUID, neither analyteKey nor unit is given, analyteKey is not a ' +
      'lab catalog key, or the given result cannot take the correction (`details.issues` names each field)',
    type: ErrorDto,
  })
  @ApiResponse({ status: 401, description: 'Not authenticated', type: ErrorDto })
  @ApiResponse({ status: 403, description: 'Missing health_data:write or intakes:write', type: ErrorDto })
  @ApiResponse({ status: 404, description: 'No lab_report intake with this id for the caller, or no such result in it', type: ErrorDto })
  @ApiResponse({
    status: 409,
    description: 'The intake status forbids editing its items (`details.reason`: `ALREADY_APPLIED`)',
    type: ErrorDto,
  })
  mapResult(
    @CurrentUser('id') userId: string,
    @Param('intakeId', ParseUUIDPipe) intakeId: string,
    @Body() dto: MapLabResultDto,
  ) {
    return this.mapping.map(userId, intakeId, dto);
  }
}
