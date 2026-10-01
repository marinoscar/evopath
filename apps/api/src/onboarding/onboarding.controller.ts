// =============================================================================
// /api/onboarding — the caller's first-run checklist (#203)
// =============================================================================
//
// Gated on `user_settings:read`: the response is the caller's onboarding UI
// state (a `user_settings` namespace) plus a checklist derived from their own
// data. The admin block is added only for callers holding
// `system_settings:read`, the permission the Doctor it summarises requires.
//
// Read-only: never writes a row, including the default `user_settings` row.
// =============================================================================

import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../common/constants/roles.constants';
import {
  OnboardingQueryDto,
  OnboardingResponse,
  OnboardingResponseDto,
} from './dto/onboarding.dto';
import { OnboardingService } from './onboarding.service';

@ApiTags('Onboarding')
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.USER_SETTINGS_READ] })
  @ApiOperation({
    summary: "Get the caller's first-run onboarding checklist",
    description:
      'Returns the onboarding UI state stored in the `onboarding` user-settings namespace ' +
      '(`welcomeSeenAt`, `checklistDismissedAt`, `goal`; each `null` when unset) and a ' +
      'checklist derived from the data, never stored.\n\n' +
      '`user.steps` lists only the steps the caller can perform: `health_profile` ' +
      '(`health_data:read`), `gym` (`gyms:read`), `first_workout` (`workouts:read`) and ' +
      '`ai_plan` (AI enabled, `ai:use` and `programs:read`). A `strength` or `hypertrophy` ' +
      'goal puts `gym` and `first_workout` before `health_profile`.\n\n' +
      '`admin` is non-null only when the caller holds `system_settings:read`. Its steps ' +
      '(`storage`, `email`, `allowlist` required; `ai`, `push`, `backup` features) are derived ' +
      'from the Doctor report and the allowlist; a step is `done` when every Doctor check it ' +
      "maps to passes, and `detail` is the first non-passing check's remedy.\n\n" +
      '**Read-only.** Requires `user_settings:read`.',
  })
  @ApiQuery({
    name: 'refresh',
    required: false,
    enum: ['true', 'false'],
    description: '`true` bypasses the Doctor report cache for the admin steps.',
  })
  @ApiResponse({ status: 200, description: 'The onboarding checklist.', type: OnboardingResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid query parameter' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing user_settings:read' })
  async get(
    @CurrentUser() user: RequestUser,
    @Query() query: OnboardingQueryDto,
  ): Promise<OnboardingResponse> {
    const { refresh } = query as { refresh?: boolean };

    return this.onboarding.get(
      { id: user.id, permissions: user.permissions },
      { refresh: refresh === true },
    );
  }
}
