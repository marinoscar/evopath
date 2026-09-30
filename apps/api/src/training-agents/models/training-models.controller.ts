import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AiEnabledGuard } from '../../ai/config/ai-enabled.guard';
import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
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
//   POST /api/ai/training/estimate   ai:use (+ AiEnabledGuard)   token estimate
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
      'reasoning effort it will use, or the state that blocks it and where to fix it (`fix`: ' +
      '`settings`, `keys` or `admin`). Precedence: your per-role choice, then your default ' +
      'model, then an automatic pick (`auto`). The researcher needs an OpenAI model with ' +
      '`hosted_tools` and the administrator\'s web-search switch. `effectiveEffort` is always an ' +
      'effort the model offers. Also the run limits and which run kinds can start.',
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
      'An estimate, not a quote: tokens only, never a price. Makes no provider call.',
  })
  @ApiDataResponse(TrainingRunEstimate, { description: 'The estimate and the cap' })
  @ApiResponse({ status: 400, description: 'Validation error', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  estimate(@CurrentUser('id') userId: string, @Body() dto: EstimateTrainingRunDto): Promise<TrainingRunEstimateData> {
    return this.trainingModels.estimate(userId, dto);
  }
}
