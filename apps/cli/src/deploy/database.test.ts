import { describe, expect, it } from 'vitest';

import { PreconditionError, UsageError } from '../errors.js';
import type { CompletedCheck } from './checks/index.js';
import {
  assertCreatableDatabaseName,
  blocksNewDatabase,
  createDatabaseStatement,
  ensureDatabase,
  onlyDatabaseMissing,
  unattendedDatabaseRefusal,
} from './database.js';
import { CommandFailedError, type CommandResult, type RunCommandOptions, type runCommand } from './executor.js';

const PASSWORD = 'the-database-password';

const ENV = new Map([
  ['POSTGRES_HOST', 'db.example.test'],
  ['POSTGRES_PORT', '5432'],
  ['POSTGRES_USER', 'appuser'],
  ['POSTGRES_PASSWORD', PASSWORD],
  ['POSTGRES_DB', 'appdb'],
]);

function completed(id: string, status: CompletedCheck['status'], detail = ''): CompletedCheck {
  return { id, title: id, status, detail, severity: 'required', durationMs: 0 };
}

const MISSING: CompletedCheck[] = [
  completed('database-reachable', 'pass'),
  completed('database-credentials', 'pass'),
  completed('database-exists', 'fail', 'database "appdb" does not exist'),
];

/** The full re-verify after a CREATE, all well. */
const VERIFIED: CompletedCheck[] = [
  completed('database-reachable', 'pass'),
  completed('database-credentials', 'pass'),
  completed('database-exists', 'pass', 'appdb'),
  { ...completed('database-create-privilege', 'pass', 'appuser holds CREATEDB'), severity: 'recommended' },
  { ...completed('database-privileges', 'pass', 'appuser can create tables'), severity: 'recommended' },
  { ...completed('database-ssl', 'skip', 'POSTGRES_SSL is not true'), severity: 'recommended' },
];

const EXISTS: CompletedCheck[] = [
  completed('database-reachable', 'pass'),
  completed('database-credentials', 'pass'),
  completed('database-exists', 'pass', 'appdb'),
];

interface Seen {
  argv: readonly string[];
  env: NodeJS.ProcessEnv | undefined;
}

/** Answers psql by the statement it carries (the argv's last element). */
function psqlFake(answer: (statement: string) => { ok: boolean; stdout?: string; stderr?: string }): {
  run: typeof runCommand;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const run = (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    seen.push({ argv, env: options.env });
    const reply = answer(argv[argv.length - 1] ?? '');
    const result: CommandResult = {
      argv,
      cwd: options.cwd,
      exitCode: reply.ok ? 0 : 1,
      stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '',
      durationMs: 0,
      timedOut: false,
    };
    if (!reply.ok) throw new CommandFailedError(result.stderr, result);
    return result;
  }) as typeof runCommand;
  return { run, seen };
}

const CAN_CREATE = (statement: string) =>
  /rolcreatedb/.test(statement) ? { ok: true, stdout: 't' } : { ok: true, stdout: '1' };

function creates(seen: Seen[]): Seen[] {
  return seen.filter((call) => /CREATE DATABASE/.test(call.argv[call.argv.length - 1] ?? ''));
}

describe('the identifier rule', () => {
  it('accepts plain names and quotes them', () => {
    expect(createDatabaseStatement('appdb')).toBe('CREATE DATABASE "appdb"');
    expect(createDatabaseStatement('_App_2$')).toBe('CREATE DATABASE "_App_2$"');
  });

  it.each(['1app', 'app-db', 'app db', 'app"; DROP DATABASE x; --', '', 'a'.repeat(64)])(
    'refuses %j',
    (name) => {
      expect(() => assertCreatableDatabaseName(name)).toThrow(UsageError);
    },
  );
});

describe('onlyDatabaseMissing', () => {
  it('is true only when the missing database is the one required failure', () => {
    expect(onlyDatabaseMissing(MISSING)).toBe(true);
    expect(onlyDatabaseMissing(EXISTS)).toBe(false);
    expect(
      onlyDatabaseMissing([
        completed('database-reachable', 'pass'),
        completed('database-credentials', 'fail', 'password authentication failed for appuser'),
        completed('database-exists', 'skip'),
      ]),
    ).toBe(false);
  });
});

describe('ensureDatabase', () => {
  it('does nothing when the database exists', async () => {
    const { run, seen } = psqlFake(CAN_CREATE);
    const result = await ensureDatabase({ env: ENV, runCommand: run, check: async () => EXISTS });
    expect(result.outcome).toBe('exists');
    expect(seen).toEqual([]);
  });

  it('creates it with --create-database, against the maintenance database, password never in argv', async () => {
    const { run, seen } = psqlFake(CAN_CREATE);
    const result = await ensureDatabase({
      env: ENV,
      runCommand: run,
      createDatabase: true,
      nonInteractive: true,
      check: async () => MISSING,
      verify: async () => VERIFIED,
    });

    expect(result.outcome).toBe('created');
    const [create] = creates(seen);
    expect(create?.argv[create.argv.length - 1]).toBe('CREATE DATABASE "appdb"');
    expect(create?.argv).toContain('postgres');
    expect(create?.env?.['PGPASSWORD']).toBe(PASSWORD);
    for (const call of seen) {
      expect(call.argv.join(' ')).not.toContain(PASSWORD);
      expect(call.argv.join(' ')).not.toMatch(/DROP|ALTER/i);
    }
  });

  it('asks when interactive, and creates only on yes', async () => {
    const yes = psqlFake(CAN_CREATE);
    const questions: string[] = [];
    await ensureDatabase({
      env: ENV,
      runCommand: yes.run,
      check: async () => MISSING,
      verify: async () => VERIFIED,
      ask: async (question) => {
        questions.push(question);
        return true;
      },
    });
    expect(questions[0]).toContain('appdb');
    expect(creates(yes.seen)).toHaveLength(1);

    const no = psqlFake(CAN_CREATE);
    await expect(
      ensureDatabase({ env: ENV, runCommand: no.run, check: async () => MISSING, ask: async () => false }),
    ).rejects.toThrow(/declined/);
    expect(creates(no.seen)).toHaveLength(0);
  });

  it('refuses in a non-interactive run without the flag, naming it', async () => {
    const { run, seen } = psqlFake(CAN_CREATE);
    const error = await ensureDatabase({
      env: ENV,
      runCommand: run,
      nonInteractive: true,
      check: async () => MISSING,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('--create-database');
    expect(creates(seen)).toHaveLength(0);
  });

  it('fails with a remedy when the role cannot create databases', async () => {
    const { run, seen } = psqlFake((statement) =>
      /rolcreatedb/.test(statement) ? { ok: true, stdout: 'f' } : { ok: true },
    );
    const error = await ensureDatabase({
      env: ENV,
      runCommand: run,
      createDatabase: true,
      check: async () => MISSING,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('CREATEDB');
    expect(creates(seen)).toHaveLength(0);
  });

  it('never acts on any other failure', async () => {
    const { run, seen } = psqlFake(CAN_CREATE);
    await expect(
      ensureDatabase({
        env: ENV,
        runCommand: run,
        createDatabase: true,
        check: async () => [
          completed('database-reachable', 'pass'),
          completed('database-credentials', 'fail', 'password authentication failed for appuser'),
          completed('database-exists', 'skip'),
        ],
      }),
    ).rejects.toThrow(/password authentication failed/);
    expect(seen).toEqual([]);
  });

  it('refuses a name outside the grammar before asking anything', async () => {
    const { run, seen } = psqlFake(CAN_CREATE);
    const asked: string[] = [];
    await expect(
      ensureDatabase({
        env: new Map([...ENV, ['POSTGRES_DB', 'app-db']]),
        runCommand: run,
        check: async () => MISSING,
        ask: async (question) => {
          asked.push(question);
          return true;
        },
      }),
    ).rejects.toThrow(UsageError);
    expect(asked).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('treats a concurrent creation (42P04) as success', async () => {
    const { run } = psqlFake((statement) =>
      /CREATE DATABASE/.test(statement)
        ? { ok: false, stderr: 'ERROR:  database "appdb" already exists (42P04)' }
        : CAN_CREATE(statement),
    );
    const result = await ensureDatabase({
      env: ENV,
      runCommand: run,
      createDatabase: true,
      check: async () => MISSING,
      verify: async () => VERIFIED,
    });
    expect(result.outcome).toBe('created');
  });
});

// =============================================================================
// Offer, create, RE-VERIFY -- and name the line to correct  (issue #396)
// =============================================================================

describe('ensureDatabase re-verifies what it created (#396)', () => {
  it('runs the full check set after the CREATE, reports every line, and returns it', async () => {
    const { run } = psqlFake(CAN_CREATE);
    const lines: string[] = [];
    const order: string[] = [];
    const result = await ensureDatabase({
      env: ENV,
      runCommand: run,
      createDatabase: true,
      check: async () => {
        order.push('check');
        return MISSING;
      },
      verify: async () => {
        order.push('verify');
        return VERIFIED;
      },
      onLine: (line) => lines.push(line),
    });

    expect(order).toEqual(['check', 'verify']);
    expect(result.checks).toEqual(VERIFIED);
    // A real answer, where `skipped: database-exists did not pass` used to be.
    expect(lines).toContain('pass database-privileges: appuser can create tables');
    expect(lines.some((line) => /skipped: database-exists/.test(line))).toBe(false);
  });

  it('does not re-verify a database that already existed', async () => {
    const { run } = psqlFake(CAN_CREATE);
    let verified = false;
    const result = await ensureDatabase({
      env: ENV,
      runCommand: run,
      check: async () => EXISTS,
      verify: async () => {
        verified = true;
        return VERIFIED;
      },
    });
    expect(verified).toBe(false);
    expect(result.checks).toEqual(EXISTS);
  });

  it('stops when the new database cannot take a table, with the GRANT as the remedy', async () => {
    const { run, seen } = psqlFake(CAN_CREATE);
    const error = await ensureDatabase({
      env: ENV,
      runCommand: run,
      createDatabase: true,
      check: async () => MISSING,
      verify: async () =>
        VERIFIED.map((result) =>
          result.id === 'database-privileges'
            ? {
                ...result,
                status: 'warn' as const,
                detail: 'appuser cannot create in schema public',
                remedy: 'Migrations will fail. Grant it: GRANT CREATE ON SCHEMA public TO appuser;',
              }
            : result,
        ),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('database-privileges');
    expect((error as Error).message).toContain('GRANT CREATE ON SCHEMA public');
    // Created once, and nothing issued to undo it.
    expect(creates(seen)).toHaveLength(1);
    for (const call of seen) expect(call.argv.join(' ')).not.toMatch(/DROP/i);
  });

  it('stops when a required check fails against the new database', async () => {
    const { run } = psqlFake(CAN_CREATE);
    await expect(
      ensureDatabase({
        env: ENV,
        runCommand: run,
        createDatabase: true,
        check: async () => MISSING,
        verify: async () =>
          VERIFIED.map((result) =>
            result.id === 'database-exists'
              ? { ...result, status: 'fail' as const, detail: 'database "appdb" does not exist' }
              : result,
          ),
      }),
    ).rejects.toThrow(/not usable yet[\s\S]*database-exists/);
  });

  it('does not stop on a privileges answer it could not determine', () => {
    expect(
      blocksNewDatabase({
        ...completed('database-privileges', 'warn', 'could not determine privileges'),
        severity: 'recommended',
      }),
    ).toBe(false);
    expect(
      blocksNewDatabase({
        ...completed('database-privileges', 'warn', 'appuser cannot create in schema public'),
        severity: 'recommended',
      }),
    ).toBe(true);
  });
});

describe('refusals name POSTGRES_DB and the file it is in (#396)', () => {
  const ENV_PATH = '/opt/apps/app/repo/infra/compose/.env';

  it('declined: names POSTGRES_DB and the .env path', async () => {
    const { run, seen } = psqlFake(CAN_CREATE);
    const error = await ensureDatabase({
      env: ENV,
      runCommand: run,
      envPath: ENV_PATH,
      check: async () => MISSING,
      ask: async () => false,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreconditionError);
    const message = (error as Error).message;
    expect(message).toContain('declined');
    expect(message).toContain('POSTGRES_DB');
    expect(message).toContain(`If "appdb" is not the name you meant, correct POSTGRES_DB in ${ENV_PATH}`);
    expect(creates(seen)).toHaveLength(0);
  });

  it('unattended: names the flag, POSTGRES_DB and the .env path', async () => {
    const { run } = psqlFake(CAN_CREATE);
    const error = await ensureDatabase({
      env: ENV,
      runCommand: run,
      envPath: ENV_PATH,
      nonInteractive: true,
      check: async () => MISSING,
    }).catch((caught: unknown) => caught);

    const message = (error as Error).message;
    expect(message).toContain('--create-database');
    expect(message).toContain(`correct POSTGRES_DB in ${ENV_PATH}`);
  });
});

describe('unattendedDatabaseRefusal (#396)', () => {
  it('returns the refusal ensureDatabase would give, and never creates -- even with an ask seam about', async () => {
    const { run, seen } = psqlFake(CAN_CREATE);
    const refusal = await unattendedDatabaseRefusal({
      env: ENV,
      runCommand: run,
      envPath: '/x/.env',
      check: async () => MISSING,
    });

    expect(refusal).toBeInstanceOf(PreconditionError);
    expect(refusal?.message).toContain('--create-database');
    expect(refusal?.message).toContain('correct POSTGRES_DB in /x/.env');
    expect(creates(seen)).toHaveLength(0);
  });

  it('has nothing to say when the database exists', async () => {
    const { run } = psqlFake(CAN_CREATE);
    expect(await unattendedDatabaseRefusal({ env: ENV, runCommand: run, check: async () => EXISTS })).toBeUndefined();
  });

  it('leaves every other database failure to validate-environment', async () => {
    const { run, seen } = psqlFake(CAN_CREATE);
    const refusal = await unattendedDatabaseRefusal({
      env: ENV,
      runCommand: run,
      check: async () => [
        completed('database-reachable', 'fail', 'connection refused to db.example.test:5432'),
        completed('database-credentials', 'skip'),
        completed('database-exists', 'skip'),
      ],
    });
    expect(refusal).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('refuses with the CREATEDB remedy when the role could not create it anyway', async () => {
    const { run } = psqlFake((statement) =>
      /rolcreatedb/.test(statement) ? { ok: true, stdout: 'f' } : { ok: true },
    );
    const refusal = await unattendedDatabaseRefusal({ env: ENV, runCommand: run, check: async () => MISSING });
    expect(refusal?.message).toContain('CREATEDB');
  });
});
