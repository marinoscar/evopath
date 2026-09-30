import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AiEnabledGuard } from '../ai/config/ai-enabled.guard';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../common/dto/error.dto';
import {
  TRAINING_USAGE_MAX_MONTHS_BACK,
  TrainingMonthlyUsageDto,
  TrainingRunUsageDto,
  TrainingUsageMonthQueryDto,
  TrainingUsageRunParamDto,
  type TrainingMonthlyUsage,
  type TrainingRunUsage,
} from './dto/training-usage.dto';
import { TrainingUsageService } from './training-usage.service';

// =============================================================================
// Training agent usage (E6.3)
// =============================================================================
//
//   GET /api/ai/training/runs/:runId/usage   ai:use (+ AiEnabledGuard)   one of my runs
//   GET /api/ai/training/usage?month=YYYY-MM ai:use (+ AiEnabledGuard)   my agent runs in a month
//
// OWNER-SCOPED BY CONSTRUCTION: no DTO carries a user id; the service is handed
// the authenticated caller and keys every statement by it. Another user's run
// is a 404. Tokens, model and key source only: no currency.
// =============================================================================

const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;
const FORBIDDEN = { status: 403, description: '`AI_DISABLED`, or missing `ai:use`', type: ErrorDto } as const;

@ApiTags('AI Training')
@Controller('ai/training')
@UseGuards(AiEnabledGuard)
export class TrainingUsageController {
  constructor(private readonly usage: TrainingUsageService) {}

  @Get('runs/:runId/usage')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'Usage of one of my training agent runs, by node and role',
    description:
      'Tokens, requests and failures of every provider round trip the run made (a plan run, an ' +
      'evaluation or a quick adaptation), in total and per graph node with its agent role, provider, ' +
      'model and key source (`user`: your key, `org`: the organisation key, `none`: a keyless server). ' +
      'Tokens only: no currency is computed. `totals` equals your AI usage report restricted to the ' +
      'run\'s jobs. A row with `node: null` holds what cannot be pinned to one node (typically a failed ' +
      'call when two nodes share a model).\n\n' +
      '`cap` is the run\'s token limit, the tokens counted against it (input + output + reasoning, the ' +
      'count the budget enforces) and whether it was reached (the run failed ' +
      '`TRAINING_RUN_BUDGET_EXCEEDED`, or a critic or revision was skipped). `retention.purged` is ' +
      'true when `ai.usageRetentionDays` removed the usage rows: the numbers then come from the ' +
      'run\'s own tally (no failures or cached input). A running run reports partial numbers.',
  })
  @ApiParam({ name: 'runId', description: 'The run id (`runId` of a training run or an adaptation).' })
  @ApiDataResponse(TrainingRunUsageDto, { description: 'The run\'s usage' })
  @ApiResponse({ status: 400, description: 'Validation error', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  @ApiResponse({ status: 404, description: 'No such run of yours', type: ErrorDto })
  runUsage(@CurrentUser('id') userId: string, @Param() params: TrainingUsageRunParamDto): Promise<TrainingRunUsage> {
    return this.usage.runUsage(userId, params.runId);
  }

  @Get('usage')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'My training agent usage in a month',
    description:
      'Every provider round trip of your agent runs in one UTC month (days inclusive, like the ' +
      'platform reports), by agent role, by model, by key source and by run kind (`create`, ' +
      '`revise`, `evaluate`, `adapt`). Usage outside agent runs is not included (see ' +
      '`GET /api/ai/usage/me` for all of it). Tokens only: no currency. `unattributed` in `byRole` ' +
      'holds what cannot be pinned to one role.\n\n' +
      '`typical` is the median tokens of your last 10 completed runs of each kind (any month), ' +
      '`null` with fewer than 3. `retention.partial` means part of the month is older than ' +
      '`ai.usageRetentionDays` and its rows may be gone.\n\n' +
      `Refused with **400** (\`details.reason: "TRAINING_USAGE_MONTH_INVALID"\`) for a month in the ` +
      `future or more than ${TRAINING_USAGE_MAX_MONTHS_BACK} months back.`,
  })
  @ApiQuery({ name: 'month', required: false, type: String, description: 'UTC month, `YYYY-MM`. Default: the current month.' })
  @ApiDataResponse(TrainingMonthlyUsageDto, { description: 'Your agent usage in the month' })
  @ApiResponse({ status: 400, description: 'Invalid query, or `TRAINING_USAGE_MONTH_INVALID`', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  monthly(@CurrentUser('id') userId: string, @Query() query: TrainingUsageMonthQueryDto): Promise<TrainingMonthlyUsage> {
    return this.usage.monthlyUsage(userId, query.month);
  }
}
