import { PreconditionError, UsageError } from '../errors.js';
import {
  DATABASE_CHECKS,
  MAINTENANCE_DATABASE,
  canCreateDatabase,
  databaseSettings,
  runChecks,
  runPsql,
  type Check,
  type CheckContext,
  type CompletedCheck,
  type DatabaseSettings,
} from './checks/index.js';
import { consented, obtainConsent, type ConsentOptions } from './consent.js';
import type { runCommand } from './executor.js';

// =============================================================================
// Creating the application database when it does not exist  (issue #391)
// =============================================================================
//
// `database-exists` used to end an install with a `createdb` remedy, on a
// server that was reachable, whose credentials worked, and whose role often
// held CREATEDB -- so the install stopped to have a human type one command.
//
// THREE RULES, each pinned by a test:
//
//   1. ONLY THE ONE FAILURE. The database is created only when the server is
//      reachable, the credentials authenticate, and the ONLY problem is that
//      the named database does not exist (3D000). Anything else -- refused,
//      bad password, pg_hba -- is reported exactly as before; creating a
//      database is not a remedy for any of those.
//   2. NEVER SILENTLY. A typo in POSTGRES_DB is indistinguishable, from here,
//      from a database that simply does not exist yet; creating it silently
//      would migrate into a second, empty database and the operator's first
//      evidence would be an application with no data. So: a prompt, or
//      `--create-database` for a non-interactive run.
//   3. CREATE, NEVER DROP OR ALTER. The only statement this ever issues is
//      `CREATE DATABASE "<name>"`, against the `postgres` maintenance
//      database, with the password passed through PGPASSWORD (by name in the
//      argv, by value in the environment -- `runPsql`). The identifier is
//      validated against a conservative grammar and then double-quoted, so no
//      value from the `.env` can extend the statement.
//
// AND, SINCE #396, TWO MORE:
//
//   4. RE-VERIFIED, NOT ASSUMED. After the CREATE, the WHOLE database check
//      set runs again against the new database -- `database-privileges`
//      included -- so the operator sees a real answer where they used to see
//      `skipped: database-exists did not pass`, and a role that can create a
//      database but not a table stops HERE, with the GRANT, rather than in the
//      migration four minutes later.
//   5. ONE FUNCTION. `ensureDatabase` is THE "offer, create, re-verify"
//      behaviour. install's and update's `ensure-database` steps call it, and a
//      fork's own wizard must call it too, rather than stitching the pieces
//      back together -- the same argument `detectRenewalOwner` makes for
//      renewal: two copies of a gate are two gates, and they drift.
// =============================================================================

/**
 * The identifiers this will create. Deliberately narrower than PostgreSQL's
 * own grammar: no quotes, no spaces, nothing that needs thinking about. A name
 * outside it is refused rather than escaped -- create it by hand if you must.
 */
export const CREATABLE_DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** PostgreSQL truncates identifiers longer than this, silently. */
const MAX_IDENTIFIER_BYTES = 63;

/** Throws a UsageError unless `name` is safe to create. */
export function assertCreatableDatabaseName(name: string): void {
  if (!CREATABLE_DATABASE_NAME.test(name) || Buffer.byteLength(name) > MAX_IDENTIFIER_BYTES) {
    throw new UsageError(
      `POSTGRES_DB "${name}" is not a name this will create: it must match ` +
        `${CREATABLE_DATABASE_NAME.source} and be at most ${MAX_IDENTIFIER_BYTES} bytes. ` +
        'Create the database by hand, or choose a plainer name.',
    );
  }
}

/** The one statement ever issued. Validates, then quotes. */
export function createDatabaseStatement(name: string): string {
  assertCreatableDatabaseName(name);
  return `CREATE DATABASE "${name}"`;
}

/** True when `database-exists` failed because the database is absent (3D000). */
export function isMissingDatabase(result: Pick<CompletedCheck, 'id' | 'status' | 'detail'>): boolean {
  return (
    result.id === 'database-exists' &&
    result.status === 'fail' &&
    /does not exist/i.test(result.detail)
  );
}

/**
 * True when the ONLY required failure among database checks is a missing
 * database. That is the single case `ensure-database` may act on -- see rule 1.
 */
export function onlyDatabaseMissing(results: readonly CompletedCheck[]): boolean {
  const failed = results.filter((result) => result.status === 'fail' && result.severity === 'required');
  return failed.length === 1 && isMissingDatabase(failed[0] as CompletedCheck);
}

/** The checks that decide whether the database is usable, and nothing else. */
const EXISTENCE_CHECK_IDS = new Set(['database-reachable', 'database-credentials', 'database-exists']);

/** The existence subset of the registry: reachable, credentials, exists. */
export const DATABASE_EXISTENCE_CHECKS: readonly Check[] = DATABASE_CHECKS.filter((candidate) =>
  EXISTENCE_CHECK_IDS.has(candidate.id),
);

/**
 * Whether a re-verify result means the database just created is not usable.
 *
 * Every REQUIRED failure, and one more: `database-privileges` DEFINITELY
 * answering "cannot create in schema public" (#396). That check is only
 * `recommended` for doctor, because on an existing database an administrator
 * may have arranged privileges some other way -- but on a database this run
 * has just created, "cannot create tables" means the migration fails next, so
 * it stops here, with the GRANT as the remedy. "Could not determine" does not
 * stop anything; only a definite no does.
 */
export function blocksNewDatabase(result: CompletedCheck): boolean {
  if (result.status === 'fail' && result.severity === 'required') return true;
  return result.id === 'database-privileges' && result.status === 'warn' && /cannot create in schema/i.test(result.detail);
}

export interface EnsureDatabaseOptions extends Omit<ConsentOptions, 'flag'> {
  env: ReadonlyMap<string, string>;
  runCommand: typeof runCommand;
  /** `--create-database`: consent given in advance. */
  createDatabase?: boolean | undefined;
  /** Where to report, one line at a time. */
  onLine?: ((line: string) => void) | undefined;
  /**
   * The environment file POSTGRES_DB was read from, named in every refusal
   * (#396): "does not exist yet" and "a typo" look identical from here, so the
   * operator is told exactly which line to correct. Absent: "the environment
   * file".
   */
  envPath?: string | undefined;
  /**
   * The existence checks, replaceable in tests. Defaults to the real
   * reachable/credentials/exists subset of the registry.
   */
  check?: ((context: CheckContext) => Promise<CompletedCheck[]>) | undefined;
  /**
   * The re-verify after a CREATE (#396), replaceable in tests. Defaults to the
   * WHOLE database check set, `database-privileges` included.
   */
  verify?: ((context: CheckContext) => Promise<CompletedCheck[]>) | undefined;
}

export interface EnsureDatabaseResult {
  outcome: 'exists' | 'created';
  database: string;
  detail: string;
  /**
   * What was checked, for a caller that renders it (a fork's wizard): the
   * existence checks when the database was already there, the full re-verify
   * when it was just created.
   */
  checks: CompletedCheck[];
}

function checkContextFor(options: Pick<EnsureDatabaseOptions, 'env' | 'runCommand'>): CheckContext {
  return { runCommand: options.runCommand, deployRoot: '', bindPort: 0, proxyRoot: '', env: options.env };
}

/** "correct POSTGRES_DB in <file>" -- named, because a typo looks like absence. */
function correctionFor(settings: DatabaseSettings, envPath: string | undefined): string {
  return `If "${settings.database}" is not the name you meant, correct POSTGRES_DB in ${envPath ?? 'the environment file'}.`;
}

function remedyFor(settings: DatabaseSettings, envPath: string | undefined): string {
  const name = settings.database;
  return (
    `Create it by hand: CREATE DATABASE "${name}"; (or: createdb -h ${settings.host} -p ${settings.port} -U ${settings.user} ${name})\n` +
    `  ${correctionFor(settings, envPath)}`
  );
}

/**
 * Makes sure the configured database exists: when it is the ONLY thing
 * missing, offers to create it (a prompt, or `--create-database`), creates it,
 * and re-verifies it with the full database check set. Never drops or alters
 * anything.
 *
 * ⚠ THIS IS THE ONE IMPLEMENTATION (#396). install's and update's
 * `ensure-database` steps both call it, and a fork's own setup wizard MUST
 * call it too rather than reimplementing any part of "offer, create,
 * re-verify" -- the checks it runs, the consent rules and the refusal
 * messages are all here so that no two callers can disagree about them.
 * `result.checks` is what was verified, for a wizard to render.
 */
export async function ensureDatabase(options: EnsureDatabaseOptions): Promise<EnsureDatabaseResult> {
  const settings = databaseSettings(options.env);
  if (settings === undefined) {
    throw new UsageError('No environment to read the database settings from.');
  }

  const check =
    options.check ?? (async (context: CheckContext) => await runChecks(DATABASE_EXISTENCE_CHECKS, context));

  const results = await check(checkContextFor(options));
  for (const result of results) options.onLine?.(`${result.status} ${result.id}: ${result.detail}`);

  const failed = results.filter((result) => result.status === 'fail');
  if (failed.length === 0) {
    return {
      outcome: 'exists',
      database: settings.database,
      detail: `database "${settings.database}" exists`,
      checks: results,
    };
  }

  // Rule 1: anything but "absent" is reported, not acted on.
  if (!onlyDatabaseMissing(results)) {
    throw new PreconditionError(
      'The database is not usable with these settings:\n' +
        failed.map((result) => `  - ${result.detail}\n    ${result.remedy ?? ''}`).join('\n'),
    );
  }

  // Refused before anything else is asked: a name we would not create is not
  // worth a question.
  assertCreatableDatabaseName(settings.database);

  const capability = await canCreateDatabase(settings, options.runCommand);
  if (capability.canCreate === false) {
    throw new PreconditionError(
      `Database "${settings.database}" does not exist, and ${settings.user} is not allowed to create databases.\n` +
        `  Either have an administrator grant it: ALTER ROLE "${settings.user}" CREATEDB;\n` +
        `  or create it as a role that can: CREATE DATABASE "${settings.database}" OWNER "${settings.user}";`,
    );
  }
  if (capability.canCreate === undefined) {
    // Not a refusal: the CREATE below answers the question for certain.
    options.onLine?.(
      `could not tell whether ${settings.user} may create databases (${capability.error ?? 'unknown'}); will try`,
    );
  }

  const where = `${settings.host}:${settings.port}`;
  const consent = await obtainConsent(
    `Database "${settings.database}" does not exist on ${where}. Create it now as ${settings.user}?`,
    {
      flag: options.createDatabase,
      nonInteractive: options.nonInteractive,
      promptContext: options.promptContext,
      ask: options.ask,
    },
  );

  if (!consented(consent)) {
    throw new PreconditionError(
      (consent === 'declined'
        ? `Database "${settings.database}" (POSTGRES_DB) does not exist on ${where}, and creating it was declined.\n`
        : `Database "${settings.database}" (POSTGRES_DB) does not exist on ${where}. ` +
          'Nothing could be asked in this mode, so it was not created. Re-run with --create-database to create it.\n') +
        `  ${remedyFor(settings, options.envPath)}`,
    );
  }

  options.onLine?.(`Creating database "${settings.database}" on ${where}`);
  const created = await runPsql(
    options.runCommand,
    settings,
    MAINTENANCE_DATABASE,
    createDatabaseStatement(settings.database),
  );

  // 42P04 duplicate_database: something else created it between the check and
  // now. The goal -- it exists -- is met, so that is not a failure.
  if (!created.ok && !/42P04|already exists/i.test(created.stderr)) {
    throw new PreconditionError(
      `Could not create database "${settings.database}": ${firstLine(created.stderr)}\n  ${remedyFor(settings, options.envPath)}`,
    );
  }

  // Rule 4 (#396): re-verified, not assumed. The FULL set, so the checks that
  // were skipped behind `database-exists` -- privileges above all -- give a
  // real answer now, and a CREATE that "succeeded" against the wrong server is
  // caught here rather than by the migration.
  const verify = options.verify ?? (async (context: CheckContext) => await runChecks(DATABASE_CHECKS, context));
  const verified = await verify(checkContextFor(options));
  for (const result of verified) options.onLine?.(`${result.status} ${result.id}: ${result.detail}`);

  const blocking = verified.filter(blocksNewDatabase);
  if (blocking.length > 0) {
    throw new PreconditionError(
      `Created database "${settings.database}" on ${where}, but it is not usable yet:\n` +
        blocking.map((result) => `  - ${result.id}: ${result.detail}\n    ${result.remedy ?? ''}`).join('\n') +
        '\nNothing was dropped; fix the above, then re-run with --resume.',
    );
  }

  return {
    outcome: 'created',
    database: settings.database,
    detail: `created database "${settings.database}" on ${where}`,
    checks: verified,
  };
}

export interface UnattendedRefusalOptions {
  env: ReadonlyMap<string, string>;
  runCommand: typeof runCommand;
  envPath?: string | undefined;
  onLine?: ((line: string) => void) | undefined;
  /** The existence checks, replaceable in tests. */
  check?: ((context: CheckContext) => Promise<CompletedCheck[]>) | undefined;
}

/**
 * The refusal `ensureDatabase` WILL give later, found before anything is
 * cloned (#396) -- or undefined when there is none to give.
 *
 * For a run that cannot obtain consent (`--non-interactive` without
 * `--create-database`): the database settings are already known, the
 * database is missing, and nobody can be asked -- so the install is going to
 * stop at `ensure-database` no matter what, and stopping at preflight instead
 * spares the clone. Found by calling `ensureDatabase` itself with consent
 * forced UNAVAILABLE, so the message is the same one and the CREATE is
 * unreachable: no flag, no `ask`, `nonInteractive` -- it can only refuse.
 *
 * Any OTHER database problem (unreachable, bad password) answers undefined:
 * `validate-environment` owns those, with the settings the run actually
 * writes. This only ever pre-empts the one refusal that no later step could
 * turn into a success.
 */
export async function unattendedDatabaseRefusal(options: UnattendedRefusalOptions): Promise<Error | undefined> {
  const check =
    options.check ?? (async (context: CheckContext) => await runChecks(DATABASE_EXISTENCE_CHECKS, context));
  const results = await check(checkContextFor(options));
  for (const result of results) options.onLine?.(`${result.status} ${result.id}: ${result.detail}`);
  if (!onlyDatabaseMissing(results)) return undefined;

  try {
    await ensureDatabase({
      env: options.env,
      runCommand: options.runCommand,
      envPath: options.envPath,
      createDatabase: false,
      nonInteractive: true,
      check: async () => results,
    });
  } catch (error) {
    return error instanceof Error ? error : new PreconditionError(String(error));
  }
  return undefined;
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '') ?? 'failed';
}
