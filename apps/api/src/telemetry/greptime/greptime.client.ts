import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, types as pgTypes, type PoolClient, type PoolConfig, type QueryArrayResult } from 'pg';

import {
  TelemetryConnectionService,
  type GreptimeEnvironmentConfig,
} from '../connection/telemetry-connection.service';
import type { TelemetryConnectionRole } from '../connection/telemetry-connection.schema';

import {
  TelemetryMultiStatementError,
  TelemetryNotConfiguredError,
  TelemetryQueryFailedError,
  TelemetryQueryTimeoutError,
  TelemetryQueryAbortedError,
} from './greptime.errors';
import { checkHostResolves, hostNotFoundMessage, isDnsError, type HostCheckOptions } from './greptime-host';

// =============================================================================
// GreptimeClient — the API's only connection to the telemetry store
// (issue #534, epic #528)
// =============================================================================
//
// GreptimeDB speaks the PostgreSQL wire protocol (port 4003 by default), so
// this is `pg` — the driver the API already ships — pointed at it. Two
// lazily-created pools, one per login:
//
//   reader  a GreptimeDB `readonly` user. SELECT, SHOW, DESCRIBE,
//           information_schema. Everything user-driven (the status page here;
//           the explorer #535 and the assistant #536) runs on it.
//   admin   used for exactly the statements the reader is refused:
//           `ALTER DATABASE … SET 'ttl'` (retention) and `SHOW CREATE
//           DATABASE`. A route never runs caller-supplied SQL on it.
//
// WHERE THE CONNECTION COMES FROM (#558): `TelemetryConnectionService`, the one
// resolver — the connection an administrator saved at
// /admin/settings/telemetry, else the `GREPTIME_*` deployment default. It can
// change while the process runs, so each pool is keyed by a FINGERPRINT of the
// connection it was built from (source, host, port, database, user, and the
// password's version). When `run()` finds the fingerprint moved, the old pool
// is ended in the background and a new one is built on demand with the
// password read fresh from the credential store. A save therefore takes
// effect on every instance within one refresh interval, with no restart.
//
// WHAT THE SPIKE (#529) FOUND, AND WHAT THIS FILE DOES ABOUT IT
// -----------------------------------------------------------------------------
//
//   - NO BIND PARAMETERS. `$1` fails with "Placeholder '$1' was not provided a
//     value". So `query*` take a finished SQL string and nothing else; a
//     caller that interpolates a value quotes it itself (`quoteIdent` /
//     `quoteLiteral` below) and validates it first.
//   - NO SERVER-SIDE TIMEOUT. The read-only user cannot `SET
//     statement_timeout` and the startup parameter is ignored, so every call
//     takes a `timeoutMs` and enforces it HERE: the statement runs on a
//     dedicated pooled client, and on timeout that client is DESTROYED
//     (`release(true)`) rather than returned — a socket with a query still in
//     flight must never be handed to the next caller — and a typed
//     `TelemetryQueryTimeoutError` is thrown.
//   - MULTI-STATEMENT STRINGS RUN EVERY STATEMENT. A result that comes back as
//     an array of result sets is refused with `TelemetryMultiStatementError`
//     (after the fact — rejecting the text up front is the explorer's guard).
//   - int8 AND numeric ARRIVE AS STRINGS, and stay strings (UInt64 shows up as
//     numeric; a JS number would lose precision). Timestamp types are kept as
//     the server's text too, because GreptimeDB's nanosecond timestamps do not
//     survive a round trip through `Date`. See `greptimeTypeParser`.
//
// Rows come back in ARRAY mode, positionally matching `fields`: telemetry SQL
// routinely selects two columns with the same name (`a.trace_id`,
// `b.trace_id`), which object rows would silently collapse. `rowsAsObjects`
// is there for the callers (like the status service) that know their column
// names are unique.
//
// A HOST THAT DOES NOT EXIST IS SAID SO (issue #564). A failed connect whose
// error is a DNS one reports the host could not be resolved. One that merely
// TIMED OUT is followed by a single, longer lookup of the host (Docker's DNS
// answers EAI_AGAIN only after ~5 s, just past the connect timeout), so "no
// such host" is not disguised as "timeout expired". The success path never
// pays for a lookup.
//
// ⚠ NEVER LOG A CREDENTIAL. Nothing here logs the pool configuration, and
// every error this file raises is built from fixed text or the server's own
// error message.
// =============================================================================

/** A column of a result, as the wire protocol describes it. */
export interface TelemetryField {
  name: string;
  /** PostgreSQL type OID (1043 varchar, 20 int8, 1700 numeric, 1114/1184 timestamp, …). */
  dataTypeID: number;
}

/** One statement's result. `rows[i][j]` is the value of `fields[j]`. */
export interface TelemetryQueryResult {
  fields: TelemetryField[];
  rows: unknown[][];
}

export interface TelemetryQueryOptions {
  /** Hard client-side ceiling on the statement's wall-clock time. */
  timeoutMs: number;
  /**
   * Abandons the statement (destroying its connection, exactly as a timeout
   * does) when aborted — `TelemetryQueryAbortedError`. Issue #536: a closed
   * assistant stream stops its in-flight query.
   */
  signal?: AbortSignal;
}

export interface TelemetryPingResult {
  reachable: boolean;
  /** `SELECT version()` — e.g. `PostgreSQL 16.3 GreptimeDB 1.2.1`. */
  version?: string;
  error?: string;
}

/** The `greptime` block of `config/configuration.ts` — the deployment default. */
export type GreptimeConfig = GreptimeEnvironmentConfig;

/** The subset of `pg.Pool` this class uses — what a test substitutes. */
export interface GreptimePool {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

type Role = TelemetryConnectionRole;

interface KeyedPool {
  pool: GreptimePool;
  fingerprint: string;
  /** The host the pool connects to — named when a connect fails (#564). */
  host: string;
  /** `host` is the automatic deployment host — changes what a DNS failure says. */
  automaticHost: boolean;
}

/** Pool sizes. Small on purpose: telemetry reads are admin-only and rare. */
export const GREPTIME_READER_POOL_MAX = 4;
export const GREPTIME_ADMIN_POOL_MAX = 1;

/** How long to wait for a TCP connection + authentication before giving up. */
export const GREPTIME_CONNECT_TIMEOUT_MS = 5_000;

/** Timeout for `ping()`. */
export const GREPTIME_PING_TIMEOUT_MS = 5_000;

/** Type OIDs whose text form is kept verbatim instead of parsed by `pg`. */
const KEEP_AS_TEXT_OIDS = new Set<number>([
  20, // int8 — beyond Number.MAX_SAFE_INTEGER in practice (durations in ns)
  1700, // numeric — how UInt64 columns arrive
  1082, // date
  1083, // time
  1114, // timestamp
  1184, // timestamptz
  1266, // timetz
]);

/**
 * Per-pool type parser: the types above come back as the server's text,
 * everything else as `pg` would parse it (booleans, int2/int4, floats, json).
 */
export function greptimeTypeParser(oid: number, format?: 'text' | 'binary'): (value: string) => unknown {
  if (KEEP_AS_TEXT_OIDS.has(oid)) {
    return (value: string) => value;
  }

  return pgTypes.getTypeParser(oid, format ?? 'text') as (value: string) => unknown;
}

/**
 * Double-quotes an SQL identifier. Only for a value that was already
 * validated (from configuration, or checked against `information_schema`) —
 * quoting makes an identifier unambiguous, it does not make an arbitrary
 * string safe to accept.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Single-quotes an SQL string literal. Same caveat as `quoteIdent`. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** `rows` as objects keyed by field name. Only when the names are unique. */
export function rowsAsObjects(result: TelemetryQueryResult): Record<string, unknown>[] {
  return result.rows.map((row) =>
    Object.fromEntries(result.fields.map((field, index) => [field.name, row[index]])),
  );
}

@Injectable()
export class GreptimeClient implements OnModuleDestroy {
  private readonly logger = new Logger(GreptimeClient.name);
  private readonly pools: Partial<Record<Role, KeyedPool>> = {};
  /** A pool being built (its password is being read), so concurrent calls share it. */
  private readonly building: Partial<Record<Role, Promise<KeyedPool>>> = {};

  constructor(private readonly connection: TelemetryConnectionService) {}

  /** Whether the reader connection is configured (admin UI or deployment default). */
  isConfigured(): boolean {
    return this.connection.isConfigured();
  }

  /**
   * Why the reader connection cannot be used, in administrator language, or
   * null — set only for the GreptimeDB deployed with this application, when
   * the deployment provisions no reader login (issue #570).
   */
  configurationProblem(): string | null {
    return this.connection.configurationProblem('reader');
  }

  /** Whether the admin connection is configured as well (retention, `SHOW CREATE DATABASE`). */
  isAdminConfigured(): boolean {
    return this.connection.isAdminConfigured();
  }

  /** The GreptimeDB database telemetry is written to (default `public`). */
  get database(): string {
    return this.connection.database;
  }

  /**
   * Runs one statement as the read-only user. The SQL is sent as-is: see the
   * header for why there are no parameters.
   */
  async queryReader(sql: string, options: TelemetryQueryOptions): Promise<TelemetryQueryResult> {
    return this.run('reader', sql, options);
  }

  /**
   * Runs one statement as the admin user. NEVER with caller-supplied SQL: this
   * connection can alter retention and drop data.
   */
  async queryAdmin(sql: string, options: TelemetryQueryOptions): Promise<TelemetryQueryResult> {
    return this.run('admin', sql, options);
  }

  /** Reachability probe over the reader connection. Never throws. */
  async ping(): Promise<TelemetryPingResult> {
    if (!this.isConfigured()) {
      return { reachable: false, error: this.configurationProblem() ?? new TelemetryNotConfiguredError('reader').message };
    }

    try {
      const result = await this.queryReader('SELECT version()', { timeoutMs: GREPTIME_PING_TIMEOUT_MS });
      const version = result.rows[0]?.[0];

      return { reachable: true, ...(typeof version === 'string' ? { version } : {}) };
    } catch (error) {
      return { reachable: false, error: describeError(error) };
    }
  }

  async onModuleDestroy(): Promise<void> {
    const pools = Object.values(this.pools).map((entry) => entry.pool);

    for (const role of Object.keys(this.pools) as Role[]) {
      delete this.pools[role];
    }

    await Promise.all(
      pools.map((pool) =>
        pool.end().catch((error: unknown) => {
          this.logger.warn(`Closing a GreptimeDB pool failed: ${describeError(error)}`);
        }),
      ),
    );
  }

  /** Builds a pool. A seam for tests; production code never overrides it. */
  protected createPool(config: PoolConfig): GreptimePool {
    return new Pool(config);
  }

  /**
   * `null` when `host` resolves (or the check is inconclusive), else why it
   * does not. Only consulted after a connect TIMED OUT. A seam for tests;
   * production code never overrides it.
   */
  protected resolveHost(host: string, options: HostCheckOptions): Promise<string | null> {
    return checkHostResolves(host, undefined, undefined, options);
  }

  // ---------------------------------------------------------------------------

  private async run(
    role: Role,
    sql: string,
    { timeoutMs, signal }: TelemetryQueryOptions,
  ): Promise<TelemetryQueryResult> {
    if (signal?.aborted) throw new TelemetryQueryAbortedError();

    const keyed = await this.pool(role);
    const client = await this.connect(keyed);

    if (signal?.aborted) {
      client.release();
      throw new TelemetryQueryAbortedError();
    }

    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let onAbort: (() => void) | undefined;

    const query = client.query({ text: sql, rowMode: 'array' }) as unknown as Promise<
      QueryArrayResult | QueryArrayResult[]
    >;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new TelemetryQueryTimeoutError(timeoutMs));
      }, timeoutMs);
      timer.unref?.();
    });

    // Abandoned like a timeout: `timedOut` routes it to the destroy branch.
    const aborted = new Promise<never>((_, reject) => {
      if (!signal) return;
      onAbort = () => {
        timedOut = true;
        reject(new TelemetryQueryAbortedError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      const result = await Promise.race([query, timeout, aborted]);

      client.release();

      if (Array.isArray(result)) {
        throw new TelemetryMultiStatementError();
      }

      return {
        fields: result.fields.map((field) => ({ name: field.name, dataTypeID: field.dataTypeID })),
        rows: result.rows,
      };
    } catch (error) {
      if (timedOut) {
        // The query is still in flight on this socket: destroy it, and make
        // sure its eventual rejection (the socket closing under it) is not an
        // unhandled one.
        query.catch(() => undefined);
        client.release(true);
        throw error;
      }

      if (error instanceof TelemetryMultiStatementError) {
        throw error;
      }

      // A server-side error (it has a `severity`) leaves the connection
      // usable; anything else (a reset socket) does not.
      const fromServer = isServerError(error);
      client.release(fromServer ? undefined : true);

      throw new TelemetryQueryFailedError(
        describeError(error),
        sqlState(error),
        fromServer ? 'server' : 'connection',
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  private async connect(target: KeyedPool): Promise<PoolClient> {
    try {
      return await target.pool.connect();
    } catch (error) {
      throw new TelemetryQueryFailedError(
        `Could not connect to GreptimeDB: ${await this.connectFailureReason(target, error)}`,
        sqlState(error),
        'connection',
      );
    }
  }

  /**
   * Why a connect failed. A DNS error names the host; a timeout may be a DNS
   * failure that lost the race, so the host is looked up once more under a
   * longer ceiling before "timeout" is believed (#564). Never throws.
   */
  private async connectFailureReason({ host, automaticHost }: KeyedPool, error: unknown): Promise<string> {
    const options = { automatic: automaticHost };

    if (isDnsError(error)) return hostNotFoundMessage(host, error, options);

    if (isConnectTimeout(error)) {
      const notFound = await this.resolveHost(host, options).catch(() => null);
      if (notFound) return notFound;
    }

    return describeError(error);
  }

  /**
   * The pool for this login, for the connection in force NOW. Rebuilt when
   * the connection's fingerprint moved since the pool was made (an admin save,
   * a credential rotation, a reset to the deployment default).
   */
  private async pool(role: Role): Promise<KeyedPool> {
    const fingerprint = this.connection.fingerprint(role);

    if (!fingerprint) {
      // No longer configured: drop a pool left over from when it was.
      this.retire(role);
      throw new TelemetryNotConfiguredError(role);
    }

    const existing = this.pools[role];
    if (existing && existing.fingerprint === fingerprint) return existing;

    const inFlight = this.building[role];
    if (inFlight) return inFlight;

    const building = this.build(role).finally(() => {
      delete this.building[role];
    });
    this.building[role] = building;

    return building;
  }

  private async build(role: Role): Promise<KeyedPool> {
    let credentials: Awaited<ReturnType<TelemetryConnectionService['resolveCredentials']>>;

    try {
      credentials = await this.connection.resolveCredentials(role);
    } catch (error) {
      // A credential-store read failed (database down, or a password that no
      // longer decrypts). The message never carries the secret.
      throw new TelemetryQueryFailedError(
        `Could not read the GreptimeDB ${role} credential: ${describeError(error)}`,
        undefined,
        'connection',
      );
    }

    if (!credentials) {
      throw new TelemetryNotConfiguredError(role);
    }

    const pool = this.createPool({
      host: credentials.host,
      port: credentials.port,
      database: credentials.database,
      user: credentials.user,
      password: credentials.password,
      max: role === 'reader' ? GREPTIME_READER_POOL_MAX : GREPTIME_ADMIN_POOL_MAX,
      application_name: `api-telemetry-${role}`,
      connectionTimeoutMillis: GREPTIME_CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: true,
      types: { getTypeParser: greptimeTypeParser } as PoolConfig['types'],
    });

    // An idle client's socket dying emits `error` on the pool; unhandled, that
    // is an uncaught exception that would take the API down with it.
    pool.on('error', (error) => {
      this.logger.warn(`GreptimeDB ${role} connection error: ${describeError(error)}`);
    });

    const replaced = this.pools[role];
    const keyed: KeyedPool = {
      pool,
      fingerprint: credentials.fingerprint,
      host: credentials.host,
      automaticHost: credentials.automaticHost,
    };
    this.pools[role] = keyed;

    if (replaced) {
      this.logger.log(`GreptimeDB ${role} connection changed; replacing its pool`);
      this.endInBackground(role, replaced.pool);
    }

    return keyed;
  }

  /** Forget this login's pool and close it in the background. */
  private retire(role: Role): void {
    const existing = this.pools[role];
    if (!existing) return;

    delete this.pools[role];
    this.endInBackground(role, existing.pool);
  }

  /**
   * `end()` waits for checked-out clients to be released, so it is never
   * awaited on the query path: in-flight statements on the old pool finish
   * (or time out) on their own, and nothing new is handed out from it.
   */
  private endInBackground(role: Role, pool: GreptimePool): void {
    void pool.end().catch((error: unknown) => {
      this.logger.warn(`Closing a stale GreptimeDB ${role} pool failed: ${describeError(error)}`);
    });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** pg's connect-timeout errors ("timeout expired", "… due to connection timeout"). */
function isConnectTimeout(error: unknown): boolean {
  return /timeout/i.test(describeError(error));
}

function isServerError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'severity' in error;
}

function sqlState(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

  return typeof code === 'string' ? code : undefined;
}
