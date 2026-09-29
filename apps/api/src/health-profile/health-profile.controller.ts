import { BadRequestException, Body, Controller, Get, Headers, Put } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { HealthProfileDto, HealthProfileInputDto } from './dto/health-profile.dto';
import { HealthProfileService } from './health-profile.service';

// =============================================================================
// /api/health-profile — the caller's own health profile (E2.1, #47)
// =============================================================================
//
// Named `health-profile`, not `health`: `/api/health` is the liveness module.
// There is no id parameter — the profile is always the JWT user's.
// `health_data:*` is deliberately separate from `user_settings:*` so a
// deployment can withhold health data from a role without also blocking its
// UI preferences (see `common/constants/roles.constants.ts`).
// =============================================================================

@ApiTags('Health Profile')
@Controller('health-profile')
export class HealthProfileController {
  constructor(private readonly healthProfile: HealthProfileService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_READ] })
  @ApiOperation({
    summary: "Get the caller's health profile",
    description:
      'Returns the stored profile, or an empty one (all fields null, `unitSystem: metric`, `version: 0`, `updatedAt: null`) when none has been saved.',
  })
  @ApiResponse({ status: 200, description: 'Health profile', type: HealthProfileDto })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing health_data:read' })
  async get(@CurrentUser('id') userId: string) {
    return this.healthProfile.get(userId);
  }

  @Put()
  @Auth({ permissions: [PERMISSIONS.HEALTH_DATA_WRITE] })
  @ApiOperation({
    summary: "Replace the caller's health profile",
    description:
      'Full replace (upsert). Every nullable field that is omitted is stored as null; only `unitSystem` is required. Send the `version` from the last read as `If-Match` to refuse a save over a newer one (409).',
  })
  @ApiHeader({
    name: 'If-Match',
    description:
      'Expected version for optimistic concurrency (0 when no profile has been saved yet). Omit to overwrite unconditionally.',
    required: false,
  })
  @ApiResponse({ status: 200, description: 'Saved health profile', type: HealthProfileDto })
  @ApiResponse({ status: 400, description: 'Validation error or malformed If-Match' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing health_data:write' })
  @ApiResponse({ status: 409, description: 'Version conflict' })
  async put(
    @CurrentUser('id') userId: string,
    @Body() dto: HealthProfileInputDto,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.healthProfile.put(userId, dto, parseIfMatch(ifMatch));
  }
}

/** `If-Match: 3` or `If-Match: "3"` -> 3; absent -> undefined; anything else -> 400. */
export function parseIfMatch(header: string | undefined): number | undefined {
  if (header === undefined || header.trim() === '') {
    return undefined;
  }

  const raw = header.trim().replace(/^"(.*)"$/, '$1');

  if (!/^\d+$/.test(raw)) {
    throw new BadRequestException('If-Match must be a non-negative integer version');
  }

  return parseInt(raw, 10);
}
