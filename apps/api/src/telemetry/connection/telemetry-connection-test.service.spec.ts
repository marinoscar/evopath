import { TelemetryConnectionTestService, type TelemetryProbeClient } from './telemetry-connection-test.service';
import type { TestTelemetryConnectionInput } from './dto/telemetry-connection.dto';
import type { HostCheckOptions } from '../greptime/greptime-host';

// =============================================================================
// TelemetryConnectionTestService — tests (issue #558, epic #528)
// =============================================================================
//
// ALWAYS RESOLVES — never throws, whatever the probe does — with a per-role
// verdict; the admin login is skipped rather than probed when `adminUser` is
// null; a blank password means "the current one"; `end()` is always called,
// including on a timeout or an error; and the error text never carries the
// password.
// =============================================================================

const CANDIDATE: TestTelemetryConnectionInput = {
  host: 'candidate-host',
  pgPort: 4003,
  database: 'public',
  readerUser: 'reader',
  readerPassword: 'reader-pw',
  adminUser: 'admin',
  adminPassword: 'admin-pw',
};

class TestableService extends TelemetryConnectionTestService {
  readonly created: unknown[] = [];
  readonly hostsAsked: string[] = [];
  readonly hostModesAsked: Array<boolean | undefined> = [];
  nextClient: () => TelemetryProbeClient = () => makeClient();
  /** `null` (host resolves) unless a test wires it otherwise. */
  hostResolution: (host: string) => Promise<string | null> = async () => null;

  protected override createClient(config: unknown): TelemetryProbeClient {
    this.created.push(config);
    return this.nextClient();
  }

  protected override resolveHost(host: string, options: HostCheckOptions): Promise<string | null> {
    this.hostsAsked.push(host);
    this.hostModesAsked.push(options.automatic);
    return this.hostResolution(host);
  }
}

interface FakeClient extends TelemetryProbeClient {
  connect: jest.Mock;
  query: jest.Mock;
  end: jest.Mock;
  on: jest.Mock;
}

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue({ rows: [['PostgreSQL 16.3 GreptimeDB 1.2.1']] }),
    end: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    ...overrides,
  };
}

const DEPLOYMENT = {
  host: 'deploy-host',
  pgPort: 4010,
  database: 'deploy_db',
  readerUser: 'env-reader',
  adminUser: 'env-admin' as string | null,
  readerConfigured: true,
  adminConfigured: true,
};

const DEPLOYMENT_PASSWORDS: Record<'reader' | 'admin', string | null> = {
  reader: 'env-reader-pw',
  admin: 'env-admin-pw',
};

function build(
  currentPassword: (role: 'reader' | 'admin') => Promise<string | null> = async () => 'current-pw',
  deployment: { description?: Partial<typeof DEPLOYMENT>; passwords?: Partial<typeof DEPLOYMENT_PASSWORDS> } = {},
) {
  const passwords = { ...DEPLOYMENT_PASSWORDS, ...deployment.passwords };
  const connection = {
    currentPassword: jest.fn(currentPassword),
    deploymentHost: 'deploy-host',
    describeDeployment: jest.fn(() => ({ ...DEPLOYMENT, ...deployment.description })),
    deploymentPassword: jest.fn((role: 'reader' | 'admin') => passwords[role]),
  };
  const service = new TestableService(connection as never);
  return { service, connection };
}

describe('TelemetryConnectionTestService', () => {
  // ==========================================================================
  // Always resolves
  // ==========================================================================

  describe('always resolves', () => {
    it('never throws when the reader probe rejects for an unexpected reason', async () => {
      const { service } = build();
      service.nextClient = () => makeClient({ connect: jest.fn().mockRejectedValue(new Error('kaboom')) });

      await expect(service.test(CANDIDATE, 'admin-1')).resolves.toMatchObject({
        reader: { success: false },
      });
    });

    it('reports per-role success/failure independently', async () => {
      const { service } = build();
      let call = 0;
      service.nextClient = () => {
        call += 1;
        return call === 1
          ? makeClient()
          : makeClient({ connect: jest.fn().mockRejectedValue(new Error('admin refused')) });
      };

      const result = await service.test(CANDIDATE, 'admin-1');

      expect(result.reader.success).toBe(true);
      expect('success' in result.admin && result.admin.success).toBe(false);
    });
  });

  // ==========================================================================
  // Automatic host (issue #562)
  // ==========================================================================

  describe('host', () => {
    it('an automatic (null) host probes the deployment host, and reports it as `host`', async () => {
      const { service } = build();

      const result = await service.test({ ...CANDIDATE, host: null }, 'admin-1');

      expect(result.host).toBe('deploy-host');
      expect(result.hostMode).toBe('auto');
      expect(service.created).toHaveLength(2);
      for (const config of service.created) {
        expect(config).toMatchObject({ host: 'deploy-host', port: 4010, database: 'deploy_db' });
      }
    });

    it('an automatic host ALWAYS uses the deployment logins, ignoring every submitted credential (issue #570)', async () => {
      const { service, connection } = build();

      await service.test(
        {
          host: null,
          pgPort: 9999,
          database: 'typed_db',
          readerUser: 'typed-reader',
          readerPassword: 'guessed-reader-pw',
          adminUser: 'typed-admin',
          adminPassword: 'guessed-admin-pw',
        },
        'admin-1',
      );

      expect(service.created).toEqual([
        expect.objectContaining({ port: 4010, database: 'deploy_db', user: 'env-reader', password: 'env-reader-pw' }),
        expect.objectContaining({ port: 4010, database: 'deploy_db', user: 'env-admin', password: 'env-admin-pw' }),
      ]);
      expect(JSON.stringify(service.created)).not.toMatch(/guessed|typed/);
      // Nor the password of a stored (custom) connection.
      expect(connection.currentPassword).not.toHaveBeenCalled();
    });

    it('an automatic host whose deployment has no reader login says so in administrator language, without probing', async () => {
      const { service } = build(undefined, { passwords: { reader: null } });

      const result = await service.test({ ...CANDIDATE, host: null }, 'admin-1');

      expect(result.reader).toEqual({
        success: false,
        latencyMs: 0,
        error:
          'The GreptimeDB deployed with this application has no reader login configured. ' +
          'Update the application to provision it.',
      });
      expect(result.reader.error).not.toMatch(/env|compose|GREPTIME_|appctl|CLI/i);
      // The admin login is still checked on its own.
      expect(service.created).toHaveLength(1);
      expect(service.created[0]).toMatchObject({ user: 'env-admin' });
    });

    it('an automatic host: no admin user in the deployment skips the admin; a user without a password is a gap', async () => {
      const skipped = build(undefined, { description: { adminUser: null } });
      await expect(skipped.service.test({ ...CANDIDATE, host: null }, 'admin-1')).resolves.toMatchObject({
        admin: { skipped: true },
      });

      const gap = build(undefined, { passwords: { admin: null } });
      const result = await gap.service.test({ ...CANDIDATE, host: null }, 'admin-1');
      expect(result.admin).toMatchObject({
        success: false,
        error: expect.stringContaining('has no admin login configured'),
      });
    });

    it('a custom host probes exactly that host, and reports it as `host`', async () => {
      const { service } = build();

      const result = await service.test(CANDIDATE, 'admin-1');

      expect(result.host).toBe('candidate-host');
      expect(result.hostMode).toBe('custom');
      expect(service.created[0]).toMatchObject({ host: 'candidate-host', user: 'reader', password: 'reader-pw' });
    });
  });

  // ==========================================================================
  // A host that does not resolve (issue #564)
  // ==========================================================================

  describe('a host that does not resolve', () => {
    it('reports the host-not-found message for both reader and admin, and creates no client', async () => {
      const { service } = build();
      service.hostResolution = async () => 'host not found';

      const result = await service.test(CANDIDATE, 'admin-1');

      expect(result.reader.success).toBe(false);
      expect(result.reader.error).toBe('host not found');
      expect('success' in result.admin && result.admin.success).toBe(false);
      expect('error' in result.admin && result.admin.error).toBe('host not found');
      expect(service.created).toHaveLength(0);
    });

    it('still reports admin as skipped when adminUser is null', async () => {
      const { service } = build();
      service.hostResolution = async () => 'host not found';

      const result = await service.test({ ...CANDIDATE, adminUser: null }, 'admin-1');

      expect(result.admin).toEqual({ skipped: true });
      expect(service.created).toHaveLength(0);
    });

    it('lets a missing password win over a host that does not resolve', async () => {
      const { service } = build(async () => null);
      service.hostResolution = async () => 'host not found';

      const result = await service.test({ ...CANDIDATE, readerPassword: '' }, 'admin-1');

      expect(result.reader.error).toContain('No reader password was supplied');
      expect(service.created).toHaveLength(0);
    });

    it('resolves the host once, with the effective (candidate) host', async () => {
      const { service } = build();

      await service.test(CANDIDATE, 'admin-1');

      expect(service.hostsAsked).toEqual(['candidate-host']);
      expect(service.hostModesAsked).toEqual([false]);
    });

    it('resolves the deployment host once, as automatic, when the candidate host is automatic (null)', async () => {
      const { service } = build();

      await service.test({ ...CANDIDATE, host: null }, 'admin-1');

      expect(service.hostsAsked).toEqual(['deploy-host']);
      expect(service.hostModesAsked).toEqual([true]);
    });
  });

  // ==========================================================================
  // A DNS error surfacing from the probe itself
  // ==========================================================================

  describe('a DNS error from the connect attempt', () => {
    it('is reported as host-not-found for a custom host: names it, keeps the driver message, says to check or clear it', async () => {
      const { service } = build();
      service.nextClient = () =>
        makeClient({
          connect: jest
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('getaddrinfo EAI_AGAIN candidate-host'), { code: 'EAI_AGAIN' }),
            ),
        });

      const result = await service.test({ ...CANDIDATE, adminUser: null }, 'admin-1');

      expect(result.reader.success).toBe(false);
      expect(result.reader.error).toContain('candidate-host');
      expect(result.reader.error).toContain('(getaddrinfo EAI_AGAIN candidate-host)');
      expect(result.reader.error).toContain('Check the host name, or clear it');
      expect(result.reader.error).not.toMatch(/compose|appctl/i);
    });

    it('is reported as the automatic-host message when the candidate host is automatic (null)', async () => {
      const { service } = build();
      service.nextClient = () =>
        makeClient({
          connect: jest
            .fn()
            .mockRejectedValue(Object.assign(new Error('getaddrinfo EAI_AGAIN deploy-host'), { code: 'EAI_AGAIN' })),
        });

      const result = await service.test({ ...CANDIDATE, host: null, adminUser: null }, 'admin-1');

      expect(result.reader.success).toBe(false);
      expect(result.reader.error).toContain('"deploy-host"');
      expect(result.reader.error).toContain('(getaddrinfo EAI_AGAIN deploy-host)');
      expect(result.reader.error).toContain('Deploy GreptimeDB');
      expect(result.reader.error).not.toMatch(/compose|appctl/i);
    });

    it('still masks a password that happens to appear in the DNS error text', async () => {
      const { service } = build();
      service.nextClient = () =>
        makeClient({
          connect: jest
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('getaddrinfo EAI_AGAIN reader-pw'), { code: 'EAI_AGAIN' }),
            ),
        });

      const result = await service.test({ ...CANDIDATE, adminUser: null }, 'admin-1');

      expect(result.reader.error).not.toContain('reader-pw');
      expect(result.reader.error).toContain('••••');
    });
  });

  // ==========================================================================
  // Admin skipped when adminUser is null
  // ==========================================================================

  describe('admin login', () => {
    it('is skipped, not probed, when adminUser is null', async () => {
      const { service } = build();

      const result = await service.test({ ...CANDIDATE, adminUser: null }, 'admin-1');

      expect(result.admin).toEqual({ skipped: true });
      // Only the reader client was built.
      expect(service.created).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Blank password uses the current password
  // ==========================================================================

  describe('a blank password', () => {
    it('uses the connection in force\'s current password for that role', async () => {
      const { service, connection } = build(async (role) => (role === 'reader' ? 'the-current-reader-pw' : null));

      await service.test({ ...CANDIDATE, readerPassword: '' }, 'admin-1');

      expect(connection.currentPassword).toHaveBeenCalledWith('reader');
      expect(service.created[0]).toMatchObject({ password: 'the-current-reader-pw' });
    });

    it('reports missing-password, not a probe attempt, when there is no current password either', async () => {
      const { service } = build(async () => null);

      const result = await service.test({ ...CANDIDATE, readerPassword: '', adminUser: null }, 'admin-1');

      expect(result.reader.success).toBe(false);
      expect(result.reader.error).toContain('No reader password was supplied');
      expect(service.created).toHaveLength(0);
    });

    it('does not touch currentPassword when a password is supplied', async () => {
      const { service, connection } = build();

      await service.test(CANDIDATE, 'admin-1');

      expect(connection.currentPassword).not.toHaveBeenCalledWith('reader');
    });
  });

  // ==========================================================================
  // client.end() is always called
  // ==========================================================================

  describe('client.end()', () => {
    it('is called on a successful probe', async () => {
      const { service } = build();
      const client = makeClient();
      service.nextClient = () => client;

      await service.test({ ...CANDIDATE, adminUser: null }, 'admin-1');

      expect(client.end).toHaveBeenCalledTimes(1);
    });

    it('is called even when the probe errors', async () => {
      const { service } = build();
      const client = makeClient({ connect: jest.fn().mockRejectedValue(new Error('refused')) });
      service.nextClient = () => client;

      await service.test({ ...CANDIDATE, adminUser: null }, 'admin-1');

      expect(client.end).toHaveBeenCalledTimes(1);
    });

    it('is called even when the query hangs past the timeout', async () => {
      const { service } = build();
      const client = makeClient({ query: jest.fn(() => new Promise(() => undefined)) });
      service.nextClient = () => client;

      const result = await service.test({ ...CANDIDATE, adminUser: null }, 'admin-1');

      expect(result.reader.success).toBe(false);
      expect(result.reader.error).toContain('did not answer in time');
      expect(client.end).toHaveBeenCalledTimes(1);
    }, 10_000);

    it('does not let a hanging end() block the result', async () => {
      const { service } = build();
      const client = makeClient({ end: jest.fn(() => new Promise(() => undefined)) });
      service.nextClient = () => client;

      const result = await service.test({ ...CANDIDATE, adminUser: null }, 'admin-1');

      expect(result.reader.success).toBe(true);
    }, 10_000);
  });

  // ==========================================================================
  // The error message never contains the password
  // ==========================================================================

  describe('error masking', () => {
    it('masks the password out of an error message that echoed it back', async () => {
      const { service } = build();
      service.nextClient = () =>
        makeClient({
          connect: jest.fn().mockRejectedValue(new Error('auth failed for password "reader-pw"')),
        });

      const result = await service.test({ ...CANDIDATE, adminUser: null }, 'admin-1');

      expect(result.reader.error).not.toContain('reader-pw');
      expect(result.reader.error).toContain('••••');
    });

    it("masks each probe's own password out of ITS OWN error, never the other login's", async () => {
      const { service } = build();
      // Both probes hit the exact same failure text; each must mask only the
      // password IT was connecting with, proving the mask is per-call, not global.
      service.nextClient = () =>
        makeClient({
          connect: jest.fn().mockRejectedValue(new Error('auth failed for reader-pw and admin-pw')),
        });

      const result = await service.test(CANDIDATE, 'admin-1');

      expect(result.reader.error).not.toContain('reader-pw');
      expect('error' in result.admin && result.admin.error).not.toContain('admin-pw');
    });
  });

  // ==========================================================================
  // Reader vs admin SQL
  // ==========================================================================

  describe('the SQL each login runs', () => {
    it('runs SELECT version() as the reader and SHOW CREATE DATABASE as the admin', async () => {
      const { service } = build();
      const clients: FakeClient[] = [];
      service.nextClient = () => {
        const client = makeClient();
        clients.push(client);
        return client;
      };

      await service.test(CANDIDATE, 'admin-1');

      expect(clients[0].query).toHaveBeenCalledWith({ text: 'SELECT version()', rowMode: 'array' });
      expect(clients[1].query).toHaveBeenCalledWith({ text: 'SHOW CREATE DATABASE "public"', rowMode: 'array' });
    });
  });
});
