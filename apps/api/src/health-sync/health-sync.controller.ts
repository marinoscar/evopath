import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { AuthCredential, type AuthCredentialInfo } from '../auth/decorators/auth-credential.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ErrorDto } from '@marinoscar/platform-api/core';
import {
  DeviceViewDto,
  ListReportsQueryDto,
  ListRunsQueryDto,
  RegisterDeviceDto,
  ReportCreatedViewDto,
  ReportSummaryViewDto,
  ReportViewDto,
  RunViewDto,
  SyncDto,
  SyncResultViewDto,
  UnpairQueryDto,
  UploadDiagnosticsDto,
} from './dto/health-sync.dto';
import {
  SYNC_MAX_DAYS_AHEAD,
  SYNC_MAX_DAYS_BACK,
  SYNC_WINDOW_MAX_DAYS,
} from './health-sync.constants';
import { HealthSyncService } from './health-sync.service';

// =============================================================================
// /api/health-sync — Android Health Connect sync (epic #276, #278)
// =============================================================================
//
// Owner-scoped: another user's device is a 404. `goals:read` for GET,
// `goals:write` otherwise; a sync carrying measurements or sleep also needs
// `health_data:write` (403). The phone calls these with its paired PAT.
// =============================================================================

const DEVICE_ID_PARAM = { name: 'id', type: String, format: 'uuid', description: 'The health sync device id.' } as const;
const REPORT_ID_PARAM = { name: 'reportId', type: String, format: 'uuid', description: 'The diagnostics report id.' } as const;

const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;
const NO_READ = { status: 403, description: 'Missing goals:read', type: ErrorDto } as const;
const NO_WRITE = { status: 403, description: 'Missing goals:write', type: ErrorDto } as const;
const NOT_FOUND = { status: 404, description: 'The caller has no device with this id', type: ErrorDto } as const;

@ApiTags('Health sync')
@Controller('health-sync')
export class HealthSyncController {
  constructor(private readonly healthSync: HealthSyncService) {}

  @Post('devices')
  @HttpCode(HttpStatus.OK)
  @Auth({ permissions: [PERMISSIONS.GOALS_WRITE] })
  @ApiOperation({
    summary: 'Register a phone',
    description:
      'Upsert on the caller\'s `installationId`; re-registering a revoked device reactivates it. Called with a ' +
      'personal access token, the device links that token (unpairing revokes it; `tokenExpiresAt` reports it).',
  })
  @ApiDataResponse(DeviceViewDto)
  @ApiResponse({ status: 400, description: 'Validation error', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  register(
    @CurrentUser('id') userId: string,
    @AuthCredential() credential: AuthCredentialInfo | null,
    @Body() dto: RegisterDeviceDto,
  ) {
    return this.healthSync.register(userId, dto, credential);
  }

  @Get('devices')
  @Auth({ permissions: [PERMISSIONS.GOALS_READ] })
  @ApiOperation({ summary: 'List paired phones', description: 'Newest first, revoked ones included.' })
  @ApiDataResponse(DeviceViewDto, { isArray: true })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  list(@CurrentUser('id') userId: string) {
    return this.healthSync.list(userId);
  }

  @Get('devices/:id')
  @Auth({ permissions: [PERMISSIONS.GOALS_READ] })
  @ApiOperation({ summary: 'Get a paired phone' })
  @ApiParam(DEVICE_ID_PARAM)
  @ApiDataResponse(DeviceViewDto)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  @ApiResponse(NOT_FOUND)
  get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.healthSync.get(userId, id);
  }

  @Delete('devices/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auth({ permissions: [PERMISSIONS.GOALS_WRITE] })
  @ApiOperation({
    summary: 'Unpair a phone',
    description:
      'The device becomes `revoked` and its linked access token is revoked. With `deleteEntries=true` its ' +
      'imported activity entries and sleep sessions are deleted and its measurements soft-deleted. Idempotent.',
  })
  @ApiParam(DEVICE_ID_PARAM)
  @ApiResponse({ status: 204, description: 'Unpaired' })
  @ApiResponse({ status: 400, description: 'The id is not a UUID', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  async unpair(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: UnpairQueryDto,
  ): Promise<void> {
    await this.healthSync.unpair(userId, id, query.deleteEntries);
  }

  @Post('devices/:id/sync')
  @HttpCode(HttpStatus.OK)
  @Auth({ permissions: [PERMISSIONS.GOALS_WRITE] })
  @ApiOperation({
    summary: 'Upload a sync',
    description:
      'Activity entries (and, with `health_data:write`, measurements and sleep sessions) read from Health ' +
      'Connect, upserted on their external ids (`source: integration` / `origin: device`). Local days lie in ' +
      `[today - ${SYNC_MAX_DAYS_BACK}, today + ${SYNC_MAX_DAYS_AHEAD}] in the user's time zone; a \`window\` spans ` +
      `at most ${SYNC_WINDOW_MAX_DAYS} days. With a \`window\` and \`run.status: ok\`, rows of the types in ` +
      '`run.details.syncedTypes` that the payload no longer carries are deleted. The run is always recorded.',
  })
  @ApiParam(DEVICE_ID_PARAM)
  @ApiDataResponse(SyncResultViewDto)
  @ApiResponse({
    status: 400,
    description: 'Validation error, or `details.reason`: `ENTRY_DATE_OUT_OF_RANGE` (with `details.path`), `WINDOW_TOO_LARGE`',
    type: ErrorDto,
  })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse({
    status: 403,
    description: 'Missing goals:write, or measurements/sleep sent without health_data:write',
    type: ErrorDto,
  })
  @ApiResponse(NOT_FOUND)
  @ApiResponse({ status: 409, description: '`details.reason`: `DEVICE_REVOKED`', type: ErrorDto })
  sync(
    @CurrentUser('id') userId: string,
    @CurrentUser('permissions') permissions: string[] | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SyncDto,
  ) {
    return this.healthSync.sync(userId, id, dto, (permissions ?? []).includes(PERMISSIONS.HEALTH_DATA_WRITE));
  }

  @Get('devices/:id/runs')
  @Auth({ permissions: [PERMISSIONS.GOALS_READ] })
  @ApiOperation({ summary: "List a phone's sync runs", description: 'Newest first.' })
  @ApiParam(DEVICE_ID_PARAM)
  @ApiDataResponse(RunViewDto, { isArray: true })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  @ApiResponse(NOT_FOUND)
  listRuns(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Query() query: ListRunsQueryDto) {
    return this.healthSync.listRuns(userId, id, query.limit);
  }

  @Post('devices/:id/diagnostics')
  @Auth({ permissions: [PERMISSIONS.GOALS_WRITE] })
  @ApiOperation({
    summary: 'Upload a diagnostics report',
    description: 'Accepted for a revoked device too. The newest 20 reports per device are kept.',
  })
  @ApiParam(DEVICE_ID_PARAM)
  @ApiDataResponse(ReportCreatedViewDto, { status: 201 })
  @ApiResponse({ status: 400, description: 'Validation error', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  uploadDiagnostics(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UploadDiagnosticsDto,
  ) {
    return this.healthSync.uploadDiagnostics(userId, id, dto);
  }

  @Get('devices/:id/diagnostics')
  @Auth({ permissions: [PERMISSIONS.GOALS_READ] })
  @ApiOperation({ summary: "List a phone's diagnostics reports", description: 'Newest first, without the report body.' })
  @ApiParam(DEVICE_ID_PARAM)
  @ApiDataResponse(ReportSummaryViewDto, { isArray: true })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  @ApiResponse(NOT_FOUND)
  listDiagnostics(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListReportsQueryDto,
  ) {
    return this.healthSync.listDiagnostics(userId, id, query.limit);
  }

  @Get('devices/:id/diagnostics/:reportId')
  @Auth({ permissions: [PERMISSIONS.GOALS_READ] })
  @ApiOperation({ summary: 'Get a diagnostics report' })
  @ApiParam(DEVICE_ID_PARAM)
  @ApiParam(REPORT_ID_PARAM)
  @ApiDataResponse(ReportViewDto)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  @ApiResponse({ status: 404, description: 'No such device or report for the caller', type: ErrorDto })
  getDiagnostics(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('reportId', ParseUUIDPipe) reportId: string,
  ) {
    return this.healthSync.getDiagnostics(userId, id, reportId);
  }
}
