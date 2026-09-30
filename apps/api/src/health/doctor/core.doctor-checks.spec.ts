import { HealthCheckError } from '@nestjs/terminus';

import { DoctorCheckOutcome } from '../../doctor/doctor-check.interface';
import { DoctorCheckRegistry } from '../../doctor/doctor-check.registry';
import { DatabaseHealthIndicator } from '../indicators/database.indicator';
import { PrismaService } from '../../prisma/prisma.service';
import { DbConnectionDoctorCheck } from './db-connection.doctor-check';
import { DbMigrationsDoctorCheck, decideMigrations } from './db-migrations.doctor-check';
import { EncryptionKeyDoctorCheck } from './encryption-key.doctor-check';

function expectRemedy(outcome: DoctorCheckOutcome): void {
  expect(['warn', 'fail']).toContain(outcome.status);
  expect(outcome.remedy).toEqual(expect.stringMatching(/\S{10,}/));
}

describe('core doctor checks', () => {
  describe('db.connection', () => {
    const make = (isHealthy: jest.Mock) => {
      const registry = new DoctorCheckRegistry();
      const check = new DbConnectionDoctorCheck(registry, { isHealthy } as unknown as DatabaseHealthIndicator);
      check.onModuleInit();
      return { check, registry };
    };

    it('registers itself', () => {
      const { registry, check } = make(jest.fn());
      expect(registry.get('db.connection')).toBe(check);
    });

    it('passes with the latency', async () => {
      const { check } = make(jest.fn().mockResolvedValue({ database: { status: 'up', responseTime: '4ms' } }));

      await expect(check.run()).resolves.toMatchObject({ status: 'pass', data: { latencyMs: 4 } });
    });

    it('warns when SELECT 1 is slow', async () => {
      const { check } = make(jest.fn().mockResolvedValue({ database: { status: 'up', responseTime: '900ms' } }));
      const outcome = await check.run();

      expect(outcome.status).toBe('warn');
      expectRemedy(outcome);
    });

    it('fails with the indicator’s message when the database is down', async () => {
      const error = new HealthCheckError('Database check failed', {
        database: { status: 'down', message: 'Connection refused' },
      });
      const { check } = make(jest.fn().mockRejectedValue(error));
      const outcome = await check.run();

      expect(outcome).toMatchObject({ status: 'fail', error: 'Connection refused' });
      expectRemedy(outcome);
    });
  });

  describe('db.migrations', () => {
    it('passes when every migration finished', () => {
      expect(decideMigrations({ applied: 42, unfinished: 0, rolledBack: 0, firstUnfinished: null })).toMatchObject({
        status: 'pass',
        data: { applied: 42 },
      });
    });

    it('fails on a started-but-unfinished migration, naming it', () => {
      const outcome = decideMigrations({ applied: 41, unfinished: 1, rolledBack: 0, firstUnfinished: '20260101_x' });

      expect(outcome.status).toBe('fail');
      expect(outcome.detail).toContain('20260101_x');
      expectRemedy(outcome);
    });

    it('fails on a rolled-back migration never re-applied', () => {
      const outcome = decideMigrations({ applied: 41, unfinished: 0, rolledBack: 1, firstUnfinished: null });

      expect(outcome.status).toBe('fail');
      expectRemedy(outcome);
    });

    it('fails when nothing was ever applied', () => {
      expectRemedy(decideMigrations({ applied: 0, unfinished: 0, rolledBack: 0, firstUnfinished: null }));
    });

    it('reads _prisma_migrations with one SELECT and depends on db.connection', async () => {
      const $queryRaw = jest.fn().mockResolvedValue([
        { applied: 10, unfinished: 0, rolled_back: 0, first_unfinished: null },
      ]);
      const check = new DbMigrationsDoctorCheck(new DoctorCheckRegistry(), { $queryRaw } as unknown as PrismaService);

      await expect(check.run()).resolves.toMatchObject({ status: 'pass', data: { applied: 10 } });
      expect(String($queryRaw.mock.calls[0][0].join(''))).toContain('_prisma_migrations');
      expect(check.dependsOn).toEqual(['db.connection']);
    });

    it('fails when the table cannot be read', async () => {
      const $queryRaw = jest.fn().mockRejectedValue(new Error('relation "_prisma_migrations" does not exist'));
      const check = new DbMigrationsDoctorCheck(new DoctorCheckRegistry(), { $queryRaw } as unknown as PrismaService);
      const outcome = await check.run();

      expect(outcome.error).toContain('does not exist');
      expectRemedy(outcome);
    });
  });

  describe('secrets.encryption-key', () => {
    const make = (assertKey: () => void) => {
      const check = new EncryptionKeyDoctorCheck(new DoctorCheckRegistry());
      (check as unknown as { assertKey: () => void }).assertKey = assertKey;
      return check;
    };

    it('passes when the key is valid', async () => {
      await expect(make(() => undefined).run()).resolves.toMatchObject({ status: 'pass' });
    });

    it('fails with the shape-only error when the key is missing', async () => {
      const outcome = await make(() => {
        throw new Error('SECRETS_ENCRYPTION_KEY is not set. It must be a base64-encoded 32-byte key.');
      }).run();

      expect(outcome.status).toBe('fail');
      expect(outcome.error).toContain('is not set');
      expectRemedy(outcome);
    });
  });
});
