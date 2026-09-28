import type { ConfigService } from '@nestjs/config';
import type { PoolConfig } from 'pg';

import { TelemetryConnectionService } from '../connection/telemetry-connection.service';

import {
  GreptimeClient,
  greptimeTypeParser,
  quoteIdent,
  quoteLiteral,
  rowsAsObjects,
  type GreptimeConfig,
  type GreptimePool,
} from './greptime.client';
import {
  TelemetryMultiStatementError,
  TelemetryNotConfiguredError,
  TelemetryQueryAbortedError,
  TelemetryQueryFailedError,
  TelemetryQueryTimeoutError,
} from './greptime.errors';
import type { HostCheckOptions } from './greptime-host';

const CONFIGURED: GreptimeConfig = {
  host: 'greptimedb',
  pgPort: 4003,
  database: 'public',
  readerUser: 'reader',
  readerPassword: 'reader-pw',
  adminUser: 'admin',
  adminPassword: 'admin-pw',
  available: true,
};

/**
 * A connection resolver whose only source is the given `GREPTIME_*` default
 * (no stored connection is ever read: `refresh` is never called here).
 */
function configService(greptime: Partial<GreptimeConfig>): TelemetryConnectionService {
  const config = { get: jest.fn().mockReturnValue(greptime) } as unknown as ConfigService;

  return new TelemetryConnectionService(config, {} as never, {} as never);
}

interface FakeClient {
  query: jest.Mock;
  release: jest.Mock;
}

class TestableClient extends GreptimeClient {
  readonly created: PoolConfig[] = [];
  readonly createdPools: Array<GreptimePool & { connect: jest.Mock; end: jest.Mock }> = [];
  readonly hostsAsked: string[] = [];
  readonly hostModesAsked: Array<boolean | undefined> = [];
  client: FakeClient = { query: jest.fn(), release: jest.fn() };
  /** `null` (host resolves / inconclusive) unless a test wires it otherwise. */
  hostResolution: (host: string) => Promise<string | null> = async () => null;

  protected override createPool(config: PoolConfig): GreptimePool {
    this.created.push(config);
    const pool = {
      connect: jest.fn(async () => this.client),
      end: jest.fn(async () => undefined),
      on: jest.fn(),
    };
    this.createdPools.push(pool as never);
    return pool as unknown as GreptimePool;
  }

  protected override resolveHost(host: string, options: HostCheckOptions): Promise<string | null> {
    this.hostsAsked.push(host);
    this.hostModesAsked.push(options.automatic);
    return this.hostResolution(host);
  }
}

describe('GreptimeClient', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('configuration', () => {
    it('is not configured without GreptimeDB env, and refuses to query', async () => {
      const client = new TestableClient(configService({ available: false }));

      expect(client.isConfigured()).toBe(false);
      expect(client.isAdminConfigured()).toBe(false);
      await expect(client.queryReader('SELECT 1', { timeoutMs: 100 })).rejects.toBeInstanceOf(
        TelemetryNotConfiguredError,
      );
      expect(client.created).toHaveLength(0);
    });

    it('refuses an admin query when only the reader credential is set', async () => {
      const client = new TestableClient(configService({ ...CONFIGURED, adminUser: '', adminPassword: '' }));

      expect(client.isConfigured()).toBe(true);
      expect(client.isAdminConfigured()).toBe(false);
      await expect(client.queryAdmin('SHOW DATABASES', { timeoutMs: 100 })).rejects.toBeInstanceOf(
        TelemetryNotConfiguredError,
      );
    });

    it('creates each pool lazily, once, with its own credential and size', async () => {
      const client = new TestableClient(configService(CONFIGURED));
      client.client.query.mockResolvedValue({ fields: [], rows: [] });

      expect(client.created).toHaveLength(0);

      await client.queryReader('SELECT 1', { timeoutMs: 1000 });
      await client.queryReader('SELECT 2', { timeoutMs: 1000 });
      await client.queryAdmin('SELECT 3', { timeoutMs: 1000 });

      expect(client.created).toHaveLength(2);
      expect(client.created[0]).toMatchObject({
        host: 'greptimedb',
        port: 4003,
        database: 'public',
        user: 'reader',
        password: 'reader-pw',
        max: 4,
        application_name: 'api-telemetry-reader',
      });
      expect(client.created[1]).toMatchObject({ user: 'admin', password: 'admin-pw', max: 1 });
    });
  });

  describe('queryReader', () => {
    it('runs the SQL in array mode and returns fields and rows', async () => {
      const client = new TestableClient(configService(CONFIGURED));
      client.client.query.mockResolvedValue({
        fields: [
          { name: 'trace_id', dataTypeID: 1043, tableID: 0 },
          { name: 'trace_id', dataTypeID: 1043, tableID: 0 },
        ],
        rows: [['a', 'b']],
      });

      const result = await client.queryReader('SELECT a.trace_id, b.trace_id FROM x', { timeoutMs: 1000 });

      expect(client.client.query).toHaveBeenCalledWith({
        text: 'SELECT a.trace_id, b.trace_id FROM x',
        rowMode: 'array',
      });
      expect(result).toEqual({
        fields: [
          { name: 'trace_id', dataTypeID: 1043 },
          { name: 'trace_id', dataTypeID: 1043 },
        ],
        rows: [['a', 'b']],
      });
      expect(client.client.release).toHaveBeenCalledWith();
    });

    it('on timeout destroys the connection and throws TelemetryQueryTimeoutError', async () => {
      jest.useFakeTimers();
      const client = new TestableClient(configService(CONFIGURED));
      let rejectQuery: (error: Error) => void = () => undefined;
      client.client.query.mockReturnValue(
        new Promise((_, reject) => {
          rejectQuery = reject;
        }),
      );

      const pending = client.queryReader('SELECT sleep()', { timeoutMs: 250 });
      const assertion = expect(pending).rejects.toBeInstanceOf(TelemetryQueryTimeoutError);

      await jest.advanceTimersByTimeAsync(250);
      await assertion;

      // Destroyed (`release(true)`), never returned to the pool.
      expect(client.client.release).toHaveBeenCalledTimes(1);
      expect(client.client.release).toHaveBeenCalledWith(true);

      // The abandoned query's eventual rejection is not an unhandled one.
      rejectQuery(new Error('Connection terminated'));
      await Promise.resolve();
    });

    it('on abort destroys the connection and throws TelemetryQueryAbortedError', async () => {
      const client = new TestableClient(configService(CONFIGURED));
      client.client.query.mockReturnValue(new Promise(() => undefined));
      const controller = new AbortController();

      const pending = client.queryReader('SELECT sleep()', { timeoutMs: 60_000, signal: controller.signal });
      while (client.client.query.mock.calls.length === 0) await Promise.resolve();
      controller.abort();

      await expect(pending).rejects.toBeInstanceOf(TelemetryQueryAbortedError);
      expect(client.client.release).toHaveBeenCalledWith(true);
    });

    it('refuses to start when already aborted', async () => {
      const client = new TestableClient(configService(CONFIGURED));
      const controller = new AbortController();
      controller.abort();

      await expect(
        client.queryReader('SELECT 1', { timeoutMs: 1000, signal: controller.signal }),
      ).rejects.toBeInstanceOf(TelemetryQueryAbortedError);
      expect(client.client.query).not.toHaveBeenCalled();
    });

    it('carries the timeout it enforced', async () => {
      jest.useFakeTimers();
      const client = new TestableClient(configService(CONFIGURED));
      client.client.query.mockReturnValue(new Promise(() => undefined));

      const pending = client.queryReader('SELECT 1', { timeoutMs: 1234 });
      const assertion = expect(pending).rejects.toMatchObject({ timeoutMs: 1234 });
      await jest.advanceTimersByTimeAsync(1234);
      await assertion;
    });

    it('refuses a multi-statement result', async () => {
      const client = new TestableClient(configService(CONFIGURED));
      client.client.query.mockResolvedValue([
        { fields: [], rows: [] },
        { fields: [], rows: [] },
      ]);

      await expect(client.queryReader('SELECT 1; SELECT 2', { timeoutMs: 1000 })).rejects.toBeInstanceOf(
        TelemetryMultiStatementError,
      );
      expect(client.client.release).toHaveBeenCalledTimes(1);
    });

    it('wraps a server error and returns the healthy connection to the pool', async () => {
      const client = new TestableClient(configService(CONFIGURED));
      client.client.query.mockRejectedValue(
        Object.assign(new Error('Table not found: nope'), { severity: 'ERROR', code: '42P01' }),
      );

      await expect(client.queryReader('SELECT * FROM nope', { timeoutMs: 1000 })).rejects.toMatchObject({
        constructor: TelemetryQueryFailedError,
        message: 'Table not found: nope',
        code: '42P01',
        origin: 'server',
      });
      expect(client.client.release).toHaveBeenCalledWith(undefined);
    });

    it('destroys the connection on a transport error', async () => {
      const client = new TestableClient(configService(CONFIGURED));
      client.client.query.mockRejectedValue(new Error('Connection terminated unexpectedly'));

      await expect(client.queryReader('SELECT 1', { timeoutMs: 1000 })).rejects.toMatchObject({
        constructor: TelemetryQueryFailedError,
        origin: 'connection',
      });
      expect(client.client.release).toHaveBeenCalledWith(true);
    });

    it('reports a failed connect as TelemetryQueryFailedError without the password', async () => {
      const client = new TestableClient(configService(CONFIGURED));
      await client.queryReader('SELECT 1', { timeoutMs: 1000 }).catch(() => undefined);
      client.createdPools[0].connect.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.1:4003'));

      const error = await client.queryReader('SELECT 1', { timeoutMs: 1000 }).catch((e: Error) => e);

      expect(error).toBeInstanceOf(TelemetryQueryFailedError);
      expect((error as TelemetryQueryFailedError).origin).toBe('connection');
      expect((error as Error).message).toContain('ECONNREFUSED');
      expect((error as Error).message).not.toContain('reader-pw');
    });
  });

  describe('connect failure reason (issue #564)', () => {
    /**
     * A client whose connection is forced to the requested host mode.
     *
     * Since #570 the environment default (`GREPTIME_HOST` set, nothing
     * stored) resolves as AUTOMATIC, not CUSTOM — so `resolveCredentials` is
     * always overridden here to pin `automaticHost` to the mode under test,
     * rather than relying on the environment's own default.
     */
    async function primed({ automatic = false } = {}): Promise<TestableClient> {
      const connection = configService(CONFIGURED);
      const original = connection.resolveCredentials.bind(connection);
      jest
        .spyOn(connection, 'resolveCredentials')
        .mockImplementation(async (role) => {
          const credentials = await original(role);
          return credentials && { ...credentials, automaticHost: automatic };
        });
      const client = new TestableClient(connection);
      client.client.query.mockResolvedValue({ fields: [], rows: [] });
      // Build the pool once so createdPools[0] exists to reconfigure `connect`.
      await client.queryReader('SELECT 1', { timeoutMs: 1000 });
      return client;
    }

    it('a DNS-coded connect error names the host and never consults resolveHost', async () => {
      const client = await primed();
      client.hostResolution = jest.fn(async () => 'should not be called');
      client.createdPools[0].connect.mockRejectedValue(
        Object.assign(new Error('getaddrinfo EAI_AGAIN greptimedb'), { code: 'EAI_AGAIN' }),
      );

      const error = await client.queryReader('SELECT 1', { timeoutMs: 1000 }).catch((e: Error) => e);

      expect((error as Error).message).toContain('greptimedb');
      expect((error as Error).message).toContain('(getaddrinfo EAI_AGAIN greptimedb)');
      expect((error as Error).message).toContain('Check the host name, or clear it');
      expect((error as Error).message).not.toMatch(/compose|appctl/i);
      expect(client.hostsAsked).toEqual([]);
    });

    it('a DNS-coded connect error on the automatic host points at "Deploy GreptimeDB"', async () => {
      const client = await primed({ automatic: true });
      client.createdPools[0].connect.mockRejectedValue(
        Object.assign(new Error('getaddrinfo EAI_AGAIN greptimedb'), { code: 'EAI_AGAIN' }),
      );

      const error = await client.queryReader('SELECT 1', { timeoutMs: 1000 }).catch((e: Error) => e);

      expect((error as Error).message).toMatch(/^Could not connect to GreptimeDB: GreptimeDB is not running alongside/);
      expect((error as Error).message).toContain('(getaddrinfo EAI_AGAIN greptimedb)');
      expect((error as Error).message).toContain('Deploy GreptimeDB');
      expect((error as Error).message).not.toMatch(/compose|appctl/i);
    });

    it('a connect timeout asks resolveHost with the host mode of the connection in force', async () => {
      const custom = await primed();
      custom.createdPools[0].connect.mockRejectedValue(new Error('timeout expired'));
      await custom.queryReader('SELECT 1', { timeoutMs: 1000 }).catch(() => undefined);

      const automatic = await primed({ automatic: true });
      automatic.createdPools[0].connect.mockRejectedValue(new Error('timeout expired'));
      await automatic.queryReader('SELECT 1', { timeoutMs: 1000 }).catch(() => undefined);

      expect(custom.hostModesAsked).toEqual([false]);
      expect(automatic.hostModesAsked).toEqual([true]);
    });

    it('a connect timeout followed by resolveHost naming the host uses that message', async () => {
      const client = await primed();
      client.hostResolution = async () => 'GreptimeDB host "greptimedb" could not be resolved';
      client.createdPools[0].connect.mockRejectedValue(new Error('timeout expired'));

      const error = await client.queryReader('SELECT 1', { timeoutMs: 1000 }).catch((e: Error) => e);

      expect((error as Error).message).toBe(
        'Could not connect to GreptimeDB: GreptimeDB host "greptimedb" could not be resolved',
      );
      expect(client.hostsAsked).toEqual(['greptimedb']);
    });

    it('a connect timeout with an inconclusive resolveHost keeps the original timeout text', async () => {
      const client = await primed();
      client.hostResolution = async () => null;
      client.createdPools[0].connect.mockRejectedValue(new Error('Connection terminated due to connection timeout'));

      const error = await client.queryReader('SELECT 1', { timeoutMs: 1000 }).catch((e: Error) => e);

      expect((error as Error).message).toBe(
        'Could not connect to GreptimeDB: Connection terminated due to connection timeout',
      );
      expect(client.hostsAsked).toEqual(['greptimedb']);
    });

    it('a non-timeout, non-DNS connect error never consults resolveHost', async () => {
      const client = await primed();
      client.hostResolution = jest.fn(async () => 'should not be called');
      client.createdPools[0].connect.mockRejectedValue(new Error('password authentication failed'));

      const error = await client.queryReader('SELECT 1', { timeoutMs: 1000 }).catch((e: Error) => e);

      expect((error as Error).message).toBe('Could not connect to GreptimeDB: password authentication failed');
      expect(client.hostsAsked).toEqual([]);
    });

    it('a successful query never consults resolveHost', async () => {
      const client = await primed();

      expect(client.hostsAsked).toEqual([]);
    });
  });

  describe('ping', () => {
    it('returns the version when reachable', async () => {
      const client = new TestableClient(configService(CONFIGURED));
      client.client.query.mockResolvedValue({
        fields: [{ name: 'version', dataTypeID: 25 }],
        rows: [['PostgreSQL 16.3 GreptimeDB 1.2.1']],
      });

      await expect(client.ping()).resolves.toEqual({
        reachable: true,
        version: 'PostgreSQL 16.3 GreptimeDB 1.2.1',
      });
    });

    it('never throws when unreachable', async () => {
      const client = new TestableClient(configService(CONFIGURED));
      client.client.query.mockRejectedValue(new Error('boom'));

      await expect(client.ping()).resolves.toEqual({ reachable: false, error: 'boom' });
    });

    it('reports unconfigured without creating a pool', async () => {
      const client = new TestableClient(configService({ available: false }));

      await expect(client.ping()).resolves.toMatchObject({ reachable: false });
      expect(client.created).toHaveLength(0);
    });

    it('reports the host-not-found message on a DNS-coded connect failure, and never throws', async () => {
      // The environment default (GREPTIME_HOST set, nothing stored) resolves
      // as AUTOMATIC since #570, so a DNS-coded failure names the built-in
      // host and points at "Deploy GreptimeDB", not the custom-host text.
      const client = new TestableClient(configService(CONFIGURED));
      client.client.query.mockResolvedValue({ fields: [], rows: [] });
      await client.queryReader('SELECT 1', { timeoutMs: 1000 });
      client.hostResolution = jest.fn(async () => 'should not be called');
      client.createdPools[0].connect.mockRejectedValue(
        Object.assign(new Error('getaddrinfo ENOTFOUND greptimedb'), { code: 'ENOTFOUND' }),
      );

      const result = await client.ping();

      expect(result.reachable).toBe(false);
      expect('error' in result && result.error).toContain('greptimedb');
      expect('error' in result && result.error).toContain('does not exist on its network');
      expect('error' in result && result.error).toContain('Deploy GreptimeDB');
      expect('error' in result && result.error).not.toMatch(/compose|appctl/i);
      expect(client.hostsAsked).toEqual([]);
    });

    it('reports the custom-host message on a DNS-coded connect failure for a forced-custom connection', async () => {
      const connection = configService(CONFIGURED);
      const original = connection.resolveCredentials.bind(connection);
      jest
        .spyOn(connection, 'resolveCredentials')
        .mockImplementation(async (role) => {
          const credentials = await original(role);
          return credentials && { ...credentials, automaticHost: false };
        });
      const client = new TestableClient(connection);
      client.client.query.mockResolvedValue({ fields: [], rows: [] });
      await client.queryReader('SELECT 1', { timeoutMs: 1000 });
      client.hostResolution = jest.fn(async () => 'should not be called');
      client.createdPools[0].connect.mockRejectedValue(
        Object.assign(new Error('getaddrinfo ENOTFOUND greptimedb'), { code: 'ENOTFOUND' }),
      );

      const result = await client.ping();

      expect(result.reachable).toBe(false);
      expect('error' in result && result.error).toContain('greptimedb');
      expect('error' in result && result.error).toContain('could not be resolved');
      expect('error' in result && result.error).not.toMatch(/compose|appctl/i);
      expect(client.hostsAsked).toEqual([]);
    });

    it('never throws when a connect timeout resolves to a host-not-found message', async () => {
      const client = new TestableClient(configService(CONFIGURED));
      client.client.query.mockResolvedValue({ fields: [], rows: [] });
      await client.queryReader('SELECT 1', { timeoutMs: 1000 });
      client.hostResolution = async () => 'GreptimeDB host "greptimedb" could not be resolved';
      client.createdPools[0].connect.mockRejectedValue(new Error('timeout expired'));

      await expect(client.ping()).resolves.toMatchObject({
        reachable: false,
        error: 'Could not connect to GreptimeDB: GreptimeDB host "greptimedb" could not be resolved',
      });
    });
  });

  describe('pool rebuild on fingerprint change (issue #558)', () => {
    it('reuses the pool while the fingerprint is unchanged', async () => {
      const client = new TestableClient(configService(CONFIGURED));
      client.client.query.mockResolvedValue({ fields: [], rows: [] });

      await client.queryReader('SELECT 1', { timeoutMs: 1000 });
      await client.queryReader('SELECT 2', { timeoutMs: 1000 });

      expect(client.created).toHaveLength(1);
    });

    it('rebuilds the pool — and ends the old one — when the connection fingerprint moves', async () => {
      const connection = configService(CONFIGURED);
      const client = new TestableClient(connection);
      client.client.query.mockResolvedValue({ fields: [], rows: [] });

      await client.queryReader('SELECT 1', { timeoutMs: 1000 });
      expect(client.created).toHaveLength(1);
      const firstPool = client.createdPools[0];

      // Simulate an admin save: the resolver's fingerprint (and the password it
      // hands out) changes on this same instance.
      jest.spyOn(connection, 'fingerprint').mockReturnValue('new-fingerprint');
      jest.spyOn(connection, 'resolveCredentials').mockResolvedValue({
        host: 'greptimedb',
        port: 4003,
        database: 'public',
        user: 'reader',
        password: 'rotated-reader-pw',
        fingerprint: 'new-fingerprint',
        automaticHost: false,
      });

      await client.queryReader('SELECT 3', { timeoutMs: 1000 });

      expect(client.created).toHaveLength(2);
      expect(client.created[1]).toMatchObject({ password: 'rotated-reader-pw' });
      // The stale pool is ended in the background, never awaited on the query path.
      await Promise.resolve();
      await Promise.resolve();
      expect(firstPool.end).toHaveBeenCalledTimes(1);
    });

    it('throws TelemetryNotConfiguredError, and drops any pool it held, when the fingerprint goes away', async () => {
      const connection = configService(CONFIGURED);
      const client = new TestableClient(connection);
      client.client.query.mockResolvedValue({ fields: [], rows: [] });
      await client.queryReader('SELECT 1', { timeoutMs: 1000 });
      const firstPool = client.createdPools[0];

      jest.spyOn(connection, 'fingerprint').mockReturnValue(null);

      await expect(client.queryReader('SELECT 2', { timeoutMs: 1000 })).rejects.toBeInstanceOf(
        TelemetryNotConfiguredError,
      );
      await Promise.resolve();
      expect(firstPool.end).toHaveBeenCalledTimes(1);
    });

    it('shares one build between concurrent first calls — only one pool is created', async () => {
      const client = new TestableClient(configService(CONFIGURED));
      client.client.query.mockResolvedValue({ fields: [], rows: [] });

      const [a, b, c] = await Promise.all([
        client.queryReader('SELECT 1', { timeoutMs: 1000 }),
        client.queryReader('SELECT 2', { timeoutMs: 1000 }),
        client.queryReader('SELECT 3', { timeoutMs: 1000 }),
      ]);

      expect(client.created).toHaveLength(1);
      expect([a, b, c]).toEqual([
        { fields: [], rows: [] },
        { fields: [], rows: [] },
        { fields: [], rows: [] },
      ]);
    });
  });

  it('ends every pool on module destroy', async () => {
    const client = new TestableClient(configService(CONFIGURED));
    client.client.query.mockResolvedValue({ fields: [], rows: [] });
    await client.queryReader('SELECT 1', { timeoutMs: 1000 });
    await client.queryAdmin('SELECT 1', { timeoutMs: 1000 });

    await client.onModuleDestroy();

    expect(client.createdPools.map((pool) => pool.end.mock.calls.length)).toEqual([1, 1]);
  });

  describe('helpers', () => {
    it('quotes identifiers and literals', () => {
      expect(quoteIdent('public')).toBe('"public"');
      expect(quoteIdent('we"ird')).toBe('"we""ird"');
      expect(quoteLiteral("o'neil")).toBe("'o''neil'");
    });

    it('keeps int8, numeric and timestamps as text; parses the rest', () => {
      expect(greptimeTypeParser(20)('9007199254740993')).toBe('9007199254740993');
      expect(greptimeTypeParser(1700)('18446744073709551615')).toBe('18446744073709551615');
      expect(greptimeTypeParser(1114)('2026-09-27 03:00:00.123456789')).toBe('2026-09-27 03:00:00.123456789');
      expect(greptimeTypeParser(23)('42')).toBe(42);
      expect(greptimeTypeParser(16)('t')).toBe(true);
    });

    it('maps array rows to objects', () => {
      expect(
        rowsAsObjects({
          fields: [
            { name: 'a', dataTypeID: 23 },
            { name: 'b', dataTypeID: 1043 },
          ],
          rows: [[1, 'x']],
        }),
      ).toEqual([{ a: 1, b: 'x' }]);
    });
  });
});
