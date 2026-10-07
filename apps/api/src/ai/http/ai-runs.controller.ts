import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '@marinoscar/platform-api/core';
import { AiEnabledGuard } from '../config/ai-enabled.guard';
import { AiService } from '../runtime/ai.service';
import { AiRunsService } from '../runtime/ai-runs.service';
import type { AiRunHandle, AiRunView } from '../runtime/ai-runtime.types';
import { toAiRequest } from './ai-http-request';
import { AiResponseRequestDto } from './dto/ai-response-request.dto';
import { AiRunDto, AiRunStartedDto, type AiRunHttpView } from './dto/ai-response.dto';

// =============================================================================
// AiRunsController (issue #433, epic #419) — background AI runs over HTTP
// =============================================================================
//
//   POST /api/ai/runs                  ai:use   queue a run      -> 202 { runId, jobId }
//   GET  /api/ai/runs/:runId           ai:use   poll it          -> AiRun
//   POST /api/ai/runs/:runId/cancel    ai:use   cancel it        -> AiRun
//
// A run is an `ai_runs` row executed by one `ai.response.run` queue job
// (docs/specs/ai-platform.md §2.20; CLAUDE.md "every long-running activity is a
// queue job"). The gates run when it is queued — an unusable request fails
// fast, as the same JSON error `POST /api/ai/responses` answers — and again
// when the job executes.
//
// OWNER-SCOPED. Reads and cancels go through `AiRunsService.get/cancel`, which
// match on (id, caller): another user's run id is a 404, indistinguishable
// from one that does not exist.
//
// The view published here omits the stored request (the prompt) and the job
// internals; `output` is the completed `AiResponse`, an image run's stored
// images (#437 — `POST /api/ai/images*` queue those), a transcript (#438 —
// `POST /api/ai/audio/transcriptions`), or stored speech (#439 —
// `POST /api/ai/audio/speech`). Nothing carries a key.
// Cancel works the same for both kinds of run.
// =============================================================================

const RUN_ID_PARAM = { name: 'runId', description: 'The run id returned by `POST /api/ai/runs`.' } as const;

@ApiTags('AI')
@Controller('ai/runs')
@UseGuards(AiEnabledGuard)
export class AiRunsController {
  constructor(
    private readonly ai: AiService,
    private readonly runs: AiRunsService,
  ) {}

  @Post()
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Start a background AI run',
    description:
      'Queues the same request `POST /api/ai/responses` accepts and returns at once with ' +
      '**202**; poll `GET /api/ai/runs/{runId}` for the result. The request is checked now ' +
      '(AI enabled, model enabled, your key, …) and refused with the same JSON errors as the ' +
      'synchronous route; it is checked again when the run executes, and a run that can no ' +
      'longer proceed ends `failed` with the AI error code in `errorCode`.\n\n' +
      '`400` with `details.reason: "AI_INVALID_REQUEST"` when this deployment has background ' +
      'runs switched off (`allowBackgroundRuns: false` in `GET /api/ai/config`), and for an ' +
      '`mcp` tool that carries `headers` — a queued request is stored, and MCP headers never are.\n\n' +
      'A `storageObjectId` input is checked now and read again when the run executes; the ' +
      'run stores the id only, never a URL. An input deleted meanwhile fails the run ' +
      '`AI_INVALID_REQUEST`.',
  })
  @ApiDataResponse(AiRunStartedDto, { status: 202, description: 'The run was queued' })
  @ApiResponse({
    status: 400,
    description: 'Validation error, `AI_INVALID_REQUEST` (including background runs disabled), `AI_CAPABILITY_UNSUPPORTED`',
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
  async start(@Body() dto: AiResponseRequestDto, @CurrentUser('id') userId: string): Promise<AiRunHandle> {
    return this.ai.forUser(userId).startRun(toAiRequest(dto));
  }

  @Get(':runId')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'Get one of my background AI runs',
    description:
      '`status` is `pending`, `running`, `succeeded`, `failed` or `cancelled`. `output` is ' +
      'the completed response once `succeeded` — or, for an image run started by ' +
      '`POST /api/ai/images` or `/api/ai/images/edits`, `{ type: "images", storageObjectIds, … }` ' +
      '(download each with `GET /api/storage/objects/{id}/download`), or for a transcription ' +
      'started by `POST /api/ai/audio/transcriptions`, `{ type: "transcription", text, … }`, or ' +
      'for speech started by `POST /api/ai/audio/speech`, `{ type: "speech", storageObjectId, ' +
      'aiGenerated: true, … }`; ' +
      '`errorCode` (an AI error ' +
      'code) and `errorMessage` once `failed`. Only your own runs: any other id is a 404.',
  })
  @ApiParam(RUN_ID_PARAM)
  @ApiDataResponse(AiRunDto, { description: 'The run' })
  @ApiResponse({ status: 403, description: '`AI_DISABLED`, or missing `ai:use`', type: ErrorDto })
  @ApiResponse({ status: 404, description: 'No such run of yours', type: ErrorDto })
  async get(@Param('runId') runId: string, @CurrentUser('id') userId: string): Promise<AiRunHttpView> {
    return toHttpView(await this.runs.get(userId, runId));
  }

  @Post(':runId/cancel')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel one of my background AI runs',
    description:
      'Cancels the run if it is still `pending` or `running` and returns it. Idempotent: a ' +
      'finished run is returned unchanged. A running provider call is aborted as soon as the ' +
      'executing worker notices. Only your own runs: any other id is a 404.',
  })
  @ApiParam(RUN_ID_PARAM)
  @ApiDataResponse(AiRunDto, { description: 'The run, after cancellation' })
  @ApiResponse({ status: 403, description: '`AI_DISABLED`, or missing `ai:use`', type: ErrorDto })
  @ApiResponse({ status: 404, description: 'No such run of yours', type: ErrorDto })
  async cancel(@Param('runId') runId: string, @CurrentUser('id') userId: string): Promise<AiRunHttpView> {
    return toHttpView(await this.runs.cancel(userId, runId));
  }
}

/** Named fields only — `jobId` is queue plumbing, not part of the published view. */
function toHttpView(run: AiRunView): AiRunHttpView {
  return {
    id: run.id,
    status: run.status,
    provider: run.provider,
    modelId: run.modelId,
    output: run.output as AiRunHttpView['output'],
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt ? run.completedAt.toISOString() : null,
  };
}
