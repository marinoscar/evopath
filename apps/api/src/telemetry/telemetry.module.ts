import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { CredentialsModule } from '../credentials/credentials.module';
import { JobsModule } from '../jobs/jobs.module';
import { SettingsModule } from '../settings/settings.module';
import { TelemetryAssistantController } from './assistant/telemetry-assistant.controller';
import { TelemetryAssistantService } from './assistant/telemetry-assistant.service';
import { TelemetryConnectionAdminService } from './connection/telemetry-connection-admin.service';
import { TelemetryConnectionTestService } from './connection/telemetry-connection-test.service';
import { TelemetryConnectionController } from './connection/telemetry-connection.controller';
import { TelemetryConnectionService } from './connection/telemetry-connection.service';
import { TelemetryDashboardController } from './dashboard/telemetry-dashboard.controller';
import { TelemetryDashboardService } from './dashboard/telemetry-dashboard.service';
import { TelemetryExportService } from './export/telemetry-export.service';
import { GreptimeClient } from './greptime/greptime.client';
import { TelemetryRetentionHandler } from './handlers/telemetry-retention.handler';
import { TelemetryQueryService } from './query/telemetry-query.service';
import { TelemetrySchemaService } from './query/telemetry-schema.service';
import { StackAgentClient } from './stack/stack-agent.client';
import { TelemetryStackDeployHandler } from './stack/telemetry-stack-deploy.handler';
import { TelemetryStackController } from './stack/telemetry-stack.controller';
import { TelemetryStackService } from './stack/telemetry-stack.service';
import { TelemetryRetentionTask } from './tasks/telemetry-retention.task';
import { TelemetryAdminController } from './telemetry-admin.controller';
import { TelemetryConfigController } from './telemetry-config.controller';
import { TelemetryExplorerController } from './telemetry-explorer.controller';
import { TelemetrySettingsService } from './telemetry-settings.service';
import { TelemetryStatusService } from './telemetry-status.service';
import { TelemetryConnectionDoctorCheck } from './doctor/telemetry-connection.doctor-check';
import { TelemetryExportDoctorCheck } from './doctor/telemetry-export.doctor-check';
import { TelemetryFreshnessDoctorCheck } from './doctor/telemetry-freshness.doctor-check';
import { TelemetryReachableDoctorCheck } from './doctor/telemetry-reachable.doctor-check';
import { TelemetryTablesDoctorCheck } from './doctor/telemetry-tables.doctor-check';

// =============================================================================
// TelemetryModule (issue #534, epic #528)
// =============================================================================
//
// The API side of observability: the `telemetry` settings (and the runtime
// export gate they drive), the GreptimeDB client, the store's status, and the
// server-only `telemetry.retention.apply` job with its enqueue-only cron.
//
// The explorer (#535): `TelemetryQueryService` (the one entry point for
// caller-supplied SQL: guard, row cap, timeout, audit), `TelemetrySchemaService`
// (tables and columns) and `TelemetryExportService` (csv/ndjson/xlsx/parquet),
// behind `TelemetryExplorerController` on `telemetry:query`.
//
// The assistant (#536, #571): `TelemetryAssistantService` runs a
// troubleshooting agent's tool loop through `AiService` (hence `AiModule`);
// every statement its tools run — the model's and the ones it builds itself
// (`assistant/telemetry-assistant.sql.ts`) — goes through
// `TelemetryQueryService.run` with `source: 'assistant'`, so it is held to
// exactly the explorer's guard and bounds; `TelemetrySchemaService` lists and
// describes tables, and `SystemSettingsService` (from `SettingsModule`) gives
// the allowlisted feature flags `get_app_context` reports. Streamed by
// `TelemetryAssistantController`.
//
// The connection (#558): `TelemetryConnectionService` resolves the GreptimeDB
// connection at runtime — the one saved at /admin/settings/telemetry (a
// `telemetry_connection` system-settings row plus two passwords in the
// credential store, hence `CredentialsModule`), else the `GREPTIME_*`
// deployment default. `GreptimeClient` builds its pools from it and rebuilds
// them when it changes. `TelemetryConnectionController` is the admin surface.
//
// The services (#567): on a VPS, `StackAgentClient` talks to the
// `stack-agent` sidecar (STACK_AGENT_URL/TOKEN) to report the telemetry
// containers' state and to start them through the server-only
// `telemetry.stack.deploy` job. `TelemetryStackController` is the admin
// surface, under /api/admin/telemetry/stack.
//
// The dashboard (#577): `TelemetryDashboardService` runs the fixed,
// server-authored statements of `dashboard/telemetry-dashboard.sql.ts` (no
// caller SQL) on the reader pool, with a 15 s result cache, behind
// `TelemetryDashboardController` on `telemetry:query`.
//
// `GreptimeClient`, `TelemetrySettingsService` and the two query services are
// exported for it.
// =============================================================================

@Module({
  imports: [JobsModule, SettingsModule, AiModule, CredentialsModule],
  controllers: [
    TelemetryAdminController,
    TelemetryConfigController,
    TelemetryExplorerController,
    TelemetryAssistantController,
    TelemetryConnectionController,
    TelemetryStackController,
    TelemetryDashboardController,
  ],
  providers: [
    TelemetryConnectionService,
    TelemetryConnectionAdminService,
    TelemetryConnectionTestService,
    GreptimeClient,
    TelemetrySettingsService,
    TelemetryStatusService,
    TelemetryRetentionHandler,
    TelemetryRetentionTask,
    TelemetryQueryService,
    TelemetrySchemaService,
    TelemetryExportService,
    TelemetryAssistantService,
    StackAgentClient,
    TelemetryStackService,
    TelemetryStackDeployHandler,
    TelemetryDashboardService,
    // Doctor checks (#634): read-only — never the connection test (it
    // audits) and never the dashboard service's audited reads.
    TelemetryExportDoctorCheck,
    TelemetryConnectionDoctorCheck,
    TelemetryReachableDoctorCheck,
    TelemetryTablesDoctorCheck,
    TelemetryFreshnessDoctorCheck,
  ],
  exports: [GreptimeClient, TelemetrySettingsService, TelemetryQueryService, TelemetrySchemaService],
})
export class TelemetryModule {}
