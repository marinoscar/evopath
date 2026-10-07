import { ConfigService } from '@nestjs/config';

import { DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth.service';
import { AuthProvidersDoctorCheck } from './auth-providers.doctor-check';
import { InitialAdminDoctorCheck, decideInitialAdmin } from './initial-admin.doctor-check';
import { JwtSecretDoctorCheck, decideJwtSecret } from './jwt-secret.doctor-check';

function expectRemedy(outcome: DoctorCheckOutcome): void {
  expect(['warn', 'fail']).toContain(outcome.status);
  expect(outcome.remedy).toEqual(expect.stringMatching(/\S{10,}/));
}

const config = (values: Record<string, unknown>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

describe('auth doctor checks', () => {
  describe('auth.jwt-secret', () => {
    it('fails when unset or the fallback', () => {
      for (const value of [undefined, '', 'fallback-secret']) {
        const outcome = decideJwtSecret(value);
        expect(outcome.status).toBe('fail');
        expectRemedy(outcome);
      }
    });

    it('warns when shorter than 32 characters', () => {
      const outcome = decideJwtSecret('short-secret');
      expect(outcome).toMatchObject({ status: 'warn', data: { length: 12 } });
      expectRemedy(outcome);
    });

    it('passes a long secret and never echoes it', async () => {
      const secret = 'x'.repeat(20) + 'a-very-distinctive-tail';
      const check = new JwtSecretDoctorCheck(new DoctorCheckRegistry(), config({ 'jwt.secret': secret }));
      const outcome = await check.run();

      expect(outcome.status).toBe('pass');
      expect(JSON.stringify(outcome)).not.toContain('distinctive');
    });

    it('registers itself', () => {
      const registry = new DoctorCheckRegistry();
      const check = new JwtSecretDoctorCheck(registry, config({}));
      check.onModuleInit();
      expect(registry.list()).toEqual([check]);
    });
  });

  describe('auth.providers', () => {
    const make = (providers: Array<{ name: string; enabled: boolean }>) =>
      new AuthProvidersDoctorCheck(new DoctorCheckRegistry(), {
        getEnabledProviders: jest.fn().mockResolvedValue(providers),
      } as unknown as AuthService);

    it('passes with the enabled providers named', async () => {
      await expect(make([{ name: 'google', enabled: true }]).run()).resolves.toMatchObject({
        status: 'pass',
        detail: 'Enabled: google',
      });
    });

    it('fails when none is enabled', async () => {
      const outcome = await make([]).run();
      expect(outcome.status).toBe('fail');
      expectRemedy(outcome);
    });
  });

  describe('auth.initial-admin', () => {
    it('fails when no active admin exists, whatever the variable says', () => {
      for (const initialAdminEmailSet of [true, false]) {
        const outcome = decideInitialAdmin({ initialAdminEmailSet, activeAdmins: 0 });
        expect(outcome.status).toBe('fail');
        expectRemedy(outcome);
      }
    });

    it('warns when INITIAL_ADMIN_EMAIL is unset', () => {
      const outcome = decideInitialAdmin({ initialAdminEmailSet: false, activeAdmins: 2 });
      expect(outcome.status).toBe('warn');
      expectRemedy(outcome);
    });

    it('passes with admins and the variable set', () => {
      expect(decideInitialAdmin({ initialAdminEmailSet: true, activeAdmins: 1 }).status).toBe('pass');
    });

    it('counts ACTIVE users holding the admin role', async () => {
      const count = jest.fn().mockResolvedValue(1);
      const check = new InitialAdminDoctorCheck(
        new DoctorCheckRegistry(),
        config({ INITIAL_ADMIN_EMAIL: 'admin@example.com' }),
        { user: { count } } as unknown as PrismaService,
      );

      await expect(check.run()).resolves.toMatchObject({ status: 'pass' });
      expect(count).toHaveBeenCalledWith({
        where: { isActive: true, userRoles: { some: { role: { name: 'admin' } } } },
      });
      // The email address itself is not reported.
      expect(JSON.stringify(await check.run())).not.toContain('admin@example.com');
    });
  });
});
