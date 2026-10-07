import { Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import { LOGS_TABLE, TRACES_TABLE } from '../dashboard/telemetry-dashboard.sql';
import { TelemetryStatus } from '../dto/telemetry-status.dto';
import { TelemetryStatusService } from '../telemetry-status.service';
import { TELEMETRY_SETTINGS_PATH } from './telemetry-export.doctor-check';

/** Pure: the two tables every telemetry page reads exist, and data expires. */
export function decideTelemetryTables(status: TelemetryStatus): DoctorCheckOutcome {
  const names = new Set(status.tables.map((t) => t.name));
  const missing = [TRACES_TABLE, LOGS_TABLE].filter((t) => !names.has(t));
  const data = {
    tables: status.tables.length,
    ttlDays: status.ttl?.days ?? null,
    retentionDays: status.retentionDays,
  };

  if (!status.reachable) {
    return {
      status: 'fail',
      detail: 'GreptimeDB could not be read',
      remedy: `Check the GreptimeDB connection at ${TELEMETRY_SETTINGS_PATH}.`,
      ...(status.error ? { error: status.error } : {}),
      data,
    };
  }

  if (missing.length > 0) {
    return {
      status: 'fail',
      detail: `Missing table(s): ${missing.join(', ')}; nothing has been exported into ${status.database} yet`,
      remedy:
        'Tables are created by the first export: check OTEL_ENABLED=true, OTEL_EXPORTER_OTLP_ENDPOINT points at ' +
        'the OpenTelemetry collector, and the collector writes to this GreptimeDB database.',
      ...(status.error ? { error: status.error } : {}),
      data,
    };
  }

  if (!status.ttl || status.ttl.days === null) {
    return {
      status: 'warn',
      detail: status.ttl
        ? `The retention (TTL) on database ${status.database} is "${status.ttl.raw}"; telemetry may never expire`
        : `No retention (TTL) is set on database ${status.database}; telemetry is kept forever`,
      remedy: `Apply the retention period at ${TELEMETRY_SETTINGS_PATH} (needs the GreptimeDB admin login).`,
      data,
    };
  }

  return {
    status: 'pass',
    detail: `${TRACES_TABLE} and ${LOGS_TABLE} present; retention ${status.ttl.raw}`,
    data,
  };
}

/** `telemetry` / `telemetry.tables` — the trace and log tables exist, with retention. */
@Injectable()
export class TelemetryTablesDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'telemetry.tables';
  readonly category = 'telemetry';
  readonly label = 'Telemetry tables and retention';
  readonly settingsPath = TELEMETRY_SETTINGS_PATH;
  readonly dependsOn = ['telemetry.reachable'];
  /** A ping plus two reads, each bounded at 5 s by the status service. */
  readonly timeoutMs = 12_000;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly status: TelemetryStatusService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    return decideTelemetryTables(await this.status.getStatus());
  }
}
