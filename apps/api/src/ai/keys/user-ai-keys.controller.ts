import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '@marinoscar/platform-api/core';
import { AiEnabledGuard } from '../config/ai-enabled.guard';
import { UsableAiModelDto } from './dto/usable-ai-model.dto';
import {
  SetUserAiKeyDto,
  TestUserAiKeyDto,
  UserAiKeyTestResultDto,
  UserAiKeyViewDto,
} from './dto/user-ai-key.dto';
import { UsableModelsService } from './usable-models.service';
import { UserAiKeysService } from './user-ai-keys.service';

// =============================================================================
// UserAiKeysController (issue #431, epic #419)
// =============================================================================
//
// The caller's own AI surface under `/api/ai/*`:
//
//   GET    /api/ai/keys                    ai:use
//   PUT    /api/ai/keys/:provider          ai:use
//   DELETE /api/ai/keys/:provider          ai:use (204, idempotent)
//   POST   /api/ai/keys/:provider/test     ai:use (always 200)
//   GET    /api/ai/models                  ai:use
//
// `AiEnabledGuard` on the CLASS: while `ai.enabled` is false every route here
// answers `403` with `details.reason: 'AI_DISABLED'` (docs/specs/ai-platform.md
// §2.19). Only `GET /api/ai/config` (AiPublicController) escapes that guard.
//
// Every route acts on `@CurrentUser('id')` — there is no `:userId` anywhere, so
// no request can name another user's key.
//
// ⚠ WRITE-ONLY KEYS. No response here carries key material.
// =============================================================================

const PROVIDER_PARAM = {
  name: 'provider',
  description: 'Provider id, e.g. `openai`.',
  example: 'openai',
} as const;

@ApiTags('AI')
@Controller('ai')
@UseGuards(AiEnabledGuard)
export class UserAiKeysController {
  constructor(
    private readonly keys: UserAiKeysService,
    private readonly usableModels: UsableModelsService,
  ) {}

  @Get('keys')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'List my AI provider keys',
    description:
      'One entry per enabled provider, whether or not you have stored a key for it. Each ' +
      'entry is masked: `hint` shows the last four characters, never the key. ' +
      '`lastErrorCode` records a key the provider has since rejected (it is kept, not ' +
      'deleted). `403` with `details.reason: "AI_DISABLED"` while AI is disabled.',
  })
  @ApiDataResponse(UserAiKeyViewDto, { isArray: true, description: 'Your keys, masked' })
  @ApiResponse({ status: 403, description: '`AI_DISABLED`, or missing `ai:use`', type: ErrorDto })
  async list(@CurrentUser('id') userId: string) {
    return this.keys.list(userId);
  }

  @Put('keys/:provider')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'Set or replace my key for a provider',
    description:
      'The key is **verified against the provider first**, then the models it can reach ' +
      'are computed, and only then is it stored (encrypted). A rejected key answers **400** ' +
      'with `details.reason: "AI_KEY_INVALID"` and **nothing is stored**; an unreachable ' +
      'provider answers with its own error (e.g. 503 `AI_PROVIDER_UNAVAILABLE`), also ' +
      'storing nothing. **Write-only**: the response is the masked view, never the key.',
  })
  @ApiParam(PROVIDER_PARAM)
  @ApiDataResponse(UserAiKeyViewDto, { description: 'The stored key, masked' })
  @ApiResponse({ status: 400, description: 'Validation error, or `AI_KEY_INVALID`', type: ErrorDto })
  @ApiResponse({
    status: 403,
    description: '`AI_DISABLED`, `AI_PROVIDER_DISABLED`, or missing `ai:use`',
    type: ErrorDto,
  })
  @ApiResponse({ status: 503, description: 'The provider could not be reached to verify the key', type: ErrorDto })
  async set(
    @Param('provider') provider: string,
    @Body() dto: SetUserAiKeyDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.keys.set(userId, provider, dto.apiKey);
  }

  @Delete('keys/:provider')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove my key for a provider',
    description: 'Deletes your stored key. Idempotent: removing a key you do not have is a 204.',
  })
  @ApiParam(PROVIDER_PARAM)
  @ApiResponse({ status: 204, description: 'Removed (or there was nothing to remove)' })
  @ApiResponse({ status: 403, description: '`AI_DISABLED`, or missing `ai:use`', type: ErrorDto })
  async remove(@Param('provider') provider: string, @CurrentUser('id') userId: string) {
    await this.keys.remove(userId, provider);
  }

  @Post('keys/:provider/test')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Test a key for a provider',
    description:
      'Runs two checks: `credentials` (the provider accepts the key) and `list_models` ' +
      '(how many catalog models it can reach). A blank or absent `apiKey` tests **your ' +
      'stored key** and also refreshes its verification time, `lastErrorCode` and ' +
      'reachable models; a submitted key is used for this call only and never stored. No ' +
      'test response is generated — that would bill your provider account.\n\n' +
      '⚠ **Always HTTP 200** — a rejected key is a successful diagnosis. Read `success` ' +
      'and each check’s `status`/`code`.',
  })
  @ApiParam(PROVIDER_PARAM)
  @ApiDataResponse(UserAiKeyTestResultDto, { description: 'The probe result (read `success`)' })
  @ApiResponse({ status: 400, description: 'Validation error', type: ErrorDto })
  @ApiResponse({
    status: 403,
    description: '`AI_DISABLED`, `AI_PROVIDER_DISABLED`, or missing `ai:use`',
    type: ErrorDto,
  })
  async test(
    @Param('provider') provider: string,
    @Body() dto: TestUserAiKeyDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.keys.test(userId, provider, dto.apiKey);
  }

  @Get('models')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'List the AI models I can use',
    description:
      'Every model you can call right now: admin-enabled, not deprecated, and reachable ' +
      'with **your** key for its provider (`keySource: "user"`). When you have no key for ' +
      'a provider and an organisation key is stored for it, every admin-enabled model of ' +
      'that provider is listed with `keySource: "org"` when the deployment\'s key policy is ' +
      '`byok_with_org_fallback`, or — under either policy — when you hold `ai_config:write` ' +
      '(the administrator who configured the organisation key). Otherwise that provider ' +
      'contributes nothing. Sorted by provider, ' +
      'then model id. `403` with `details.reason: "AI_DISABLED"` while AI is disabled.',
  })
  @ApiDataResponse(UsableAiModelDto, { isArray: true, description: 'The models you can use' })
  @ApiResponse({ status: 403, description: '`AI_DISABLED`, or missing `ai:use`', type: ErrorDto })
  async listModels(@CurrentUser('id') userId: string) {
    return this.usableModels.listForUser(userId);
  }
}
