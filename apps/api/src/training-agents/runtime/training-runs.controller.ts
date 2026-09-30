import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { AiEnabledGuard } from '../../ai/config/ai-enabled.guard';
import { AI_SSE_HEARTBEAT_MS, abortOnDisconnect } from '../../ai/http/ai-sse';
import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
import {
  ListTrainingRunsQueryDto,
  StartTrainingRunDto,
  TrainingRunDecisionDto,
  TrainingRunIdParamDto,
  type TrainingRunListData,
  TrainingRunStarted,
  type TrainingRunStartedData,
  TrainingRunStreamQueryDto,
  TrainingRunView,
  type TrainingRunViewData,
} from './dto/training-runs.dto';
import { RunEventsService } from './run-events.service';
import { TRAINING_SSE_POLL_MS, resolveCursor, streamRunEvents } from './run-events.sse';
import { TrainingRunsService } from './training-runs.service';

// =============================================================================
// /api/ai/training/runs and /api/ai/training/stream: agentic training runs
// =============================================================================
//
//   POST /api/ai/training/runs                     start a run       -> 202 { runId, jobId, status }
//   GET  /api/ai/training/runs                     my runs (paged)
//   GET  /api/ai/training/runs/:runId              one of my runs
//   POST /api/ai/training/runs/:runId/cancel       cancel it
//   POST /api/ai/training/runs/:runId/resume       resume an interrupted run  -> 202
//   POST /api/ai/training/runs/:runId/decision     approve or reject a pause  -> 202
//   GET  /api/ai/training/stream/:runId?after=N    its events (SSE)
//
// Every route: `AiEnabledGuard` (class level, so the kill switch answers
// before authentication) plus `ai:use`. Owner-scoped: another user's run is a
// 404. No response carries the stored request, the context snapshot, a note,
// job internals beyond the start's `jobId`, or any key.
//
// nginx: `location /api/ai/training/stream` (infra/nginx and the CLI's VPS
// vhost) forwards the stream unbuffered with a long read timeout.
// =============================================================================

const RUN_ID_PARAM = { name: 'runId', description: 'The run id returned by `POST /api/ai/training/runs`.' } as const;
const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;
const FORBIDDEN = { status: 403, description: '`AI_DISABLED`, or missing `ai:use`', type: ErrorDto } as const;
const NOT_FOUND = { status: 404, description: 'No such run of yours', type: ErrorDto } as const;
const BAD_REQUEST = { status: 400, description: 'Validation error', type: ErrorDto } as const;

@ApiTags('AI Training')
@Controller('ai/training')
@UseGuards(AiEnabledGuard)
export class TrainingRunsController {
  constructor(
    private readonly runs: TrainingRunsService,
    private readonly events: RunEventsService,
  ) {}

  @Post('runs')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Start a training agent run',
    description:
      'Starts a `create`, `revise` or `evaluate` run of the training agents in the background and ' +
      'answers **202** with its id; follow it with `GET /api/ai/training/stream/{runId}` or ' +
      '`GET /api/ai/training/runs/{runId}`. The models (per agent role) and the token cap are frozen ' +
      'when the run starts. Every model call spends **your** key (or the organisation key, per the ' +
      'key policy).\n\n' +
      'Body by kind: `create` sends `intake` (goal, experience, days, minutes, weeks, gym, limitations, ' +
      'avoid list, preferences, `includeBio`, `tailorResearch`, `autonomy`); `revise` sends `programId`, ' +
      '`basedOnVersion` (the program\'s current version) and `instruction` (at most 500 characters); ' +
      '`evaluate` sends an optional `programId` and `input`.\n\n' +
      'A request the safety screen stops is answered **200** with `status: "blocked_safety"` and ' +
      '`guidance`: no job is created and no model is called.\n\n' +
      'Refusals (`details.reason`): `TRAINING_NOT_IMPLEMENTED` (**501**) while the agents for this kind ' +
      'of run are not available yet; `TRAINING_RUN_ACTIVE` (**409**, `details.runId` is your run in ' +
      'progress) when you already have a run queued, running or waiting for your decision; ' +
      '`TRAINING_ROLE_UNAVAILABLE` (**409**, `details.role` and `details.state` as in ' +
      '`GET /api/ai/training/models`) when an agent this kind needs has no usable model; ' +
      '`TRAINING_STALE_PLAN` (**409**, `details.currentVersion`) when `basedOnVersion` is not the ' +
      'program\'s current version. The intake\'s gym and a revised program must be yours (**404**).',
  })
  @ApiDataResponse(TrainingRunStarted, { status: 202, description: 'The run was queued' })
  @ApiResponse({ status: 200, description: 'The safety screen stopped the run (`status: "blocked_safety"`)' })
  @ApiResponse(BAD_REQUEST)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  @ApiResponse({ status: 404, description: 'The intake\'s gym or the revised program is not yours', type: ErrorDto })
  @ApiResponse({
    status: 409,
    description: '`TRAINING_RUN_ACTIVE`, `TRAINING_ROLE_UNAVAILABLE`, `TRAINING_STALE_PLAN`',
    type: ErrorDto,
  })
  @ApiResponse({ status: 501, description: '`TRAINING_NOT_IMPLEMENTED`', type: ErrorDto })
  async start(
    @CurrentUser('id') userId: string,
    @Body() dto: StartTrainingRunDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<TrainingRunStartedData> {
    const started = await this.runs.create(userId, dto);

    if (started.status === 'blocked_safety') reply.status(HttpStatus.OK);

    return started;
  }

  @Get('runs')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'My training agent runs',
    description: 'Newest first, optionally filtered by `programId` and `status`.',
  })
  @ApiDataResponse(TrainingRunView, { pagination: 'flat', description: 'A page of runs' })
  @ApiResponse(BAD_REQUEST)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  list(@CurrentUser('id') userId: string, @Query() query: ListTrainingRunsQueryDto): Promise<TrainingRunListData> {
    return this.runs.list(userId, query);
  }

  @Get('runs/:runId')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'One of my training agent runs',
    description:
      '`status`: `queued`, `running`, `awaiting_approval` (see `expiresAt`), `interrupted` (resume it), ' +
      '`succeeded`, `failed` (`errorCode`), `cancelled` or `blocked_safety`. `usage` is by role, by ' +
      'node and in total; `lastEventSeq` is where the event stream is.',
  })
  @ApiParam(RUN_ID_PARAM)
  @ApiDataResponse(TrainingRunView, { description: 'The run' })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  @ApiResponse(NOT_FOUND)
  get(@CurrentUser('id') userId: string, @Param() params: TrainingRunIdParamDto): Promise<TrainingRunViewData> {
    return this.runs.get(userId, params.runId);
  }

  @Post('runs/:runId/cancel')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel one of my training agent runs',
    description:
      'A queued, paused or interrupted run is cancelled at once; a running one stops within a few ' +
      'seconds (its in-flight model call is aborted). Idempotent: a finished run is returned unchanged.',
  })
  @ApiParam(RUN_ID_PARAM)
  @ApiDataResponse(TrainingRunView, { description: 'The run, after the cancel request' })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  @ApiResponse(NOT_FOUND)
  cancel(@CurrentUser('id') userId: string, @Param() params: TrainingRunIdParamDto): Promise<TrainingRunViewData> {
    return this.runs.cancel(userId, params.runId);
  }

  @Post('runs/:runId/resume')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Resume an interrupted training agent run',
    description:
      'Continues an `interrupted` run from its last completed step in a new background job; ' +
      'completed steps are not repeated. `409 TRAINING_RUN_NOT_RESUMABLE` for any other status, or ' +
      'after three resumes; `409 TRAINING_RUN_ACTIVE` when another run of yours is in progress.',
  })
  @ApiParam(RUN_ID_PARAM)
  @ApiDataResponse(TrainingRunView, { status: 202, description: 'The run, queued again' })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({ status: 409, description: '`TRAINING_RUN_NOT_RESUMABLE`, `TRAINING_RUN_ACTIVE`', type: ErrorDto })
  resume(@CurrentUser('id') userId: string, @Param() params: TrainingRunIdParamDto): Promise<TrainingRunViewData> {
    return this.runs.resume(userId, params.runId);
  }

  @Post('runs/:runId/decision')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Approve or reject a paused training agent run',
    description:
      'Records your decision on a run that is `awaiting_approval` and continues it in a new ' +
      'background job. `note` (optional, at most 1,000 characters) is passed to the agents and ' +
      'never shown in events. `409 TRAINING_RUN_NOT_AWAITING_DECISION` when the run is not paused.',
  })
  @ApiParam(RUN_ID_PARAM)
  @ApiDataResponse(TrainingRunView, { status: 202, description: 'The run, queued again' })
  @ApiResponse(BAD_REQUEST)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({ status: 409, description: '`TRAINING_RUN_NOT_AWAITING_DECISION`, `TRAINING_RUN_ACTIVE`', type: ErrorDto })
  decide(
    @CurrentUser('id') userId: string,
    @Param() params: TrainingRunIdParamDto,
    @Body() dto: TrainingRunDecisionDto,
  ): Promise<TrainingRunViewData> {
    return this.runs.decide(userId, params.runId, dto);
  }

  @Get('stream/:runId')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Follow a training agent run (SSE)',
    description:
      'Replays the run\'s events with `seq` greater than `after` (or the `Last-Event-ID` header when ' +
      '`after` is absent; from the start when neither is sent), then streams new ones as they are ' +
      `recorded (checked every ${TRAINING_SSE_POLL_MS / 1000} second). ` +
      'Each frame is `id: <seq>`, `event: <type>`, `data: <json>`; reconnect with `after=<last id>` ' +
      'to continue without a gap or a duplicate. The stream ends with `event: end` (`{ status }`) once ' +
      'the run is `succeeded`, `failed`, `cancelled`, `blocked_safety` or `awaiting_approval` and every ' +
      `event was sent. A \`: ping\` comment is sent every ${AI_SSE_HEARTBEAT_MS / 1000} seconds. ` +
      'Closing the connection does **not** cancel the run.\n\n' +
      'Lifecycle event types: `run.queued`, `run.started`, `run.resumed`, `stage.started`, ' +
      '`stage.completed`, `agent.usage` (role, node, provider, model, token counts, latency), ' +
      '`run.deferred`, `run.interrupted`, `run.awaiting_approval`, `run.completed`, `run.failed`, ' +
      '`run.cancelled`. Events carry identifiers, counts and codes only; never prompt text, model ' +
      'output or keys.\n\n' +
      'An unknown run, or another user\'s, is an ordinary JSON **404**.',
  })
  @ApiParam(RUN_ID_PARAM)
  @ApiOkResponse({
    description: 'An open event stream; it ends after `end`.',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example:
            'id: 1\nevent: run.queued\ndata: {"kind":"create","trigger":"user"}\n\n' +
            'id: 2\nevent: run.started\ndata: {"kind":"create"}\n\n' +
            'id: 3\nevent: stage.started\ndata: {"node":"prepare_context"}\n\n' +
            ': ping\n\n' +
            'event: end\ndata: {"status":"succeeded"}\n\n',
        },
      },
    },
  })
  @ApiResponse(BAD_REQUEST)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  @ApiResponse(NOT_FOUND)
  async stream(
    @CurrentUser('id') userId: string,
    @Param() params: TrainingRunIdParamDto,
    @Query() query: TrainingRunStreamQueryDto,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Ownership and existence first: a foreign or unknown run is a JSON 404.
    await this.runs.get(userId, params.runId);

    await streamRunEvents(reply, {
      runId: params.runId,
      after: resolveCursor(query.after, lastEventId),
      events: this.events,
      status: () => this.runs.statusOf(userId, params.runId),
      disconnect: abortOnDisconnect(reply.raw),
    });
  }
}
