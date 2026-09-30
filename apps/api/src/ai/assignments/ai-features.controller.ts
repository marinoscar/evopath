import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
import { AiEnabledGuard } from '../config/ai-enabled.guard';
import { AiFeatureModelResolver } from './ai-feature-model-resolver.service';
import { AiFeaturesView, type AiFeaturesViewData } from './dto/ai-feature-resolution.dto';

// =============================================================================
// GET /api/ai/features (#173) — ai:use (+ AiEnabledGuard)
// =============================================================================
//
// The caller's resolution for every AI feature: the model the administrator's
// assignments (or the auto pick) give them, or the state that blocks it.
// Owner-scoped by construction; makes no provider call; no key material.
// `AiEnabledGuard` at class level so the kill switch answers before auth.
// =============================================================================

@ApiTags('AI')
@Controller('ai')
@UseGuards(AiEnabledGuard)
export class AiFeaturesController {
  constructor(private readonly resolver: AiFeatureModelResolver) {}

  @Get('features')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'My AI feature models',
    description:
      'For each AI feature (photo features and training agents): the model it will use for you and ' +
      'whose key pays (`model.keySource`), where that choice came from (`source`: `admin_feature`, ' +
      '`admin_default` or `auto`), or the blocking `state` and who can fix it (`fix`: `keys` or ' +
      '`admin`). States: `ready`, `auto` (runnable); `no_key` (no key source at all), `no_models` ' +
      '(a key source but no usable model), `missing_capability`, `web_search_disabled`, ' +
      '`ai_disabled`. `assignmentUnavailable` names an administrator assignment your key cannot ' +
      'use (resolution fell through). Models are chosen by the administrator; users do not pick them.',
  })
  @ApiDataResponse(AiFeaturesView, { description: 'One resolution per feature, in registry order' })
  @ApiResponse({ status: 401, description: 'Not authenticated', type: ErrorDto })
  @ApiResponse({ status: 403, description: '`AI_DISABLED`, or missing `ai:use`', type: ErrorDto })
  features(@CurrentUser('id') userId: string): Promise<AiFeaturesViewData> {
    return this.resolver.overview(userId);
  }
}
