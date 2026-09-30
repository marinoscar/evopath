import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ErrorDto } from '../common/dto/error.dto';
import {
  UserDataResetRequestDto,
  UserDataResetStartedDto,
  UserDataResetStatusDto,
  UserDataSummaryDto,
} from './dto/user-data.dto';
import { USER_DATA_RESET_CONFIRMATION, USER_DATA_RESET_TYPE } from './user-data.constants';
import { UserDataService } from './user-data.service';

// =============================================================================
// UserDataController (issue #202)
// =============================================================================
//
//   GET  /api/user-data/summary          user_settings:write
//   POST /api/user-data/reset            user_settings:write  (202, idempotent)
//   GET  /api/user-data/reset/:jobId     user_settings:write
//
// All three are `user_settings:write`, the string `user-settings.controller.ts`
// enforces for its writes: a reset is the most destructive edit a user can
// make to their own account, and the summary exists only to feed its
// confirmation dialog. Every route acts on the caller alone.
// =============================================================================

@ApiTags('User Data')
@Controller('user-data')
export class UserDataController {
  constructor(private readonly userData: UserDataService) {}

  @Get('summary')
  @Auth({ permissions: [PERMISSIONS.USER_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Count what a data reset would delete',
    description:
      'How many workouts, gyms, measurements, programs, training runs, custom exercises and ' +
      'equipment, photos (storage objects), AI keys, access tokens, notifications, photo intakes, ' +
      'workout adaptations and stored credentials the caller owns. Measurements count active ' +
      'readings (check-in scores included); access tokens count the ones not revoked.',
  })
  @ApiResponse({ status: 200, description: "The caller's data counts", type: UserDataSummaryDto })
  getSummary(@CurrentUser('id') userId: string) {
    return this.userData.getSummary(userId);
  }

  @Post('reset')
  @Auth({ permissions: [PERMISSIONS.USER_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Delete all of the caller's data",
    description:
      `Queues a \`${USER_DATA_RESET_TYPE}\` job that deletes everything the caller owns — ` +
      'workouts, gyms, measurements and check-ins, health profile, photo intakes, programs, ' +
      'training runs, custom exercises and equipment, AI keys and history, stored credentials, ' +
      'personal access tokens, device sessions, push subscriptions, notifications, settings, ' +
      'the profile picture and every uploaded file — and returns at once with **202**. ' +
      'The account, its roles and its sign-in (refresh token) are kept. Poll ' +
      '`GET /api/user-data/reset/{jobId}`.\n\n' +
      `\`confirmation\` must be exactly \`${USER_DATA_RESET_CONFIRMATION}\`; anything else is a ` +
      '**400**. **Idempotent:** while the caller\'s reset is pending or running, the call returns ' +
      'that job instead of queueing another. A reset also deletes the caller\'s personal access ' +
      'tokens, so a client authenticated with a `pat_` token loses access once it runs.',
  })
  @ApiResponse({ status: 202, description: 'The reset job (new, or the one already in flight)', type: UserDataResetStartedDto })
  @ApiResponse({ status: 400, description: 'The confirmation phrase is missing or wrong', type: ErrorDto })
  requestReset(@CurrentUser('id') userId: string, @Body() _dto: UserDataResetRequestDto) {
    return this.userData.requestReset(userId);
  }

  @Get('reset/:jobId')
  @Auth({ permissions: [PERMISSIONS.USER_SETTINGS_WRITE] })
  @ApiParam({ name: 'jobId', description: 'The reset job id returned by `POST /api/user-data/reset`', format: 'uuid' })
  @ApiOperation({
    summary: "Get the status of the caller's data reset",
    description:
      '`status` is `pending`, `running`, `succeeded` or `failed`. Once `succeeded`, `result` ' +
      'counts what was deleted per category, plus `storageObjectsDeleted` and ' +
      '`storageObjectsFailed` (files the storage provider refused to delete; their records are ' +
      'kept so a later reset can retry them). Once `failed`, `error` says why. **404** for any ' +
      "job that is not the caller's own data reset.",
  })
  @ApiResponse({ status: 200, description: 'The reset job status', type: UserDataResetStatusDto })
  @ApiResponse({ status: 404, description: "Not the caller's data reset job", type: ErrorDto })
  getResetStatus(
    @CurrentUser('id') userId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ) {
    return this.userData.getResetStatus(userId, jobId);
  }
}
