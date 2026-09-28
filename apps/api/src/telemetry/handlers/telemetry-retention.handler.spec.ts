import type { Job } from '@prisma/client';

import { DEFAULT_SYSTEM_SETTINGS } from '../../common/types/settings.types';
import { JOB_TYPE_LABELS, jobTypeLabel } from '../../jobs/job-type-labels';
import {
  retentionStatement,
  TELEMETRY_RETENTION_TYPE,
  TelemetryRetentionHandler,
} from './telemetry-retention.handler';

const JOB = { id: 'job-1' } as Job;

function build(options: { configured?: boolean; admin?: boolean; retentionDays?: number } = {}) {
  const registry = { register: jest.fn() };
  const systemSettings = {
    getTelemetryPolicy: jest.fn().mockResolvedValue({
      ...DEFAULT_SYSTEM_SETTINGS.telemetry,
      retentionDays: options.retentionDays ?? 14,
    }),
  };
  const greptime = {
    database: 'public',
    isConfigured: jest.fn().mockReturnValue(options.configured ?? true),
    isAdminConfigured: jest.fn().mockReturnValue(options.admin ?? true),
    queryAdmin: jest.fn().mockResolvedValue({ fields: [], rows: [] }),
  };

  const handler = new TelemetryRetentionHandler(registry as never, systemSettings as never, greptime as never);

  return { handler, registry, systemSettings, greptime };
}

describe('TelemetryRetentionHandler', () => {
  it('has the permanent type string and a 60s / 3-attempt profile', () => {
    const { handler } = build();

    expect(handler.type).toBe('telemetry.retention.apply');
    expect(TELEMETRY_RETENTION_TYPE).toBe('telemetry.retention.apply');
    expect(handler.profile).toEqual({ maxRuntimeMs: 60_000, maxAttempts: 3 });
  });

  it('is server-only: the admin credential must never reach a node', () => {
    const { handler } = build();

    expect((handler as unknown as Record<string, unknown>).nodeResultSchema).toBeUndefined();
    expect((handler as unknown as Record<string, unknown>).persistNodeResult).toBeUndefined();
  });

  it('self-registers', () => {
    const { handler, registry } = build();

    handler.onModuleInit();

    expect(registry.register).toHaveBeenCalledWith(handler);
  });

  it('is labelled for the jobs dashboard', () => {
    expect(JOB_TYPE_LABELS[TELEMETRY_RETENTION_TYPE]).toBe('Telemetry retention');
    expect(jobTypeLabel(TELEMETRY_RETENTION_TYPE)).not.toBe(TELEMETRY_RETENTION_TYPE);
  });

  it('sets the database TTL from telemetry.retentionDays on the admin connection', async () => {
    const { handler, greptime } = build({ retentionDays: 14 });

    await handler.process(JOB);

    expect(greptime.queryAdmin).toHaveBeenCalledTimes(1);
    expect(greptime.queryAdmin).toHaveBeenCalledWith(`ALTER DATABASE public SET 'ttl'='14d'`, {
      timeoutMs: 30_000,
    });
  });

  it('completes as a no-op when GreptimeDB is not configured', async () => {
    const { handler, greptime, systemSettings } = build({ configured: false });

    await expect(handler.process(JOB)).resolves.toBeUndefined();

    expect(greptime.queryAdmin).not.toHaveBeenCalled();
    expect(systemSettings.getTelemetryPolicy).not.toHaveBeenCalled();
  });

  it('completes as a no-op when the admin credential is missing', async () => {
    const { handler, greptime } = build({ admin: false });

    await expect(handler.process(JOB)).resolves.toBeUndefined();

    expect(greptime.queryAdmin).not.toHaveBeenCalled();
  });

  it('throws (so the queue retries) when GreptimeDB refuses', async () => {
    const { handler, greptime } = build();
    greptime.queryAdmin.mockRejectedValue(new Error('unreachable'));

    await expect(handler.process(JOB)).rejects.toThrow('unreachable');
  });
});

describe('retentionStatement', () => {
  it('emits the database name unquoted (GreptimeDB resolves a quoted name literally)', () => {
    expect(retentionStatement('telemetry_db', 30)).toBe(`ALTER DATABASE telemetry_db SET 'ttl'='30d'`);
  });

  it.each(['tele"metry', 'public; DROP TABLE x', '1db', ''])('refuses the non-plain database name %p', (db) => {
    expect(() => retentionStatement(db, 30)).toThrow();
  });

  it.each([0, -1, 3651, 1.5, Number.NaN])('refuses %p days', (days) => {
    expect(() => retentionStatement('public', days)).toThrow();
  });
});
