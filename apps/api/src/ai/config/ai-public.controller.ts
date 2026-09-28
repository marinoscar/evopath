import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { AiConfigService } from './ai-config.service';
import { AiPublicConfigDto } from './dto/ai-public-config.dto';

// =============================================================================
// AiPublicController — GET /api/ai/config (issue #428, epic #419)
// =============================================================================
//
// `@Auth()` with NO permission, exactly like `GET /api/notifications/config`:
// every signed-in user renders (or hides) AI surfaces against this answer, and
// the users it matters to are precisely the ones who cannot read
// `system_settings`.
//
// ⚠ DELIBERATELY NOT BEHIND `AiEnabledGuard` — it is how a browser learns that
// AI is OFF, so it must answer while AI is off (docs/specs/ai-platform.md §2.19).
// Every other route under `/api/ai/*` carries that guard.
// =============================================================================

@ApiTags('AI')
@Controller('ai')
export class AiPublicController {
  constructor(private readonly aiConfig: AiConfigService) {}

  @Get('config')
  @Auth()
  @ApiOperation({
    summary: 'Get the AI capabilities of this deployment',
    description:
      'Whether AI is enabled, which key policy applies, and — while enabled — each registered ' +
      'provider with whether it is enabled and whether an admin (org) key is stored for it. ' +
      'Readable by any signed-in user, and reachable while AI is disabled: this is how a ' +
      'client learns to hide its AI surfaces. Carries no key, key hint or configuration ' +
      'detail. An admin key serves a user only under `byok_with_org_fallback`. Answers may ' +
      'lag an administrator’s change by up to five seconds.',
  })
  @ApiResponse({ status: 200, description: 'The AI capabilities', type: AiPublicConfigDto })
  async getConfig() {
    return this.aiConfig.describePublic();
  }
}
