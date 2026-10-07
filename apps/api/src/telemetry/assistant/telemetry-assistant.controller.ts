import { Body, Controller, HttpCode, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { AiEnabledGuard } from '../../ai/config/ai-enabled.guard';
import { AI_SSE_HEARTBEAT_MS, abortOnDisconnect } from '../../ai/http/ai-sse';
import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ErrorDto } from '@marinoscar/platform-api/core';
import { TelemetryAssistantRequestDto } from '../dto/telemetry-assistant.dto';
import { TelemetryAssistantService } from './telemetry-assistant.service';
import { openTelemetrySse } from './telemetry-assistant.sse';

// =============================================================================
// TelemetryAssistantController (issue #536, reworked in #571; epic #528)
// =============================================================================
//
//   POST /api/admin/telemetry/assistant/stream   telemetry:query AND ai:use (SSE)
//
// ACCESS. `@Auth({ permissions: [...] })` is ALL-OF (`PermissionsGuard` uses
// `every`), so the caller must hold both: `telemetry:query` because the
// assistant reads telemetry data, `ai:use` because it spends an AI key.
// `AiEnabledGuard` answers 403 `AI_DISABLED` while the platform is off. This
// route lives under `/api/admin/telemetry`, not `/api/ai`, so the AI
// kill-switch and RBAC tripwire suites (which discover `/api/ai*` and
// `/api/admin/ai*`) do not enumerate it; the guard is applied explicitly and
// pinned by this controller's spec.
//
// STREAMING. Like `POST /api/ai/responses/stream` (see `ai/http/ai-sse.ts`),
// not `@Sse()`: the service's preconditions run BEFORE anything is written,
// so "assistant disabled", "no model selected" and friends are ordinary JSON
// errors with `details.reason`. The response is committed to
// `text/event-stream` only on the first event (`openTelemetrySse` hijacks the
// reply lazily). Closing the connection aborts the provider call and the
// in-flight query.
//
// nginx: `location /api/admin/telemetry/assistant/stream` (infra/nginx and
// the CLI's VPS vhost) forwards it unbuffered with a long read timeout.
// =============================================================================

@ApiTags('Telemetry')
@Controller('admin/telemetry')
@UseGuards(AiEnabledGuard)
export class TelemetryAssistantController {
  constructor(private readonly assistant: TelemetryAssistantService) {}

  @Post('assistant/stream')
  @Auth({ permissions: [PERMISSIONS.TELEMETRY_QUERY, PERMISSIONS.AI_USE] })
  @HttpCode(HttpStatus.OK)
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Ask the telemetry AI assistant to investigate (SSE)',
    description:
      'A troubleshooting agent for this application: it investigates a question (errors, slowness, "is ' +
      'anything wrong?", or simply "write me a query") over the telemetry store and answers with a ' +
      'structured report. Tools: `get_app_context` (deployment, configuration, tables, data range), ' +
      '`health_overview` (a baseline over a window: per-service errors and latency, failing routes, log ' +
      'severities, top error messages, slowest spans), `get_trace` (every span and log of one trace), ' +
      '`run_query`, `list_tables` and `describe_table`. Every statement — the model\'s and the ones the ' +
      'server builds for the baseline and trace tools — goes through the same guard, row cap, timeout and ' +
      'audit trail as `POST /api/admin/telemetry/query` (audited as `telemetry:assistant_query`), and each ' +
      'turn is audited as `telemetry:assistant`. A turn takes at most `telemetry.assistant.maxSteps` model ' +
      'round-trips (at most 20). The AI call spends **your** key for the configured provider (or the ' +
      'organisation key, per the key policy). Row values are shown to the model only when ' +
      '`telemetry.assistant.shareResults` is on (otherwise only shapes, counts, durations and timestamps), ' +
      'and never more than `telemetry.assistant.maxResultRowsToModel` (at most 100) rows per statement.\n\n' +
      '`history` carries up to 20 earlier turns of the conversation (oldest first, each at most ' +
      '8000 characters); send an assistant turn as plain text.\n\n' +
      '**Frames.** `event: <name>` plus `data: <json>`:\n' +
      '- `step` — `{ index, tool, input?: { table?, sql?, window?, traceId? }, rowCount?, truncated?, ' +
      'durationMs, error?, thought? }`, one per tool call (`index` is 0-based; `thought` is the model\'s ' +
      'interim reasoning for that round, on the round\'s first call only, at most 1000 characters);\n' +
      '- `answer` — `{ sql: string | null, explanation, report }` where `report` is `{ status: ' +
      '"issue_found" | "no_issue_found" | "inconclusive" | "no_data", summary, findings: [{ title, severity: ' +
      '"critical" | "high" | "medium" | "low" | "info", evidence, queryIndex? }], rootCause: string | null, ' +
      'confidence: "high" | "medium" | "low", recommendations: string[], queries: [{ title, sql }] }` or ' +
      '`null` when the model did not return a report (then `explanation` is its raw text). `sql` is ' +
      '`queries[0].sql` (or null) and `explanation` the summary, for older clients. Every report query ' +
      'passed the read-only SQL guard; a refused one is withdrawn with a note in the summary;\n' +
      '- `error` — `{ code, message }` (an `AI_*` code, a `TELEMETRY_*` reason, or `INTERNAL_ERROR`);\n' +
      '- `done` — `{}`, always last.\n' +
      `A \`: ping\` comment is sent every ${AI_SSE_HEARTBEAT_MS / 1000} seconds.\n\n` +
      '**Errors before streaming** are ordinary JSON errors with `details.reason`: `AI_DISABLED` ' +
      '(403), `TELEMETRY_NOT_CONFIGURED` (503), `TELEMETRY_DISABLED` (409), ' +
      '`TELEMETRY_ASSISTANT_DISABLED` (409, `telemetry.assistant.enabled` is off), ' +
      '`TELEMETRY_ASSISTANT_NOT_CONFIGURED` (409, no provider/model selected).\n\n' +
      '**Cancel** by closing the connection: the AI call and any running query are aborted.',
  })
  @ApiOkResponse({
    description: 'An open event stream; it ends after `done`.',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example:
            'event: step\ndata: {"index":0,"tool":"get_app_context","durationMs":85,"thought":"Checking what is deployed and how much telemetry there is."}\n\n' +
            'event: step\ndata: {"index":1,"tool":"health_overview","input":{"window":"1h"},"durationMs":420,"thought":"Taking a one-hour baseline of errors and latency."}\n\n' +
            'event: step\ndata: {"index":2,"tool":"run_query","input":{"sql":"SELECT span_name, count(*) AS errors FROM opentelemetry_traces WHERE span_status_code = \'STATUS_CODE_ERROR\' AND timestamp > now() - INTERVAL \'1 hour\' GROUP BY span_name ORDER BY errors DESC LIMIT 10"},"rowCount":2,"truncated":false,"durationMs":40,"thought":"Most errors are on one route; breaking them down by span."}\n\n' +
            'event: step\ndata: {"index":3,"tool":"get_trace","input":{"traceId":"4bf92f3577b34da6a3ce929d0e0e4736"},"rowCount":7,"truncated":false,"durationMs":55}\n\n' +
            ': ping\n\n' +
            'event: answer\ndata: {"sql":"SELECT span_name, count(*) AS errors FROM opentelemetry_traces WHERE span_status_code = \'STATUS_CODE_ERROR\' AND timestamp > now() - INTERVAL \'1 hour\' GROUP BY span_name ORDER BY errors DESC LIMIT 10","explanation":"42 of 1,310 requests (3.2%) failed in the last hour, all on POST /api/jobs.","report":{"status":"issue_found","summary":"42 of 1,310 requests (3.2%) failed in the last hour, all on POST /api/jobs.","findings":[{"title":"POST /api/jobs failing","severity":"high","evidence":"42 error spans since 10:05 UTC; sample trace 4bf92f3577b34da6a3ce929d0e0e4736 ends in a database timeout.","queryIndex":0}],"rootCause":"Database timeouts on the jobs insert.","confidence":"medium","recommendations":["Check database connection pool saturation."],"queries":[{"title":"Error spans by name","sql":"SELECT span_name, count(*) AS errors FROM opentelemetry_traces WHERE span_status_code = \'STATUS_CODE_ERROR\' AND timestamp > now() - INTERVAL \'1 hour\' GROUP BY span_name ORDER BY errors DESC LIMIT 10"}]}}\n\n' +
            'event: done\ndata: {}\n\n',
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Validation error', type: ErrorDto })
  @ApiResponse({
    status: 403,
    description: '`AI_DISABLED`, or missing `telemetry:query` / `ai:use`',
    type: ErrorDto,
  })
  @ApiResponse({
    status: 409,
    description: '`TELEMETRY_DISABLED`, `TELEMETRY_ASSISTANT_DISABLED`, `TELEMETRY_ASSISTANT_NOT_CONFIGURED`',
    type: ErrorDto,
  })
  @ApiResponse({ status: 503, description: '`TELEMETRY_NOT_CONFIGURED`', type: ErrorDto })
  async stream(
    @Body() dto: TelemetryAssistantRequestDto,
    @CurrentUser('id') userId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const disconnect = abortOnDisconnect(reply.raw);
    const sse = openTelemetrySse(reply, disconnect);

    try {
      // Throws (before any event) only for the preconditions: the global filter answers those as JSON.
      await this.assistant.stream(userId, dto, { signal: disconnect.signal, emit: sse.send });
    } catch (err) {
      if (!sse.opened) {
        disconnect.dispose();
        throw err;
      }

      // Not expected (the service reports failures in band); close the stream cleanly.
      sse.send('error', { code: 'INTERNAL_ERROR', message: 'The telemetry assistant failed unexpectedly.' });
      sse.send('done', {});
    } finally {
      if (sse.opened) sse.close();
    }
  }
}
