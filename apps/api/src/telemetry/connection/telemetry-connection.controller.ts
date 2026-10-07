import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ErrorDto } from '@marinoscar/platform-api/core';
import {
  TelemetryConnectionResponseDto,
  TelemetryConnectionTestResultDto,
  TestTelemetryConnectionDto,
  UpdateTelemetryConnectionDto,
} from './dto/telemetry-connection.dto';
import { TelemetryConnectionAdminService } from './telemetry-connection-admin.service';
import { TelemetryConnectionTestService } from './telemetry-connection-test.service';

// =============================================================================
// TelemetryConnectionController (issue #558, epic #528)
// =============================================================================
//
//   GET    /api/admin/telemetry/connection        telemetry:read
//   PUT    /api/admin/telemetry/connection        telemetry:write  (If-Match optional → 409)
//   DELETE /api/admin/telemetry/connection        telemetry:write  (If-Match optional → 409)
//   POST   /api/admin/telemetry/connection/test   telemetry:write  (always 200)
//
// The same permission strings as the rest of the telemetry admin surface, so
// the one `telemetry` settings card covers it (CLAUDE.md, Settings UI Pattern
// rule 3).
// =============================================================================

const IF_MATCH_DESCRIPTION =
  'Expected `version` of the stored connection, for optimistic concurrency (`0` asserts ' +
  'nothing is stored). Omit to write unconditionally. The connection has its own version ' +
  'counter, so a concurrent save of an unrelated setting cannot conflict with it.';

@ApiTags('Telemetry')
@Controller('admin/telemetry/connection')
export class TelemetryConnectionController {
  constructor(
    private readonly admin: TelemetryConnectionAdminService,
    private readonly tester: TelemetryConnectionTestService,
  ) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.TELEMETRY_READ] })
  @ApiOperation({
    summary: 'Get the telemetry store connection (Admin only)',
    description:
      'The GreptimeDB connection in force and where it comes from: `source` is `stored` ' +
      '(saved on this page), `environment` (nothing saved: the GreptimeDB deployed with this ' +
      'application) or `none`.\n\n' +
      'The host mode decides who owns the whole connection. **Automatic** (`hostMode: auto`, ' +
      '`host: null`) is the GreptimeDB deployed with this application: its host, port, database, ' +
      'logins and passwords all come from the deployment, and `deploymentManaged` is true — ' +
      'there are no credentials to enter. **Custom** (`hostMode: custom`, `host` a literal, ' +
      '`source: stored`) is used wholly as saved, passwords from the credential store. ' +
      '`effectiveHost` is the host actually used.\n\n' +
      '`deployment` describes the GreptimeDB deployed with this application (host, port, ' +
      'database, users, and whether it provisions a reader and an admin login) whatever is in ' +
      'force; `problem` says, in administrator language, why a deployment-managed connection ' +
      'cannot be used (null otherwise).\n\n' +
      '**Passwords are never returned.** `credentials.reader` / `credentials.admin` say ' +
      'whether each password is present, with a masked `hint` only for a custom connection\'s ' +
      'stored password.',
  })
  @ApiResponse({ status: 200, description: 'The telemetry store connection', type: TelemetryConnectionResponseDto })
  async getConnection() {
    return this.admin.describeForAdmin();
  }

  @Put()
  @Auth({ permissions: [PERMISSIONS.TELEMETRY_WRITE] })
  @ApiOperation({
    summary: 'Save the telemetry store connection (Admin only)',
    description:
      'Saves the GreptimeDB connection. It takes effect on this instance immediately and on ' +
      'every other one within five seconds — no restart.\n\n' +
      '**Automatic** — `host` omitted, null or blank: the GreptimeDB deployed with this ' +
      'application. Only that choice is stored; the host, port, database, logins and passwords ' +
      'all come from the deployment. Every other field is accepted and **ignored**, and any ' +
      'stored reader/admin password is deleted. Nothing is required.\n\n' +
      '**Custom** — a literal `host`: used wholly as saved. `readerUser` and `adminUser` (null ' +
      'for none) are required; `pgPort` and `database` default to `4003` and `public`. ' +
      '`readerPassword` / `adminPassword` are **write-only**: omit them or send them empty to ' +
      'keep the stored ones. A save with no stored password to keep is a 400 — the ' +
      'deployment\'s password is never copied into the store. `adminUser: null` removes the ' +
      'admin login and its stored password (retention is then not applied).\n\n' +
      'Every save re-applies the export gate and queues a `telemetry.retention.apply` job.',
  })
  @ApiHeader({ name: 'If-Match', description: IF_MATCH_DESCRIPTION, required: false })
  @ApiResponse({ status: 200, description: 'The saved connection', type: TelemetryConnectionResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Validation error, or (custom host) a required user or password is missing',
    type: ErrorDto,
  })
  @ApiResponse({ status: 409, description: 'Version conflict', type: ErrorDto })
  async replaceConnection(
    @Body() dto: UpdateTelemetryConnectionDto,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.admin.replace(dto, userId, parseIfMatch(ifMatch));
  }

  @Delete()
  @Auth({ permissions: [PERMISSIONS.TELEMETRY_WRITE] })
  @ApiOperation({
    summary: 'Reset the telemetry store connection (Admin only)',
    description:
      'Deletes the stored connection and both stored passwords, so the `GREPTIME_*` deployment ' +
      'default applies again (or no connection, when the deployment has none). Takes effect ' +
      'like a save: immediately here, within five seconds everywhere else.',
  })
  @ApiHeader({ name: 'If-Match', description: IF_MATCH_DESCRIPTION, required: false })
  @ApiResponse({ status: 200, description: 'The connection now in force', type: TelemetryConnectionResponseDto })
  @ApiResponse({ status: 409, description: 'Version conflict', type: ErrorDto })
  async resetConnection(@CurrentUser('id') userId: string, @Headers('if-match') ifMatch?: string) {
    return this.admin.reset(userId, parseIfMatch(ifMatch));
  }

  @Post('test')
  @Auth({ permissions: [PERMISSIONS.TELEMETRY_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Test a telemetry store connection (Admin only)',
    description:
      'Checks the connection **in the request body**, which does not have to have been saved: ' +
      'the reader runs `SELECT version()`, the admin (when there is an admin user) runs ' +
      '`SHOW CREATE DATABASE <database>`.\n\n' +
      'A blank host is **automatic**: the GreptimeDB deployed with this application is probed ' +
      'with the deployment\'s own port, database, logins and passwords — any submitted ones are ' +
      'ignored — and a login the deployment does not provide is reported in the probe\'s ' +
      '`error`. For a **custom** host the body is probed as sent, and a blank password means ' +
      'the one the connection in force uses for that login. The host actually probed is ' +
      'returned as `host`, with `hostMode`.\n\n' +
      '**Always 200** — read `reader.success` and `admin.success` (or `admin.skipped`). Each ' +
      'check is bounded to five seconds to connect and five to answer.',
  })
  @ApiResponse({ status: 200, description: 'The outcome of each check', type: TelemetryConnectionTestResultDto })
  @ApiResponse({ status: 400, description: 'Validation error', type: ErrorDto })
  async testConnection(@Body() dto: TestTelemetryConnectionDto, @CurrentUser('id') userId: string) {
    return this.tester.test(dto, userId);
  }
}

/** An unparseable `If-Match` is treated as absent, exactly as the other admin controllers do. */
function parseIfMatch(ifMatch: string | undefined): number | undefined {
  const parsed = ifMatch !== undefined ? Number.parseInt(ifMatch, 10) : NaN;

  return Number.isInteger(parsed) ? parsed : undefined;
}
