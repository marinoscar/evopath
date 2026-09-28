import { Body, Controller, Get, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ErrorDto } from '../common/dto/error.dto';
import {
  TelemetryExportRequestDto,
  TelemetryQueryRequestDto,
  TelemetryQueryResultDto,
  TelemetrySchemaDto,
} from './dto/telemetry-query.dto';
import { TELEMETRY_EXPORT_CONTENT_TYPES, TelemetryExportService } from './export/telemetry-export.service';
import { TelemetryQueryService } from './query/telemetry-query.service';
import { TelemetrySchemaService } from './query/telemetry-schema.service';

// =============================================================================
// TelemetryExplorerController (issue #535, epic #528)
// =============================================================================
//
//   POST /api/admin/telemetry/query    telemetry:query
//   GET  /api/admin/telemetry/schema   telemetry:query
//   POST /api/admin/telemetry/export   telemetry:query   (binary attachment)
//
// All three on `telemetry:query` — the permission that means "may read the
// telemetry DATA", distinct from `telemetry:read` (may see the store's
// configuration and status). The schema is on it too: table and column names
// are derived from the data (every span attribute becomes a column).
//
// Failures carry `details.reason` (see query/telemetry-query.errors.ts).
// =============================================================================

const ERROR_REASONS_DOC =
  'Failures carry `details.reason`: `TELEMETRY_NOT_CONFIGURED` (503, no telemetry store in this ' +
  'deployment), `TELEMETRY_UNREACHABLE` (503), `TELEMETRY_DISABLED` (409, `telemetry.enabled` ' +
  'is off)';

const QUERY_REASONS_DOC =
  ', `TELEMETRY_QUERY_REJECTED` (400, not exactly one read-only statement), ' +
  '`TELEMETRY_QUERY_FAILED` (400, the telemetry store refused the statement — the message is its ' +
  'own) and `TELEMETRY_QUERY_TIMEOUT` (504, the statement outran `telemetry.query.timeoutSeconds`).';

@ApiTags('Telemetry')
@Controller('admin/telemetry')
export class TelemetryExplorerController {
  constructor(
    private readonly queries: TelemetryQueryService,
    private readonly schema: TelemetrySchemaService,
    private readonly exports: TelemetryExportService,
  ) {}

  @Post('query')
  @HttpCode(HttpStatus.OK)
  @Auth({ permissions: [PERMISSIONS.TELEMETRY_QUERY] })
  @ApiOperation({
    summary: 'Run a read-only SQL query against the telemetry store (Admin only)',
    description:
      'Runs ONE read-only statement (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN) as the telemetry ' +
      'store\'s read-only user. At most `maxRows` rows are returned (default and ceiling: the ' +
      '`telemetry.query.maxRows` setting); `truncated` says whether more matched. Rows are ' +
      'positional arrays matching `columns`; `int8`/`numeric` values are strings so no precision ' +
      'is lost, and timestamps are the store\'s own text. That text carries microseconds (the ' +
      'PostgreSQL protocol\'s precision); select `CAST(ts AS STRING) AS ts_ns` for nanoseconds. Every call, ' +
      'refused ones included, is written to the audit log as `telemetry:query`.\n\n' +
      ERROR_REASONS_DOC +
      QUERY_REASONS_DOC,
  })
  @ApiResponse({ status: 200, description: 'The query result', type: TelemetryQueryResultDto })
  @ApiResponse({ status: 400, description: 'Validation error, refused or failed statement', type: ErrorDto })
  @ApiResponse({ status: 409, description: 'Telemetry is disabled', type: ErrorDto })
  @ApiResponse({ status: 503, description: 'No telemetry store, or it did not answer', type: ErrorDto })
  @ApiResponse({ status: 504, description: 'The statement timed out', type: ErrorDto })
  async query(@Body() dto: TelemetryQueryRequestDto, @CurrentUser('id') userId: string) {
    return this.queries.run(userId, dto.sql, { maxRows: dto.maxRows, source: 'explorer' });
  }

  @Get('schema')
  @Auth({ permissions: [PERMISSIONS.TELEMETRY_QUERY] })
  @ApiOperation({
    summary: 'List the telemetry tables and their columns (Admin only)',
    description:
      'Every table of the telemetry database with its row estimate and columns (name, SQL type, ' +
      'and GreptimeDB\'s semantic type: `TAG`, `FIELD` or `TIMESTAMP`), sorted by table name and ' +
      'column position. Cached for up to 30 seconds: tables appear on first write and attribute ' +
      'columns as new attributes arrive.\n\n' +
      ERROR_REASONS_DOC +
      ' and `TELEMETRY_QUERY_TIMEOUT` (504).',
  })
  @ApiResponse({ status: 200, description: 'The telemetry schema', type: TelemetrySchemaDto })
  @ApiResponse({ status: 409, description: 'Telemetry is disabled', type: ErrorDto })
  @ApiResponse({ status: 503, description: 'No telemetry store, or it did not answer', type: ErrorDto })
  @ApiResponse({ status: 504, description: 'The schema read timed out', type: ErrorDto })
  async getSchema() {
    return this.schema.getSchema();
  }

  @Post('export')
  @HttpCode(HttpStatus.OK)
  @Auth({ permissions: [PERMISSIONS.TELEMETRY_QUERY] })
  @ApiOperation({
    summary: 'Export a telemetry query result as a file (Admin only)',
    description:
      'Runs the statement exactly as `POST /api/admin/telemetry/query` does (same guard, same ' +
      'timeout, row cap = `telemetry.query.maxRows`) and returns the result as an attachment: ' +
      '`csv` (RFC 4180, UTF-8 with BOM; text cells that a spreadsheet would read as a formula ' +
      'are prefixed with `\'`), `ndjson` (one object per row; a repeated column name gets `_2`, ' +
      '`_3`), `xlsx` (one sheet, `results`) or `parquet`. `X-Telemetry-Row-Count` and ' +
      '`X-Telemetry-Truncated` report the row count and whether the cap cut the result short. ' +
      'Audited as `telemetry:export`.\n\n' +
      ERROR_REASONS_DOC +
      QUERY_REASONS_DOC,
  })
  @ApiProduces(...Object.values(TELEMETRY_EXPORT_CONTENT_TYPES).map((type) => type.split(';')[0]))
  @ApiResponse({
    status: 200,
    description: 'The exported file',
    headers: {
      'Content-Disposition': {
        description: '`attachment; filename="telemetry-<yyyyMMdd-HHmmss>.<format>"`',
        schema: { type: 'string' },
      },
      'X-Telemetry-Row-Count': { description: 'Rows in the file.', schema: { type: 'integer' } },
      'X-Telemetry-Truncated': {
        description: '`true` when more rows matched than the row cap allowed.',
        schema: { type: 'string', enum: ['true', 'false'] },
      },
    },
    content: Object.fromEntries(
      Object.values(TELEMETRY_EXPORT_CONTENT_TYPES).map((type) => [
        type.split(';')[0],
        { schema: { type: 'string', format: 'binary' } },
      ]),
    ),
  })
  @ApiResponse({ status: 400, description: 'Validation error, refused or failed statement', type: ErrorDto })
  @ApiResponse({ status: 409, description: 'Telemetry is disabled', type: ErrorDto })
  @ApiResponse({ status: 503, description: 'No telemetry store, or it did not answer', type: ErrorDto })
  @ApiResponse({ status: 504, description: 'The statement timed out', type: ErrorDto })
  async export(
    @Body() dto: TelemetryExportRequestDto,
    @CurrentUser('id') userId: string,
    @Res() reply: FastifyReply,
  ) {
    const file = await this.exports.export(userId, dto.sql, dto.format);

    return reply
      .status(200)
      .header('Content-Type', file.contentType)
      .header('Content-Disposition', `attachment; filename="${file.filename}"`)
      .header('Content-Length', String(file.buffer.length))
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Telemetry-Row-Count', String(file.rowCount))
      .header('X-Telemetry-Truncated', String(file.truncated))
      .send(file.buffer);
  }
}
