import { Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import { GREPTIME_PING_TIMEOUT_MS, GreptimeClient } from '../greptime/greptime.client';
import { TELEMETRY_SETTINGS_PATH } from './telemetry-export.doctor-check';

/**
 * `telemetry` / `telemetry.reachable` — GreptimeDB answers `SELECT version()`
 * as the reader. `GreptimeClient.ping()` never throws. NOT the connection
 * test service, which audits the attempt.
 */
@Injectable()
export class TelemetryReachableDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'telemetry.reachable';
  readonly category = 'telemetry';
  readonly label = 'GreptimeDB reachability';
  readonly settingsPath = TELEMETRY_SETTINGS_PATH;
  readonly dependsOn = ['telemetry.connection'];
  readonly timeoutMs = GREPTIME_PING_TIMEOUT_MS + 2_000;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly greptime: GreptimeClient,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const started = Date.now();
    const ping = await this.greptime.ping();
    const latencyMs = Date.now() - started;

    if (!ping.reachable) {
      return {
        status: 'fail',
        detail: 'GreptimeDB did not answer as the reader',
        remedy:
          `Check the GreptimeDB container is running and reachable from the API, and the reader login at ` +
          `${TELEMETRY_SETTINGS_PATH} (its "Test connection" button gives a full diagnosis).`,
        ...(ping.error ? { error: ping.error } : {}),
        data: { latencyMs },
      };
    }

    return {
      status: 'pass',
      detail: `Answered in ${latencyMs} ms${ping.version ? `: ${ping.version}` : ''}`,
      data: { latencyMs, version: ping.version ?? null },
    };
  }
}
