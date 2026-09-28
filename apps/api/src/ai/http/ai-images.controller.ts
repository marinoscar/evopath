import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
import { AiEnabledGuard } from '../config/ai-enabled.guard';
import { AiService } from '../runtime/ai.service';
import type { AiEditImageRequest, AiGenerateImageRequest, AiRunHandle } from '../runtime/ai-runtime.types';
import {
  AiImageEditRequestDto,
  AiImageGenerateRequestDto,
  type AiImageEditRequestInput,
  type AiImageGenerateRequestInput,
} from './dto/ai-images.dto';
import { AiRunStartedDto } from './dto/ai-response.dto';

// =============================================================================
// AiImagesController (issue #437, epic #420)
// =============================================================================
//
//   POST /api/ai/images          ai:use   generate images   -> 202 { runId, jobId }
//   POST /api/ai/images/edits    ai:use   edit my images    -> 202 { runId, jobId }
//
// ALWAYS ASYNCHRONOUS. Each request becomes an `ai_runs` row executed by one
// `ai.image.generate` job (CLAUDE.md: every long-running activity is a queue
// job); the result is read from the existing `GET /api/ai/runs/{runId}`,
// whose `output.storageObjectIds` are storage objects the caller owns and
// downloads through `GET /api/storage/objects/{id}/download`. No image bytes
// ever travel in an AI response or sit in a database row.
//
// The gates run now — an unusable request (AI off, no key, a model without
// the capability, an input that is not the caller's) is refused here with
// the ordinary JSON error — and again when the job executes. An edit's
// inputs are the caller's own storage objects: an unknown id is 404 and
// somebody else's is 403, the answers `/api/storage/objects/{id}` gives.
//
// `AiEnabledGuard` on the CLASS (the kill switch answers before auth).
// =============================================================================

const REFUSALS =
  'Refusals carry the AI error code in `details.reason`: `AI_DISABLED`, `AI_PROVIDER_DISABLED`, ' +
  '`AI_MODEL_NOT_ENABLED`, `AI_KEY_REQUIRED`, `AI_MODEL_NOT_REACHABLE` (403); ' +
  '`AI_CAPABILITY_UNSUPPORTED`, `AI_INVALID_REQUEST` (400). A run that later cannot proceed ends ' +
  '`failed` with the code in `errorCode` — including `AI_STORAGE_UNAVAILABLE` when this ' +
  'deployment has no object storage configured to keep the images in.';

@ApiTags('AI')
@Controller('ai/images')
@UseGuards(AiEnabledGuard)
export class AiImagesController {
  constructor(private readonly ai: AiService) {}

  @Post()
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Generate images',
    description:
      'Queues an image generation with **your** key for the provider (or the organisation key, ' +
      'when the deployment allows fallback and you have none) and returns at once with **202**. ' +
      'Poll `GET /api/ai/runs/{runId}`: once `succeeded`, `output.storageObjectIds` are storage ' +
      'objects you own — download each with `GET /api/storage/objects/{id}/download`.\n\n' +
      '`model` is required and must be an enabled model with the `image_generation` capability; ' +
      '`n` is 1-4. Always asynchronous, whatever `allowBackgroundRuns` says.\n\n' +
      REFUSALS,
  })
  @ApiDataResponse(AiRunStartedDto, { status: 202, description: 'The image run was queued' })
  @ApiResponse({
    status: 400,
    description: 'Validation error, `AI_INVALID_REQUEST`, `AI_CAPABILITY_UNSUPPORTED`',
    type: ErrorDto,
  })
  @ApiResponse({
    status: 403,
    description:
      '`AI_DISABLED`, `AI_PROVIDER_DISABLED`, `AI_MODEL_NOT_ENABLED`, `AI_KEY_REQUIRED`, ' +
      '`AI_MODEL_NOT_REACHABLE`, or missing `ai:use`',
    type: ErrorDto,
  })
  async generate(
    @Body() dto: AiImageGenerateRequestDto,
    @CurrentUser('id') userId: string,
  ): Promise<AiRunHandle> {
    return this.ai.forUser(userId).generateImage(toGenerateRequest(dto));
  }

  @Post('edits')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Edit images',
    description:
      'Queues an edit of your own images and returns at once with **202**; poll ' +
      '`GET /api/ai/runs/{runId}` exactly as for a generation.\n\n' +
      '`imageStorageObjectIds` (1-16) and the optional `maskStorageObjectId` name storage objects ' +
      'you uploaded through `/api/storage/objects`: each must be `ready`, a PNG, JPEG or WebP ' +
      '(the mask a PNG) and at most 25 MiB. An unknown id is **404** and another user\'s is ' +
      '**403**, as the storage API itself answers. `model` must be an enabled model with the ' +
      '`image_edit` capability.\n\n' +
      REFUSALS,
  })
  @ApiDataResponse(AiRunStartedDto, { status: 202, description: 'The image edit run was queued' })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, `AI_INVALID_REQUEST` (including an input that is not ready, not an ' +
      'allowed image type, or too large), `AI_CAPABILITY_UNSUPPORTED`',
    type: ErrorDto,
  })
  @ApiResponse({
    status: 403,
    description:
      'An input storage object that is not yours; `AI_DISABLED`, `AI_PROVIDER_DISABLED`, ' +
      '`AI_MODEL_NOT_ENABLED`, `AI_KEY_REQUIRED`, `AI_MODEL_NOT_REACHABLE`; or missing `ai:use`',
    type: ErrorDto,
  })
  @ApiResponse({ status: 404, description: 'An input storage object does not exist', type: ErrorDto })
  async edit(@Body() dto: AiImageEditRequestDto, @CurrentUser('id') userId: string): Promise<AiRunHandle> {
    return this.ai.forUser(userId).editImage(toEditRequest(dto));
  }
}

/** Named fields only — a key added to the DTO later does not reach a provider unexamined. */
function toGenerateRequest(body: AiImageGenerateRequestInput): AiGenerateImageRequest {
  const request: AiGenerateImageRequest = { model: body.model, prompt: body.prompt };

  if (body.provider !== undefined) request.provider = body.provider;
  if (body.size !== undefined) request.size = body.size;
  if (body.quality !== undefined) request.quality = body.quality;
  if (body.background !== undefined) request.background = body.background;
  if (body.outputFormat !== undefined) request.outputFormat = body.outputFormat;
  if (body.n !== undefined) request.n = body.n;
  if (body.providerOptions !== undefined) request.providerOptions = body.providerOptions;

  return request;
}

function toEditRequest(body: AiImageEditRequestInput): AiEditImageRequest {
  const request: AiEditImageRequest = {
    ...toGenerateRequest(body),
    imageStorageObjectIds: body.imageStorageObjectIds,
  };

  if (body.maskStorageObjectId !== undefined) request.maskStorageObjectId = body.maskStorageObjectId;

  return request;
}
