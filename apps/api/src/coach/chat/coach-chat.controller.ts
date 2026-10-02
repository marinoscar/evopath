import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { AiEnabledGuard } from '../../ai/config/ai-enabled.guard';
import { AI_SSE_HEARTBEAT_MS, abortOnDisconnect, pipeAiSse } from '../../ai/http/ai-sse';
import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
import { COACH_CHAT_HISTORY_LIMIT } from './coach-chat-prompt';
import { CoachChatService, type CoachChatEvent } from './coach-chat.service';
import { CoachTimelineService } from './coach-timeline.service';
import {
  COACH_CHAT_TEXT_MAX,
  CoachChatRequestDto,
  CoachTimelinePageView,
  CoachTimelineQueryDto,
  type CoachTimelinePage,
} from './dto/coach-chat.dto';

// =============================================================================
// /api/coach — chat and timeline (E7.7, #247; docs/specs/ai-coach.md §2.9, §3.6)
// =============================================================================
//
//   POST /api/coach/chat/stream   ai:use + programs:read   one chat turn (SSE)
//   POST /api/coach/chat/clear    ai:use                   "Start over" (204)
//   GET  /api/coach/messages      ai:use                   the caller's timeline
//
// `AiEnabledGuard` at class level, like every consumer route under `/api/ai`
// and `/api/coach`: while AI is off both answer 403 `AI_DISABLED`. Owner
// scoped by construction: every route and every chat tool acts on
// `@CurrentUser('id')`, and no parameter names a user.
//
// STREAMING. Like `POST /api/ai/responses/stream`: the turn's preconditions
// and its first event are settled BEFORE the reply is hijacked, so a refusal
// (coach off, no model for `coach.chat`, the `ai.limits` 429 of the first
// call) is an ordinary JSON error. `pipeAiSse` then writes the frames with the
// shared headers (`X-Accel-Buffering: no`) and the `: ping` heartbeat.
// nginx: `location /api/coach/chat/stream` in `infra/nginx/nginx.conf` and
// the CLI's VPS vhost (`apps/cli/src/deploy/proxy.ts`).
// =============================================================================

const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;

@ApiTags('AI Coach')
@Controller('coach')
@UseGuards(AiEnabledGuard)
export class CoachChatController {
  constructor(
    private readonly chat: CoachChatService,
    private readonly timeline: CoachTimelineService,
  ) {}

  @Post('chat/stream')
  @Auth({ permissions: [PERMISSIONS.AI_USE, PERMISSIONS.PROGRAMS_READ] })
  @HttpCode(HttpStatus.OK)
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Chat with the coach (SSE)',
    description:
      `Sends one message (\`text\`, at most ${COACH_CHAT_TEXT_MAX} characters) and streams the coach's answer as ` +
      '`text/event-stream`. The coach answers in the caller\'s persona with the `coach.chat` model, the last ' +
      `${COACH_CHAT_HISTORY_LIMIT} timeline messages as history, and read-only tools over the caller's own data ` +
      '(training signals, today\'s plan, recent workouts, check-in scores, progress-photo dates and counts, the ' +
      'last weekly review). Its one write tool pauses the coach for 1 to 14 days (`COACH_PAUSE_INVALID` to the ' +
      'model outside that range); it never changes a plan, program or workout: a plan change is a link to ' +
      '`/train` ("Adjust today\'s workout"). Both turns are stored as timeline messages (`kind: chat`).\n\n' +
      '**Safety.** A message that mentions an urgent physical symptom, self-harm, suicidal thoughts or ' +
      'disordered eating gets a fixed supportive reply with a seek-help line and no model call; pain or an ' +
      'injury switches the coach to a calm supportive register, and so does any message within 24 hours of a ' +
      'safety-blocked one. A safety-blocked message and its fixed reply are never sent to the model as history.\n\n' +
      '**Frames.** `event: <type>` with the frame as JSON in `data:` (the JSON repeats `type`):\n' +
      '- `safety` — `{ level: "blocked" | "conservative", screen: "distress" | "symptom" | "pain" }`, first, ' +
      'when a safety screen matched;\n' +
      '- `tool` — `{ name, status: "ok" | "invalid_arguments" | "unknown_tool" | "error" | "timeout" }`, one per ' +
      'tool call, while the coach works (never the arguments or the result);\n' +
      '- `delta` — `{ text }`, the reply in order (already checked by the content guard);\n' +
      '- `done` — `{ messageId, userMessageId, links: [{ label, href }], pausedUntil: string | null, fallback }`, ' +
      'last: the stored reply\'s id; `fallback` is true when the guard replaced the model\'s reply;\n' +
      '- `error` — `{ code, message, userMessageId }` (an `AI_*` code or `INTERNAL_ERROR`), last, when the turn ' +
      'failed after streaming began or after your message was stored; no reply is stored. `userMessageId` is the ' +
      'stored message (null when none was stored): send it back as `retryOf` with the same `text` to retry without ' +
      'storing the message twice.\n' +
      `A \`: ping\` comment is sent every ${AI_SSE_HEARTBEAT_MS / 1000} seconds.\n\n` +
      '**Errors before streaming** are ordinary JSON errors with `details.reason`: a validation 400 (empty or over ' +
      `${COACH_CHAT_TEXT_MAX} characters), or 400 \`COACH_RETRY_INVALID\` (a \`retryOf\` that is not your latest ` +
      'chat message, already has a reply, or whose text differs); 403 `AI_DISABLED`, missing `ai:use` or ' +
      '`programs:read`, or ' +
      '`COACH_DISABLED` (`details.code`); 409 `AI_FEATURE_UNAVAILABLE` (no usable model for `coach.chat`); 429 ' +
      '`AI_RATE_LIMITED` (`ai.limits`, with `Retry-After`); and the AI errors of the first model call. Nothing ' +
      'is stored then.\n\n' +
      '**Cancel** by closing the connection: the provider call is aborted and the partial reply is discarded.',
  })
  @ApiOkResponse({
    description: 'An open event stream; it ends after `done` or `error`.',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example:
            'event: tool\ndata: {"type":"tool","name":"get_training_signals","status":"ok"}\n\n' +
            ': ping\n\n' +
            'event: delta\ndata: {"type":"delta","text":"Two of three sessions done this week. "}\n\n' +
            'event: delta\ndata: {"type":"delta","text":"Friday closes it out."}\n\n' +
            'event: done\ndata: {"type":"done","messageId":"7d9f0c1e-3b1a-4c55-9a51-1f0c2d3e4f50",' +
            '"userMessageId":"5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d","links":[],"pausedUntil":null,"fallback":false}\n\n',
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Validation error, or `COACH_RETRY_INVALID`', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse({
    status: 403,
    description: '`AI_DISABLED`, missing `ai:use` or `programs:read`, `COACH_DISABLED`, or an AI key refusal',
    type: ErrorDto,
  })
  @ApiResponse({ status: 409, description: '`AI_FEATURE_UNAVAILABLE`: no usable model for `coach.chat`', type: ErrorDto })
  @ApiResponse({ status: 429, description: '`AI_RATE_LIMITED` (`ai.limits` or the provider)', type: ErrorDto })
  @ApiResponse({ status: 503, description: '`AI_PROVIDER_UNAVAILABLE` before streaming began', type: ErrorDto })
  async stream(
    @Body() dto: CoachChatRequestDto,
    @CurrentUser('id') userId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const disconnect = abortOnDisconnect(reply.raw);
    let iterator: AsyncIterator<CoachChatEvent>;
    let first: IteratorResult<CoachChatEvent>;

    try {
      // Eager: the preconditions AND the first event (the first model call).
      // Any rejection here is answered as JSON by the global filter.
      const events = await this.chat.startTurn(userId, dto.text, {
        signal: disconnect.signal,
        ...(dto.retryOf ? { retryOf: dto.retryOf } : {}),
      });
      iterator = events[Symbol.asyncIterator]();
      first = await iterator.next();
    } catch (err) {
      disconnect.dispose();
      throw err;
    }

    await pipeAiSse(reply, prepend(first, iterator), disconnect);
  }

  @Post('chat/clear')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Start the coach chat over',
    description:
      'Starts a fresh conversation: stamps the caller\'s `chatClearedAt` (returned by `GET /api/coach/state`) with ' +
      'the current instant. From then on `GET /api/coach/messages` lists only messages created after it, the ' +
      'coach chat sends the model only those as history, and nudges see only coach lines written since. A ' +
      '`retryOf` naming a message from before the clear is 400 `COACH_RETRY_INVALID`.\n\n' +
      'A soft clear: no message is deleted, and opening, rating or listening to an earlier message still works. ' +
      'Coach memories (`why`, commitments), settings, streaks and the weekly review stay. A safety-blocked ' +
      'message still keeps the coach in its supportive register for 24 hours, cleared or not. Idempotent: ' +
      'calling it again only moves the instant forward. Works while the coach is off or paused.',
  })
  @ApiNoContentResponse({ description: 'The chat was cleared' })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse({ status: 403, description: '`AI_DISABLED`, or missing `ai:use`', type: ErrorDto })
  async clear(@CurrentUser('id') userId: string): Promise<void> {
    await this.timeline.clear(userId);
  }

  @Get('messages')
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  @ApiOperation({
    summary: 'List my coach timeline',
    description:
      'The caller\'s coach messages, every kind in one timeline (nudges, chat turns, weekly reviews, ' +
      'celebrations, photo prompts), newest first, created after the caller\'s last "Start over" ' +
      '(`POST /api/coach/chat/clear`). Page with `before` = the previous page\'s `nextCursor` (a ' +
      'message id); `limit` 1 to 50, default 30. Only the caller\'s own messages: a `before` that is not one of ' +
      'them is 400. Audio fields are filled only while `audioStatus` is `ready`.',
  })
  @ApiDataResponse(CoachTimelinePageView, { description: 'One page of the timeline' })
  @ApiResponse({ status: 400, description: 'Validation error, or an invalid `before` cursor', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse({ status: 403, description: '`AI_DISABLED`, or missing `ai:use`', type: ErrorDto })
  messages(@CurrentUser('id') userId: string, @Query() query: CoachTimelineQueryDto): Promise<CoachTimelinePage> {
    return this.timeline.list(userId, query);
  }
}

/** `first` (already pulled) followed by the rest of `iterator`. Returning it returns the iterator. */
async function* prepend<T>(first: IteratorResult<T>, iterator: AsyncIterator<T>): AsyncGenerator<T> {
  try {
    if (first.done) return;
    yield first.value;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await iterator.return?.();
  }
}
