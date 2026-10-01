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
import {
  CreateMeasurementEntryDto,
  LatestMeasurementsDto,
  LIST_PAGE_SIZE_DEFAULT,
  LIST_CATEGORIES,
  LIST_PAGE_SIZE_MAX,
  ListMeasurementsQueryDto,
  MeasurementDto,
  MeasurementEntryDto,
  MeasurementRevisionsDto,
  MeasurementSeriesDto,
  MetricCatalogDto,
  SERIES_DEFAULT_DAYS,
  SERIES_MAX_POINTS,
  SERIES_MAX_RANGE_DAYS,
  SeriesQueryDto,
  UpdateMeasurementEntryDto,
} from './dto/measurement.dto';
import { MeasurementsService } from './measurements.service';
import { catalogView } from './metric-registry';

// =============================================================================
// /api/measurements — the caller's own measurements (E2.2, #50)
// =============================================================================
//
// Owner-scoped: every route acts on the JWT user's rows only, and a foreign or
// unknown entry or measurement id is a 404, never a 403. Literal routes (`metrics`, `latest`,
// `series`) are declared before the parameterised `entries/:entryId` ones.
// =============================================================================

@ApiTags('Measurements')
@Controller('measurements')
export class MeasurementsController {
  constructor(private readonly measurements: MeasurementsService) {}

  @Get('metrics')
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_READ] })
  @ApiOperation({
    summary: 'Get the metric catalog',
    description:
      'Every metric this API knows: canonical unit, allowed units with their conversion `factor` ' +
      '(value in `unit` x factor = canonical value), display unit per unit system, hard bounds ' +
      '(canonical, inclusive), display decimals, allowed methods and, for daily wellness scores, ' +
      'the scale labels. Lab analytes (category `lab`) also carry their `panel` and the `aliases` ' +
      'lab reports print for them; their canonical unit is the US conventional one. Plus the ' +
      'shared method vocabulary with labels.',
  })
  @ApiResponse({ status: 200, description: 'Metric catalog', type: MetricCatalogDto })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing health_data:read' })
  getMetrics() {
    return catalogView();
  }

  @Get('latest')
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_READ] })
  @ApiOperation({
    summary: 'Get the latest reading of each body and vital metric',
    description:
      'One item per body/vital metric, in registry order, with the newest and the previous ' +
      'active reading (null where absent). Values are canonical.',
  })
  @ApiResponse({ status: 200, description: 'Latest readings', type: LatestMeasurementsDto })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing health_data:read' })
  latest(@CurrentUser('id') userId: string) {
    return this.measurements.latest(userId);
  }

  @Get('series')
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_READ] })
  @ApiOperation({
    summary: 'Get chart points for one metric',
    description:
      `Active readings of one metric (any registry metric) in \`[from, to]\`, oldest first. ` +
      `\`to\` defaults to now and \`from\` to ${SERIES_DEFAULT_DAYS} days before \`to\`; the range ` +
      `may not exceed ${SERIES_MAX_RANGE_DAYS} days (5 years). At most ${SERIES_MAX_POINTS} points: ` +
      'when the range holds more, the newest are kept and `truncated` is true.',
  })
  @ApiQuery({ name: 'metricKey', required: true, type: String })
  @ApiQuery({ name: 'from', required: false, type: String, format: 'date-time' })
  @ApiQuery({ name: 'to', required: false, type: String, format: 'date-time' })
  @ApiResponse({ status: 200, description: 'Series', type: MeasurementSeriesDto })
  @ApiResponse({ status: 400, description: 'Unknown metric, from after to, or range over 5 years' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing health_data:read' })
  series(@CurrentUser('id') userId: string, @Query() query: SeriesQueryDto) {
    return this.measurements.series(userId, query);
  }

  @Get()
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_READ] })
  @ApiOperation({
    summary: 'List measurements',
    description:
      'Active readings, newest `measuredAt` first, ties broken by insertion time. Values and ' +
      'reference limits are canonical. Body and vital readings by default; lab results with ' +
      '`category=lab` or a lab `metricKey` (wellness scores are served by check-ins).',
  })
  @ApiQuery({ name: 'metricKey', required: false, type: String, description: 'A body, vital or lab metric.' })
  @ApiQuery({ name: 'category', required: false, enum: LIST_CATEGORIES })
  @ApiQuery({ name: 'from', required: false, type: String, format: 'date-time' })
  @ApiQuery({ name: 'to', required: false, type: String, format: 'date-time' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    type: Number,
    description: `Default ${LIST_PAGE_SIZE_DEFAULT}, max ${LIST_PAGE_SIZE_MAX}.`,
  })
  @ApiDataResponse(MeasurementDto, { pagination: 'flat', description: 'Paginated measurements' })
  @ApiResponse({ status: 400, description: 'Invalid filter or pagination' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing health_data:read' })
  list(@CurrentUser('id') userId: string, @Query() query: ListMeasurementsQueryDto) {
    return this.measurements.list(userId, query);
  }

  @Post()
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_WRITE] })
  @ApiOperation({
    summary: 'Record one measurement entry',
    description:
      'Saves 1 to 6 body/vital readings, or 1 to 40 lab results from one report, together under ' +
      'a new `entryId`, at one `measuredAt` (default now). Each value may be sent in any unit the ' +
      'metric allows and is stored in its canonical unit (rounded to 4 decimals). Lab readings may ' +
      'carry `referenceLow`/`referenceHigh` (in the same unit, converted too), `referenceText` and ' +
      '`flag`. `bp_systolic` and `bp_diastolic` go together, systolic above diastolic. `origin` ' +
      'is always `manual`; `origin` and `sourceRef` cannot be sent.',
  })
  @ApiResponse({ status: 201, description: 'The created entry', type: MeasurementEntryDto })
  @ApiResponse({ status: 400, description: 'Validation error; `details.issues` names each field' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing health_data:write' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateMeasurementEntryDto) {
    return this.measurements.createEntry(userId, dto);
  }

  // ---------------------------------------------------------------------------
  // Parameterised routes. Nothing literal may be declared below this line.
  // ---------------------------------------------------------------------------

  @Get(':id/revisions')
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_READ] })
  @ApiOperation({
    summary: 'Get the revision history of a reading',
    description:
      'Every revision of one reading (body, vital or lab), newest first: the current one and each ' +
      'one an edit superseded, with `supersededAt` and `createdAt`. `id` may be any revision. ' +
      'Values and reference limits are canonical.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Revisions, newest first', type: MeasurementRevisionsDto })
  @ApiResponse({ status: 400, description: 'id is not a UUID' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing health_data:read' })
  @ApiResponse({ status: 404, description: 'No such reading for the caller, or it was deleted' })
  revisions(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.measurements.revisions(userId, id);
  }

  @Patch('entries/:entryId')
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_WRITE] })
  @ApiOperation({
    summary: 'Edit a measurement entry',
    description:
      'Supersedes every active reading of the entry: the old rows are kept with `supersededAt` ' +
      'set and new rows (`revision + 1`) carry the changes. Readings not mentioned are copied ' +
      'unchanged, and a lab reading keeps its reference range and flag unless the body changes ' +
      'them (null clears); `readings[].metricKey` must already be in the entry; the ' +
      'blood-pressure and range rules are checked on the merged result.',
  })
  @ApiParam({ name: 'entryId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The entry as it now stands', type: MeasurementEntryDto })
  @ApiResponse({ status: 400, description: 'Validation error; `details.issues` names each field' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing health_data:write' })
  @ApiResponse({ status: 404, description: 'No active entry with this id for the caller' })
  @ApiResponse({ status: 409, description: 'The entry was changed by another request' })
  update(
    @CurrentUser('id') userId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: UpdateMeasurementEntryDto,
  ) {
    return this.measurements.updateEntry(userId, entryId, dto);
  }

  @Delete('entries/:entryId')
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a measurement entry',
    description:
      'Soft-deletes every active reading of the entry (the rows keep `deletedAt`). Audited as ' +
      '`measurement_entry:delete` with the reading count only.',
  })
  @ApiParam({ name: 'entryId', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Entry deleted' })
  @ApiResponse({ status: 400, description: 'entryId is not a UUID' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing health_data:write' })
  @ApiResponse({ status: 404, description: 'No active entry with this id for the caller' })
  async remove(
    @CurrentUser('id') userId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
  ): Promise<void> {
    await this.measurements.deleteEntry(userId, entryId);
  }
}
