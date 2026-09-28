import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { TelemetryPublicConfigDto } from './dto/telemetry-config.dto';
import { TelemetrySettingsService } from './telemetry-settings.service';

// =============================================================================
// TelemetryConfigController — GET /api/telemetry/config (issue #534)
// =============================================================================
//
// `@Auth()` with NO permission, like `GET /api/ai/config`: the web app decides
// whether to render any telemetry surface (nav entries, the settings card's
// feature gate) from this answer, for every signed-in user. It carries three
// booleans and nothing else — no bounds, no provenance, no store details.
// =============================================================================

@ApiTags('Telemetry')
@Controller('telemetry')
export class TelemetryConfigController {
  constructor(private readonly settings: TelemetrySettingsService) {}

  @Get('config')
  @Auth()
  @ApiOperation({
    summary: 'Get the telemetry capabilities of this deployment',
    description:
      'Whether a telemetry store is deployed (`available` — false when GreptimeDB is not ' +
      'configured), whether telemetry collection is switched on (`enabled`), and whether the ' +
      'telemetry assistant is switched on (`assistantEnabled`). Readable by any signed-in ' +
      'user; answers may lag an administrator\'s change by up to five seconds.',
  })
  @ApiResponse({ status: 200, description: 'The telemetry capabilities', type: TelemetryPublicConfigDto })
  async getConfig() {
    return this.settings.describePublic();
  }
}
