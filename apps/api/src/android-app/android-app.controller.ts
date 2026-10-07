import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ErrorDto } from '@marinoscar/platform-api/core';
import { AndroidAppPushService } from '../notifications/android-app-push.service';
import { AndroidAppService } from './android-app.service';
import {
  AndroidAppResponseDto,
  AndroidAppTestNotificationDto,
  AndroidAppTestNotificationResponseDto,
  UpdateAndroidAppDto,
} from './dto/android-app.dto';

// =============================================================================
// AndroidAppController (issue #279, epic #276)
// =============================================================================
//
//   GET /api/admin/android-app   system_settings:read
//   PUT /api/admin/android-app   system_settings:write
//   POST /api/admin/android-app/test-notification   system_settings:write (#312)
//
// The same permission strings as the rest of the system settings surface, so
// the admin "Android app" card declares `system_settings:read` (CLAUDE.md,
// Settings UI Pattern rule 3) and the editor is disabled without `:write`.
// =============================================================================

@ApiTags('Android App')
@Controller('admin/android-app')
export class AndroidAppController {
  constructor(
    private readonly androidApp: AndroidAppService,
    private readonly androidAppPush: AndroidAppPushService,
  ) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'Get the trusted Android apps (Admin only)',
    description:
      'The Android apps this deployment trusts to open it as a Trusted Web Activity (full screen, ' +
      'no URL bar), the apps paired devices actually report (`reportedApps`: package and signing ' +
      'certificate fingerprint, with a device count and whether the pair is trusted), and the ' +
      'Digital Asset Links document `/.well-known/assetlinks.json` currently serves, and Web Push ' +
      'subscription counts by platform (`pushSubscriptions`).',
  })
  @ApiResponse({ status: 200, description: 'Trusted and reported apps', type: AndroidAppResponseDto })
  async get() {
    return this.androidApp.describe();
  }

  @Put()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Replace the trusted Android apps (Admin only)',
    description:
      'Replaces the whole list (at most 10). `packageName` is an Android application id ' +
      '(`com.example.app`); `sha256` is the signing certificate\'s SHA-256 fingerprint as ' +
      '`keytool` prints it (32 colon-separated hex bytes), accepted in either case and stored ' +
      'uppercase. Repeated pairs are dropped. `/.well-known/assetlinks.json` reflects the change ' +
      'immediately (clients may cache it for five minutes). Audited.',
  })
  @ApiResponse({ status: 200, description: 'The saved state', type: AndroidAppResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error', type: ErrorDto })
  async replace(@Body() dto: UpdateAndroidAppDto, @CurrentUser('id') userId: string) {
    return this.androidApp.replace(dto, userId);
  }

  @Post('test-notification')
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a test notification to the Android app (Admin only)',
    description:
      'Sends one Web Push to every subscription the target user (`userId`, default the caller) ' +
      'registered from inside the Android app (`platform: android_app`), through the deployment\'s ' +
      'VAPID configuration. Not a notification: no inbox row, preferences do not apply. Always ' +
      '200 when the request is valid: `results` has one row per subscription (`sent`, `failed`, or ' +
      '`gone` when the push service answered 404/410 and the subscription was removed), and ' +
      '`reason` explains an empty send (`PUSH_NOT_CONFIGURED`: no active VAPID key pair; ' +
      '`NO_ANDROID_SUBSCRIPTION`: the user has not enabled notifications in the app). Audited as ' +
      '`android_app.test_notification.sent`.',
  })
  @ApiResponse({ status: 200, description: 'The per-subscription outcome', type: AndroidAppTestNotificationResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error', type: ErrorDto })
  @ApiResponse({ status: 404, description: 'No such user', type: ErrorDto })
  async testNotification(@Body() dto: AndroidAppTestNotificationDto, @CurrentUser('id') userId: string) {
    return this.androidAppPush.sendTest(userId, dto.userId);
  }
}
