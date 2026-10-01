import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
import type { SystemCoachValue } from '../../common/schemas/settings.schema';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { PutSystemCoachSettingsDto, SystemCoachSettingsView } from '../dto/coach-admin-settings.dto';

// =============================================================================
// /api/admin/coach/settings — the deployment's coach policy (E7.2, #242)
// =============================================================================
//
// `ai_config:read` / `ai_config:write`, deliberately NOT behind
// `AiEnabledGuard` (AI rule 4): an administrator can always reach the coach
// policy, even while AI is off. Stored in the system settings row's `coach`
// namespace, through `SystemSettingsService` (validated and audited there).
// =============================================================================

const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;

@ApiTags('AI Coach Administration')
@Controller('admin/coach')
export class CoachAdminSettingsController {
  constructor(private readonly systemSettings: SystemSettingsService) {}

  @Get('settings')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_READ] })
  @ApiOperation({
    summary: 'Get the coach policy (Admin only)',
    description:
      'The deployment-wide coach policy: the coach switch, whether the profane persona level may be unlocked, ' +
      'whether spoken messages are allowed, the ceiling on a user\'s daily nudges, audio retention, the ' +
      'auto-silence threshold and the inactivity stop. Reachable while AI is off.',
  })
  @ApiDataResponse(SystemCoachSettingsView, { description: 'The coach policy' })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse({ status: 403, description: 'Missing `ai_config:read`', type: ErrorDto })
  view(): Promise<SystemCoachValue> {
    return this.systemSettings.getCoachPolicy();
  }

  @Put('settings')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_WRITE] })
  @ApiOperation({
    summary: 'Update the coach policy (Admin only)',
    description:
      'Updates the coach policy. An omitted field keeps its value. Turning `allowProfanePersonas` off ' +
      'silences profanity from the next message; users\' stored settings are not changed. A lower ' +
      '`maxNudgesPerDayCeiling` clamps every user\'s daily nudges at read time. Reachable while AI is off.',
  })
  @ApiDataResponse(SystemCoachSettingsView, { description: 'The updated coach policy' })
  @ApiResponse({ status: 400, description: 'Validation error', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse({ status: 403, description: 'Missing `ai_config:write`', type: ErrorDto })
  async update(@CurrentUser('id') userId: string, @Body() dto: PutSystemCoachSettingsDto): Promise<SystemCoachValue> {
    const saved = await this.systemSettings.patchSettings({ coach: dto } as never, userId);
    return saved.coach;
  }
}
