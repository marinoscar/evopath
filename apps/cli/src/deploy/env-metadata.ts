import { randomBytes } from 'node:crypto';

// =============================================================================
// The handful of keys that need more than their template default
// =============================================================================
// (issue #174, epic #168)
//
// env-spec.ts gets the QUESTION out of .env.example. This gets the GOOD
// question, for the minority of keys where the difference matters: mask it,
// generate it, validate it, compute it, or never ask at all.
//
// THIS REGISTRY IS DELIBERATELY SMALL AND DELIBERATELY NOT EXHAUSTIVE. A key
// with no entry still works - not secret, not essential, template default,
// help text from the parsed comments. That fallback IS the template-safety
// property: a fork that adds SENTRY_DSN gets a usable prompt without touching
// this file. Adding an entry per variable would quietly undo that, because the
// next fork's variables would be the ones without entries.
// =============================================================================

/**
 * Feature groups. Their keys are skipped unless the group is enabled.
 * `observability` is ALWAYS enabled on a VPS (#567): see `effectiveGroups` in
 * compose-files.ts. The others are opt-in.
 */
export type EnvGroup = 'observability' | 'email' | 'microsoft-oauth';

/**
 * How a generated value is made.
 *
 * - `base64-32`: 32 random bytes, standard base64 (AES-256 keys, JWT secrets).
 * - `hex-32`: 32 random bytes, lowercase hex. For values embedded in a syntax
 *   that reserves base64's own characters: GreptimeDB's
 *   `static_user_provider:cmd:user=password,user2=password2` splits on `,`,
 *   `=` and `:`, and base64 carries `=` padding (and `+`, `/`).
 */
export type GenerateKind = 'base64-32' | 'hex-32';

export interface DeriveContext {
  /** The public hostname the deployment is being published under. */
  domain: string;
  /** Answers collected so far, in prompt order. */
  answers: ReadonlyMap<string, string>;
}

export interface EnvVarMetadata {
  /** Never echoed, never logged, never rendered into a frame. */
  secret?: boolean;
  /** Asked even when the template supplies a default. */
  essential?: boolean;
  /** Offer to generate a value rather than make someone invent one. */
  generate?: GenerateKind;
  /**
   * Generate the value WITHOUT ASKING, interactive or not, whenever it is
   * blank or still a template placeholder (`isPlaceholderValue`). A real value
   * is never replaced. Requires `generate`.
   *
   * For credentials nobody needs to know, only the stack itself (#567): the
   * GreptimeDB passwords are read back by the API from the same `.env`, so
   * asking an operator to invent them is friction and a reused password.
   */
  autoGenerate?: boolean;
  /** Returns a message when the value is unusable, undefined when it is fine. */
  validate?: (value: string) => string | undefined;
  /** Computed from the domain and earlier answers; never prompted for. */
  derive?: (context: DeriveContext) => string | undefined;
  /** Forced for a VPS deployment. Not offered, not overridable by a prompt. */
  fixed?: string;
  /** Only asked when the operator opted into this group. */
  group?: EnvGroup;
  /** Never written at all, whatever the template says. */
  never?: boolean;
  /**
   * An EMPTY value is an acceptable answer for this key.
   *
   * Nothing in ENV_METADATA below sets it, and the VPS path is unchanged by
   * its existence: a deployment that cannot reach its own OAuth provider is
   * not a deployment. It exists for the LOCAL profile in `init/` (issue #344),
   * where `GOOGLE_CLIENT_ID` may legitimately be filled in later - the clone
   * is being set up, not served - and an unattended run must produce a file
   * rather than an error listing the credentials nobody has yet.
   *
   * Blank SKIPS validation; a value that is present must still validate. That
   * asymmetry is the whole point: "not configured yet" and "configured wrong"
   * are different states and only the first one is allowed through.
   */
  allowBlank?: boolean;
}

/** 32 bytes from the CSPRNG. Never Math.random, and never a shelled-out openssl:
 * the CLI cannot assume what is installed, and this must behave identically on
 * a minimal container. */
export function generateBase64Key(): string {
  return randomBytes(32).toString('base64');
}

/** 32 bytes from the CSPRNG as 64 lowercase hex characters: `[0-9a-f]` only. */
export function generateHexKey(): string {
  return randomBytes(32).toString('hex');
}

export function generateValue(kind: GenerateKind): string {
  return kind === 'hex-32' ? generateHexKey() : generateBase64Key();
}

/**
 * True when a value is still a template placeholder rather than something
 * anybody chose: the template's own default for the key, or the `change-me` /
 * `your-` spellings `.env.example` uses for credentials.
 */
export function isPlaceholderValue(value: string, templateDefault?: string): boolean {
  if (templateDefault !== undefined && templateDefault !== '' && value === templateDefault) {
    return true;
  }
  return /^change-me|^your-/i.test(value);
}

/** Whether an `autoGenerate` key's current value must be replaced. */
export function needsAutoGenerate(current: string | undefined, templateDefault?: string): boolean {
  return current === undefined || current === '' || isPlaceholderValue(current, templateDefault);
}

function requireMinLength(minimum: number) {
  return (value: string): string | undefined =>
    value.length >= minimum
      ? undefined
      : `must be at least ${minimum} characters (got ${value.length})`;
}

/** Rejects a value that is present but still the template's placeholder. */
function rejectPlaceholder(value: string): string | undefined {
  return /^your-|^change-me|example\.com$/i.test(value)
    ? 'still looks like the placeholder from .env.example'
    : undefined;
}

function combine(
  ...validators: ReadonlyArray<(value: string) => string | undefined>
) {
  return (value: string): string | undefined => {
    for (const validate of validators) {
      const message = validate(value);
      if (message !== undefined) return message;
    }
    return undefined;
  };
}

/**
 * AES-256 needs exactly 32 bytes. A key that merely LOOKS like base64 passes
 * startup and then fails the first time a credential is saved, which is a long
 * way from where the mistake was made.
 */
export function validateBase64Key32(value: string): string | undefined {
  // Empty is allowed: the API boots without this key and only refuses to SAVE
  // a credential, so an unattended install must be able to write a .env that
  // leaves it blank. It is required in practice for file uploads (#377).
  if (value === '') return undefined;

  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch {
    return 'must be base64';
  }
  // Buffer.from is lenient, so round-trip to catch input that is not base64 at
  // all rather than silently accepting a truncated decode.
  if (decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    return 'must be valid base64 (generate with: openssl rand -base64 32)';
  }
  if (decoded.length !== 32) {
    return `must decode to exactly 32 bytes for AES-256 (got ${decoded.length})`;
  }
  return undefined;
}

export function validateEmail(value: string): string | undefined {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    ? undefined
    : 'must be an email address';
}

export function validatePort(value: string): string | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536
    ? undefined
    : 'must be a port number between 1 and 65535';
}

export const ENV_METADATA: Readonly<Record<string, EnvVarMetadata>> = {
  // --- Application ---------------------------------------------------------
  NODE_ENV: { fixed: 'production' },
  APP_URL: {
    // Derived, not asked. APP_URL and GOOGLE_CALLBACK_URL disagreeing with the
    // certificate's domain is the single most common failure in a hand-built
    // .env, and both restate information the operator has already given.
    derive: ({ domain }) => `https://${domain}`,
  },

  // --- Database ------------------------------------------------------------
  // Asked explicitly rather than defaulted: .env.example says `localhost`
  // while base.compose.yml falls back to `db`, and which of the two is right
  // depends on where the process runs, not on the deployment. `db` is a compose
  // service name that only resolves INSIDE the stack (devdb.compose.yml defines
  // it); `localhost` only works from the host. Inheriting either blindly would
  // be wrong for the other case.
  POSTGRES_HOST: { essential: true },
  POSTGRES_PORT: { validate: validatePort },
  POSTGRES_USER: { essential: true },
  POSTGRES_PASSWORD: { essential: true, secret: true },
  POSTGRES_DB: { essential: true },

  // --- JWT / session -------------------------------------------------------
  JWT_SECRET: {
    essential: true,
    secret: true,
    generate: 'base64-32',
    validate: combine(requireMinLength(32), rejectPlaceholder),
  },
  COOKIE_SECRET: {
    essential: true,
    secret: true,
    generate: 'base64-32',
    validate: combine(requireMinLength(32), rejectPlaceholder),
  },

  // --- Credential encryption ----------------------------------------------
  // Offered for generation rather than merely accepted: object storage's secret
  // access key is encrypted with it (issue #377), so a deployment without one
  // cannot save a storage credential and every upload is refused with a 503.
  // Still not `essential` — an unattended install must be able to produce a
  // .env, and the API boots without it.
  SECRETS_ENCRYPTION_KEY: {
    secret: true,
    generate: 'base64-32',
    validate: validateBase64Key32,
  },

  // --- OAuth ---------------------------------------------------------------
  // An empty GOOGLE_CLIENT_ID crashes bootstrap outright with "OAuth2Strategy
  // requires a clientID option", so this is a hard requirement.
  GOOGLE_CLIENT_ID: { essential: true, validate: rejectPlaceholder },
  GOOGLE_CLIENT_SECRET: {
    essential: true,
    secret: true,
    validate: rejectPlaceholder,
  },
  GOOGLE_CALLBACK_URL: {
    derive: ({ domain }) => `https://${domain}/api/auth/google/callback`,
  },
  MICROSOFT_CLIENT_ID: { group: 'microsoft-oauth' },
  MICROSOFT_CLIENT_SECRET: { group: 'microsoft-oauth', secret: true },
  MICROSOFT_CALLBACK_URL: {
    group: 'microsoft-oauth',
    derive: ({ domain }) => `https://${domain}/api/auth/microsoft/callback`,
  },

  // --- Admin bootstrap -----------------------------------------------------
  // Without it nobody can become an admin: the seed writes the allowlist row,
  // and the first OAuth login matching this address claims the role.
  INITIAL_ADMIN_EMAIL: {
    essential: true,
    validate: combine(validateEmail, rejectPlaceholder),
  },

  // --- Test authentication -------------------------------------------------
  // NEVER offered and never written. Setting it true in production fails
  // startup by design, and there is no reason a deployment should carry it.
  TEST_AUTH_ENABLED: { never: true },

  // --- Observability -------------------------------------------------------
  OTEL_ENABLED: { group: 'observability' },
  OTEL_EXPORTER_OTLP_ENDPOINT: { group: 'observability' },
  OTEL_SERVICE_NAME: { group: 'observability' },
  // GreptimeDB telemetry store (telemetry.compose.yml). Three accounts with
  // three privileges: the collector writes, the explorer / AI assistant / BI
  // tools read, and only the retention (TTL) setting uses the admin account.
  //
  // The passwords are generated, never asked (#567), and as hex: they are
  // embedded in GreptimeDB's `user=password,...` provider string, so `,`, `=`
  // and `:` must never appear in them.
  GREPTIME_HOST: { group: 'observability' },
  GREPTIME_HTTP_PORT: { group: 'observability' },
  GREPTIME_PG_PORT: { group: 'observability' },
  // Loopback host port vps.telemetry.compose.yml publishes the PG protocol on.
  GREPTIME_BIND_PG_PORT: { group: 'observability' },
  GREPTIME_DB: { group: 'observability' },
  GREPTIME_WRITER_USER: { group: 'observability' },
  GREPTIME_WRITER_PASSWORD: {
    group: 'observability',
    secret: true,
    generate: 'hex-32',
    autoGenerate: true,
  },
  GREPTIME_READER_USER: { group: 'observability' },
  GREPTIME_READER_PASSWORD: {
    group: 'observability',
    secret: true,
    generate: 'hex-32',
    autoGenerate: true,
  },
  GREPTIME_ADMIN_USER: { group: 'observability' },
  GREPTIME_ADMIN_PASSWORD: {
    group: 'observability',
    secret: true,
    generate: 'hex-32',
    autoGenerate: true,
  },

  // --- Stack agent (#567) --------------------------------------------------
  // The API's credential for the stack-agent sidecar (vps.compose.yml), which
  // holds the Docker socket so the admin UI can redeploy the telemetry
  // containers. Only the stack reads it, so it is generated without a
  // question on install AND on update (the drift step's autoGenerate path),
  // and vps.compose.yml refuses to start without it. No group: the agent is
  // part of every VPS deployment. Hex, like the GreptimeDB passwords, so it
  // survives any quoting a hand-edited .env might put it through.
  STACK_AGENT_TOKEN: {
    secret: true,
    generate: 'hex-32',
    autoGenerate: true,
  },

  // --- Email (SES) ---------------------------------------------------------
  // THERE IS NO `storage` GROUP ANY MORE (issue #377, epic #372). Which bucket,
  // which region, which endpoint, which provider and which key are application
  // settings now, edited at /admin/settings/storage after the deployment is up,
  // so there is nothing about storage left to ask at install time — and asking
  // would recreate the second source of truth the epic removed.
  //
  // Only one survives (issue #585 removed the SES access key id/secret the
  // same way #377 removed storage's): SES_REGION still reads as a fallback
  // default, and only SES does.
  SES_REGION: { group: 'email' },
};

export function metadataFor(key: string): EnvVarMetadata {
  return ENV_METADATA[key] ?? {};
}
