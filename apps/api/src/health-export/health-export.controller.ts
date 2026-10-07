import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ErrorDto } from '@marinoscar/platform-api/core';
import { CreateHealthExportDto, HealthExportDto, HealthExportListDto } from './dto/health-export.dto';
import {
  HEALTH_EXPORT_DOWNLOAD_URL_TTL_SECONDS,
  HEALTH_EXPORT_JOB_TYPE,
  HEALTH_EXPORT_LIST_LIMIT,
  HEALTH_EXPORT_MAX_IN_FLIGHT,
  HEALTH_EXPORT_MAX_RANGE_DAYS,
  HEALTH_EXPORT_RETENTION_DAYS,
} from './health-export.constants';
import { HealthExportService } from './health-export.service';

// =============================================================================
// /api/health/exports — the caller's health data exports (H7, #191)
// =============================================================================
//
//   POST /api/health/exports       health_data:read   202, queues `health.export`
//   GET  /api/health/exports       health_data:read   recent exports, no URLs
//   GET  /api/health/exports/:id   health_data:read   status; a signed URL when ready
//
// `health_data:read`, not `:write`: exporting reads the record and changes
// nothing in it. Owner-scoped: a foreign or unknown id is a 404. A sibling of
// the liveness routes under `/api/health` (`live`, `ready`), which stay public;
// every route here declares `@Auth`.
// =============================================================================

@ApiTags('Health Export')
@Controller('health/exports')
export class HealthExportController {
  constructor(private readonly exports: HealthExportService) {}

  @Post()
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_READ] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Export health data',
    description:
      `Queues a \`${HEALTH_EXPORT_JOB_TYPE}\` job that writes the caller's selected datasets for ` +
      '`from`..`to` (calendar dates, inclusive, UTC; wellness scores by their local day) as `json`, ' +
      '`csv` (a zip of one CSV per dataset), `xlsx` or `pdf`, and returns at once with **202** and ' +
      'the export (`status: pending`). Poll `GET /api/health/exports/{id}`; the caller is also ' +
      'notified when it is ready or failed.\n\n' +
      'Values are in each metric\'s canonical unit (named in the column). Deleted readings are never ' +
      'exported; superseded revisions only with `includeHistory`. `documents` lists kept documents ' +
      `(metadata only). The range may span at most ${HEALTH_EXPORT_MAX_RANGE_DAYS} days and may not ` +
      `end in the future. At most ${HEALTH_EXPORT_MAX_IN_FLIGHT} exports per user may be pending or ` +
      'running at once (**429** otherwise).',
  })
  @ApiResponse({ status: 202, description: 'The queued export', type: HealthExportDto })
  @ApiResponse({ status: 400, description: 'Invalid format, dates, range or datasets', type: ErrorDto })
  @ApiResponse({ status: 429, description: 'Too many exports in progress', type: ErrorDto })
  request(@CurrentUser('id') userId: string, @Body() dto: CreateHealthExportDto) {
    return this.exports.request(userId, dto);
  }

  @Get()
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_READ] })
  @ApiOperation({
    summary: "List the caller's recent health exports",
    description:
      `The caller's ${HEALTH_EXPORT_LIST_LIMIT} most recent exports, newest first, with their status. ` +
      '`download` is always null here: ask `GET /api/health/exports/{id}` for a URL.',
  })
  @ApiResponse({ status: 200, description: 'Recent exports', type: HealthExportListDto })
  list(@CurrentUser('id') userId: string) {
    return this.exports.list(userId);
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_READ] })
  @ApiParam({ name: 'id', description: 'The export id returned by `POST /api/health/exports`', format: 'uuid' })
  @ApiOperation({
    summary: 'Get a health export',
    description:
      '`status` is `pending`, `running`, `ready`, `failed` or `expired`. While `ready`, `download.url` ' +
      `is a signed URL valid for ${HEALTH_EXPORT_DOWNLOAD_URL_TTL_SECONDS / 60} minutes that downloads ` +
      'the file as an attachment named `fileName`; every call mints a fresh one. Files are removed ' +
      `${HEALTH_EXPORT_RETENTION_DAYS} days after they are created (then \`expired\`). **404** for an ` +
      "id that is not one of the caller's exports.",
  })
  @ApiResponse({ status: 200, description: 'The export', type: HealthExportDto })
  @ApiResponse({ status: 404, description: "Not one of the caller's exports", type: ErrorDto })
  get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.exports.get(userId, id);
  }
}
