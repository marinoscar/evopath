import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AiEnabledGuard } from '../../ai/config/ai-enabled.guard';
import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '@marinoscar/platform-api/core';
import {
  EstimateTrainingRunDto,
  TrainingModelsView,
  type TrainingModelsViewData,
  TrainingRunEstimate,
  type TrainingRunEstimateData,
} from './dto/training-models.dto';
import { TrainingModelsService } from './training-models.service';

// =============================================================================
// /api/ai/training — the training agents' model settings, read side
// =============================================================================
//
//   GET  /api/ai/training/models     ai:use (+ AiEnabledGuard)   role states
//   POST /api/ai/training/estimate   ai:use (+ AiEnabledGuard)   token estimate and sent data
//
// Owner-scoped by construction: both act on the caller only. Neither makes a
// provider call, and no response carries key material. `AiEnabledGuard` sits
// at class level so the kill switch answers before authentication.
// =============================================================================

const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;
const FORBIDDEN = { status: 403, description: '`AI_DISABLED`, or missing `ai:use`', type: ErrorDto } as const;

@ApiTags('AI Training')
@Controller('ai/training')
@UseGuards(AiEnabledGuard)
export class TrainingModelsController {
  constructor(private readonly trainingModels: TrainingModelsService) {}

  @Get('models')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'My training agent models',
    description:
      'For each training agent role (researcher, planner, critic, evaluator): the model and ' +
      'reasoning effort it will use, or the state that blocks it and who can fix it (`fix`: ' +
      '`keys`, `admin`, or `null` when runnable). Models are chosen by the administrator, never ' +
      'by the user. Precedence: the administrator\'s assignment for the role (`source: ' +
      'admin_feature`, with its reasoning effort), then the administrator\'s default model ' +
      '(`admin_default`), then an automatic pick (`auto`), each only when usable with your key ' +
      'and capable for the role; otherwise a blocking state (`no_key`, `no_models`, ' +
      '`missing_capability`, `web_search_disabled`, `ai_disabled`). An assignment your key cannot ' +
      'use is named in `assignmentUnavailable` and resolution falls through. The researcher needs ' +
      'an OpenAI model with `hosted_tools` and the administrator\'s web-search switch. ' +
      '`effectiveEffort` is always an effort the model offers. Also the run limits and which run ' +
      'kinds can start.',
  })
  @ApiDataResponse(TrainingModelsView, { description: 'Role states, limits and run readiness' })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  models(@CurrentUser('id') userId: string): Promise<TrainingModelsViewData> {
    return this.trainingModels.overview(userId);
  }

  @Post('estimate')
  @HttpCode(HttpStatus.OK)
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'Estimate a training run\'s tokens',
    description:
      'A rough low and high token count (input plus output, by role) for a `create`, `revise` ' +
      'or `evaluate` run with your current models and efforts, and the per-run cap that applies. ' +
      'An estimate, not a quote: tokens only, never a price. With a `create` intake, or the `revise` ' +
      'fields (`programId`, `basedOnVersion`, `instruction`), it also returns `sentData`: what each agent ' +
      'that will run is sent, built by the same context builder the run uses. Makes no provider call and ' +
      'creates no run.',
  })
  @ApiDataResponse(TrainingRunEstimate, { description: 'The estimate, the cap and what will be sent' })
  @ApiResponse({ status: 400, description: 'Validation error', type: ErrorDto })
  @ApiResponse({ status: 404, description: 'The intake\'s gym or the revised program is not yours', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  estimate(@CurrentUser('id') userId: string, @Body() dto: EstimateTrainingRunDto): Promise<TrainingRunEstimateData> {
    return this.trainingModels.estimate(userId, dto);
  }
}
