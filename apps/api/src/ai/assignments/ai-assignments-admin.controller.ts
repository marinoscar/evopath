import { Body, Controller, Get, Headers, Put } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
import { AiAssignmentsAdminService } from './ai-assignments-admin.service';
import { AiAssignmentsResponseDto, type AiAssignmentsResponse, UpdateAiAssignmentsDto } from './dto/ai-assignments.dto';

// =============================================================================
// AiAssignmentsAdminController (#173)
// =============================================================================
//
//   GET /api/admin/ai/assignments   ai_config:read
//   PUT /api/admin/ai/assignments   ai_config:write
//
// Like every `/api/admin/ai/*` route, NOT behind `AiEnabledGuard`: an
// administrator configures assignments whether or not AI is on.
// =============================================================================

@ApiTags('AI Administration')
@Controller('admin/ai')
export class AiAssignmentsAdminController {
  constructor(private readonly assignments: AiAssignmentsAdminService) {}

  @Get('assignments')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_READ] })
  @ApiOperation({
    summary: 'Get the AI model assignments (Admin only)',
    description:
      'Which model each AI feature uses across the organisation: the stored `assignments` ' +
      '(`default` plus one entry per feature, `null` when unassigned), and for the default and ' +
      'each feature the models that are eligible (enabled, not deprecated, provider enabled, and ' +
      'capable for the feature) plus a `warning` when a stored assignment no longer is. Users never ' +
      'choose a model: each feature resolves to its assignment, then the default, then an automatic ' +
      'pick, each only when usable for the caller.\n\nReachable while AI is disabled.',
  })
  @ApiDataResponse(AiAssignmentsResponseDto, { description: 'The assignments and each feature’s eligible models' })
  @ApiResponse({ status: 401, description: 'Not authenticated', type: ErrorDto })
  @ApiResponse({ status: 403, description: 'Missing `ai_config:read`', type: ErrorDto })
  get(): Promise<AiAssignmentsResponse> {
    return this.assignments.describe();
  }

  @Put('assignments')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_WRITE] })
  @ApiOperation({
    summary: 'Replace the AI model assignments (Admin only)',
    description:
      'Full replace of `ai.assignments`: `default` (or `null`) and `features` (a feature left out ' +
      'or `null` is unassigned). `reasoningEffort` applies to the `training.*` features only. Each ' +
      'model must be in the catalog, enabled, not deprecated, of an enabled provider, and — for a ' +
      'feature — capable for it; the default needs only to be enabled.\n\n' +
      'Refused with **400** `details.reason: "AI_ASSIGNMENT_INVALID"` and `details.errors[]` ' +
      '(`field`, `provider`, `modelId`, `code`, `message`, `missing?`), writing nothing. ' +
      'Takes effect immediately on this instance and within five seconds on every other one.',
  })
  @ApiHeader({
    name: 'If-Match',
    description:
      'Expected `version` for optimistic concurrency (`0` asserts nothing is stored yet). Omit to ' +
      'overwrite unconditionally. The version of the whole system-settings row.',
    required: false,
  })
  @ApiDataResponse(AiAssignmentsResponseDto, { description: 'The updated assignments' })
  @ApiResponse({ status: 400, description: 'Validation error, or `AI_ASSIGNMENT_INVALID`', type: ErrorDto })
  @ApiResponse({ status: 401, description: 'Not authenticated', type: ErrorDto })
  @ApiResponse({ status: 403, description: 'Missing `ai_config:write`', type: ErrorDto })
  @ApiResponse({ status: 409, description: 'Version conflict', type: ErrorDto })
  replace(
    @Body() dto: UpdateAiAssignmentsDto,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch?: string,
  ): Promise<AiAssignmentsResponse> {
    // An unparseable `If-Match` is treated as absent, as `AiAdminController` does.
    const parsed = ifMatch !== undefined ? Number.parseInt(ifMatch, 10) : NaN;

    return this.assignments.replace(dto, userId, Number.isInteger(parsed) ? parsed : undefined);
  }
}
