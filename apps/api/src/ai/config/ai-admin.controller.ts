import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
import { AI_CAPABILITIES } from '../core/capabilities';
import { AiConfigAdminService } from './ai-config-admin.service';
import { AiModelsAdminService } from './ai-models-admin.service';
import { AiProviderTestService } from './ai-provider-test.service';
import { AiConfigResponseDto, AiKeyRemovalResponseDto } from './dto/ai-config-response.dto';
import {
  AiModelDto,
  AiModelListQueryDto,
  RefreshAiCatalogDto,
  RefreshAiCatalogResultDto,
  UpdateAiModelDto,
} from './dto/ai-model.dto';
import { RemoveAiProviderKeyDto, SetAiProviderKeyDto } from './dto/ai-provider-key.dto';
import { AiProviderTestResultDto, TestAiProviderDto } from './dto/ai-provider-test.dto';
import { UpdateAiConfigDto } from './dto/update-ai-config.dto';

// =============================================================================
// AiAdminController (issue #428, epic #419)
// =============================================================================
//
// The HTTP surface behind the admin AI settings page (#429). Every route is
// gated on `ai_config:read` / `ai_config:write` — a permission pair of its own,
// for the blast-radius reason docs/specs/ai-platform.md §3 gives — and NONE is
// behind `AiEnabledGuard`: an administrator must always be able to turn the
// platform back on (§2.19).
//
//   GET    /api/admin/ai/config                      ai_config:read
//   PUT    /api/admin/ai/config                      ai_config:write
//   PUT    /api/admin/ai/providers/:provider/key     ai_config:write
//   DELETE /api/admin/ai/providers/:provider/key     ai_config:write
//   POST   /api/admin/ai/providers/:provider/test    ai_config:write (always 200)
//   GET    /api/admin/ai/models                      ai_config:read
//   PATCH  /api/admin/ai/models/:id                  ai_config:write
//   POST   /api/admin/ai/models/refresh              ai_config:write
//
// ⚠ THE ADMIN KEY IS WRITE-ONLY. No route here, or anywhere, returns it; the
// responses carry `keyStatus` — a masked hint built without decrypting.
// =============================================================================

const PROVIDER_PARAM = {
  name: 'provider',
  description: 'Provider id, e.g. `openai`.',
  example: 'openai',
} as const;

@ApiTags('AI Administration')
@Controller('admin/ai')
export class AiAdminController {
  constructor(
    private readonly admin: AiConfigAdminService,
    private readonly providerTest: AiProviderTestService,
    private readonly models: AiModelsAdminService,
  ) {}

  @Get('config')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_READ] })
  @ApiOperation({
    summary: 'Get the AI platform configuration (Admin only)',
    description:
      'The `ai` settings namespace — the kill switch, the key policy, prompt logging, ' +
      'defaults — plus one entry per provider (every registered adapter and every provider ' +
      'with a settings slot) carrying its `enabled` switch, `baseUrl` override, the ' +
      'capabilities its adapter supports, and `keyStatus`: a masked description of the ' +
      'stored admin key. **The admin key itself is never returned by this or any other ' +
      'endpoint.**\n\n' +
      'Reachable while AI is disabled — this is how an administrator turns it back on.',
  })
  @ApiResponse({ status: 200, description: 'The AI configuration', type: AiConfigResponseDto })
  async getConfig() {
    return this.admin.describeForAdmin();
  }

  @Put('config')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_WRITE] })
  @ApiOperation({
    summary: 'Replace the AI platform configuration (Admin only)',
    description:
      'Full replace of the `ai` namespace. `providers` is keyed by provider id; a provider ' +
      'left out keeps its stored settings. An empty or null `baseUrl` / `maxOutputTokensCap` ' +
      'clears a stored one. Takes effect immediately on this instance and within five ' +
      'seconds on every other one — no restart.\n\n' +
      'Refused with **400** (reason in `details.reason`) when it enables a provider with no ' +
      'registered adapter (`AI_PROVIDER_NOT_REGISTERED`), names a provider this deployment ' +
      'has no settings slot for (`AI_UNKNOWN_PROVIDER`), ' +
      'or selects `byok_with_org_fallback` while AI is on and an enabled provider has no ' +
      'admin key (`AI_KEY_REQUIRED`). Nothing is written when any of these apply.\n\n' +
      'There is no key field: the admin key has its own routes, so it is verified before it ' +
      'is stored and never travels with a settings save.',
  })
  @ApiHeader({
    name: 'If-Match',
    description:
      'Expected `version` for optimistic concurrency (`0` asserts nothing is stored yet). ' +
      'Omit to overwrite unconditionally. This is the version of the whole system-settings ' +
      'row, so a concurrent save of an unrelated setting can cause a conflict — reload and ' +
      're-apply.',
    required: false,
  })
  @ApiResponse({ status: 200, description: 'The updated AI configuration', type: AiConfigResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error, or a rejected combination (see above)', type: ErrorDto })
  @ApiResponse({ status: 409, description: 'Version conflict', type: ErrorDto })
  async replaceConfig(
    @Body() dto: UpdateAiConfigDto,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    // An unparseable `If-Match` is treated as absent, exactly as
    // `StorageConfigController` does — `NaN !== version` would otherwise turn
    // every save into a 409 no reload can fix.
    const parsed = ifMatch !== undefined ? Number.parseInt(ifMatch, 10) : NaN;
    const expectedVersion = Number.isInteger(parsed) ? parsed : undefined;

    return this.admin.replace(dto, userId, expectedVersion);
  }

  @Put('providers/:provider/key')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_WRITE] })
  @ApiOperation({
    summary: "Set or rotate a provider's admin key (Admin only)",
    description:
      'Stores the admin (org) key for one provider in the encrypted credential store. The ' +
      'key is **verified against the provider first**: a rejected key answers **400** with ' +
      '`details.reason: "AI_KEY_INVALID"` and **nothing is stored**, so a typo can never ' +
      'replace a working key. An unreachable provider answers with its own error (e.g. 503 ' +
      '`AI_PROVIDER_UNAVAILABLE`), also storing nothing.\n\n' +
      'The admin key drives catalog discovery and the connection test, and serves users ' +
      'only under the `byok_with_org_fallback` key policy. It is **write-only**: the response ' +
      'is the admin view, carrying a masked `keyStatus.hint`, never the key.',
  })
  @ApiParam(PROVIDER_PARAM)
  @ApiResponse({ status: 200, description: 'The updated AI configuration', type: AiConfigResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error, or `AI_KEY_INVALID`', type: ErrorDto })
  @ApiResponse({ status: 404, description: 'No adapter is registered for this provider', type: ErrorDto })
  @ApiResponse({ status: 503, description: 'The provider could not be reached to verify the key', type: ErrorDto })
  async setKey(
    @Param('provider') provider: string,
    @Body() dto: SetAiProviderKeyDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.admin.setKey(provider, dto.apiKey, userId);
  }

  @Delete('providers/:provider/key')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Remove a provider's admin key (Admin only)",
    description:
      'Deletes the stored admin key. Requires the typed confirmation ' +
      '`{ "confirmation": "REMOVE" }`. Idempotent. Catalog refresh and the connection test ' +
      'stop working for this provider until a new key is saved.\n\n' +
      'When the key policy is `byok_with_org_fallback`, the response carries ' +
      '`warnings: ["ORG_FALLBACK_WITHOUT_KEY"]` — users without their own key now have no ' +
      'key for this provider.',
  })
  @ApiParam(PROVIDER_PARAM)
  @ApiResponse({
    status: 200,
    description: 'The resulting configuration, plus `warnings`',
    type: AiKeyRemovalResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Missing or incorrect confirmation', type: ErrorDto })
  @ApiResponse({ status: 404, description: 'Unknown provider', type: ErrorDto })
  async deleteKey(
    @Param('provider') provider: string,
    @Body() _dto: RemoveAiProviderKeyDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.admin.deleteKey(provider, userId);
  }

  @Post('providers/:provider/test')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Test a provider key (Admin only)',
    description:
      'Runs up to three checks against the provider: `credentials` (the key is accepted), ' +
      '`list_models` (how many models it can see) and `responses_smoke` (one tiny test ' +
      'response — only when an admin-enabled, non-deprecated text model is visible to the ' +
      'key; otherwise skipped with `no_eligible_model`). A blank `apiKey` tests the stored ' +
      'admin key; a blank `baseUrl` uses the stored override. **Nothing is saved.**\n\n' +
      '**This returns HTTP 200 even when the key is broken** — a refused key is a successful ' +
      'diagnosis. Read `success`, and each check\'s `code` (`ok`, `not_configured`, ' +
      '`not_attempted`, `no_eligible_model`, `not_supported`, or an AI error code such as ' +
      '`AI_KEY_INVALID` / `AI_RATE_LIMITED` / `AI_PROVIDER_UNAVAILABLE`). Gated on ' +
      '`ai_config:write` because it spends a request on the provider account.',
  })
  @ApiParam(PROVIDER_PARAM)
  @ApiResponse({
    status: 200,
    description: 'The outcome of the checks. Check `success`.',
    type: AiProviderTestResultDto,
  })
  @ApiResponse({ status: 404, description: 'No adapter is registered for this provider', type: ErrorDto })
  async testProvider(
    @Param('provider') provider: string,
    @Body() dto: TestAiProviderDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.providerTest.test(provider, dto, userId);
  }

  @Get('models')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_READ] })
  @ApiOperation({
    summary: 'List the AI model catalog (Admin only)',
    description:
      'Every model catalog discovery has found, paginated and filterable, ordered by provider ' +
      'then model id. Deprecated models (no longer listed by their provider) are excluded ' +
      'unless `includeDeprecated=true`. `capabilities` is null for a row whose stored ' +
      'capability record is not valid — typically an `unclassified` model.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: 'Max 100.' })
  @ApiQuery({ name: 'provider', required: false, type: String })
  @ApiQuery({ name: 'capability', required: false, enum: AI_CAPABILITIES })
  @ApiQuery({ name: 'enabled', required: false, enum: ['true', 'false'] })
  @ApiQuery({
    name: 'includeDeprecated',
    required: false,
    enum: ['true', 'false'],
    description: 'Default false.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    type: String,
    description: 'Case-insensitive substring of the model id or display name.',
  })
  @ApiDataResponse(AiModelDto, { pagination: 'flat', description: 'Paginated model catalog' })
  async listModels(@Query() query: AiModelListQueryDto): Promise<unknown> {
    return this.models.list(query);
  }

  // Literal `models/refresh` is declared before the parameterised route below
  // for readability; the methods differ (POST vs PATCH) so they cannot collide.
  @Post('models/refresh')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Refresh a provider's model catalog (Admin only)",
    description:
      'Enqueues an `ai.catalog.refresh` background job for one provider and returns its id; ' +
      'follow it in the Jobs dashboard (`GET /api/admin/jobs`). A refresh already pending or ' +
      'running for the provider is returned instead of a second one being queued.\n\n' +
      'Discovery runs under the admin key, so this answers **409** (`details.reason: ' +
      '"AI_KEY_REQUIRED"`) when none is stored. A refresh never enables a model and never ' +
      'overwrites an `admin_override`.',
  })
  @ApiResponse({ status: 200, description: 'The queued job', type: RefreshAiCatalogResultDto })
  @ApiResponse({ status: 404, description: 'No adapter is registered for this provider', type: ErrorDto })
  @ApiResponse({ status: 409, description: 'No admin key is stored for this provider', type: ErrorDto })
  async refreshModels(@Body() dto: RefreshAiCatalogDto, @CurrentUser('id') userId: string) {
    return this.models.refresh(dto.provider, userId);
  }

  @Patch('models/:id')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_WRITE] })
  @ApiOperation({
    summary: 'Enable, rename or reclassify a model (Admin only)',
    description:
      'Partial update of one catalog row. Supplying `capabilities` (a full capability ' +
      'record) marks the row `admin_override`, which a catalog refresh never overwrites.\n\n' +
      'Enabling is refused with **409** (`AI_MODEL_DEPRECATED`) for a model its provider no ' +
      'longer lists, and with **400** (`AI_MODEL_UNCLASSIFIED`) for an `unclassified` model ' +
      'unless `capabilities` is supplied in the same request.',
  })
  @ApiParam({ name: 'id', description: 'Catalog row id (not the provider model id).', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The updated model', type: AiModelDto })
  @ApiResponse({ status: 400, description: 'Validation error, or enabling an unclassified model', type: ErrorDto })
  @ApiResponse({ status: 404, description: 'No such model', type: ErrorDto })
  @ApiResponse({ status: 409, description: 'Enabling a deprecated model', type: ErrorDto })
  async updateModel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAiModelDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.models.update(id, dto, userId);
  }
}
