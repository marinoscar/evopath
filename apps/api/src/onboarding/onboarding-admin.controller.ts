// =============================================================================
// /api/admin/onboarding — new-user activation metrics (#212)
// =============================================================================
//
// Gated on `system_settings:read`, like the Doctor and the admin half of
// `GET /api/onboarding`: the Setup guide page that shows these numbers is
// already an administrator's surface. Read-only, aggregates only.
// =============================================================================

import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import {
  ACTIVATION_WINDOW_DAYS,
  ONBOARDING_METRICS_DAYS_DEFAULT,
  ONBOARDING_METRICS_DAYS_MAX,
  OnboardingMetricsQueryDto,
  OnboardingMetricsResponse,
  OnboardingMetricsResponseDto,
} from './dto/onboarding-metrics.dto';
import { OnboardingMetricsService } from './onboarding-metrics.service';

@ApiTags('Onboarding')
@Controller('admin/onboarding')
export class OnboardingAdminController {
  constructor(private readonly metricsService: OnboardingMetricsService) {}

  @Get('metrics')
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'Get new-user activation metrics (Admin only)',
    description:
      'Aggregate activation numbers for the users created in the last `days` days (the cohort).\n\n' +
      `\`eligible\` counts cohort users created at least ${ACTIVATION_WINDOW_DAYS} days ago; ` +
      `\`activated\` those among them whose first completed workout came within ${ACTIVATION_WINDOW_DAYS} ` +
      'days of sign-up, and `activationRate` is `activated / eligible` (`null` when none are eligible). ' +
      '`medianHoursToFirstWorkout` is over cohort users with at least one completed workout, rounded ' +
      'to one decimal. `steps` gives, per onboarding step (`health_profile`, `gym`, `first_workout`, ' +
      '`ai_plan`), how many cohort users have it done now and the rate over the cohort.\n\n' +
      '**Read-only**, aggregates only: no per-user data is returned.',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    description: `Cohort window in days, 1 to ${ONBOARDING_METRICS_DAYS_MAX} (default ${ONBOARDING_METRICS_DAYS_DEFAULT}).`,
  })
  @ApiDataResponse(OnboardingMetricsResponseDto, { description: 'The activation metrics.' })
  @ApiResponse({ status: 400, description: 'Invalid query parameter' })
  async metrics(@Query() query: OnboardingMetricsQueryDto): Promise<OnboardingMetricsResponse> {
    const { days } = query as { days: number };

    return this.metricsService.metrics(days);
  }
}
