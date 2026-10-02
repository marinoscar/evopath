import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AiEnabledGuard } from '../ai/config/ai-enabled.guard';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../common/dto/error.dto';
import { HealthSummaryView, type HealthSummaryViewData, SetHealthSummaryConsentDto } from './dto/health-summary.dto';
import { HealthSummaryService } from './health-summary.service';

// =============================================================================
// /api/ai/training/health-summary — the opt-in AI health summary (H8, #192)
// =============================================================================
//
//   GET  /api/ai/training/health-summary          ai:use + health_data:read
//   PUT  /api/ai/training/health-summary/consent  ai:use + health_data:write (audited)
//   POST /api/ai/training/health-summary/refresh  ai:use + health_data:write (enqueues a job)
//
// Owner-scoped by construction: every route acts on the caller only.
// `AiEnabledGuard` at class level, like every consumer route under
// `/api/ai/*`: while AI is off nothing is generated and nothing is sent, so
// the consent cannot matter. No response carries key material or raw health
// values: the summary text is the caller's own.
// =============================================================================

const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;
const FORBIDDEN = {
  status: 403,
  description: '`AI_DISABLED`, or missing `ai:use` or the `health_data` permission',
  type: ErrorDto,
} as const;

@ApiTags('AI Training')
@Controller('ai/training/health-summary')
@UseGuards(AiEnabledGuard)
export class HealthSummaryController {
  constructor(private readonly summaries: HealthSummaryService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.AI_USE, PERMISSIONS.HEALTH_DATA_READ] })
  @ApiOperation({
    summary: 'My AI health summary',
    description:
      'Whether "Use my health data in training plans and coach chat" is on, what turning it on shares and which model ' +
      'provider processes it, the newest summary (verbatim, as the training agents and the coach chat receive it ' +
      'while the consent is on), the newest attempt, and whether the summary is stale (the health data changed since). ' +
      'Makes no provider call.',
  })
  @ApiDataResponse(HealthSummaryView, { description: 'The consent, the summary and its state' })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  view(@CurrentUser('id') userId: string): Promise<HealthSummaryViewData> {
    return this.summaries.view(userId);
  }

  @Put('consent')
  @Auth({ permissions: [PERMISSIONS.AI_USE, PERMISSIONS.HEALTH_DATA_WRITE] })
  @ApiOperation({
    summary: 'Turn the health summary on or off',
    description:
      'Turns "Use my health data in training plans and coach chat" on or off (off by default). On: a summary of your lab ' +
      'results, blood pressure, resting heart rate, body measurements and check-in scores is written by the ' +
      'administrator\'s model for this feature (queued at once). Training plans then use the summary; the AI Coach ' +
      'chat may read the summary and, on request, look up your individual biomarker values (lab results with dates, ' +
      'units, flags and reference ranges; never documents, file names or notes). Off: generation stops (a queued ' +
      'summary is cancelled), later training runs omit the summary, and the coach chat can read neither the summary ' +
      'nor biomarker values. Audited ' +
      '(`health_summary:consent`). Returns the updated view.',
  })
  @ApiDataResponse(HealthSummaryView, { description: 'The updated consent and summary state' })
  @ApiResponse({ status: 400, description: 'Validation error', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  setConsent(@CurrentUser('id') userId: string, @Body() dto: SetHealthSummaryConsentDto): Promise<HealthSummaryViewData> {
    return this.summaries.setConsent(userId, dto.enabled);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.ACCEPTED)
  @Auth({ permissions: [PERMISSIONS.AI_USE, PERMISSIONS.HEALTH_DATA_WRITE] })
  @ApiOperation({
    summary: 'Refresh my health summary',
    description:
      'Queues a new summary now (an `ai.health.summary` job), even when the health data has not changed. ' +
      '409 `HEALTH_SUMMARY_CONSENT_OFF` while the consent is off, `HEALTH_SUMMARY_NO_DATA` without health data.',
  })
  @ApiDataResponse(HealthSummaryView, { status: 202, description: 'Queued; the view with `pending: true`' })
  @ApiResponse({ status: 409, description: 'Consent off, or no health data', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  refresh(@CurrentUser('id') userId: string): Promise<HealthSummaryViewData> {
    return this.summaries.refresh(userId);
  }
}
