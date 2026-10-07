import { DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import { PrismaService } from '../../prisma/prisma.service';
import { DatabaseBackupAdminService } from '../db-backup-admin.service';
import { PgVersionCheck } from '../pg-version.util';
import { BackupPgClientDoctorCheck, decidePgClient } from './backup-pg-client.doctor-check';
import { BackupScheduleDoctorCheck, decideBackupSchedule } from './backup-schedule.doctor-check';

function expectRemedy(outcome: DoctorCheckOutcome): void {
  expect(['warn', 'fail']).toContain(outcome.status);
  expect(outcome.remedy).toEqual(expect.stringMatching(/\S{10,}/));
}

const NOW = new Date('2026-09-30T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe('backup doctor checks', () => {
  describe('backup.schedule', () => {
    const base = {
      enabled: true,
      nextRunAt: '2026-10-01T02:00:00.000Z',
      latestTerminal: { status: 'completed', finishedAt: hoursAgo(10), lastError: null },
      lastSuccessAt: hoursAgo(10),
    };

    it('passes a recent success on an enabled schedule', () => {
      expect(decideBackupSchedule(base, NOW)).toMatchObject({ status: 'pass', data: { lastSuccessAgeHours: 10 } });
    });

    it('fails when the latest run failed, carrying its error', () => {
      const outcome = decideBackupSchedule(
        { ...base, latestTerminal: { status: 'failed', finishedAt: hoursAgo(1), lastError: 'pg_dump: error: x' } },
        NOW,
      );

      expect(outcome).toMatchObject({ status: 'fail', error: 'pg_dump: error: x' });
      expectRemedy(outcome);
    });

    it('fails when the latest run went stale', () => {
      const outcome = decideBackupSchedule(
        { ...base, latestTerminal: { status: 'stale', finishedAt: null, lastError: null } },
        NOW,
      );
      expect(outcome.detail).toContain('went stale');
      expectRemedy(outcome);
    });

    it('warns when the schedule is off', () => {
      expectRemedy(decideBackupSchedule({ ...base, enabled: false }, NOW));
    });

    it('warns when enabled but no backup ever completed', () => {
      const outcome = decideBackupSchedule({ ...base, latestTerminal: null, lastSuccessAt: null }, NOW);
      expect(outcome.detail).toContain('none has ever completed');
      expectRemedy(outcome);
    });

    it('warns when the last success is older than 48 h', () => {
      expectRemedy(decideBackupSchedule({ ...base, lastSuccessAt: hoursAgo(49) }, NOW));
      expect(decideBackupSchedule({ ...base, lastSuccessAt: hoursAgo(48) }, NOW).status).toBe('pass');
    });

    it('reads the config and the two latest runs', async () => {
      const getConfig = jest.fn().mockResolvedValue({ enabled: true, nextRunAt: null });
      const findFirst = jest
        .fn()
        .mockResolvedValueOnce({ status: 'completed', finishedAt: new Date(), lastError: null })
        .mockResolvedValueOnce({ finishedAt: new Date(), createdAt: new Date() });
      const check = new BackupScheduleDoctorCheck(
        new DoctorCheckRegistry(),
        { getConfig } as unknown as DatabaseBackupAdminService,
        { databaseBackupRun: { findFirst } } as unknown as PrismaService,
      );

      await expect(check.run()).resolves.toMatchObject({ status: 'pass' });
      expect(findFirst).toHaveBeenCalledTimes(2);
    });
  });

  describe('backup.pg-client', () => {
    const version = (overrides: Partial<PgVersionCheck>): PgVersionCheck => ({
      status: 'ok',
      client: 'pg_dump (PostgreSQL) 17.2',
      clientMajor: 17,
      serverMajor: 16,
      message: '',
      ...overrides,
    });

    it('passes a client that can dump the server', () => {
      expect(decidePgClient(version({}))).toMatchObject({ status: 'pass', data: { clientMajor: 17, serverMajor: 16 } });
    });

    it('fails a client older than the server', () => {
      expectRemedy(decidePgClient(version({ status: 'blocked', clientMajor: 16, serverMajor: 17 })));
    });

    it('fails a client older than the pinned minimum', () => {
      const outcome = decidePgClient(version({ clientMajor: 15, serverMajor: 15 }));
      expect(outcome.status).toBe('fail');
      expectRemedy(outcome);
    });

    it('warns when pg_dump is missing', () => {
      const outcome = decidePgClient(version({ status: 'unknown', client: null, clientMajor: null }));
      expect(outcome.status).toBe('warn');
      expectRemedy(outcome);
    });

    it('passes, saying so, when only the server version is unknown', () => {
      const outcome = decidePgClient(version({ status: 'unknown', serverMajor: null }));
      expect(outcome).toMatchObject({ status: 'pass', detail: expect.stringContaining('could not be read') });
    });

    it('allows pg_dump --version its own timeout and registers itself', async () => {
      const registry = new DoctorCheckRegistry();
      const check = new BackupPgClientDoctorCheck(registry);
      (check as unknown as { probe: () => Promise<PgVersionCheck> }).probe = async () => version({});
      check.onModuleInit();

      await expect(check.run()).resolves.toMatchObject({ status: 'pass' });
      expect(check.timeoutMs).toBeGreaterThan(10_000);
      expect(registry.get('backup.pg-client')).toBe(check);
    });
  });
});
