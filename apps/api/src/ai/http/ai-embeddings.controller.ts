import { Body, Controller, HttpCode, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
import { AiEnabledGuard } from '../config/ai-enabled.guard';
import { AI_EMBEDDINGS_MAX_INPUTS } from '../core/types/media.types';
import { AiService } from '../runtime/ai.service';
import type { AiEmbedRequest } from '../runtime/ai-runtime.types';
import { abortOnDisconnect } from './ai-sse';
import {
  AiEmbeddingsRequestDto,
  AiEmbeddingsResponseDto,
  type AiEmbeddingsHttpResponse,
  type AiEmbeddingsRequestInput,
} from './dto/ai-embeddings.dto';

// =============================================================================
// AiEmbeddingsController (issue #440, epic #420)
// =============================================================================
//
//   POST /api/ai/embeddings    ai:use    vectors for one text or a batch
//
// Synchronous, like `POST /api/ai/responses`: one provider round-trip, no
// job. A large backfill is a fork's own job type calling `AiService.embed`
// per chunk — never a loop of HTTP calls holding a request open.
//
// `AiEnabledGuard` on the CLASS (the kill switch answers before auth), and
// every other gate runs inside `AiService.embed` — the same pipeline an
// in-process caller gets. The caller is always `@CurrentUser('id')`, so a
// request can only spend the caller's own key (or the org fallback).
// =============================================================================

@ApiTags('AI')
@Controller('ai')
@UseGuards(AiEnabledGuard)
export class AiEmbeddingsController {
  constructor(private readonly ai: AiService) {}

  @Post('embeddings')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Create embeddings',
    description:
      'One embedding vector per input text, in input order, generated with **your** key for ' +
      'the provider (or the organisation key, when the deployment allows fallback and you ' +
      'have none).\n\n' +
      '`model` is required and must be an enabled model with the `embeddings` capability — ' +
      'vectors are only comparable within one model, so store `model` (and `dimensions`) ' +
      `beside them. \`input\` is one text or up to ${AI_EMBEDDINGS_MAX_INPUTS} texts; a larger ` +
      'batch is refused with `AI_INVALID_REQUEST` — split it into chunks, and for a large ' +
      'backfill enqueue a job that embeds one chunk at a time. `dimensions` shortens every ' +
      'vector where the model supports it (OpenAI `text-embedding-3-*`); a model that does ' +
      'not is `AI_INVALID_REQUEST`. The request body is limited to 1 MB.\n\n' +
      'Refusals carry the AI error code in `details.reason`: `AI_DISABLED`, ' +
      '`AI_PROVIDER_DISABLED`, `AI_MODEL_NOT_ENABLED`, `AI_KEY_REQUIRED`, ' +
      '`AI_MODEL_NOT_REACHABLE` (403); `AI_CAPABILITY_UNSUPPORTED` (the model does not ' +
      'embed), `AI_INVALID_REQUEST`, `AI_KEY_INVALID` (400); `AI_RATE_LIMITED` (429); ' +
      '`AI_PROVIDER_UNAVAILABLE` (503).',
  })
  @ApiDataResponse(AiEmbeddingsResponseDto, { description: 'The vectors' })
  @ApiResponse({
    status: 400,
    description: 'Validation error, `AI_INVALID_REQUEST`, `AI_CAPABILITY_UNSUPPORTED`, `AI_KEY_INVALID`',
    type: ErrorDto,
  })
  @ApiResponse({
    status: 403,
    description:
      '`AI_DISABLED`, `AI_PROVIDER_DISABLED`, `AI_MODEL_NOT_ENABLED`, `AI_KEY_REQUIRED`, ' +
      '`AI_MODEL_NOT_REACHABLE`, or missing `ai:use`',
    type: ErrorDto,
  })
  @ApiResponse({
    status: 429,
    description:
      '`AI_RATE_LIMITED` — the provider throttled the call, or a deployment rate limit (`ai.limits`, named in `details.limit`) was reached. `details.retryAfterMs` and the `Retry-After` header (seconds) say when to retry',
    type: ErrorDto,
  })
  @ApiResponse({ status: 503, description: '`AI_PROVIDER_UNAVAILABLE`', type: ErrorDto })
  async embed(
    @Body() dto: AiEmbeddingsRequestDto,
    @CurrentUser('id') userId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AiEmbeddingsHttpResponse> {
    const disconnect = abortOnDisconnect(reply.raw);

    try {
      const result = await this.ai.forUser(userId).embed(toEmbedRequest(dto), { signal: disconnect.signal });

      return {
        provider: result.provider,
        model: result.model,
        dimensions: result.dimensions,
        vectors: result.vectors,
        usage: result.usage,
      };
    } finally {
      disconnect.dispose();
    }
  }
}

/** Named fields only — a key added to the DTO later does not reach a provider unexamined. */
function toEmbedRequest(body: AiEmbeddingsRequestInput): AiEmbedRequest {
  const request: AiEmbedRequest = { model: body.model, input: body.input };

  if (body.provider !== undefined) request.provider = body.provider;
  if (body.dimensions !== undefined) request.dimensions = body.dimensions;
  if (body.providerOptions !== undefined) request.providerOptions = body.providerOptions;

  return request;
}
