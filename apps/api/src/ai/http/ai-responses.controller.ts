import { Body, Controller, HttpCode, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
import { AiEnabledGuard } from '../config/ai-enabled.guard';
import type { AiResponse, AiStreamEvent } from '../core/types/responses.types';
import { AiService } from '../runtime/ai.service';
import { toAiRequest } from './ai-http-request';
import { AI_SSE_HEARTBEAT_MS, abortOnDisconnect, pipeAiSse } from './ai-sse';
import { AiResponseRequestDto } from './dto/ai-response-request.dto';
import { AiResponseDto } from './dto/ai-response.dto';

// =============================================================================
// AiResponsesController (issue #433, epic #419) — the consumer HTTP API
// =============================================================================
//
// HTTP access to the runtime facade for the web Playground and the CLI
// (`appctl api post /ai/responses …`):
//
//   POST /api/ai/responses              ai:use   one response
//   POST /api/ai/responses/stream       ai:use   one response, streamed (SSE)
//
// `AiEnabledGuard` on the CLASS: while `ai.enabled` is false every route
// answers `403` with `details.reason: 'AI_DISABLED'` before anything else is
// read. Every other gate (provider enabled, model enabled, capability, key,
// reachability) runs inside `AiService`, the same pipeline an in-process
// caller gets — this controller adds none of its own and skips none.
//
// Every route acts on `@CurrentUser('id')`: there is no parameter that names
// a user, so a request can only ever spend the caller's own key.
//
// A client that disconnects aborts its provider call (both routes): the
// signal reaches the adapter, and the usage row records a cancellation.
//
// ⚠ NO KEY EGRESS. The facade resolves the key per call and hands it to the
// adapter; no value returned here, and no SSE frame, has a field for one.
// =============================================================================

@ApiTags('AI')
@Controller('ai')
@UseGuards(AiEnabledGuard)
export class AiResponsesController {
  constructor(private readonly ai: AiService) {}

  @Post('responses')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate an AI response',
    description:
      'One model response, generated with **your** key for the provider (or the ' +
      'organisation key, when the deployment allows fallback and you have none).\n\n' +
      '`model` and `provider` are optional: with both omitted your `ai.defaultModel` user ' +
      'setting is used. `structuredOutput.jsonSchema` is a JSON Schema document; when given, ' +
      'the response carries `parsed`, already validated against it (output that does not ' +
      'match is `502` with `details.reason: "AI_STRUCTURED_OUTPUT_INVALID"`). `tools` takes ' +
      '**provider-hosted** tools only — `web_search`, `file_search`, `code_interpreter`, ' +
      '`image_generation`, `mcp` — each switched on by an administrator (see `hostedTools` in ' +
      '`GET /api/ai/config`); function tools are **not** accepted over HTTP. Hosted calls come ' +
      'back as `hosted_tool_call` output items, and web-search citations as `citations` on the ' +
      'message. `maxOutputTokens` is clamped to the deployment cap and ' +
      'the model\'s own limit. The request body is limited to 1 MB.\n\n' +
      'An `image`/`file` part names its bytes by `url` or by `storageObjectId` — one of your ' +
      'own `ready` storage objects (unknown `404`, another user\'s `403`). A stored image ' +
      '(PNG/JPEG/GIF/WebP, at most 20 MiB) needs a model with `vision_input`, any other file ' +
      '(at most 50 MiB) one with `file_input`; the provider reads it through a short-lived ' +
      'presigned URL or its own file upload, never a public link. Unconfigured object ' +
      'storage is `503` `AI_STORAGE_UNAVAILABLE`.\n\n' +
      'Refusals carry the AI error code in `details.reason`: `AI_DISABLED`, ' +
      '`AI_PROVIDER_DISABLED`, `AI_MODEL_NOT_ENABLED`, `AI_KEY_REQUIRED`, ' +
      '`AI_MODEL_NOT_REACHABLE`, `AI_TOOL_DISABLED` (403); `AI_CAPABILITY_UNSUPPORTED`, `AI_INVALID_REQUEST`, ' +
      '`AI_KEY_INVALID` (400); `AI_RATE_LIMITED` (429 — a provider throttle, or a deployment ' +
      'rate limit named in `details.limit`; with `details.retryAfterMs` and `Retry-After` when known); `AI_CONTENT_FILTERED` (422); `AI_PROVIDER_UNAVAILABLE` (503).',
  })
  @ApiDataResponse(AiResponseDto, { description: 'The completed response' })
  @ApiResponse({
    status: 400,
    description: 'Validation error, `AI_INVALID_REQUEST`, `AI_CAPABILITY_UNSUPPORTED`, `AI_KEY_INVALID`',
    type: ErrorDto,
  })
  @ApiResponse({
    status: 403,
    description:
      '`AI_DISABLED`, `AI_PROVIDER_DISABLED`, `AI_MODEL_NOT_ENABLED`, `AI_KEY_REQUIRED`, ' +
      '`AI_MODEL_NOT_REACHABLE`, `AI_TOOL_DISABLED`, missing `ai:use`, or another user\'s `storageObjectId` input',
    type: ErrorDto,
  })
  @ApiResponse({ status: 404, description: 'A `storageObjectId` input that does not exist', type: ErrorDto })
  @ApiResponse({ status: 422, description: '`AI_CONTENT_FILTERED`', type: ErrorDto })
  @ApiResponse({
    status: 429,
    description:
      '`AI_RATE_LIMITED` — the provider throttled the call, or a deployment rate limit (`ai.limits`, named in `details.limit`) was reached. `details.retryAfterMs` and the `Retry-After` header (seconds) say when to retry',
    type: ErrorDto,
  })
  @ApiResponse({ status: 502, description: '`AI_STRUCTURED_OUTPUT_INVALID`', type: ErrorDto })
  @ApiResponse({ status: 503, description: '`AI_PROVIDER_UNAVAILABLE`, `AI_STORAGE_UNAVAILABLE`', type: ErrorDto })
  async respond(
    @Body() dto: AiResponseRequestDto,
    @CurrentUser('id') userId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AiResponse> {
    const request = toAiRequest(dto);
    const disconnect = abortOnDisconnect(reply.raw);

    try {
      return await this.ai.forUser(userId).respond(request, { signal: disconnect.signal });
    } finally {
      disconnect.dispose();
    }
  }

  /**
   * Not `@Sse()` — see `ai-sse.ts`. `@Res()` without passthrough: once the
   * stream is open this handler owns the reply (it is hijacked), and until
   * then a thrown error is still answered by the global filter as JSON.
   */
  @Post('responses/stream')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.OK)
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Stream an AI response (SSE)',
    description:
      'The same request as `POST /api/ai/responses`, answered as a `text/event-stream`. Send ' +
      '`Accept: text/event-stream`; there is no `stream` flag in the body.\n\n' +
      '**Frames.** One per event, `event: <type>` with the event as JSON in `data:` (the JSON ' +
      'repeats `type`). A stream starts with `response.created`, carries ' +
      '`output_text.delta` / `reasoning_summary.delta` / `output_item.done` frames, and ends ' +
      'with exactly one of `response.completed` (whose `response` is the full `AiResponse`, ' +
      'identical to the non-streaming answer) or `error` (`{ "type": "error", "code": ' +
      '"AI_…", "message": "…" }`). A `: ping` comment line is sent every ' +
      `${AI_SSE_HEARTBEAT_MS / 1000} seconds so proxies do not reap a quiet stream.\n\n` +
      '**Errors.** Every refusal that happens before the first frame — AI disabled, no key, ' +
      'model not enabled, a validation error, a provider that rejects the key or throttles ' +
      'before streaming — is an ordinary JSON error response with the same status and ' +
      '`details.reason` the non-streaming route uses. A failure after streaming began is an ' +
      '`error` frame, after which the stream closes.\n\n' +
      '**Cancel** by closing the connection: the provider call is aborted.\n\n' +
      '**Client note.** The native `EventSource` cannot POST or send an `Authorization` ' +
      'header; use a fetch-based client.',
  })
  @ApiOkResponse({
    description: 'An open event stream; it ends after `response.completed` or `error`.',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example:
            'event: response.created\ndata: {"type":"response.created","id":"resp_1"}\n\n' +
            'event: output_text.delta\ndata: {"type":"output_text.delta","delta":"Hel"}\n\n' +
            ': ping\n\n' +
            'event: output_text.delta\ndata: {"type":"output_text.delta","delta":"lo"}\n\n' +
            'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1",' +
            '"provider":"openai","model":"gpt-5-mini","output":[{"type":"message","text":"Hello"}],' +
            '"outputText":"Hello","usage":{"inputTokens":5,"outputTokens":2},"finishReason":"stop"}}\n\n',
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error, `AI_INVALID_REQUEST`, `AI_CAPABILITY_UNSUPPORTED`, `AI_KEY_INVALID`',
    type: ErrorDto,
  })
  @ApiResponse({
    status: 403,
    description:
      '`AI_DISABLED`, `AI_PROVIDER_DISABLED`, `AI_MODEL_NOT_ENABLED`, `AI_KEY_REQUIRED`, ' +
      '`AI_MODEL_NOT_REACHABLE`, `AI_TOOL_DISABLED`, missing `ai:use`, or another user\'s `storageObjectId` input',
    type: ErrorDto,
  })
  @ApiResponse({ status: 404, description: 'A `storageObjectId` input that does not exist', type: ErrorDto })
  @ApiResponse({
    status: 429,
    description:
      '`AI_RATE_LIMITED` — the provider throttled the call, or a deployment rate limit (`ai.limits`, named in `details.limit`) was reached. `details.retryAfterMs` and the `Retry-After` header (seconds) say when to retry — before streaming began, as an ordinary JSON error',
    type: ErrorDto,
  })
  @ApiResponse({
    status: 503,
    description: '`AI_PROVIDER_UNAVAILABLE` or `AI_STORAGE_UNAVAILABLE` before streaming began',
    type: ErrorDto,
  })
  async stream(
    @Body() dto: AiResponseRequestDto,
    @CurrentUser('id') userId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const request = toAiRequest(dto);
    const disconnect = abortOnDisconnect(reply.raw);

    let events: AsyncIterable<AiStreamEvent>;

    try {
      // Eager: rejects with the AiError for every pre-stream failure, which
      // the global filter answers as JSON — nothing has been written yet.
      events = await this.ai.forUser(userId).openStream(request, { signal: disconnect.signal });
    } catch (err) {
      disconnect.dispose();
      throw err;
    }

    await pipeAiSse(reply, events, disconnect);
  }
}
