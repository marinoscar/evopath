import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { AiEnabledGuard } from '../ai/config/ai-enabled.guard';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../common/dto/error.dto';
import { AdaptationService } from './adaptation.service';
import {
  AdaptationPreview,
  type AdaptationPreviewData,
  AdaptationStarted,
  type AdaptationStartedData,
  AdaptationView,
  type AdaptationViewData,
  ApplyPlanResult,
  type ApplyPlanResultData,
  ApplyWorkoutResult,
  type ApplyWorkoutResultData,
} from './dto/adaptation.dto';
import { AdaptationIdParamDto, AdaptationRequestDto } from './dto/adaptation-request.dto';

// =============================================================================
// /api/ai/training/adaptations: "adjust today's workout" (E6.1)
// =============================================================================
//
//   POST   /api/ai/training/adaptations/context-preview   what would be sent   -> 200
//   POST   /api/ai/training/adaptations                   start one            -> 202 { adaptationId, jobId, runId }
//   GET    /api/ai/training/adaptations/:id               one of mine
//   POST   /api/ai/training/adaptations/:id/cancel        cancel it
//   POST   /api/ai/training/adaptations/:id/apply/workout use it for today     (+ workouts:write)
//   POST   /api/ai/training/adaptations/:id/apply/plan    update my plan       (+ programs:write)
//   DELETE /api/ai/training/adaptations/:id               discard it           -> 204
//
// Live progress: `GET /api/ai/training/stream/{runId}` (the E5.3 kit's SSE,
// with replay) and `GET /api/ai/training/runs/{runId}`.
//
// Every route: `AiEnabledGuard` (class level, so the kill switch answers
// before authentication) plus `ai:use`. The two apply routes call no model
// but stay here for consistency, each adding its exact write permission in
// the decorator. Owner-scoped: another user's adaptation is a 404.
// =============================================================================

const ID_PARAM = { name: 'id', description: 'The adaptation id returned by `POST /api/ai/training/adaptations`.' } as const;
const BAD_REQUEST = { status: 400, description: 'Validation error (`ADAPTATION_NOTHING_TO_CHANGE`: "Tell us what to change")', type: ErrorDto } as const;
const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;
const FORBIDDEN = { status: 403, description: '`AI_DISABLED`, or a missing permission', type: ErrorDto } as const;
const NOT_FOUND = { status: 404, description: 'No such adaptation of yours', type: ErrorDto } as const;

@ApiTags('AI Training')
@Controller('ai/training/adaptations')
@UseGuards(AiEnabledGuard)
export class AdaptationController {
  constructor(private readonly adaptations: AdaptationService) {}

  @Post('context-preview')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview what an adaptation would send',
    description:
      'Validates the request and builds the exact context an adaptation would send to the planner and critic, ' +
      'rendered as sections (`sentData`), plus the planner and critic models (and any blocking state from the ' +
      'agent model resolver), whether a provider would be called, and the safety screen\'s answer. Calls no ' +
      'provider and stores nothing. Today is the server\'s today in your Health Profile time zone.\n\n' +
      '`400` for a request that changes nothing ("Tell us what to change") or an `only` equipment type the gym ' +
      'does not have (`ADAPTATION_EQUIPMENT_NOT_IN_GYM`); `404` for a gym that is not yours.',
  })
  @ApiDataResponse(AdaptationPreview, { description: 'What would be sent' })
  @ApiResponse(BAD_REQUEST)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  @ApiResponse({ status: 404, description: 'The gym is not yours', type: ErrorDto })
  preview(@CurrentUser('id') userId: string, @Body() dto: AdaptationRequestDto): Promise<AdaptationPreviewData> {
    return this.adaptations.preview(userId, dto);
  }

  @Post()
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Adapt today's workout",
    description:
      'Starts a quick adaptation of today\'s planned workout ("I have 30 minutes", "I\'m sore", "only ' +
      'dumbbells"), or an ad-hoc session when there is none, in the background (`ai.training.adapt.run`), and ' +
      'answers **202** with its ids. Follow it live with `GET /api/ai/training/stream/{runId}` (stages ' +
      '`context`, `adapt`, `guardrails`, `critic`, `finalize`) and read the result with ' +
      '`GET /api/ai/training/adaptations/{id}`. The planner and critic models are frozen now; every model call ' +
      'spends **your** key (or the organisation key, per the key policy). One planner pass, one critic review, ' +
      'at most one revision; the server\'s guardrails decide what may ship, and loads are never model-supplied.\n\n' +
      'A request the safety screen stops is answered **200** with `status: "blocked_safety"` and `guidance`: ' +
      'no job is created and no model is called.\n\n' +
      'Refusals (`details.reason`): `ADAPTATION_IN_PROGRESS` (**409**, `details.adaptationId` and ' +
      '`details.runId` are the one in progress); `TRAINING_ROLE_UNAVAILABLE` (**409**, `details.role` is ' +
      '`planner` or `critic`, `details.state` and `details.fix` as in `GET /api/ai/training/models`).',
  })
  @ApiDataResponse(AdaptationStarted, { status: 202, description: 'The adaptation was queued' })
  @ApiResponse({ status: 200, description: 'The safety screen stopped it (`status: "blocked_safety"`)' })
  @ApiResponse(BAD_REQUEST)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  @ApiResponse({ status: 404, description: 'The gym is not yours', type: ErrorDto })
  @ApiResponse({ status: 409, description: '`ADAPTATION_IN_PROGRESS`, `TRAINING_ROLE_UNAVAILABLE`', type: ErrorDto })
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: AdaptationRequestDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdaptationStartedData> {
    const started = await this.adaptations.create(userId, dto);
    if (started.status === 'blocked_safety') reply.status(HttpStatus.OK);
    return started;
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'One of my workout adaptations',
    description:
      '`status`: `queued`, `running` (`stage` is the node), `ready` (review `proposal`), `failed` ' +
      '(`errorCode`: `ADAPTATION_CANNOT_FIT` with its "try N+10" message, `ADAPTATION_INVALID`, an `AI_*` ' +
      'code, ...), `cancelled`, `blocked_safety` (`guidance`), `applied` (`appliedAs`) or `discarded`. ' +
      '`guardrailReport` lists what the server repaired or removed; `criticReport.skipped` means "not reviewed ' +
      'by the critic"; `sentData` is what was sent.',
  })
  @ApiParam(ID_PARAM)
  @ApiDataResponse(AdaptationView, { description: 'The adaptation' })
  @ApiResponse(BAD_REQUEST)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  @ApiResponse(NOT_FOUND)
  get(@CurrentUser('id') userId: string, @Param() params: AdaptationIdParamDto): Promise<AdaptationViewData> {
    return this.adaptations.get(userId, params.id);
  }

  @Post(':id/cancel')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel one of my workout adaptations',
    description:
      'A queued adaptation is cancelled at once; a running one stops within a few seconds (its in-flight model ' +
      'call is aborted; usage of completed calls remains). Idempotent for a cancelled one; `409 ' +
      'ADAPTATION_NOT_CANCELLABLE` once it finished otherwise.',
  })
  @ApiParam(ID_PARAM)
  @ApiDataResponse(AdaptationView, { description: 'The adaptation, after the cancel request' })
  @ApiResponse(BAD_REQUEST)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({ status: 409, description: '`ADAPTATION_NOT_CANCELLABLE`', type: ErrorDto })
  cancel(@CurrentUser('id') userId: string, @Param() params: AdaptationIdParamDto): Promise<AdaptationViewData> {
    return this.adaptations.cancel(userId, params.id);
  }

  @Post(':id/apply/workout')
  @Auth({ permissions: [PERMISSIONS.AI_USE, PERMISSIONS.WORKOUTS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Use an adapted workout for today only',
    description:
      'Creates an in-progress workout for your today with the adapted exercises in order, each set prefilled ' +
      'with the target reps and a load from the plan prescription or your last time (never from the model; ' +
      'blank when neither exists), linked to today\'s planned workout the way starting it from Today links it ' +
      '(so adherence counts the day) and noted "Adapted: ...". The plan is untouched. Re-checks the proposal ' +
      'against current data first. Idempotent: a repeat answers the same workout.\n\n' +
      '`409` (`details.reason`): `WORKOUT_IN_PROGRESS` (`details.workoutId`: resume or finish it first), ' +
      '`ADAPTATION_STALE` (`details.findings`: the gym, an exercise or a pain flag changed; adjust again), ' +
      '`ADAPTATION_ALREADY_APPLIED` (it updated your plan), `ADAPTATION_NOT_READY`.',
  })
  @ApiParam(ID_PARAM)
  @ApiDataResponse(ApplyWorkoutResult, { description: 'The workout to open in the logger' })
  @ApiResponse(BAD_REQUEST)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse({ status: 403, description: '`AI_DISABLED`, or missing `ai:use` or `workouts:write`', type: ErrorDto })
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description: '`WORKOUT_IN_PROGRESS`, `ADAPTATION_STALE`, `ADAPTATION_ALREADY_APPLIED`, `ADAPTATION_NOT_READY`',
    type: ErrorDto,
  })
  applyWorkout(@CurrentUser('id') userId: string, @Param() params: AdaptationIdParamDto): Promise<ApplyWorkoutResultData> {
    return this.adaptations.applyWorkout(userId, params.id);
  }

  @Post(':id/apply/plan')
  @Auth({ permissions: [PERMISSIONS.AI_USE, PERMISSIONS.PROGRAMS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update my plan with an adapted workout',
    description:
      'Writes a new plan version in which today\'s planned workout is the adapted one (only that workout ' +
      'changes), with a change-log entry by the AI carrying the summary and rationale; the plan\'s one-tap ' +
      'revert undoes it. Re-checks the proposal against current data first. Idempotent: a repeat answers the ' +
      'same version.\n\n' +
      '`409` (`details.reason`): `ADAPTATION_NO_BASE` (an ad-hoc session has no plan to update), ' +
      '`ADAPTATION_STALE` (the plan has a newer version, or the gym, an exercise or a pain flag changed), ' +
      '`ADAPTATION_ALREADY_APPLIED` (it was used for today only), `ADAPTATION_NOT_READY`.',
  })
  @ApiParam(ID_PARAM)
  @ApiDataResponse(ApplyPlanResult, { description: 'The new plan version and its change-log entry' })
  @ApiResponse(BAD_REQUEST)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse({ status: 403, description: '`AI_DISABLED`, or missing `ai:use` or `programs:write`', type: ErrorDto })
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description: '`ADAPTATION_NO_BASE`, `ADAPTATION_STALE`, `ADAPTATION_ALREADY_APPLIED`, `ADAPTATION_NOT_READY`',
    type: ErrorDto,
  })
  applyPlan(@CurrentUser('id') userId: string, @Param() params: AdaptationIdParamDto): Promise<ApplyPlanResultData> {
    return this.adaptations.applyPlan(userId, params.id);
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Discard one of my workout adaptations',
    description:
      'Marks it `discarded` (a queued or running one is cancelled first). Idempotent. `409 ' +
      'ADAPTATION_ALREADY_APPLIED` once it was applied.',
  })
  @ApiParam(ID_PARAM)
  @ApiNoContentResponse({ description: 'Discarded' })
  @ApiResponse(BAD_REQUEST)
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(FORBIDDEN)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({ status: 409, description: '`ADAPTATION_ALREADY_APPLIED`', type: ErrorDto })
  async discard(@CurrentUser('id') userId: string, @Param() params: AdaptationIdParamDto): Promise<void> {
    await this.adaptations.discard(userId, params.id);
  }
}
