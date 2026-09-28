import { describe, expect, it } from 'vitest';

import { CommandFailedError, type CommandResult, type RunCommandOptions } from '../executor.js';
import {
  DATABASE_CHECKS,
  MAINTENANCE_DATABASE,
  canCreateDatabase,
  databaseSettings,
  runPsql,
  type DatabaseSettings,
} from './database.js';
import type { Check, CheckContext, CheckFs } from './types.js';

// =============================================================================
// Same injected-runCommand pattern as the rest of checks/*.test.ts: psql is a
// one-off docker container, and the interesting input is what it prints, not
// a real Postgres.
// =============================================================================

type Canned = { exitCode: number; stdout?: string; stderr?: string };
type Responder = (argv: readonly string[], options: RunCommandOptions) => Canned | undefined;

function fakeRunCommand(respond: Responder): typeof import('../executor.js').runCommand {
  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    const canned = respond(argv, options) ?? { exitCode: 127, stderr: `${argv[0]}: command not found` };
    const result: CommandResult = {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: canned.exitCode,
      stdout: canned.stdout ?? '',
      stderr: canned.stderr ?? '',
      durationMs: 1,
      timedOut: false,
    };
    if (result.exitCode !== 0) {
      throw new CommandFailedError(result.stderr || 'failed', result);
    }
    return result;
  }) as typeof import('../executor.js').runCommand;
}

// A fixture, not a credential: kept off the `password:` line so secret scanners
// don't read it as one. The special characters exercise quoting.
const SAMPLE_VALUE = 'p@ss/word#1';

const SETTINGS: DatabaseSettings = {
  host: 'db.internal',
  port: '5432',
  user: 'appuser',
  password: SAMPLE_VALUE,
  database: 'appdb',
  ssl: false,
};

const presentFs: CheckFs = {
  exists: () => true,
  isDirectory: () => true,
  isWritable: () => true,
  readFile: () => '',
  readdir: () => [],
};

const ENV = new Map([
  ['POSTGRES_HOST', SETTINGS.host],
  ['POSTGRES_PORT', SETTINGS.port],
  ['POSTGRES_USER', SETTINGS.user],
  ['POSTGRES_PASSWORD', SETTINGS.password],
  ['POSTGRES_DB', SETTINGS.database],
]);

function context(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    runCommand: fakeRunCommand(() => ({ exitCode: 0, stdout: 't' })),
    deployRoot: '/opt/infra/apps/demo',
    bindPort: 3535,
    proxyRoot: '/opt/infra/proxy',
    env: ENV,
    fs: presentFs,
    ...overrides,
  };
}

function find(id: string): Check {
  const check = DATABASE_CHECKS.find((candidate) => candidate.id === id);
  if (check === undefined) throw new Error(`no check ${id}`);
  return check;
}

describe('MAINTENANCE_DATABASE', () => {
  it('is postgres', () => {
    expect(MAINTENANCE_DATABASE).toBe('postgres');
  });
});

describe('runPsql', () => {
  it('runs against the requested database, not necessarily the configured one', async () => {
    const seen: string[][] = [];
    const result = await runPsql(
      fakeRunCommand((argv) => {
        seen.push([...argv]);
        return { exitCode: 0, stdout: '1' };
      }),
      SETTINGS,
      MAINTENANCE_DATABASE,
      'select 1',
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('1');
    expect(seen[0]).toContain('-d');
    expect(seen[0]?.[seen[0].indexOf('-d') + 1]).toBe('postgres');
  });

  it('never puts the password in argv, and passes it only through PGPASSWORD by name', async () => {
    const seen: string[][] = [];
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];

    await runPsql(
      fakeRunCommand((argv, options) => {
        seen.push([...argv]);
        envs.push(options.env);
        return { exitCode: 0, stdout: 't' };
      }),
      SETTINGS,
      SETTINGS.database,
      'select 1',
    );

    const flat = seen.flat().join(' ');
    expect(flat).not.toContain(SETTINGS.password);
    expect(envs[0]?.PGPASSWORD).toBe(SETTINGS.password);
    // PGPASSWORD is declared by name (-e PGPASSWORD) so docker forwards the
    // value from its own env, never spelled out a second time in argv.
    expect(seen[0]).toContain('PGPASSWORD');
  });

  it('never throws: a psql failure comes back as ok: false with stderr', async () => {
    const result = await runPsql(
      fakeRunCommand(() => ({ exitCode: 2, stderr: 'psql: error: FATAL:  role "appuser" does not exist' })),
      SETTINGS,
      SETTINGS.database,
      'select 1',
    );

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('role "appuser" does not exist');
  });

  it('adds PGSSLMODE=require only when the settings ask for TLS', async () => {
    const seen: string[][] = [];
    await runPsql(
      fakeRunCommand((argv) => {
        seen.push([...argv]);
        return { exitCode: 0, stdout: 't' };
      }),
      { ...SETTINGS, ssl: true },
      SETTINGS.database,
      'select 1',
    );

    expect(seen.flat()).toContain('PGSSLMODE=require');
  });
});

describe('canCreateDatabase', () => {
  it('is true when the role holds CREATEDB or is a superuser', async () => {
    const seen: string[][] = [];
    const result = await canCreateDatabase(
      SETTINGS,
      fakeRunCommand((argv) => {
        seen.push([...argv]);
        return { exitCode: 0, stdout: 't' };
      }),
    );

    expect(result).toEqual({ canCreate: true });
    // Asked against the maintenance database, not the (possibly nonexistent)
    // application database.
    const dIndex = seen[0]?.indexOf('-d') ?? -1;
    expect(seen[0]?.[dIndex + 1]).toBe(MAINTENANCE_DATABASE);
    expect(seen.flat().join(' ')).toContain('pg_roles');
  });

  it('is false when the role has neither privilege', async () => {
    const result = await canCreateDatabase(
      SETTINGS,
      fakeRunCommand(() => ({ exitCode: 0, stdout: 'f' })),
    );

    expect(result).toEqual({ canCreate: false });
  });

  it('is undefined -- undetermined -- when psql itself fails, carrying the first stderr line', async () => {
    const result = await canCreateDatabase(
      SETTINGS,
      fakeRunCommand(() => ({
        exitCode: 2,
        stderr: 'psql: error: FATAL:  password authentication failed for user "appuser"\nsome detail',
      })),
    );

    expect(result.canCreate).toBeUndefined();
    expect(result.error).toBe('psql: error: FATAL:  password authentication failed for user "appuser"');
  });

  it('is undefined -- undetermined -- on an answer that is neither t nor f', async () => {
    const result = await canCreateDatabase(
      SETTINGS,
      fakeRunCommand(() => ({ exitCode: 0, stdout: '' })),
    );

    expect(result.canCreate).toBeUndefined();
    expect(result.error).toContain('unexpected answer');
  });

  it('never puts the password in argv', async () => {
    const seen: string[][] = [];
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];

    await canCreateDatabase(
      SETTINGS,
      fakeRunCommand((argv, options) => {
        seen.push([...argv]);
        envs.push(options.env);
        return { exitCode: 0, stdout: 't' };
      }),
    );

    expect(seen.flat().join(' ')).not.toContain(SETTINGS.password);
    expect(envs[0]?.PGPASSWORD).toBe(SETTINGS.password);
  });
});

describe('database-create-privilege check', () => {
  it('skips before an environment has been resolved', async () => {
    const result = await find('database-create-privilege').run(context({ env: undefined }));
    expect(result.status).toBe('skip');
  });

  it('passes and names the role when it holds CREATEDB', async () => {
    const result = await find('database-create-privilege').run(
      context({ runCommand: fakeRunCommand(() => ({ exitCode: 0, stdout: 't' })) }),
    );

    expect(result.status).toBe('pass');
    expect(result.detail).toContain(SETTINGS.user);
    expect(result.detail).toContain('CREATEDB');
  });

  it('warns (never fails) when the role cannot create databases, with a remedy covering both fixes', async () => {
    const result = await find('database-create-privilege').run(
      context({ runCommand: fakeRunCommand(() => ({ exitCode: 0, stdout: 'f' })) }),
    );

    expect(result.status).toBe('warn');
    // Recommended severity, never required: only matters if the database
    // does not exist yet.
    expect(find('database-create-privilege').severity).toBe('recommended');
    expect(result.remedy).toContain('ALTER ROLE');
    expect(result.remedy).toContain('CREATEDB');
    expect(result.remedy).toContain('CREATE DATABASE');
    expect(result.remedy).toContain(SETTINGS.database);
  });

  it('warns, naming the failure, when the question could not be answered', async () => {
    const result = await find('database-create-privilege').run(
      context({
        runCommand: fakeRunCommand(() => ({
          exitCode: 2,
          stderr: 'psql: error: could not connect to server',
        })),
      }),
    );

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('could not determine');
    expect(result.detail).toContain('could not connect to server');
  });

  it('is listed in DATABASE_CHECKS between database-exists and database-privileges', () => {
    const ids = DATABASE_CHECKS.map((check) => check.id);
    expect(ids.indexOf('database-exists')).toBeLessThan(ids.indexOf('database-create-privilege'));
    expect(ids.indexOf('database-create-privilege')).toBeLessThan(ids.indexOf('database-privileges'));
  });

  it('requires database-credentials, same as the other post-connect checks', () => {
    expect(find('database-create-privilege').requires).toEqual(['database-credentials']);
  });
});

describe('databaseSettings (sanity, shared with external.test.ts)', () => {
  it('reads the POSTGRES_* values', () => {
    expect(databaseSettings(ENV)).toEqual(SETTINGS);
  });
});

// =============================================================================
// doctor stays read-only about a missing database  (issue #396)
// =============================================================================
//
// install now TREATS a missing database as a question (ensure-database offers
// to create it). doctor must not: it still FAILS `database-exists`, as a
// required check, with the `createdb` remedy -- and issues nothing but a read.
// =============================================================================
describe('database-exists, as doctor runs it (#396)', () => {
  it('fails, required, with the createdb remedy, and issues nothing but `select 1`', async () => {
    const seen: string[] = [];
    const result = await find('database-exists').run(
      context({
        runCommand: fakeRunCommand((argv) => {
          seen.push(argv.join(' '));
          return { exitCode: 2, stderr: 'psql: error: FATAL:  database "appdb" does not exist (3D000)' };
        }),
      }),
    );

    expect(find('database-exists').severity).toBe('required');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('does not exist');
    expect(result.remedy).toContain(`createdb -h ${SETTINGS.host} -U ${SETTINGS.user} ${SETTINGS.database}`);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.endsWith('select 1')).toBe(true);
    expect(seen.join('\n')).not.toMatch(/CREATE|DROP|ALTER/);
  });
});
