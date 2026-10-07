import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ErrorDto } from '@marinoscar/platform-api/core';
import {
  AdminFactoryResetRequestDto,
  AdminFactoryResetStartedDto,
  AdminFactoryResetStatusDto,
  AdminFactoryResetSummaryDto,
} from './dto/admin-factory-reset.dto';
import { ADMIN_FACTORY_RESET_CONFIRMATION, ADMIN_FACTORY_RESET_TYPE } from './admin-factory-reset.constants';
import { AdminFactoryResetService } from './admin-factory-reset.service';

// =============================================================================
// AdminFactoryResetController (issue #211)
// =============================================================================
//
//   GET  /api/admin/factory-reset/summary   system:factory_reset
//   POST /api/admin/factory-reset           system:factory_reset  (202, one per deployment)
//   GET  /api/admin/factory-reset/:jobId    system:factory_reset
//
// `system:factory_reset` is a permission of its own (Admin only), not
// `system_settings:write`: wiping every user and all their data is a
// categorically bigger act than editing a setting, the same reasoning that
// gave restore its own `db_backup:restore`.
// =============================================================================

@ApiTags('Factory Reset')
@Controller('admin/factory-reset')
export class AdminFactoryResetController {
  constructor(private readonly factoryReset: AdminFactoryResetService) {}

  @Get('summary')
  @Auth({ permissions: [PERMISSIONS.SYSTEM_FACTORY_RESET] })
  @ApiOperation({
    summary: 'Count what a factory reset would delete',
    description:
      'Deployment-wide counts: users other than the caller, workouts, gyms, active measurements, ' +
      'programs, training runs, storage objects (database backup archives excluded), job rows that ' +
      'are not running, notifications, allowlist entries other than the caller\'s, broadcasts, AI ' +
      'runs, and custom exercises and equipment.',
  })
  @ApiResponse({ status: 200, description: 'What a factory reset would delete', type: AdminFactoryResetSummaryDto })
  getSummary(@CurrentUser('id') userId: string) {
    return this.factoryReset.getSummary(userId);
  }

  @Post()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_FACTORY_RESET] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Factory reset the whole application',
    description:
      `Queues a \`${ADMIN_FACTORY_RESET_TYPE}\` job and returns at once with **202**. The job ` +
      'deletes every user other than the caller (and everything they own), all of the caller\'s ' +
      'own data (as a user data reset does), every storage object except database backup ' +
      'archives, the allowlist (except the caller\'s entry), broadcasts, notifications, push ' +
      'subscriptions, AI runs and usage, per-user credentials, custom exercises and equipment, ' +
      'and job history (running jobs and backup-linked jobs are kept). It KEEPS the caller\'s ' +
      'account, roles and sign-in, roles and permissions, system settings, deployment ' +
      'credentials, the AI model catalog, seeded catalogs, worker nodes (handed to the caller), ' +
      'database backups and the audit log. Poll `GET /api/admin/factory-reset/{jobId}`.\n\n' +
      `\`confirmation\` must be exactly \`${ADMIN_FACTORY_RESET_CONFIRMATION}\`; anything else is ` +
      'a **400**. **One per deployment:** while a factory reset is pending or running, the call ' +
      'returns that job instead of queueing another.',
  })
  @ApiResponse({ status: 202, description: 'The factory reset job (new, or the one already in flight)', type: AdminFactoryResetStartedDto })
  @ApiResponse({ status: 400, description: 'The confirmation phrase is missing or wrong', type: ErrorDto })
  requestReset(@CurrentUser('id') userId: string, @Body() _dto: AdminFactoryResetRequestDto) {
    return this.factoryReset.requestReset(userId);
  }

  @Get(':jobId')
  @Auth({ permissions: [PERMISSIONS.SYSTEM_FACTORY_RESET] })
  @ApiParam({ name: 'jobId', description: 'The job id returned by `POST /api/admin/factory-reset`', format: 'uuid' })
  @ApiOperation({
    summary: 'Get the status of a factory reset',
    description:
      '`status` is `pending`, `running`, `succeeded` or `failed`. Once `succeeded`, `result` ' +
      'counts what was deleted per category, including `usersDeleted`, `storageObjectsDeleted` ' +
      'and `storageObjectsFailed` (files the storage provider refused to delete; their records ' +
      'are kept so a later reset can retry them). Once `failed`, `error` says why. **404** for ' +
      'any job that is not a factory reset.',
  })
  @ApiResponse({ status: 200, description: 'The factory reset job status', type: AdminFactoryResetStatusDto })
  @ApiResponse({ status: 404, description: 'Not a factory reset job', type: ErrorDto })
  getResetStatus(@Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.factoryReset.getResetStatus(jobId);
  }
}
