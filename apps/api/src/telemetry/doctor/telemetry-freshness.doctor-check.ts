import { Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import { LAST_DATA_LOOKBACK_MS, toDate } from '../dashboard/telemetry-dashboard.service';
import { lastDataSql } from '../dashboard/telemetry-dashboard.sql';
import { DASHBOARD_VERDICT_THRESHOLDS } from '../dashboard/telemetry-dashboard.verdict';
import { GreptimeClient, rowsAsObjects } from '../greptime/greptime.client';
import { TELEMETRY_SETTINGS_PATH } from './telemetry-export.doctor-check';

/** Per-statement ceiling, the same as the status reads. */
const FRESHNESS_QUERY_TIMEOUT_MS = 5_000;

/**
 * Pure: is data ACTUALLY arriving? The threshold is the dashboard verdict's
 * own `noDataMinutes`, so this check and the dashboard's "no data" banner
 * agree by construction.
 */
export function decideTelemetryFreshness(
  last: { traces: Date | null; logs: Date | null },
  now: Date = new Date(),
  noDataMinutes: number = DASHBOARD_VERDICT_THRESHOLDS.noDataMinutes,
): DoctorCheckOutcome {
  const age = (d: Date | null) => (d === null ? null : Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60_000)));
  const tracesAge = age(last.traces);
  const logsAge = age(last.logs);
  const data = {
    lastTraceAt: last.traces?.toISOString() ?? null,
    lastLogAt: last.logs?.toISOString() ?? null,
    lastTraceMinutesAgo: tracesAge,
    lastLogMinutesAgo: logsAge,
    thresholdMinutes: noDataMinutes,
  };
  const remedy =
    'Check the OpenTelemetry collector container is running and exporting to GreptimeDB, and that ' +
    `OTEL_EXPORTER_OTLP_ENDPOINT points at it. The dashboard at ${TELEMETRY_SETTINGS_PATH}/dashboard shows the gap.`;

  if (tracesAge === null && logsAge === null) {
    return { status: 'fail', detail: 'No trace or log has arrived in the last 7 days', remedy, data };
  }

  const stale: string[] = [];
  const describe = (kind: string, minutes: number | null) =>
    minutes === null ? `no ${kind} in 7 days` : `last ${kind} ${minutes}m ago`;

  if (tracesAge === null || tracesAge > noDataMinutes) stale.push(describe('trace', tracesAge));
  if (logsAge === null || logsAge > noDataMinutes) stale.push(describe('log', logsAge));

  if (stale.length > 0) {
    return { status: 'warn', detail: `Telemetry is not current: ${stale.join('; ')}`, remedy, data };
  }

  return {
    status: 'pass',
    detail: `Receiving data: ${describe('trace', tracesAge)}, ${describe('log', logsAge)}`,
    data,
  };
}

/**
 * `telemetry` / `telemetry.freshness` — traces and logs are actually being
 * captured, not merely configured.
 *
 * REUSES the dashboard's `lastDataSql` (the statement behind its `lastDataAt`)
 * over the READER path directly — `GreptimeClient.queryReader` — and not
 * `TelemetryDashboardService.summary`, which writes a `telemetry:dashboard`
 * audit row per read. Depends on `telemetry.tables`, so both tables exist.
 */
@Injectable()
export class TelemetryFreshnessDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'telemetry.freshness';
  readonly category = 'telemetry';
  readonly label = 'Telemetry data freshness';
  readonly settingsPath = `${TELEMETRY_SETTINGS_PATH}/dashboard`;
  readonly dependsOn = ['telemetry.tables'];
  readonly timeoutMs = FRESHNESS_QUERY_TIMEOUT_MS + 2_000;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly greptime: GreptimeClient,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const now = new Date();
    const sql = lastDataSql(
      new Date(now.getTime() - LAST_DATA_LOOKBACK_MS),
      new Date(now.getTime() + 60_000),
      {},
      { traces: true, logs: true },
    );

    const row = rowsAsObjects(await this.greptime.queryReader(sql, { timeoutMs: FRESHNESS_QUERY_TIMEOUT_MS }))[0] ?? {};

    return decideTelemetryFreshness({ traces: toDate(row.traces_last), logs: toDate(row.logs_last) }, now);
  }
}
