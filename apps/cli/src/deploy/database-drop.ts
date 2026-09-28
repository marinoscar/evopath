/**
 * Dropping the application's database — the opt-in half of uninstall.
 *
 * ⚠ `DROP DATABASE WITH (FORCE)` WAS REJECTED, and it is the obvious choice.
 * Two reasons: it is a syntax error on PostgreSQL 13, which is still in the
 * field; and it terminates backends without saying which or how many, so an
 * operator cannot tell "nothing was connected" from "I just killed a session
 * somebody was using". This does it in two explicit steps and reports the
 * count.
 *
 * ⚠ BACKENDS ARE TERMINATED ONLY ON ERROR 55006 (`object_in_use`), and only
 * for THAT database. Terminating pre-emptively would kill sessions on a
 * database that was about to drop cleanly anyway; terminating unscoped would
 * kill every session on the server, including other applications'.
 *
 * The connection is made to the `postgres` maintenance database, because a
 * database cannot be dropped from a session connected to it.
 */
import { UsageError } from '../errors.js';
import { runCommand as defaultRunCommand } from './executor.js';

/** PostgreSQL's `object_in_use`: "database is being accessed by other users". */
export const OBJECT_IN_USE = '55006';

export interface DatabaseDropOptions {
  /** Connection parameters, read from the deployment's own `.env`. */
  env: ReadonlyMap<string, string>;
  /** The database to drop. Must be confirmed by the caller before we get here. */
  database: string;
  runCommand?: typeof defaultRunCommand | undefined;
  /** Postgres image used for the throwaway psql client. */
  image?: string | undefined;
}

export interface DatabaseDropResult {
  dropped: boolean;
  /** How many backends were terminated. Always reported, even when zero. */
  terminated: number;
  detail: string;
}

const DEFAULT_IMAGE = 'postgres:16-alpine';

/**
 * Runs one SQL statement through a throwaway psql container.
 *
 * `PGPASSWORD` is passed BY NAME, never in an argv: an argv is visible in
 * `ps` to every user on the host, and this one carries the database
 * superuser's password. The same discipline `checks/database.ts` already uses.
 *
 * `PGCONNECT_TIMEOUT` and, when `POSTGRES_SSL=true`, `PGSSLMODE=require` go the
 * same way: named in the argv, valued in the environment. Without the SSL mode
 * a managed PostgreSQL that requires TLS refuses the drop outright; without
 * the timeout an unreachable host holds the uninstall for the full minute.
 */
async function psql(
  options: DatabaseDropOptions,
  sql: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const run = options.runCommand ?? defaultRunCommand;
  const env = options.env;

  const host = env.get('POSTGRES_HOST');
  const user = env.get('POSTGRES_USER');
  const password = env.get('POSTGRES_PASSWORD');

  if (host === undefined || user === undefined || password === undefined) {
    throw new UsageError(
      'The deployment environment does not carry POSTGRES_HOST, POSTGRES_USER and POSTGRES_PASSWORD, so the database cannot be reached.',
    );
  }

  const ssl = env.get('POSTGRES_SSL') === 'true';

  const result = await run(
    [
      'docker',
      'run',
      '--rm',
      '--network',
      'host',
      // Each by NAME. The values follow in the env map below, never here.
      '--env',
      'PGPASSWORD',
      '--env',
      'PGCONNECT_TIMEOUT',
      ...(ssl ? ['--env', 'PGSSLMODE'] : []),
      options.image ?? DEFAULT_IMAGE,
      'psql',
      '--host',
      host,
      '--port',
      env.get('POSTGRES_PORT') ?? '5432',
      '--username',
      user,
      // The maintenance database: a database cannot be dropped from a session
      // connected to it.
      '--dbname',
      'postgres',
      '--no-password',
      '--tuples-only',
      '--command',
      sql,
    ],
    {
      cwd: process.cwd(),
      timeoutMs: 60_000,
      allowExitCodes: [0, 1, 2, 3],
      env: {
        ...process.env,
        PGPASSWORD: password,
        PGCONNECT_TIMEOUT: '5',
        ...(ssl ? { PGSSLMODE: 'require' } : {}),
      },
    },
  );

  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

/** Double-quoted, with embedded quotes doubled. Never interpolated raw. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export async function dropDatabase(
  options: DatabaseDropOptions,
): Promise<DatabaseDropResult> {
  const quoted = quoteIdentifier(options.database);

  // Plain DROP first. Most of the time nothing is connected -- the stack came
  // down a moment ago -- and terminating backends nobody asked about is a
  // side effect this does not need to have.
  const first = await psql(options, `DROP DATABASE ${quoted};`);
  if (first.exitCode === 0) {
    return { dropped: true, terminated: 0, detail: 'dropped; no sessions were connected' };
  }

  const blocked = first.stderr.includes(OBJECT_IN_USE) ||
    /is being accessed by other users/i.test(first.stderr);

  if (!blocked) {
    return {
      dropped: false,
      terminated: 0,
      detail: first.stderr.trim() || 'the drop failed for an unknown reason',
    };
  }

  // SCOPED to this database. `pg_terminate_backend` over every backend would
  // take down other applications sharing this PostgreSQL, which is exactly the
  // deployment model this CLI assumes.
  const terminate = await psql(
    options,
    `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = ${literal(options.database)} AND pid <> pg_backend_pid();`,
  );
  const terminated = Number.parseInt(terminate.stdout.trim(), 10);

  const second = await psql(options, `DROP DATABASE ${quoted};`);
  if (second.exitCode !== 0) {
    return {
      dropped: false,
      terminated: Number.isNaN(terminated) ? 0 : terminated,
      detail: second.stderr.trim() || 'the drop failed after terminating sessions',
    };
  }

  const count = Number.isNaN(terminated) ? 0 : terminated;
  return {
    dropped: true,
    terminated: count,
    // Always reported. An operator who was not told a session was killed
    // cannot know to go and ask whose it was.
    detail: `dropped after terminating ${String(count)} session(s)`,
  };
}

/** A single-quoted SQL string literal, with embedded quotes doubled. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
