import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { UsageError } from '../errors.js';
import { confirmationMatches, planUninstall, runUninstall } from './uninstall.js';
import { OBJECT_IN_USE, dropDatabase, quoteIdentifier } from './database-drop.js';
import { DEPLOY_STATE_VERSION, deployStatePath, writeState, type DeployState } from './state.js';

const FAKE_DB_PASSWORD = 'not-a-real-password';

function deployment(env = 'POSTGRES_DB=appdb\nAPP_BIND_PORT=3535\n'): string {
  const root = mkdtempSync(join(tmpdir(), 'appctl-uninstall-'));
  mkdirSync(join(root, 'repo', '.git'), { recursive: true });
  writeFileSync(join(root, '.env'), env);
  return root;
}

const okResult = (stdout = '') => ({
  argv: [],
  cwd: '/tmp',
  exitCode: 0,
  stdout,
  stderr: '',
  durationMs: 1,
  timedOut: false,
});

/**
 * ⚠ EVERY ASSERTION IN THIS BLOCK IS A REFUSAL, AND REFUSALS ARE WHAT A LATER
 * "SIMPLIFY" PASS DELETES. Each of the four is shared infrastructure this
 * deployment is a tenant of, not an owner of; removing any one of them breaks
 * a neighbouring application that has nothing to do with this uninstall.
 */
describe('uninstall refuses to remove shared infrastructure', () => {
  it('keeps the shared Docker network: other applications are on it', () => {
    const plan = planUninstall({ deployRoot: deployment() });

    expect(plan.keeps.map((keep) => keep.what)).toContain('the shared Docker network');
    expect(plan.removes.join('\n')).not.toMatch(/network/i);
  });

  it('keeps the shared proxy container: other applications are served by it', () => {
    const plan = planUninstall({ deployRoot: deployment() });

    expect(plan.keeps.map((keep) => keep.what)).toContain('the shared proxy container');
  });

  it("keeps the TLS certificate by default: Let's Encrypt allows 5 duplicates per week", () => {
    // Re-issuing during a debugging session exhausts the quota, and then a
    // reinstall CANNOT get a certificate at all. Keeping it is the feature.
    const plan = planUninstall({ deployRoot: deployment() });
    const cert = plan.keeps.find((keep) => keep.what.includes('TLS certificate'));

    expect(cert).toBeDefined();
    expect(cert?.because).toMatch(/5 duplicate/i);
  });

  it('keeps the renewal cron entry: it is per-host and renews the neighbours too', () => {
    const plan = planUninstall({ deployRoot: deployment() });
    const cron = plan.keeps.find((keep) => keep.what.includes('cron'));

    expect(cron).toBeDefined();
    expect(cron?.because).toMatch(/per-host/i);
  });
});

describe('the two destructive extras', () => {
  it('neither happens without being asked, and the plan says why', () => {
    const plan = planUninstall({ deployRoot: deployment() });
    const whats = plan.keeps.map((keep) => keep.what);

    expect(whats.some((what) => what.includes('appdb'))).toBe(true);
    expect(whats).toContain('every object in storage');
  });

  it('the confirmation is the resource\'s OWN NAME, so one cannot authorise the other', async () => {
    // ⚠ The entire reason the confirmation is not the word DELETE. An operator
    // who decided to drop a database has not thereby decided to empty a bucket,
    // and a single magic word typed once would authorise both.
    expect(confirmationMatches('appdb', 'appdb')).toBe(true);
    expect(confirmationMatches('DELETE', 'appdb')).toBe(false);
    expect(confirmationMatches('my-bucket', 'appdb')).toBe(false);
    expect(confirmationMatches(undefined, 'appdb')).toBe(false);
    expect(confirmationMatches('appdb', undefined)).toBe(false);
  });

  it('refuses --drop-database when the typed name does not match', async () => {
    const root = deployment();

    await expect(
      runUninstall({
        deployRoot: root,
        dropDatabase: true,
        confirmDatabase: 'DELETE',
        runCommand: vi.fn().mockResolvedValue(okResult()) as never,
      }),
    ).rejects.toBeInstanceOf(UsageError);

    // And nothing was removed on the way to that refusal.
    expect(existsSync(join(root, 'repo'))).toBe(true);
    expect(existsSync(join(root, '.env'))).toBe(true);
  });
});

describe('the read-only inventory', () => {
  it('a dry run removes nothing at all', async () => {
    // Nobody can consent to a number they were not shown, so the plan must be
    // obtainable without any of it happening.
    const root = deployment();
    const run = vi.fn();

    const result = await runUninstall({
      deployRoot: root,
      dryRun: true,
      runCommand: run as never,
    });

    expect(result.removed).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'repo'))).toBe(true);
    expect(existsSync(join(root, '.env'))).toBe(true);
  });

  it('names the real database from the deployment\'s own environment', () => {
    const plan = planUninstall({ deployRoot: deployment('POSTGRES_DB=production_db\n') });

    expect(plan.databaseName).toBe('production_db');
  });

  it('refuses a directory that is not a deployment', () => {
    const empty = mkdtempSync(join(tmpdir(), 'appctl-empty-'));

    expect(() => planUninstall({ deployRoot: empty })).toThrow(UsageError);
  });
});

describe('dropDatabase', () => {
  const env = new Map([
    ['POSTGRES_HOST', 'localhost'],
    ['POSTGRES_USER', 'postgres'],
    ['POSTGRES_PASSWORD', 'secret'],
  ]);

  it('never puts the password in an argv, where ps would show it', async () => {
    const run = vi.fn().mockResolvedValue(okResult());

    await dropDatabase({ env, database: 'appdb', runCommand: run as never });

    for (const call of run.mock.calls) {
      expect((call[0] as string[]).join(' ')).not.toContain('secret');
    }
    // Passed by name, with the value in the environment instead.
    expect((run.mock.calls[0]?.[0] as string[])).toContain('PGPASSWORD');
    expect((run.mock.calls[0]?.[1] as { env?: Record<string, string> }).env?.PGPASSWORD).toBe(
      'secret',
    );
  });

  it('tries a plain DROP first and terminates nothing when it succeeds', async () => {
    const run = vi.fn().mockResolvedValue(okResult());

    const result = await dropDatabase({ env, database: 'appdb', runCommand: run as never });

    expect(result.dropped).toBe(true);
    expect(result.terminated).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls.join(' ')).not.toContain('pg_terminate_backend');
  });

  it(`terminates backends only on ${OBJECT_IN_USE}, and only for that database`, async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ...okResult(), exitCode: 1, stderr: `ERROR: ${OBJECT_IN_USE}: database is being accessed by other users` })
      .mockResolvedValueOnce(okResult('3\n'))
      .mockResolvedValueOnce(okResult());

    const result = await dropDatabase({ env, database: 'appdb', runCommand: run as never });

    expect(result.dropped).toBe(true);
    // ⚠ Always reported. An operator not told a session was killed cannot know
    // to go and ask whose it was.
    expect(result.terminated).toBe(3);
    expect(result.detail).toMatch(/terminating 3 session/);

    // ⚠ SCOPED. An unscoped pg_terminate_backend takes down every other
    // application sharing this PostgreSQL.
    const terminateSql = (run.mock.calls[1]?.[0] as string[]).join(' ');
    expect(terminateSql).toContain('pg_terminate_backend');
    expect(terminateSql).toContain("datname = 'appdb'");
  });

  it('does not terminate anything when the failure is something else', async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ ...okResult(), exitCode: 1, stderr: 'ERROR: permission denied' });

    const result = await dropDatabase({ env, database: 'appdb', runCommand: run as never });

    expect(result.dropped).toBe(false);
    expect(result.terminated).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never uses DROP DATABASE WITH (FORCE), a syntax error on PostgreSQL 13', async () => {
    const run = vi.fn().mockResolvedValue(okResult());

    await dropDatabase({ env, database: 'appdb', runCommand: run as never });

    expect(run.mock.calls.join(' ')).not.toMatch(/WITH \(FORCE\)/i);
  });

  it('quotes an identifier rather than interpolating it raw', () => {
    expect(quoteIdentifier('appdb')).toBe('"appdb"');
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  });
});

describe('uninstall reuses the recorded proxy runtime when no flag overrides it', () => {
  function deploymentWithProxyState(overrides: Partial<DeployState> = {}): string {
    const root = deployment();
    const state: DeployState = {
      version: DEPLOY_STATE_VERSION,
      repoUrl: 'https://example.test/o/r',
      ref: 'main',
      commitSha: 'a'.repeat(40),
      domain: 'app.example.test',
      bindPort: 3535,
      deployRoot: root,
      installedAt: '2026-01-01T00:00:00.000Z',
      lastDeployedAt: '2026-01-01T00:00:00.000Z',
      lastCommand: 'install',
      appctlVersion: '1.0.0',
      proxyMode: 'container',
      proxyContainer: 'recorded-proxy',
      ...overrides,
    };
    writeState(state);

    // A vhost this tool wrote, so `removeVhost` actually has something to
    // validate and reload around, rather than a silent no-op.
    const vhostDir = join(root, 'proxy', 'nginx', 'conf.d');
    mkdirSync(vhostDir, { recursive: true });
    writeFileSync(join(vhostDir, 'app.example.test.conf'), '# Managed by appctl deploy\n');

    return root;
  }

  it('plan carries the recorded proxyMode/proxyContainer forward', () => {
    const root = deploymentWithProxyState();

    const plan = planUninstall({ deployRoot: root, proxyRoot: join(root, 'proxy') });

    expect(plan.proxyMode).toBe('container');
    expect(plan.proxyContainer).toBe('recorded-proxy');
  });

  it('with no --proxy-mode/--proxy-container flag, the removal uses the RECORDED container', async () => {
    const root = deploymentWithProxyState();
    const run = vi.fn().mockResolvedValue(okResult());

    await runUninstall({ deployRoot: root, proxyRoot: join(root, 'proxy'), runCommand: run as never });

    const argvs = run.mock.calls.map((call) => (call[0] as string[]).join(' '));
    expect(argvs).toContain('docker exec recorded-proxy nginx -t');
    expect(argvs).toContain('docker exec recorded-proxy nginx -s reload');
  });

  it('an explicit --proxy-container flag overrides the recorded one', async () => {
    const root = deploymentWithProxyState();
    const run = vi.fn().mockResolvedValue(okResult());

    await runUninstall({
      deployRoot: root,
      proxyRoot: join(root, 'proxy'),
      proxyContainer: 'flagged-proxy',
      runCommand: run as never,
    });

    const argvs = run.mock.calls.map((call) => (call[0] as string[]).join(' '));
    expect(argvs).toContain('docker exec flagged-proxy nginx -t');
    expect(argvs).not.toContain('docker exec recorded-proxy nginx -t');
  });

  it('an explicit --proxy-mode flag overrides the recorded mode (host, not container)', async () => {
    const root = deploymentWithProxyState();
    const run = vi.fn().mockResolvedValue(okResult());

    await runUninstall({
      deployRoot: root,
      proxyRoot: join(root, 'proxy'),
      proxyMode: 'host',
      runCommand: run as never,
    });

    const argvs = run.mock.calls.map((call) => (call[0] as string[]).join(' '));
    expect(argvs).toContain('nginx -t');
    expect(argvs.some((argv) => argv.startsWith('docker exec'))).toBe(false);
  });
});

describe('uninstall tears down the stack the deployment recorded (#531)', () => {
  function recorded(groups?: string[]): string {
    const root = deployment();
    writeState({
      version: DEPLOY_STATE_VERSION,
      repoUrl: 'https://example.test/o/r',
      ref: 'main',
      commitSha: 'a'.repeat(40),
      bindPort: 3535,
      deployRoot: root,
      installedAt: '2026-01-01T00:00:00.000Z',
      lastDeployedAt: '2026-01-01T00:00:00.000Z',
      lastCommand: 'install',
      appctlVersion: '1.0.0',
      ...(groups === undefined ? {} : { groups }),
    });
    return root;
  }

  it('includes the telemetry stack in `down -v` when observability was enabled', async () => {
    // ⚠ `down -v` removes only the services and volumes of the files it is
    // given: without telemetry.compose.yml the collector, GreptimeDB and the
    // `greptimedb-data` volume would outlive the uninstall.
    const root = recorded(['observability']);
    const run = vi.fn().mockResolvedValue(okResult());

    expect(planUninstall({ deployRoot: root }).groups).toEqual(['observability']);
    await runUninstall({ deployRoot: root, runCommand: run as never });

    const down = run.mock.calls
      .map((call) => (call[0] as string[]).join(' '))
      .find((argv) => argv.includes(' down '));
    expect(down).toContain('-f telemetry.compose.yml');
    expect(down).toContain('-f vps.telemetry.compose.yml');
  });

  it('includes it for a deployment recorded without the group, too (#567)', async () => {
    // Telemetry is always on: the stack runs it, so `down -v` must remove it.
    const root = recorded();
    const run = vi.fn().mockResolvedValue(okResult());

    expect(planUninstall({ deployRoot: root }).groups).toEqual(['observability']);
    await runUninstall({ deployRoot: root, runCommand: run as never });

    const down = run.mock.calls
      .map((call) => (call[0] as string[]).join(' '))
      .find((argv) => argv.includes(' down '));
    expect(down).toBeDefined();
    expect(down).toContain('-f telemetry.compose.yml');
    expect(down).toContain('-f vps.telemetry.compose.yml');
  });
});

describe('--purge-storage runs inside the api image, before anything is destroyed', () => {
  it('refuses without the bucket name, and removes nothing', async () => {
    const root = deployment();
    const run = vi.fn().mockResolvedValue(okResult());

    await expect(
      runUninstall({ deployRoot: root, purgeStorage: true, runCommand: run as never }),
    ).rejects.toThrow(/NOT purged/);

    expect(existsSync(join(root, 'repo'))).toBe(true);
    expect(existsSync(join(root, '.env'))).toBe(true);
  });

  it('purges BEFORE `compose down`, while the image and config still exist', async () => {
    // ⚠ Ordering is the whole point. The purge reads the bucket and credential
    // through the application's own config service, inside its own image. Run
    // after `down -v` and `rm -rf repo`, there is nothing left to run it with.
    const root = deployment();
    const order: string[] = [];
    const run = vi.fn().mockImplementation(async (argv: readonly string[]) => {
      if (argv.includes('storage:purge')) order.push('purge');
      if (argv.includes('down')) order.push('down');
      return okResult('{"deleted":4}');
    });

    await runUninstall({
      deployRoot: root,
      purgeStorage: true,
      confirmBucket: 'my-bucket',
      runCommand: run as never,
    });

    expect(order).toEqual(['purge', 'down']);
  });

  it('passes the typed bucket name through for the container to re-check', async () => {
    const root = deployment();
    const run = vi.fn().mockResolvedValue(okResult('{}'));

    await runUninstall({
      deployRoot: root,
      purgeStorage: true,
      confirmBucket: 'my-bucket',
      runCommand: run as never,
    });

    const purge = run.mock.calls.find((call) => (call[0] as string[]).includes('storage:purge'));
    expect(purge?.[0]).toContain('--confirm');
    expect(purge?.[0]).toContain('my-bucket');
  });

  it('refuses LOUDLY when the purge fails, rather than removing the deployment anyway', async () => {
    // A purge that quietly did not happen leaves the operator believing their
    // bucket is empty. Silent retention is the one outcome this must never
    // produce, so the whole uninstall stops.
    const root = deployment();
    const run = vi.fn().mockImplementation(async (argv: readonly string[]) => {
      if (argv.includes('storage:purge')) throw new Error('no such service: api');
      return okResult();
    });

    await expect(
      runUninstall({
        deployRoot: root,
        purgeStorage: true,
        confirmBucket: 'my-bucket',
        runCommand: run as never,
      }),
    ).rejects.toThrow(/no such service/);

    expect(existsSync(join(root, 'repo'))).toBe(true);
  });
});

describe('--drop-database actually drops the database (#522)', () => {
  const DB_ENV = [
    'POSTGRES_DB=appdb',
    'POSTGRES_HOST=db.example.test',
    'POSTGRES_PORT=6543',
    'POSTGRES_USER=postgres',
    `POSTGRES_PASSWORD=${FAKE_DB_PASSWORD}`,
    'APP_BIND_PORT=3535',
    '',
  ].join('\n');

  function deploymentWithVhost(env = DB_ENV): string {
    const root = deployment(env);
    const state: DeployState = {
      version: DEPLOY_STATE_VERSION,
      repoUrl: 'https://example.test/o/r',
      ref: 'main',
      commitSha: 'a'.repeat(40),
      domain: 'app.example.test',
      bindPort: 3535,
      deployRoot: root,
      installedAt: '2026-01-01T00:00:00.000Z',
      lastDeployedAt: '2026-01-01T00:00:00.000Z',
      lastCommand: 'install',
      appctlVersion: '1.0.0',
      proxyMode: 'host',
    };
    writeState(state);
    const vhostDir = join(root, 'proxy', 'nginx', 'conf.d');
    mkdirSync(vhostDir, { recursive: true });
    writeFileSync(join(vhostDir, 'app.example.test.conf'), '# Managed by appctl deploy\n');
    return root;
  }

  const vhostPath = (root: string) =>
    join(root, 'proxy', 'nginx', 'conf.d', 'app.example.test.conf');
  const isDrop = (argv: readonly string[]) =>
    argv.includes('psql') && argv.some((arg) => arg.includes('DROP DATABASE'));

  it('the plan lists the database, with its server, under REMOVES when the flag is set', () => {
    const plan = planUninstall({ deployRoot: deployment(DB_ENV), dropDatabase: true });

    expect(plan.removes).toContain('database appdb on db.example.test:6543 (DROP DATABASE)');
    expect(plan.keeps.some((keep) => keep.what.includes('appdb'))).toBe(false);
  });

  it('the plan lists the database under KEEPS, and not under removes, without the flag', () => {
    const plan = planUninstall({ deployRoot: deployment(DB_ENV) });

    expect(plan.keeps.some((keep) => keep.what.includes('appdb'))).toBe(true);
    expect(plan.removes.join('\n')).not.toContain('DROP DATABASE');
  });

  it('drops AFTER `compose down` and BEFORE the vhost and the files are removed', async () => {
    const root = deploymentWithVhost();
    const order: string[] = [];
    const run = vi.fn().mockImplementation(async (argv: readonly string[]) => {
      if (argv.includes('down')) order.push('down');
      if (isDrop(argv)) {
        order.push('drop');
        // The files a retry needs must still be on disk at this moment.
        expect(existsSync(join(root, '.env'))).toBe(true);
        expect(existsSync(join(root, 'repo'))).toBe(true);
        expect(existsSync(vhostPath(root))).toBe(true);
      }
      if (argv.join(' ') === 'nginx -t') order.push('vhost');
      return okResult();
    });

    const result = await runUninstall({
      deployRoot: root,
      proxyRoot: join(root, 'proxy'),
      dropDatabase: true,
      confirmDatabase: 'appdb',
      runCommand: run as never,
    });

    expect(order).toEqual(['down', 'drop', 'vhost']);
    expect(result.removed).toBe(true);
    expect(result.database).toEqual({
      name: 'appdb',
      terminated: 0,
      detail: 'dropped; no sessions were connected',
    });
    expect(existsSync(join(root, 'repo'))).toBe(false);
    expect(existsSync(join(root, '.env'))).toBe(false);
  });

  it('reports the terminated-session count and journals it', async () => {
    const root = deploymentWithVhost();
    mkdirSync(join(root, 'logs'), { recursive: true });
    let drops = 0;
    let journalAtVhost = '';
    const run = vi.fn().mockImplementation(async (argv: readonly string[]) => {
      if (isDrop(argv)) {
        drops += 1;
        if (drops === 1) {
          return {
            ...okResult(),
            exitCode: 1,
            stderr: `ERROR: ${OBJECT_IN_USE}: database "appdb" is being accessed by other users`,
          };
        }
      }
      if (argv.some((arg) => arg.includes('pg_terminate_backend'))) return okResult('2\n');
      // The journal lives under logs/, which the uninstall itself removes, so
      // it is read while it still exists: after the drop, before the files go.
      if (argv.join(' ') === 'nginx -t') {
        journalAtVhost = readdirSync(join(root, 'logs'))
          .map((file) => readFileSync(join(root, 'logs', file), 'utf8'))
          .join('\n');
      }
      return okResult();
    });

    const result = await runUninstall({
      deployRoot: root,
      proxyRoot: join(root, 'proxy'),
      dropDatabase: true,
      confirmDatabase: 'appdb',
      runCommand: run as never,
    });

    expect(result.database?.terminated).toBe(2);
    expect(journalAtVhost).toMatch(/Dropped database appdb.*terminated 2 session/);
    expect(journalAtVhost).not.toContain(FAKE_DB_PASSWORD);
  });

  it('a failed drop THROWS, and keeps the checkout, the .env and the vhost for a re-run', async () => {
    const root = deploymentWithVhost();
    const run = vi.fn().mockImplementation(async (argv: readonly string[]) => {
      if (isDrop(argv)) return { ...okResult(), exitCode: 2, stderr: 'psql: error: connection refused' };
      return okResult();
    });

    const failure = runUninstall({
      deployRoot: root,
      proxyRoot: join(root, 'proxy'),
      dropDatabase: true,
      confirmDatabase: 'appdb',
      runCommand: run as never,
    });

    await expect(failure).rejects.toBeInstanceOf(UsageError);
    await expect(failure).rejects.toThrow(/NOT dropped: psql: error: connection refused/);
    await expect(failure).rejects.toThrow(/re-run/i);

    expect(existsSync(join(root, 'repo'))).toBe(true);
    expect(existsSync(join(root, '.env'))).toBe(true);
    expect(existsSync(deployStatePath(root))).toBe(true);
    expect(existsSync(vhostPath(root))).toBe(true);
    const argvs = run.mock.calls.map((call) => (call[0] as string[]).join(' '));
    expect(argvs).not.toContain('nginx -t');
    expect(argvs.some((argv) => argv.includes('nginx -s reload'))).toBe(false);

    // And the same command is accepted again: the stack is down, but the
    // checkout and .env that planUninstall looks for are still there.
    expect(() => planUninstall({ deployRoot: root, dropDatabase: true })).not.toThrow();
    const retry = await runUninstall({
      deployRoot: root,
      proxyRoot: join(root, 'proxy'),
      dropDatabase: true,
      confirmDatabase: 'appdb',
      runCommand: vi.fn().mockResolvedValue(okResult()) as never,
    });
    expect(retry.removed).toBe(true);
    expect(retry.database?.name).toBe('appdb');
    expect(existsSync(join(root, '.env'))).toBe(false);
  });

  it('a drop that cannot even start (no credentials) is also a loud failure, not a success', async () => {
    const root = deployment('POSTGRES_DB=appdb\n');

    await expect(
      runUninstall({
        deployRoot: root,
        dropDatabase: true,
        confirmDatabase: 'appdb',
        runCommand: vi.fn().mockResolvedValue(okResult()) as never,
      }),
    ).rejects.toThrow(/NOT dropped/);

    expect(existsSync(join(root, 'repo'))).toBe(true);
    expect(existsSync(join(root, '.env'))).toBe(true);
  });

  it('never puts the password in an argv during the uninstall', async () => {
    const root = deployment(DB_ENV);
    const run = vi.fn().mockResolvedValue(okResult());

    await runUninstall({
      deployRoot: root,
      dropDatabase: true,
      confirmDatabase: 'appdb',
      runCommand: run as never,
    });

    const drop = run.mock.calls.find((call) => isDrop(call[0] as string[]));
    expect(drop).toBeDefined();
    for (const call of run.mock.calls) {
      expect((call[0] as string[]).join(' ')).not.toContain(FAKE_DB_PASSWORD);
    }
    expect((drop?.[1] as { env?: Record<string, string> }).env?.PGPASSWORD).toBe(
      FAKE_DB_PASSWORD,
    );
  });
});

describe('dropDatabase connection settings', () => {
  const base: [string, string][] = [
    ['POSTGRES_HOST', 'localhost'],
    ['POSTGRES_USER', 'postgres'],
    ['POSTGRES_PASSWORD', 'secret'],
  ];

  it('POSTGRES_SSL=true sets PGSSLMODE=require in the environment, named but not valued in argv', async () => {
    const run = vi.fn().mockResolvedValue(okResult());

    await dropDatabase({
      env: new Map([...base, ['POSTGRES_SSL', 'true']]),
      database: 'appdb',
      runCommand: run as never,
    });

    const argv = run.mock.calls[0]?.[0] as string[];
    const options = run.mock.calls[0]?.[1] as { env?: Record<string, string> };
    expect(options.env?.PGSSLMODE).toBe('require');
    expect(argv).toContain('PGSSLMODE');
    expect(argv.join(' ')).not.toContain('require');
  });

  it('without POSTGRES_SSL, PGSSLMODE is neither named nor set', async () => {
    const run = vi.fn().mockResolvedValue(okResult());
    const saved = process.env.PGSSLMODE;
    delete process.env.PGSSLMODE;

    try {
      await dropDatabase({ env: new Map(base), database: 'appdb', runCommand: run as never });
    } finally {
      if (saved !== undefined) process.env.PGSSLMODE = saved;
    }

    const argv = run.mock.calls[0]?.[0] as string[];
    const options = run.mock.calls[0]?.[1] as { env?: Record<string, string> };
    expect(argv).not.toContain('PGSSLMODE');
    expect(options.env?.PGSSLMODE).toBeUndefined();
  });

  it('bounds the connection attempt with PGCONNECT_TIMEOUT=5, via the environment', async () => {
    const run = vi.fn().mockResolvedValue(okResult());

    await dropDatabase({ env: new Map(base), database: 'appdb', runCommand: run as never });

    const argv = run.mock.calls[0]?.[0] as string[];
    const options = run.mock.calls[0]?.[1] as { env?: Record<string, string> };
    expect(options.env?.PGCONNECT_TIMEOUT).toBe('5');
    expect(argv).toContain('PGCONNECT_TIMEOUT');
    expect(argv.join(' ')).not.toContain('PGCONNECT_TIMEOUT=');
  });
});
