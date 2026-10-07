// =============================================================================
// TelemetryHostModule: the app's adapters for the telemetry slice's host ports
// (marinoscar/EnterpriseAppBase#703, PP-4.2)
// =============================================================================
//
// Passed to `TelemetryModule.forRoot({ imports: [TelemetryHostModule] })`.
// Imports the app modules the adapters need (jobs, settings, AI,
// credentials; Prisma is global) and exports one provider per port, so the
// telemetry slice injects capabilities by token and never imports app code.
// =============================================================================

import { Module } from '@nestjs/common';

import { AiModule } from '../../ai/ai.module';
import { CredentialsModule } from '../../credentials/credentials.module';
import { CredentialsService } from '../../credentials/credentials.service';
import { JobsModule } from '../../jobs/jobs.module';
import { SettingsModule } from '../../settings/settings.module';
import {
  TELEMETRY_AI,
  TELEMETRY_APP_INFO,
  TELEMETRY_AUDIT_SINK,
  TELEMETRY_CREDENTIAL_STORE,
  TELEMETRY_JOBS,
  TELEMETRY_SETTINGS_STORE,
  type TelemetryCredentialStore,
} from '@marinoscar/platform-api/telemetry';
import { TelemetryAiAdapter } from './telemetry-ai.adapter';
import { TelemetryAppInfoAdapter } from './telemetry-app-info.adapter';
import { TelemetryAuditSinkAdapter } from './telemetry-audit-sink.adapter';
import { TelemetryJobsAdapter } from './telemetry-jobs.adapter';
import { TelemetrySettingsStoreAdapter } from './telemetry-settings-store.adapter';

/** Compile-time proof that the credential service IS the credential port, unadapted. */
export type CredentialsServiceIsTelemetryCredentialStore = CredentialsService extends TelemetryCredentialStore
  ? true
  : never;
const _credentialsFit: CredentialsServiceIsTelemetryCredentialStore = true;
void _credentialsFit;

const PORTS = [
  { provide: TELEMETRY_AUDIT_SINK, useClass: TelemetryAuditSinkAdapter },
  { provide: TELEMETRY_SETTINGS_STORE, useClass: TelemetrySettingsStoreAdapter },
  { provide: TELEMETRY_CREDENTIAL_STORE, useExisting: CredentialsService },
  { provide: TELEMETRY_JOBS, useClass: TelemetryJobsAdapter },
  { provide: TELEMETRY_AI, useClass: TelemetryAiAdapter },
  { provide: TELEMETRY_APP_INFO, useClass: TelemetryAppInfoAdapter },
];

@Module({
  imports: [JobsModule, SettingsModule, AiModule, CredentialsModule],
  providers: PORTS,
  exports: PORTS.map((port) => port.provide),
})
export class TelemetryHostModule {}
