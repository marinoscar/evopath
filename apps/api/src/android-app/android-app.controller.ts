import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ErrorDto } from '../common/dto/error.dto';
import { AndroidAppService } from './android-app.service';
import { AndroidAppResponseDto, UpdateAndroidAppDto } from './dto/android-app.dto';

// =============================================================================
// AndroidAppController (issue #279, epic #276)
// =============================================================================
//
//   GET /api/admin/android-app   system_settings:read
//   PUT /api/admin/android-app   system_settings:write
//
// The same permission strings as the rest of the system settings surface, so
// the admin "Android app" card declares `system_settings:read` (CLAUDE.md,
// Settings UI Pattern rule 3) and the editor is disabled without `:write`.
// =============================================================================

@ApiTags('Android App')
@Controller('admin/android-app')
export class AndroidAppController {
  constructor(private readonly androidApp: AndroidAppService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'Get the trusted Android apps (Admin only)',
    description:
      'The Android apps this deployment trusts to open it as a Trusted Web Activity (full screen, ' +
      'no URL bar), the apps paired devices actually report (`reportedApps`: package and signing ' +
      'certificate fingerprint, with a device count and whether the pair is trusted), and the ' +
      'Digital Asset Links document `/.well-known/assetlinks.json` currently serves.',
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
}
