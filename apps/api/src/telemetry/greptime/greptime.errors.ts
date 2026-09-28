// =============================================================================
// Typed failures of the GreptimeDB client (issue #534, epic #528)
// =============================================================================
//
// One base class so a caller (the status service here; the explorer's query
// service in #535; the assistant's tools in #536) can catch "anything the
// telemetry store did" in one clause and map the subclasses to its own
// response. NONE OF THESE MESSAGES CARRIES A CREDENTIAL: they are built from
// fixed text plus, for `TelemetryQueryFailedError`, the server's own error
// message, which GreptimeDB builds from the SQL it was given — never from the
// connection's password.
// =============================================================================

/** Base of every error `GreptimeClient` throws on purpose. */
export class TelemetryStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The connection this call needs is not configured — neither saved at
 * /admin/settings/telemetry nor supplied by the `GREPTIME_*` deployment
 * default, or the admin login missing for an admin call. Not a fault: a
 * deployment without a telemetry store is a supported state.
 */
export class TelemetryNotConfiguredError extends TelemetryStoreError {
  constructor(readonly role: 'reader' | 'admin') {
    super(
      role === 'admin'
        ? 'The GreptimeDB admin connection is not configured. Set the admin user and password at ' +
            '/admin/settings/telemetry (or GREPTIME_ADMIN_USER / GREPTIME_ADMIN_PASSWORD as the deployment default).'
        : 'GreptimeDB is not configured. Configure the connection at /admin/settings/telemetry ' +
            '(or GREPTIME_HOST / GREPTIME_READER_USER / GREPTIME_READER_PASSWORD as the deployment default).',
    );
  }
}

/**
 * The statement did not finish within `timeoutMs`. Enforced CLIENT-SIDE: the
 * read-only user cannot `SET statement_timeout`, and GreptimeDB ignores the
 * startup parameter (spike #529). The connection that ran it has already been
 * destroyed when this is thrown; the server may still be finishing the query.
 */
export class TelemetryQueryTimeoutError extends TelemetryStoreError {
  constructor(readonly timeoutMs: number) {
    super(`The telemetry query did not finish within ${timeoutMs} ms and was abandoned.`);
  }
}

/**
 * The SQL string produced more than one result set. The simple query
 * protocol runs every statement in a multi-statement string (spike #529), so
 * the client refuses to hand such a result back; the explorer's guard (#535)
 * should reject the text before it is ever sent.
 */
export class TelemetryMultiStatementError extends TelemetryStoreError {
  constructor() {
    super('Exactly one SQL statement may be executed per telemetry query.');
  }
}

/**
 * GreptimeDB (or the network) refused or failed the statement.
 *
 * `origin` tells the two apart: `server` is GreptimeDB answering with an
 * error (bad SQL, permission refused — the caller's statement is at fault and
 * the message is safe to show), `connection` is the store not answering at
 * all (refused/reset socket, failed authentication handshake).
 */
export class TelemetryQueryFailedError extends TelemetryStoreError {
  constructor(
    message: string,
    /** SQLSTATE when the server supplied one (or a Node error code for a socket failure). */
    readonly code?: string,
    readonly origin: 'server' | 'connection' = 'server',
  ) {
    super(message);
  }
}

/**
 * The caller's `AbortSignal` fired while the statement was in flight (the
 * assistant's client disconnected, issue #536). Like a timeout, the
 * connection that ran it has already been destroyed; the server may still be
 * finishing the query.
 */
export class TelemetryQueryAbortedError extends TelemetryStoreError {
  constructor() {
    super('The telemetry query was cancelled.');
  }
}
