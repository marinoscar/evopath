import { ConfigService } from '@nestjs/config';

import { telemetryGate } from '@marinoscar/platform-api/otel-core';
import { DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import { TelemetryConnectionService } from '../connection/telemetry-connection.service';
import { TelemetryStatus } from '../dto/telemetry-status.dto';
import { GreptimeClient } from '../greptime/greptime.client';
import { TelemetrySettingsService } from '../telemetry-settings.service';
import { TelemetryStatusService } from '../telemetry-status.service';
import { TelemetryConnectionDoctorCheck } from './telemetry-connection.doctor-check';
import {
  TelemetryExportDoctorCheck,
  decideTelemetryExport,
  displayOtlpEndpoint,
} from './telemetry-export.doctor-check';
import { TelemetryFreshnessDoctorCheck, decideTelemetryFreshness } from './telemetry-freshness.doctor-check';
import { TelemetryReachableDoctorCheck } from './telemetry-reachable.doctor-check';
import { TelemetryTablesDoctorCheck, decideTelemetryTables } from './telemetry-tables.doctor-check';

function expectRemedy(outcome: DoctorCheckOutcome): void {
  expect(['warn', 'fail']).toContain(outcome.status);
  expect(outcome.remedy).toEqual(expect.stringMatching(/\S{10,}/));
}

const registry = () => new DoctorCheckRegistry();

describe('telemetry doctor checks', () => {
  describe('telemetry.export', () => {
    const on = { collectionEnabled: true, sdkEnabled: true, gateOpen: true, endpoint: 'http://otel-collector:4318' };

    it('is skip when collection is off — intentional, no remedy', () => {
      const outcome = decideTelemetryExport({ ...on, collectionEnabled: false });
      expect(outcome).toMatchObject({ status: 'skip', detail: 'Telemetry collection is off' });
      expect(outcome.remedy).toBeUndefined();
    });

    it('fails when collection is on but the SDK is not installed', () => {
      const outcome = decideTelemetryExport({ ...on, sdkEnabled: false });
      expect(outcome.status).toBe('fail');
      expect(outcome.remedy).toContain('OTEL_ENABLED=true');
    });

    it('warns while the export gate is closed', () => {
      expectRemedy(decideTelemetryExport({ ...on, gateOpen: false }));
    });

    it('passes with the endpoint', () => {
      expect(decideTelemetryExport(on)).toMatchObject({
        status: 'pass',
        detail: 'Exporting to http://otel-collector:4318',
      });
    });

    it('strips credentials and query strings from the endpoint', () => {
      expect(displayOtlpEndpoint('https://user:s3cret@otlp.example.com:4318/v1?token=abc')).toBe(
        'https://otlp.example.com:4318/v1',
      );
      expect(displayOtlpEndpoint(undefined)).toBeNull();
    });

    it('reads the policy fresh, the SDK switch and the gate', async () => {
      const getPolicy = jest.fn().mockResolvedValue({ enabled: true });
      const values: Record<string, unknown> = { 'otel.enabled': true, 'otel.endpoint': 'http://c:4318' };
      const check = new TelemetryExportDoctorCheck(
        registry(),
        { getPolicy } as unknown as TelemetrySettingsService,
        { get: (k: string) => values[k] } as unknown as ConfigService,
      );
      const previous = telemetryGate.isEnabled();
      telemetryGate.setEnabled(true);

      try {
        await expect(check.run()).resolves.toMatchObject({ status: 'pass' });
        expect(getPolicy).toHaveBeenCalledWith({ fresh: true });
      } finally {
        telemetryGate.setEnabled(previous);
      }
    });
  });

  describe('telemetry.connection', () => {
    const make = (configured: boolean, problem: string | null = null) =>
      new TelemetryConnectionDoctorCheck(registry(), {
        describeSnapshot: () => ({
          source: configured ? 'environment' : 'none',
          host: configured ? 'greptimedb' : '',
          pgPort: 4003,
          database: 'public',
          reader: { user: 'reader', passwordSet: configured },
        }),
        isConfigured: () => configured,
        isAdminConfigured: () => false,
        configurationProblem: () => problem,
      } as unknown as TelemetryConnectionService);

    it('passes a configured reader, reporting only non-secret facts', async () => {
      const outcome = await make(true).run();
      expect(outcome).toMatchObject({ status: 'pass', detail: 'greptimedb:4003/public (environment)' });
      expect(outcome.data).toMatchObject({ readerPasswordSet: true });
    });

    it('fails with the deployment’s own problem when it has one', async () => {
      const outcome = await make(false, 'The deployment provisions no GreptimeDB reader login.').run();
      expect(outcome.detail).toContain('no GreptimeDB reader login');
      expectRemedy(outcome);
    });

    it('fails generically otherwise, and depends on telemetry.export', async () => {
      const check = make(false);
      expectRemedy(await check.run());
      expect(check.dependsOn).toEqual(['telemetry.export']);
    });
  });

  describe('telemetry.reachable', () => {
    const make = (ping: object) =>
      new TelemetryReachableDoctorCheck(registry(), {
        ping: jest.fn().mockResolvedValue(ping),
      } as unknown as GreptimeClient);

    it('passes with the version', async () => {
      const outcome = await make({ reachable: true, version: 'PostgreSQL 16.3 GreptimeDB 1.2.1' }).run();
      expect(outcome).toMatchObject({ status: 'pass', data: { version: 'PostgreSQL 16.3 GreptimeDB 1.2.1' } });
    });

    it('fails with the error when unreachable', async () => {
      const outcome = await make({ reachable: false, error: 'connect ECONNREFUSED' }).run();
      expect(outcome.error).toBe('connect ECONNREFUSED');
      expectRemedy(outcome);
    });
  });

  describe('telemetry.tables', () => {
    const status = (overrides: Partial<TelemetryStatus> = {}): TelemetryStatus => ({
      configured: true,
      reachable: true,
      version: 'x',
      database: 'public',
      ttl: { raw: '7days', days: 7 },
      retentionDays: 7,
      tables: [
        { name: 'opentelemetry_traces', rows: 10 },
        { name: 'opentelemetry_logs', rows: 10 },
      ],
      error: null,
      ...overrides,
    });

    it('passes with both tables and a TTL', () => {
      expect(decideTelemetryTables(status())).toMatchObject({ status: 'pass', data: { ttlDays: 7 } });
    });

    it('fails when a table is missing, naming it', () => {
      const outcome = decideTelemetryTables(status({ tables: [{ name: 'opentelemetry_traces', rows: 1 }] }));
      expect(outcome.detail).toContain('opentelemetry_logs');
      expectRemedy(outcome);
    });

    it('warns when no TTL is set, or it is forever', () => {
      expectRemedy(decideTelemetryTables(status({ ttl: null })));
      expectRemedy(decideTelemetryTables(status({ ttl: { raw: 'forever', days: null } })));
    });

    it('fails when the store could not be read', () => {
      expectRemedy(decideTelemetryTables(status({ reachable: false, tables: [], error: 'boom' })));
    });

    it('reads the status service', async () => {
      const getStatus = jest.fn().mockResolvedValue(status());
      const check = new TelemetryTablesDoctorCheck(registry(), { getStatus } as unknown as TelemetryStatusService);
      await expect(check.run()).resolves.toMatchObject({ status: 'pass' });
      expect(check.dependsOn).toEqual(['telemetry.reachable']);
    });
  });

  describe('telemetry.freshness', () => {
    const NOW = new Date('2026-09-30T12:00:00Z');
    const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

    it('passes when traces and logs are both recent', () => {
      expect(decideTelemetryFreshness({ traces: minutesAgo(1), logs: minutesAgo(2) }, NOW, 5)).toMatchObject({
        status: 'pass',
        data: { lastTraceMinutesAgo: 1, lastLogMinutesAgo: 2 },
      });
    });

    it('warns "last trace Xm ago" when one side is stale', () => {
      const outcome = decideTelemetryFreshness({ traces: minutesAgo(42), logs: minutesAgo(1) }, NOW, 5);
      expect(outcome.status).toBe('warn');
      expect(outcome.detail).toContain('last trace 42m ago');
      expectRemedy(outcome);
    });

    it('warns when one side has nothing in 7 days', () => {
      const outcome = decideTelemetryFreshness({ traces: minutesAgo(1), logs: null }, NOW, 5);
      expect(outcome.detail).toContain('no log in 7 days');
      expectRemedy(outcome);
    });

    it('fails when nothing arrived in 7 days', () => {
      const outcome = decideTelemetryFreshness({ traces: null, logs: null }, NOW, 5);
      expect(outcome.status).toBe('fail');
      expectRemedy(outcome);
    });

    it('queries the reader path with the dashboard’s lastDataSql — no audit write', async () => {
      const queryReader = jest.fn().mockResolvedValue({
        fields: [{ name: 'traces_last' }, { name: 'logs_last' }],
        rows: [[new Date().toISOString(), new Date().toISOString()]],
      });
      const check = new TelemetryFreshnessDoctorCheck(registry(), { queryReader } as unknown as GreptimeClient);

      await expect(check.run()).resolves.toMatchObject({ status: 'pass' });
      const sql = String(queryReader.mock.calls[0][0]);
      expect(sql).toContain('traces_last');
      expect(sql).toContain('opentelemetry_logs');
      expect(check.dependsOn).toEqual(['telemetry.tables']);
    });
  });
});
