import type { ConfigService } from '@nestjs/config';

import {
  DEPLOYMENT_ADMIN_MISSING_MESSAGE,
  DEPLOYMENT_READER_MISSING_MESSAGE,
  TelemetryConnectionService,
  type GreptimeEnvironmentConfig,
} from './telemetry-connection.service';
import {
  TELEMETRY_CONNECTION_SETTINGS_KEY,
  TELEMETRY_DEFAULT_HOST,
  TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE,
  telemetryConnectionValueSchema,
  telemetryDeploymentHost,
} from './telemetry-connection.schema';

// =============================================================================
// TelemetryConnectionService — tests (issue #558, epic #528)
// =============================================================================
//
// THE ONE RULE THIS SUITE IS ABOUT: a stored CUSTOM row wins WHOLLY (never a
// per-field merge with the environment); a stored AUTOMATIC row (`host: null`)
// is the deployment WHOLLY — its stored users and passwords are ignored (issue
// #570); nothing stored is the environment default when it names a host, else
// none. A row that exists but fails to validate counts as "stored, unusable" —
// it must never silently fall back to the environment default.
// =============================================================================

const ENV: GreptimeEnvironmentConfig = {
  host: 'env-host',
  pgPort: 4003,
  database: 'public',
  readerUser: 'env-reader',
  readerPassword: 'env-reader-pw',
  adminUser: 'env-admin',
  adminPassword: 'env-admin-pw',
  available: true,
};

const NO_ENV: GreptimeEnvironmentConfig = {
  host: '',
  pgPort: 4003,
  database: 'public',
  readerUser: '',
  readerPassword: '',
  adminUser: '',
  adminPassword: '',
  available: false,
};

const STORED_ROW = {
  version: 3,
  updatedAt: new Date('2026-03-03T00:00:00.000Z'),
  updatedByUser: { id: 'admin-1', email: 'admin@example.com' },
};

const STORED_VALUE = {
  host: 'stored-host',
  pgPort: 4003,
  database: 'public',
  readerUser: 'stored-reader',
  adminUser: 'stored-admin',
};

const READER_INFO = {
  purpose: TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE,
  name: 'reader',
  hint: '••••1234',
  label: 'GreptimeDB read-only login (telemetry explorer, status)',
  updatedByUserId: 'admin-1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-02-02T00:00:00.000Z'),
};

const ADMIN_INFO = {
  ...READER_INFO,
  name: 'admin',
  updatedAt: new Date('2026-02-03T00:00:00.000Z'),
};

function build(env: Partial<GreptimeEnvironmentConfig> = ENV) {
  const config = { get: jest.fn().mockReturnValue(env) } as unknown as ConfigService;

  const prisma = {
    systemSettings: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const credentials: { describe: jest.Mock; getSecret: jest.Mock; deleteSecret?: jest.Mock } = {
    describe: jest.fn().mockResolvedValue(null),
    getSecret: jest.fn().mockResolvedValue(null),
  };

  const service = new TelemetryConnectionService(config, prisma as never, credentials as never);

  return { service, prisma, credentials };
}

describe('TelemetryConnectionService', () => {
  // ==========================================================================
  // Precedence
  // ==========================================================================

  describe('precedence', () => {
    it('a stored row wins wholly: host/port/database/users all come from it, not the environment', async () => {
      const { service, prisma, credentials } = build(ENV);
      prisma.systemSettings.findUnique.mockResolvedValue({ ...STORED_ROW, value: STORED_VALUE });
      credentials.describe.mockImplementation(async (_purpose: string, role: string) =>
        role === 'reader' ? READER_INFO : ADMIN_INFO,
      );

      const state = await service.refresh();

      expect(state.snapshot.source).toBe('stored');
      expect(state.snapshot.host).toBe('stored-host');
      expect(state.snapshot.reader.user).toBe('stored-reader');
      expect(state.snapshot.admin?.user).toBe('stored-admin');
      // Nothing borrowed from the environment default.
      expect(state.snapshot.host).not.toBe(ENV.host);
    });

    it('falls back to the environment default when nothing is stored and the environment names a host', async () => {
      const { service } = build(ENV);

      const state = await service.refresh();

      expect(state.snapshot.source).toBe('environment');
      expect(state.snapshot.host).toBe('env-host');
      expect(state.snapshot.reader.user).toBe('env-reader');
      expect(state.snapshot.admin?.user).toBe('env-admin');
    });

    it('resolves to none when nothing is stored and the environment names no host', async () => {
      const { service } = build(NO_ENV);

      const state = await service.refresh();

      expect(state.snapshot.source).toBe('none');
      expect(service.isConfigured()).toBe(false);
    });

    it('a stored-but-invalid row is stored-and-unusable, and never falls back to the environment', async () => {
      const { service, prisma } = build(ENV);
      prisma.systemSettings.findUnique.mockResolvedValue({
        ...STORED_ROW,
        value: { host: '', pgPort: 4003, database: 'public', readerUser: '', adminUser: null },
      });

      const state = await service.refresh();

      expect(state.snapshot.source).toBe('stored');
      expect(state.snapshot.host).toBe('');
      expect(service.isConfigured()).toBe(false);
      // Not `environment`, even though the environment is fully configured.
      expect(service.source).not.toBe('environment');
    });
  });

  // ==========================================================================
  // isConfigured / isAdminConfigured / database
  // ==========================================================================

  describe('isConfigured / isAdminConfigured / database', () => {
    it('is configured with a host, reader user and reader password; admin needs its own login too', async () => {
      const { service, prisma, credentials } = build(ENV);
      prisma.systemSettings.findUnique.mockResolvedValue({ ...STORED_ROW, value: STORED_VALUE });
      credentials.describe.mockImplementation(async (_purpose: string, role: string) =>
        role === 'reader' ? READER_INFO : null,
      );

      await service.refresh();

      expect(service.isConfigured()).toBe(true);
      expect(service.isAdminConfigured()).toBe(false);
    });

    it('isAdminConfigured requires isConfigured to also hold', async () => {
      const { service, prisma, credentials } = build(ENV);
      prisma.systemSettings.findUnique.mockResolvedValue({
        ...STORED_ROW,
        value: { ...STORED_VALUE, readerUser: '' },
      });
      credentials.describe.mockImplementation(async (_purpose: string, role: string) =>
        role === 'reader' ? null : ADMIN_INFO,
      );

      await service.refresh();

      expect(service.isConfigured()).toBe(false);
      expect(service.isAdminConfigured()).toBe(false);
    });

    it('exposes the resolved database', async () => {
      const { service, prisma, credentials } = build(ENV);
      prisma.systemSettings.findUnique.mockResolvedValue({
        ...STORED_ROW,
        value: { ...STORED_VALUE, database: 'custom_db' },
      });
      credentials.describe.mockResolvedValue(READER_INFO);

      await service.refresh();

      expect(service.database).toBe('custom_db');
    });
  });

  // ==========================================================================
  // A failed refresh
  // ==========================================================================

  describe('refreshSafely', () => {
    it('keeps the last snapshot and does not throw when the read fails', async () => {
      const { service, prisma, credentials } = build(ENV);
      prisma.systemSettings.findUnique.mockResolvedValue({ ...STORED_ROW, value: STORED_VALUE });
      credentials.describe.mockResolvedValue(READER_INFO);
      await service.refresh();
      expect(service.source).toBe('stored');

      prisma.systemSettings.findUnique.mockRejectedValue(new Error('database is down'));

      await expect(service.refreshSafely()).resolves.toBe(false);
      // The last good snapshot is untouched.
      expect(service.source).toBe('stored');
      expect(service.database).toBe(STORED_VALUE.database);
    });

    it('refresh() itself throws on a failed read, for a caller that must know', async () => {
      const { service, prisma } = build(ENV);
      prisma.systemSettings.findUnique.mockRejectedValue(new Error('boom'));

      await expect(service.refresh()).rejects.toThrow('boom');
    });
  });

  // ==========================================================================
  // resolveCredentials
  // ==========================================================================

  describe('resolveCredentials', () => {
    it('reads the stored password from CredentialsService.getSecret when the source is stored', async () => {
      const { service, prisma, credentials } = build(ENV);
      prisma.systemSettings.findUnique.mockResolvedValue({ ...STORED_ROW, value: STORED_VALUE });
      credentials.describe.mockImplementation(async (_purpose: string, role: string) =>
        role === 'reader' ? READER_INFO : ADMIN_INFO,
      );
      credentials.getSecret.mockResolvedValue('the-stored-password');
      await service.refresh();

      const creds = await service.resolveCredentials('reader');

      expect(credentials.getSecret).toHaveBeenCalledWith(TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE, 'reader');
      expect(creds).toMatchObject({
        host: 'stored-host',
        port: 4003,
        database: 'public',
        user: 'stored-reader',
        password: 'the-stored-password',
      });
    });

    it('reads the environment password when the source is environment', async () => {
      const { service, credentials } = build(ENV);
      await service.refresh();

      const creds = await service.resolveCredentials('reader');

      expect(credentials.getSecret).not.toHaveBeenCalled();
      expect(creds).toMatchObject({ user: 'env-reader', password: 'env-reader-pw' });
    });

    it('returns null when the login is not configured', async () => {
      const { service } = build(NO_ENV);
      await service.refresh();

      await expect(service.resolveCredentials('reader')).resolves.toBeNull();
    });

    it('returns null when the stored password has since gone (credential store returns null)', async () => {
      const { service, prisma, credentials } = build(ENV);
      prisma.systemSettings.findUnique.mockResolvedValue({ ...STORED_ROW, value: STORED_VALUE });
      credentials.describe.mockResolvedValue(READER_INFO);
      credentials.getSecret.mockResolvedValue(null);
      await service.refresh();

      await expect(service.resolveCredentials('reader')).resolves.toBeNull();
    });
  });

  // ==========================================================================
  // Fingerprint
  // ==========================================================================

  describe('fingerprint', () => {
    it('changes when the credential updatedAt changes, even with the same user/host', async () => {
      const { service, prisma, credentials } = build(ENV);
      prisma.systemSettings.findUnique.mockResolvedValue({ ...STORED_ROW, value: STORED_VALUE });
      credentials.describe.mockResolvedValue(READER_INFO);
      await service.refresh();
      const first = service.fingerprint('reader');

      credentials.describe.mockResolvedValue({
        ...READER_INFO,
        updatedAt: new Date('2026-05-05T00:00:00.000Z'),
      });
      await service.refresh();
      const second = service.fingerprint('reader');

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(second).not.toBe(first);
    });

    it('is stable across refreshes when nothing changed', async () => {
      const { service, prisma, credentials } = build(ENV);
      prisma.systemSettings.findUnique.mockResolvedValue({ ...STORED_ROW, value: STORED_VALUE });
      credentials.describe.mockResolvedValue(READER_INFO);
      await service.refresh();
      const first = service.fingerprint('reader');

      await service.refresh();
      const second = service.fingerprint('reader');

      expect(second).toBe(first);
    });

    it('is null when the role is not configured', async () => {
      const { service } = build(NO_ENV);
      await service.refresh();

      expect(service.fingerprint('reader')).toBeNull();
      expect(service.fingerprint('admin')).toBeNull();
    });
  });

  // ==========================================================================
  // Automatic host (issue #562)
  // ==========================================================================

  describe('automatic host', () => {
    const AUTO_VALUE = { ...STORED_VALUE, host: null };

    function storedAuto(env: Partial<GreptimeEnvironmentConfig>) {
      const built = build(env);
      built.prisma.systemSettings.findUnique.mockResolvedValue({ ...STORED_ROW, value: AUTO_VALUE });
      built.credentials.describe.mockImplementation(async (_purpose: string, role: string) =>
        role === 'reader' ? READER_INFO : ADMIN_INFO,
      );
      return built;
    }

    it('the compose service name is the last-resort deployment host', () => {
      expect(TELEMETRY_DEFAULT_HOST).toBe('greptimedb');
      expect(telemetryDeploymentHost('')).toBe('greptimedb');
      expect(telemetryDeploymentHost('   ')).toBe('greptimedb');
      expect(telemetryDeploymentHost(undefined)).toBe('greptimedb');
      expect(telemetryDeploymentHost(' env-host ')).toBe('env-host');
    });

    it('a stored null host is the deployment WHOLLY: host, port, database and users from GREPTIME_*', async () => {
      const { service } = storedAuto({ ...ENV, pgPort: 5555, database: 'env_db' });

      const state = await service.refresh();

      expect(state.snapshot).toMatchObject({
        source: 'stored',
        host: 'env-host',
        hostMode: 'auto',
        deploymentManaged: true,
        pgPort: 5555,
        database: 'env_db',
        reader: { user: 'env-reader', passwordSet: true, version: 'environment' },
        admin: { user: 'env-admin', passwordSet: true, version: 'environment' },
      });
      // The stored value keeps null — the literal is never written back.
      expect(state.stored?.host).toBeNull();
      expect(service.isConfigured()).toBe(true);
      expect(service.isAdminConfigured()).toBe(true);
    });

    it('ignores (and does not delete) the users and passwords a pre-#570 automatic row still carries', async () => {
      const { service, credentials } = storedAuto(ENV);
      credentials.getSecret.mockResolvedValue('guessed-stored-pw');
      credentials.deleteSecret = jest.fn();
      await service.refresh();

      const reader = await service.resolveCredentials('reader');
      const admin = await service.resolveCredentials('admin');

      expect(credentials.getSecret).not.toHaveBeenCalled();
      expect(credentials.deleteSecret).not.toHaveBeenCalled();
      expect(reader).toMatchObject({ host: 'env-host', user: 'env-reader', password: 'env-reader-pw', automaticHost: true });
      expect(admin).toMatchObject({ user: 'env-admin', password: 'env-admin-pw' });
      await expect(service.currentPassword('reader')).resolves.toBe('env-reader-pw');
    });

    it('a stored null host with no reader login in the deployment is unconfigured, and says why in administrator language', async () => {
      const { service } = storedAuto({ ...ENV, readerPassword: '' });

      await service.refresh();

      expect(service.isConfigured()).toBe(false);
      expect(service.configurationProblem()).toBe(DEPLOYMENT_READER_MISSING_MESSAGE);
      expect(DEPLOYMENT_READER_MISSING_MESSAGE).not.toMatch(/env|compose|GREPTIME_|appctl|CLI|variable/i);
    });

    it('reports a missing deployment admin login only when asked about the admin', async () => {
      const { service } = storedAuto({ ...ENV, adminPassword: '' });

      await service.refresh();

      expect(service.configurationProblem('reader')).toBeNull();
      expect(service.configurationProblem('admin')).toBe(DEPLOYMENT_ADMIN_MISSING_MESSAGE);
    });

    it('a custom stored host never reports a deployment problem', async () => {
      const { service, prisma } = build({ ...ENV, readerPassword: '' });
      prisma.systemSettings.findUnique.mockResolvedValue({ ...STORED_ROW, value: STORED_VALUE });

      await service.refresh();

      expect(service.configurationProblem('admin')).toBeNull();
    });

    it('describeDeployment reports what the deployment provisions, never a password', () => {
      const { service } = build({ ...ENV, adminPassword: '' });

      const deployment = service.describeDeployment();

      expect(deployment).toEqual({
        host: 'env-host',
        pgPort: 4003,
        database: 'public',
        readerUser: 'env-reader',
        adminUser: 'env-admin',
        readerConfigured: true,
        adminConfigured: false,
      });
      expect(JSON.stringify(deployment)).not.toContain('env-reader-pw');
    });

    it('a stored null host resolves to the compose service name when GREPTIME_HOST is unset or blank', async () => {
      for (const host of ['', '   ']) {
        const { service } = storedAuto({ ...ENV, host });

        const state = await service.refresh();

        expect(state.snapshot.host).toBe(TELEMETRY_DEFAULT_HOST);
        expect(service.deploymentHost).toBe(TELEMETRY_DEFAULT_HOST);
        expect(service.isConfigured()).toBe(true);
      }
    });

    it('resolveCredentials connects an automatic host to the deployment host', async () => {
      const { service } = storedAuto(ENV);
      await service.refresh();

      await expect(service.resolveCredentials('reader')).resolves.toMatchObject({ host: 'env-host' });
    });

    it('the fingerprint carries the effective host, so a different deployment host means new pools', async () => {
      const first = storedAuto(ENV);
      const second = storedAuto({ ...ENV, host: 'moved-host' });
      await first.service.refresh();
      await second.service.refresh();

      expect(first.service.fingerprint('reader')).toContain('env-host');
      expect(second.service.fingerprint('reader')).toContain('moved-host');
      expect(second.service.fingerprint('reader')).not.toBe(first.service.fingerprint('reader'));
    });

    it('the fingerprint of an automatic row follows the deployment credentials, not a stored one', async () => {
      const { service, credentials } = storedAuto(ENV);
      await service.refresh();
      const first = service.fingerprint('reader');

      // A stored credential being rotated is irrelevant to an automatic connection.
      credentials.describe.mockResolvedValue({ ...READER_INFO, updatedAt: new Date('2026-06-06T00:00:00.000Z') });
      await service.refresh();

      expect(service.fingerprint('reader')).toBe(first);
      expect(first).toContain('environment');
    });

    it('switching between a custom and an automatic row changes the fingerprint', async () => {
      const { service, prisma, credentials } = build({ ...ENV, host: 'stored-host', readerUser: 'stored-reader' });
      credentials.describe.mockResolvedValue(READER_INFO);
      prisma.systemSettings.findUnique.mockResolvedValue({ ...STORED_ROW, value: STORED_VALUE });
      await service.refresh();
      const custom = service.fingerprint('reader');

      prisma.systemSettings.findUnique.mockResolvedValue({ ...STORED_ROW, value: { host: null } });
      await service.refresh();

      expect(service.fingerprint('reader')).not.toBe(custom);
    });

    it('a stored string host (every row saved before #562) is a custom override', async () => {
      const { service, prisma } = build(ENV);
      prisma.systemSettings.findUnique.mockResolvedValue({ ...STORED_ROW, value: STORED_VALUE });

      const state = await service.refresh();

      expect(state.snapshot.hostMode).toBe('custom');
      expect(state.snapshot.host).toBe('stored-host');
      expect(state.stored?.host).toBe('stored-host');
    });

    it('the environment source is the deployment (automatic, deployment-managed); none is automatic but unmanaged', async () => {
      expect((await build(ENV).service.refresh()).snapshot).toMatchObject({ hostMode: 'auto', deploymentManaged: true });
      expect((await build(NO_ENV).service.refresh()).snapshot).toMatchObject({ hostMode: 'auto', deploymentManaged: false });
    });

    it('with no connection at all there is no current password, even if a stale one is stored', async () => {
      const { service, credentials } = build(NO_ENV);
      credentials.getSecret.mockResolvedValue('stale');
      await service.refresh();

      await expect(service.currentPassword('reader')).resolves.toBeNull();
      expect(service.configurationProblem()).toBeNull();
    });

    it('the stored-value schema: a bare marker, a pre-#570 automatic row (extra fields stripped), a custom row', () => {
      expect(telemetryConnectionValueSchema.parse({ host: null })).toEqual({ host: null });
      expect(telemetryConnectionValueSchema.parse(AUTO_VALUE)).toEqual({ host: null });
      expect(telemetryConnectionValueSchema.parse(STORED_VALUE)).toEqual(STORED_VALUE);
      expect(telemetryConnectionValueSchema.safeParse({ ...STORED_VALUE, host: 'http://x:4003' }).success).toBe(false);
      // A custom host still needs its logins.
      expect(telemetryConnectionValueSchema.safeParse({ host: 'stored-host' }).success).toBe(false);
    });
  });

  // ==========================================================================
  // Refresh reads the right key
  // ==========================================================================

  it('reads the stored row by the documented settings key', async () => {
    const { service, prisma } = build(ENV);

    await service.refresh();

    expect(prisma.systemSettings.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: TELEMETRY_CONNECTION_SETTINGS_KEY } }),
    );
  });
});
