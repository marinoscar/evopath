import { Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '../../doctor/doctor-check.interface';
import { DoctorCheckRegistry } from '../../doctor/doctor-check.registry';
import { TelemetryConnectionService } from '../connection/telemetry-connection.service';
import { TELEMETRY_SETTINGS_PATH } from './telemetry-export.doctor-check';

/**
 * `telemetry` / `telemetry.connection` — a GreptimeDB reader connection is
 * configured. Reads the in-memory snapshot only (no network): host, port,
 * database and where the connection came from. Passwords are known only as
 * "set" or not.
 */
@Injectable()
export class TelemetryConnectionDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'telemetry.connection';
  readonly category = 'telemetry';
  readonly label = 'GreptimeDB connection';
  readonly settingsPath = TELEMETRY_SETTINGS_PATH;
  readonly dependsOn = ['telemetry.export'];

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly connection: TelemetryConnectionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const snapshot = this.connection.describeSnapshot();
    const data = {
      source: snapshot.source,
      host: snapshot.host || null,
      port: snapshot.pgPort,
      database: snapshot.database,
      readerPasswordSet: snapshot.reader.passwordSet,
      adminConfigured: this.connection.isAdminConfigured(),
    };

    if (!this.connection.isConfigured()) {
      return {
        status: 'fail',
        detail: this.connection.configurationProblem('reader') ?? 'No GreptimeDB reader connection is configured',
        remedy: `Save the GreptimeDB host and reader login at ${TELEMETRY_SETTINGS_PATH}, or set the GREPTIME_* deployment defaults.`,
        data,
      };
    }

    return {
      status: 'pass',
      detail: `${snapshot.host}:${snapshot.pgPort}/${snapshot.database} (${snapshot.source})`,
      data,
    };
  }
}
