import { isIP } from 'node:net';

import { z } from 'zod';

// =============================================================================
// The stored GreptimeDB connection — `system_settings.key = 'telemetry_connection'`
// (issue #558, epic #528)
// =============================================================================
//
// WHAT IS STORED, AND WHERE
// -----------------------------------------------------------------------------
//
//   system_settings row 'telemetry_connection'   custom:    host, pgPort, database,
//                                                           readerUser, adminUser
//                                                automatic: { host: null } only — the
//                                                           deployment supplies the rest (#570)
//   credentials (telemetry_greptime, reader)     the reader's password (custom host only)
//   credentials (telemetry_greptime, admin)      the admin's password  (custom host only)
//
// The two passwords live in the encrypted credential store and nowhere else;
// the row carries no field able to hold one (compile-time proof below).
//
// WHY A ROW OF ITS OWN, NOT A NAMESPACE INSIDE 'global'. The same reason the
// email settings have one (`email/email-settings.service.ts`): the generic
// `PUT/PATCH /api/system-settings` owns the 'global' row, and a key it does
// not model is either clobbered by it or carried forward with a "preserved
// unknown key" warning on every unrelated save. A separate row cannot be
// touched by that endpoint at all, keeps the connection out of
// `GET /api/system-settings`, and gives `If-Match` a version counter of its
// own, so saving an unrelated setting cannot make this form's save conflict.
// ABSENT ROW = NOTHING STORED, which is what selects the deployment default
// (see `TelemetryConnectionService`).
//
// WHAT IS DELIBERATELY NOT HERE: THE WRITER CREDENTIAL AND THE HTTP PORT.
// `GREPTIME_WRITER_*` and `GREPTIME_HTTP_PORT` are consumed only by the OTel
// collector (which writes telemetry over HTTP) and the GreptimeDB container
// (which provisions its users from them). The API never writes telemetry and
// never speaks HTTP to GreptimeDB, so it has no use for either — and storing
// an unused write-capable secret here would widen what a compromise of the
// API's database yields, for nothing. They stay environment-only.
// =============================================================================

/** The `system_settings.key` the stored connection lives under. */
export const TELEMETRY_CONNECTION_SETTINGS_KEY = 'telemetry_connection';

/**
 * The host GreptimeDB answers on in every supported deployment: the Docker
 * Compose service name `greptimedb`, on the API's network, in both
 * `infra/compose/telemetry.compose.yml` and `vps.telemetry.compose.yml` (and
 * `.env.example` ships `GREPTIME_HOST=greptimedb`). It is the last resort of
 * the DEPLOYMENT HOST (`GREPTIME_HOST` when set and non-blank, else this), which
 * a stored connection with an AUTOMATIC host (`host: null`, issue #562)
 * resolves to at refresh time, so it follows the deployment instead of freezing
 * a literal an operator never chose.
 */
export const TELEMETRY_DEFAULT_HOST = 'greptimedb';

/** GreptimeDB's Postgres-wire default port, and its default database. */
export const TELEMETRY_DEFAULT_PG_PORT = 4003;
export const TELEMETRY_DEFAULT_DATABASE = 'public';

/** The deployment host: `GREPTIME_HOST` when set and non-blank, else `TELEMETRY_DEFAULT_HOST`. */
export function telemetryDeploymentHost(environmentHost: string | null | undefined): string {
  return environmentHost?.trim() || TELEMETRY_DEFAULT_HOST;
}

/** Credential-store purpose (and cipher sub-key domain) of the two passwords. */
export const TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE = 'telemetry_greptime';

/** The two logins the API uses. Also the credential names inside the purpose. */
export const TELEMETRY_CONNECTION_ROLES = ['reader', 'admin'] as const;
export type TelemetryConnectionRole = (typeof TELEMETRY_CONNECTION_ROLES)[number];

/** Admin-UI labels written alongside each credential. Non-secret. */
export const TELEMETRY_GREPTIME_CREDENTIAL_LABELS: Record<TelemetryConnectionRole, string> = {
  reader: 'GreptimeDB read-only login (telemetry explorer, status)',
  admin: 'GreptimeDB admin login (telemetry retention)',
};

/**
 * A hostname (RFC 1123 labels, plus `_`, which Docker Compose service names
 * use) or a bare IPv4/IPv6 address. No scheme, no port, no path: the port is
 * its own field and `pg` wants a bare host.
 */
const HOSTNAME_PATTERN =
  /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*$/;

/**
 * The database name is held to a plain identifier because the retention job
 * interpolates it UNQUOTED into `ALTER DATABASE` (GreptimeDB resolves a quoted
 * name literally there) and refuses anything else — see `PLAIN_IDENTIFIER` in
 * `handlers/telemetry-retention.handler.ts`. Accepting more here would save a
 * connection whose retention can never be applied.
 */
export const TELEMETRY_DATABASE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const telemetryHostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((value) => isIP(value) !== 0 || HOSTNAME_PATTERN.test(value), {
    message: 'host must be a hostname or an IP address — no scheme, port or path',
  });

/**
 * A host as SUBMITTED on the admin form: absent, null or blank means AUTOMATIC
 * (output `null` — the deployment host, resolved at use); anything else is a
 * custom override validated by `telemetryHostSchema`.
 */
export const telemetryOptionalHostSchema = z
  .string()
  .nullish()
  .transform((value) => (value?.trim() ? value.trim() : null))
  .pipe(telemetryHostSchema.nullable());

export const telemetryPgPortSchema = z.number().int().min(1).max(65535);

export const telemetryDatabaseSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(TELEMETRY_DATABASE_PATTERN, {
    message: 'database must be a plain identifier (letters, digits and underscores, not starting with a digit)',
  });

export const telemetryUserSchema = z.string().trim().min(1).max(128);

/**
 * A stored CUSTOM connection: GreptimeDB at a host an administrator chose.
 * The row (plus the credential store's two passwords) is the connection,
 * wholly. Every row saved before #562 has this shape.
 */
export const telemetryCustomConnectionValueSchema = z.object({
  host: telemetryHostSchema,
  pgPort: telemetryPgPortSchema,
  database: telemetryDatabaseSchema,
  readerUser: telemetryUserSchema,
  /** Null: no admin login, so retention cannot be applied (reads still work). */
  adminUser: telemetryUserSchema.nullable(),
});

/**
 * A stored AUTOMATIC connection: "the GreptimeDB deployed with this
 * application" (issues #562, #570). A marker only — the deployment supplies
 * the host, port, database, logins and passwords, resolved at every refresh.
 * Rows saved between #562 and #570 also carry port/database/users; those are
 * stripped on parse and never used.
 */
export const telemetryAutomaticConnectionValueSchema = z.object({
  host: z.null(),
});

/** The stored row's `value`. Non-secret by construction. */
export const telemetryConnectionValueSchema = z.union([
  telemetryCustomConnectionValueSchema,
  telemetryAutomaticConnectionValueSchema,
]);

export type TelemetryCustomConnectionValue = z.infer<typeof telemetryCustomConnectionValueSchema>;
export type TelemetryAutomaticConnectionValue = z.infer<typeof telemetryAutomaticConnectionValueSchema>;
export type TelemetryConnectionValue = z.infer<typeof telemetryConnectionValueSchema>;

// -----------------------------------------------------------------------------
// Compile-time proof that the stored connection carries no secret
// -----------------------------------------------------------------------------
//
// Identical technique to `TELEMETRY_SETTINGS_CARRIES_NO_SECRET` in
// `common/schemas/settings.schema.ts`. Adding a `readerPassword` (or any name
// below) to `telemetryConnectionValueSchema` makes this resolve to `never` and
// the file stops compiling. The passwords belong in `CredentialsService`
// under `TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE`, never in a row whose value
// the audit trail copies.

type TelemetryConnectionSecretFieldNames =
  | 'password'
  | 'readerPassword'
  | 'adminPassword'
  | 'writerPassword'
  | 'secret'
  | 'secretKey'
  | 'apiKey'
  | 'key'
  | 'token'
  | 'connectionString'
  | 'url';

export type TelemetryConnectionCarriesNoSecret =
  Extract<
    keyof TelemetryCustomConnectionValue | keyof TelemetryAutomaticConnectionValue,
    TelemetryConnectionSecretFieldNames
  > extends never
    ? true
    : never;

export const TELEMETRY_CONNECTION_CARRIES_NO_SECRET: TelemetryConnectionCarriesNoSecret = true;
