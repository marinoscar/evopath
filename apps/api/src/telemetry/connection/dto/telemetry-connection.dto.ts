import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  TELEMETRY_DEFAULT_DATABASE,
  TELEMETRY_DEFAULT_PG_PORT,
  telemetryDatabaseSchema,
  telemetryOptionalHostSchema,
  telemetryPgPortSchema,
  telemetryUserSchema,
} from '../telemetry-connection.schema';

// =============================================================================
// /api/admin/telemetry/connection — wire shapes (issue #558, epic #528)
// =============================================================================
//
// Passwords are WRITE-ONLY. They appear in the two request bodies and in no
// response: a response carries a masked `credentials.<login>` status built
// from `CredentialsService.describe`, which cannot decrypt anything — the same
// shape as storage's `secretStatus` and AI's `keyStatus`.
// =============================================================================

/** A password as submitted. Not trimmed: a secret is stored byte for byte. */
const passwordSchema = z.string().max(1024);

/**
 * `readerUser` — blank is "not sent" (an automatic host needs none; a custom
 * one is refused without it, below).
 */
const readerUserSchema = z
  .string()
  .trim()
  .max(128)
  .optional()
  .transform((value) => (value ? value : undefined));

/**
 * `adminUser` — null (or an empty string) means "no admin login", which
 * removes a stored admin password. Absent (undefined) is only accepted for an
 * automatic host; a custom one must say which (or null).
 */
const adminUserSchema = z
  .string()
  .trim()
  .max(128)
  .nullish()
  .transform((value) => (value === undefined ? undefined : value ? value : null));

/**
 * AUTOMATIC vs CUSTOM (issue #570). A blank host means the GreptimeDB deployed
 * with this application, whose port, database, logins and passwords the
 * deployment supplies: every other field is then accepted (older clients send
 * them) and IGNORED. A custom host needs `readerUser` and `adminUser` (or
 * null), exactly as before.
 */
function requireLoginsForCustomHost(
  value: { host: string | null; readerUser?: string; adminUser?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (value.host === null) return;

  if (!value.readerUser) {
    ctx.addIssue({ code: 'custom', path: ['readerUser'], message: 'readerUser is required for a custom host' });
  }

  if (value.adminUser === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['adminUser'],
      message: 'adminUser is required for a custom host (send null for no admin login)',
    });
  }
}

export const updateTelemetryConnectionSchema = z
  .object({
    /**
     * Hostname or IP address of GreptimeDB's Postgres-wire endpoint (no scheme,
     * port or path) — a CUSTOM GreptimeDB. Omit it, or send null or blank, for
     * AUTOMATIC: the GreptimeDB deployed with this application. Automatic is
     * stored as a marker only; its host, port, database, logins and passwords
     * all come from the deployment, and every other field of this body is
     * ignored.
     */
    host: telemetryOptionalHostSchema,
    /** Custom host only (ignored when automatic). GreptimeDB's Postgres-wire port. Omitted: 4003. */
    pgPort: telemetryPgPortSchema.default(TELEMETRY_DEFAULT_PG_PORT),
    /** Custom host only (ignored when automatic). A plain identifier. Omitted: `public`. */
    database: telemetryDatabaseSchema.default(TELEMETRY_DEFAULT_DATABASE),
    /** Custom host only, and required there: the read-only GreptimeDB user. Ignored when automatic. */
    readerUser: readerUserSchema,
    /**
     * Custom host only. Write-only. Omit or send empty to KEEP the stored
     * reader password; a save with none stored and none sent is a 400.
     * Ignored when automatic.
     */
    readerPassword: passwordSchema.optional(),
    /**
     * Custom host only, and required there: the DDL-capable user retention
     * needs, or null for none (retention is then not applied). Ignored when
     * automatic.
     */
    adminUser: adminUserSchema,
    /**
     * Custom host only. Write-only. Omit or send empty to KEEP the stored
     * admin password. Ignored when `adminUser` is null (the stored one is then
     * deleted) and when automatic.
     */
    adminPassword: passwordSchema.optional(),
  })
  .superRefine(requireLoginsForCustomHost);

export class UpdateTelemetryConnectionDto extends createZodDto(updateTelemetryConnectionSchema) {}
export type UpdateTelemetryConnectionInput = z.output<typeof updateTelemetryConnectionSchema>;

/**
 * `POST …/connection/test` — a CANDIDATE connection, not necessarily saved.
 * A blank/absent host is AUTOMATIC: the GreptimeDB deployed with this
 * application, probed with the deployment's own host, port, database, logins
 * and passwords — every other submitted field is ignored (issue #570). For a
 * custom host, a blank password means "the password the connection in force
 * uses for that login".
 */
export const testTelemetryConnectionSchema = updateTelemetryConnectionSchema;

export class TestTelemetryConnectionDto extends createZodDto(testTelemetryConnectionSchema) {}
export type TestTelemetryConnectionInput = z.output<typeof testTelemetryConnectionSchema>;

/** Masked, non-secret facts about one stored password. Mirrors storage's `secretStatus`. */
export const telemetryCredentialStatusSchema = z.object({
  /**
   * Whether a password is present for this login in the connection's source
   * (the deployment's while `deploymentManaged`, the credential store's for a
   * custom host).
   */
  configured: z.boolean(),
  /**
   * The credential store's mask (`••••Xk9q`) so an admin can tell two
   * passwords apart. Never the password. Always null for the deployment
   * default: the environment's value is not the store's to describe.
   */
  hint: z.string().nullable(),
  updatedAt: z.iso.datetime().nullable(),
  updatedByUserId: z.string().nullable(),
});

export const TELEMETRY_CONNECTION_SOURCES = ['stored', 'environment', 'none'] as const;

/** The GreptimeDB deployed with this application, as the deployment describes it. Non-secret. */
export const telemetryDeploymentConnectionSchema = z.object({
  /** The deployment host an automatic connection uses. */
  host: z.string(),
  pgPort: z.number().int(),
  database: z.string(),
  /** Empty when the deployment provisions no reader login. */
  readerUser: z.string(),
  adminUser: z.string().nullable(),
  /** The deployment provides a reader user and its password. Never the password itself. */
  readerConfigured: z.boolean(),
  /** The deployment provides an admin user and its password. Never the password itself. */
  adminConfigured: z.boolean(),
});

export const telemetryConnectionResponseSchema = z.object({
  /**
   * Where the connection in force comes from: `stored` (saved on this page —
   * a custom host, or the automatic marker), `environment` (nothing saved:
   * the deployment's own GreptimeDB) or `none`.
   */
  source: z.enum(TELEMETRY_CONNECTION_SOURCES),
  /**
   * The host as CONFIGURED: null when it is automatic (a stored automatic
   * connection, `source` `environment` or `source` `none`); a literal only for
   * a stored custom host.
   */
  host: z.string().nullable(),
  /**
   * The host actually used (or, for `source` `none`, the one an automatic
   * host would use: the deployment host). Empty only for a stored connection
   * that does not validate.
   */
  effectiveHost: z.string(),
  /** `auto` — `host` is null and `effectiveHost` is the deployment host; `custom` — a literal. */
  hostMode: z.enum(['auto', 'custom']),
  /**
   * True when the whole connection (port, database, logins, passwords) comes
   * from the deployment and nothing but the host mode is the administrator's
   * to set: `source` `environment`, or a stored automatic host. The form
   * then collects no credentials.
   */
  deploymentManaged: z.boolean(),
  /**
   * The GreptimeDB deployed with this application — what an automatic host
   * uses (and what `pgPort`/`database`/users show while `deploymentManaged`).
   * Present whatever is in force, so a form switching back to automatic can
   * say what it will get.
   */
  deployment: telemetryDeploymentConnectionSchema,
  /**
   * Why a deployment-managed connection cannot be used, in administrator
   * language (for example, the deployment provisions no reader login), or
   * null. Always null for a custom host: its problems are a test's to find.
   */
  problem: z.string().nullable(),
  pgPort: z.number().int(),
  database: z.string(),
  /** Empty when `source` is `none`. */
  readerUser: z.string(),
  adminUser: z.string().nullable(),
  /** A host, a reader login and its password: telemetry can be read. */
  configured: z.boolean(),
  /** The admin login is usable as well, so retention can be applied. */
  adminConfigured: z.boolean(),
  credentials: z.object({
    reader: telemetryCredentialStatusSchema,
    admin: telemetryCredentialStatusSchema,
  }),
  /** The stored connection's version — send it back as `If-Match`. `0` when nothing is stored. */
  version: z.number().int(),
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.object({ id: z.string(), email: z.string() }).nullable(),
});

export class TelemetryConnectionResponseDto extends createZodDto(telemetryConnectionResponseSchema) {}
export type TelemetryConnectionResponse = z.infer<typeof telemetryConnectionResponseSchema>;

export const telemetryConnectionProbeSchema = z.object({
  success: z.boolean(),
  /** Wall-clock time of the connect + statement, in milliseconds. */
  latencyMs: z.number().int(),
  /** `SELECT version()` — reader check only. */
  version: z.string().optional(),
  /** The driver's or server's message. Never a password or connection string. */
  error: z.string().optional(),
});

export const telemetryConnectionSkippedSchema = z.object({
  /** No admin user in the candidate, so the admin login was not checked. */
  skipped: z.literal(true),
});

export const telemetryConnectionTestResultSchema = z.object({
  /** The host actually probed — the deployment host when the request left `host` blank. */
  host: z.string(),
  /**
   * `auto` — the request left `host` blank, so the deployment's own GreptimeDB
   * was probed with the deployment's logins (submitted credentials ignored);
   * `custom` — the submitted host and credentials.
   */
  hostMode: z.enum(['auto', 'custom']),
  /** `SELECT version()` as the reader. */
  reader: telemetryConnectionProbeSchema,
  /** `SHOW CREATE DATABASE <database>` as the admin, or skipped. */
  admin: z.union([telemetryConnectionProbeSchema, telemetryConnectionSkippedSchema]),
});

export class TelemetryConnectionTestResultDto extends createZodDto(telemetryConnectionTestResultSchema) {}
export type TelemetryConnectionProbe = z.infer<typeof telemetryConnectionProbeSchema>;
export type TelemetryConnectionTestResult = z.infer<typeof telemetryConnectionTestResultSchema>;
