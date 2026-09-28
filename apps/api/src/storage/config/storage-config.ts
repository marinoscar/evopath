import { createHash } from 'node:crypto';

import type {
  StorageProviderKind,
  SystemStorageValue,
} from '../../common/schemas/settings.schema';

// =============================================================================
// Is this deployment's object storage usable, and with what? (issue #373)
// =============================================================================
//
// Part 1 (#373) declared the `storage` settings namespace and deliberately left
// ONE question open — see the block comment on `systemStorageSchema`:
//
//     "Whether the configuration is COMPLETE ENOUGH TO USE is a question for
//      the consumer that builds a client from it, not for the shape of the
//      document."
//
// This file is that consumer's answer, and it is the ONLY answer. Every rule
// about what "configured" means lives in `resolveStorageConfig` below: the
// provider that builds an `S3Client` asks it, the 503 an unconfigured
// deployment returns is written from its result, and part 3's connection test
// will ask the same function rather than re-deriving the same conditions with
// one of them spelled differently. A second copy of "…and a bucket, and a key
// id, and — for R2 — an account id" is how a settings page comes to report
// "ready" about a configuration the upload path refuses.
//
// PURE, AND NEST-FREE, ON PURPOSE. Nothing here injects, reads a row, decrypts
// anything or logs. The secret arrives as an argument. That is what lets the
// whole rule set be exercised with a literal and a string, and it is what lets
// part 3's connection test import the endpoint derivation without dragging
// `SystemSettingsService` and `CredentialsService` into a module that only
// wants to build a URL.
//
// WHY "EMPTY STRING" IS THE MISSING-VALUE TEST EVERYWHERE BELOW. The settings
// schema stores `''` — never `null`, never an absent key — for every string in
// this namespace, and `.trim()`s on the way in (`systemStorageSchema`). So an
// operator who typed a space into `bucket` has stored `''`, and one field test
// covers "never filled in", "cleared", and "filled in with whitespace". There
// is deliberately no `.length > 0 && !== undefined && != null` triplet here;
// the schema already removed two of those three states from existence.
// =============================================================================

/**
 * The host every Cloudflare R2 bucket is addressed through, after the account
 * id.
 *
 * A constant rather than an inline template so `deriveR2Endpoint` and any
 * future reader (a docs string, an admin page's placeholder) cannot drift by a
 * character — and a wrong character here does not fail as "wrong host", it
 * fails as a DNS error in a job log an hour later.
 */
export const R2_ENDPOINT_HOST_SUFFIX = 'r2.cloudflarestorage.com';

/**
 * The region R2 expects, literally.
 *
 * R2 has no regions, but the S3 SDK refuses to sign a request without a region
 * string, so Cloudflare documents the literal `auto`. It is used only as the
 * fallback when an operator left `region` empty — a value they typed always
 * wins, because R2's jurisdiction-restricted buckets (`eu`, `fedramp`) are
 * addressed with a real region and inventing `auto` over the top of one would
 * break exactly the deployment that was most careful.
 */
export const R2_DEFAULT_REGION = 'auto';

/**
 * The region placeholder used for an S3-compatible endpoint when the operator
 * typed none.
 *
 * WHY A PLACEHOLDER IS NEEDED AT ALL: the AWS SDK refuses to sign a request
 * without a region string, even when the endpoint already says exactly which
 * host to talk to. For a deployment addressed by endpoint, the region is only
 * part of the signature's scope — MinIO, Ceph RGW and LocalStack ignore it
 * entirely — so an unset region must not be the reason a correctly-configured
 * MinIO cannot be reached.
 *
 * `us-east-1` rather than `auto` because it is the value those servers'
 * documentation uses and the one their clients send by default. A vendor that
 * DOES check the region (Backblaze B2's `us-west-004`, Wasabi's per-site
 * regions) answers a mismatch with a signature or endpoint error — which is why
 * a region an operator typed always wins over this, and why `region` remains an
 * editable field for `s3compatible` rather than being hidden.
 */
export const S3_COMPATIBLE_DEFAULT_REGION = 'us-east-1';

/**
 * Cloudflare R2's account-scoped endpoint for `accountId`.
 *
 * DERIVED, NEVER TYPED. `accountId` is a modelled settings field precisely so
 * this string is built in one place: an operator pasting
 * `https://<account>.r2.cloudflarestorage.com` by hand gets it wrong by a
 * character often enough that "check the endpoint" is R2's most common support
 * answer, and a typo'd host fails at TLS or DNS, far from the field that caused
 * it.
 *
 * ⚠ THE BUCKET IS NOT PART OF THIS HOST. R2's S3 API addresses the bucket in
 * the path (or as a subdomain of the account host, which this app does not
 * use); appending it here would produce a URL that 404s on every request.
 *
 * Exported as a single pure helper so part 3's connection test derives the same
 * host the client actually used, rather than a second string that agrees with
 * it today.
 *
 * @param accountId - The Cloudflare account id, already trimmed by the schema.
 * @returns The `https://` origin to point the S3 client at.
 */
export function deriveR2Endpoint(accountId: string): string {
  return `https://${accountId}.${R2_ENDPOINT_HOST_SUFFIX}`;
}

/**
 * A configuration that is complete enough to build a client from.
 *
 * EVERY FIELD IS RESOLVED, not raw: `endpoint` is already derived for R2 (and
 * absent for plain S3, where the SDK builds its own), and `region` already
 * carries R2's `auto` fallback. A caller holding one of these has nothing left
 * to decide and nothing left to look up — which is the whole point, because the
 * alternative is each caller re-deriving the endpoint and one of them getting
 * it wrong.
 *
 * ⚠ `secretAccessKey` IS PLAINTEXT. It is here because an S3 client cannot be
 * built without it. Treat a value of this type the way `CredentialsService
 * .getSecret` tells you to treat its return: use it, then let it go out of
 * scope. Do not store one on an instance field, do not put one in a DTO, do not
 * log one, and do not hand one to an error constructor. `StorageConfigService`
 * holds to that rule itself — it caches the settings half and re-reads the
 * secret every time.
 */
export interface ResolvedStorageConfig {
  /** Which vendor's flavour of the S3 protocol this points at. */
  provider: StorageProviderKind;
  /** The bucket objects are written to and read from. Never empty. */
  bucket: string;
  /** Signing region. Never empty — R2 falls back to {@link R2_DEFAULT_REGION}. */
  region: string;
  /**
   * The origin to talk to, or absent to let the SDK derive AWS's own host.
   *
   * Absent is meaningful and is NOT the same as empty: passing `endpoint: ''`
   * to `S3Client` is an invalid URL, while omitting it is how one asks for the
   * regional AWS host.
   */
  endpoint?: string;
  /** The identifier half of the credential. Loggable — see the schema. */
  accessKeyId: string;
  /** ⚠ Plaintext. See the type's own warning above. */
  secretAccessKey: string;
  /**
   * `https://host/bucket/key` (true) over `https://bucket.host/key` (false),
   * or `null` for "use this vendor's convention".
   *
   * TRI-STATE, AND `null` IS CARRIED, NOT COLLAPSED. This is the one resolved
   * field that is deliberately NOT decided here: the per-vendor convention
   * (path style for `s3compatible`, virtual-host style for `s3` and `r2`)
   * lives in `buildS3ClientConfig`, which is the only place that knows what
   * each SDK flavour wants. Resolving `null` to a boolean in this file would
   * be a second copy of that table, and the failure mode of the second copy is
   * the one #374 shipped: a `false` nobody chose reaching the driver as an
   * operator's explicit answer, suppressing the default and breaking MinIO.
   * What an administrator actually stated still travels through untouched.
   */
  forcePathStyle: boolean | null;
}

/**
 * A field the configuration needs and does not have.
 *
 * `secretAccessKey` is in this union even though it is not a settings field:
 * from the point of view of "can this deployment store a file?", a missing
 * credential-store row and an empty bucket are the same kind of problem, and an
 * administrator told only about the six settings fields would stare at a
 * complete-looking form. It names the field, never its value.
 */
export const MISSING_STORAGE_CONFIG_FIELDS = [
  'bucket',
  'region',
  'endpoint',
  'accountId',
  'accessKeyId',
  'secretAccessKey',
] as const;

/**
 * A field the configuration needs and does not have.
 *
 * DERIVED FROM the tuple above rather than written out a second time, exactly
 * as `StorageProviderKind` is derived from `STORAGE_PROVIDER_KINDS`. The tuple
 * exists because #375's admin response has to VALIDATE this list on the way out
 * (`z.enum(...)` needs values, not a type), and a hand-maintained second copy in
 * a DTO is a list that silently stops matching the day a seventh field is added
 * here.
 */
export type MissingStorageConfigField =
  (typeof MISSING_STORAGE_CONFIG_FIELDS)[number];

/**
 * The result of asking whether storage is usable: yes with a config, or no with
 * the list of reasons.
 *
 * A DISCRIMINATED UNION RATHER THAN `ResolvedStorageConfig | null`, because the
 * `null` branch is the one that has to be explained to a person. An operator
 * whose uploads have started returning 503 needs "bucket, secretAccessKey",
 * and a bare `null` forces whoever writes the error to re-derive that list from
 * the raw settings — which is the second copy of the rules this file exists to
 * prevent. `StorageConfigService.resolveActiveConfig` still offers the `null`
 * shape for callers that genuinely only need "usable or not".
 */
export type StorageConfigResolution =
  | {
      configured: true;
      config: ResolvedStorageConfig;
    }
  | {
      configured: false;
      /** Which provider's requirements were checked. */
      provider: StorageProviderKind;
      /** Every missing field, not just the first — see `resolveStorageConfig`. */
      missing: MissingStorageConfigField[];
    };

/**
 * Decide whether this deployment has usable object storage, and resolve it.
 *
 * THE SINGLE DEFINITION OF "CONFIGURED", and the function every caller asks:
 * the provider that builds an `S3Client`, the 503 an unconfigured deployment
 * returns, and the connection test. There are exactly two inputs — the saved
 * settings namespace and the stored secret — and there is nowhere else a
 * storage configuration can come from.
 *
 * ── WHAT "CONFIGURED" MEANS, DEFINED ONCE ───────────────────────────────────
 *
 * Three things are required of EVERY provider:
 *
 *   * `bucket` — there is no default bucket and there must never be one. A
 *     guessed bucket name is either a 404 on every request or, far worse,
 *     somebody else's bucket.
 *   * `accessKeyId` — the identifier half of the credential.
 *   * `secretAccessKey` — its secret half, from the credential store. Absent
 *     means no row has been saved at `(storage, default)` yet.
 *
 * Anonymous access is deliberately NOT a supported configuration. A public
 * bucket cannot serve a presigned URL, cannot complete a multipart upload and
 * cannot be written to at all, so "no credentials" here is never a deployment
 * choice — it is an unfinished form, and treating it as valid would produce an
 * `S3Client` that fails every call with `AccessDenied` instead of a 503 that
 * says which field is empty.
 *
 * Then, one requirement per provider — and this is the whole of what `provider`
 * selects:
 *
 *   * `s3` needs `region`. The AWS SDK derives its host from it, and it will
 *     not sign without one. There is no default: `us-east-1` is a real region
 *     that a bucket somewhere else answers with a redirect nobody reads.
 *   * `r2` needs `accountId`, because the endpoint is DERIVED from it
 *     (`deriveR2Endpoint`). Its region is not required — see
 *     {@link R2_DEFAULT_REGION}.
 *   * `s3compatible` needs `endpoint`. It is the bucket the other two are not:
 *     MinIO, Backblaze, Wasabi, a Ceph appliance. There is nothing to derive a
 *     host from, so the operator must supply one.
 *
 * An explicitly typed `endpoint` ALWAYS WINS, for every provider. That is what
 * makes pointing `provider: 's3'` at a local MinIO possible without lying about
 * which provider it is, and it is why R2's derivation is a fallback rather than
 * an override.
 *
 * ── WHY EVERY MISSING FIELD, NOT THE FIRST ──────────────────────────────────
 *
 * Returning one field at a time turns configuring storage into six round trips
 * through a 503, each revealing the next thing that was always wrong. The
 * fields are checked in the order a form presents them so the list reads the
 * way the page looks.
 *
 * ⚠ NOTHING HERE VALIDATES THAT THE CONFIGURATION WORKS. This function cannot
 * tell a real bucket from a typo, a live key from a revoked one, or a reachable
 * endpoint from a firewalled one — it only answers "is there enough here to
 * build a client". Proving it works needs a round trip to the provider, which
 * is part 3's connection test, and conflating the two would put a network call
 * on the path of every upload.
 *
 * @param policy - The `storage` settings namespace, as stored.
 * @param secretAccessKey - The credential store's plaintext, or `null` when no
 *   row exists at `(storage, default)`.
 */
export function resolveStorageConfig(
  policy: SystemStorageValue,
  secretAccessKey: string | null,
): StorageConfigResolution {
  const missing: MissingStorageConfigField[] = [];

  if (!policy.bucket) {
    missing.push('bucket');
  }

  // Per-provider requirement. A `switch` over the derived union rather than a
  // chain of `if`s, so adding a kind to `STORAGE_PROVIDER_KINDS` makes THIS
  // decision a compile error (`noFallthroughCasesInSwitch` plus the exhaustive
  // `never` below) instead of silently landing in a branch that asks for
  // nothing and builds a client pointed at AWS.
  switch (policy.provider) {
    case 's3':
      // `endpoint` is optional here on purpose: empty means "the SDK's own
      // regional host", which is the correct and commonest configuration.
      if (!policy.region) {
        missing.push('region');
      }
      break;
    case 'r2':
      // Only when nothing was typed — an explicit endpoint makes `accountId`
      // unnecessary, and demanding both would reject a working configuration.
      if (!policy.endpoint && !policy.accountId) {
        missing.push('accountId');
      }
      break;
    case 's3compatible':
      if (!policy.endpoint) {
        missing.push('endpoint');
      }
      break;
    default: {
      // Unreachable while the switch is exhaustive; this line is what makes
      // "exhaustive" a compiler guarantee rather than a comment.
      const unhandled: never = policy.provider;
      throw new Error(`Unhandled storage provider kind: ${String(unhandled)}`);
    }
  }

  if (!policy.accessKeyId) {
    missing.push('accessKeyId');
  }

  // `null` (no row) and `''` (a row holding nothing) are the same answer to the
  // only question being asked. `CredentialsService` cannot return `''` for a
  // stored credential today — it refuses to store a blank — but reading both as
  // "not configured" costs one character and removes a way for that to matter.
  if (!secretAccessKey) {
    missing.push('secretAccessKey');
  }

  if (missing.length > 0) {
    return { configured: false, provider: policy.provider, missing };
  }

  // Restating what the list above already decided, because the compiler cannot
  // read it: an empty `missing` means the secret is present, but that is a fact
  // about a pushed array, not a narrowing. Written as a real guard rather than a
  // `!` or a cast — if the rule above is ever edited so the two disagree, this
  // returns an honest "not configured" instead of handing `null` to a client
  // constructor and failing later as an unsigned request.
  if (!secretAccessKey) {
    return {
      configured: false,
      provider: policy.provider,
      missing: ['secretAccessKey'],
    };
  }

  // Endpoint precedence, in one expression: what the operator typed, else R2's
  // derived host, else nothing (and the SDK builds AWS's).
  const endpoint =
    policy.endpoint ||
    (policy.provider === 'r2' ? deriveR2Endpoint(policy.accountId) : '');

  return {
    configured: true,
    config: {
      provider: policy.provider,
      bucket: policy.bucket,
      // `s3` never reaches a fallback — an empty region is already in `missing`
      // above, so the `||` below can only fire for the two endpoint-addressed
      // providers. That is not a coincidence: a region is what tells the SDK
      // WHERE to send an AWS request, and is only part of the signature scope
      // when an endpoint has already answered that question.
      region: policy.region || fallbackRegionFor(policy.provider),
      // Absent, not empty — `S3Client` rejects `''` as a URL. See the field's
      // note on `ResolvedStorageConfig`.
      ...(endpoint ? { endpoint } : {}),
      accessKeyId: policy.accessKeyId,
      secretAccessKey,
      // Passed through as stored, `null` included — see the field's note on
      // `ResolvedStorageConfig`. The vendor convention is the driver's to
      // apply, and it can only apply it if "unset" survives this far.
      forcePathStyle: policy.forcePathStyle,
    },
  };
}

/**
 * The region to sign with when the operator typed none.
 *
 * Only ever consulted for a provider addressed through an endpoint; `s3`
 * returns `''` here because it can never get this far (an empty region is
 * already a `missing` field for it). Returning `''` rather than throwing keeps
 * this total — a helper that threw on an unreachable branch would be a crash
 * waiting for a future edit to the requirement list above.
 */
function fallbackRegionFor(provider: StorageProviderKind): string {
  switch (provider) {
    case 'r2':
      return R2_DEFAULT_REGION;
    case 's3compatible':
      return S3_COMPATIBLE_DEFAULT_REGION;
    case 's3':
      return '';
    default: {
      const unhandled: never = provider;
      throw new Error(`Unhandled storage provider kind: ${String(unhandled)}`);
    }
  }
}

/**
 * A stable, non-reversible identity for a resolved configuration.
 *
 * WHAT IT IS FOR: `ResolvingStorageProvider` keeps a built `S3Client` and needs
 * to know, per call, whether the configuration that produced it is still the
 * configuration in force. Comparing fingerprints answers that in constant time
 * and — crucially — ACROSS A SECRET ROTATION: the secret is an input, so a key
 * rotated in the credential store yields a different fingerprint, the old
 * client is discarded, and the new key is in use on the very next call rather
 * than at the next restart. A stale client after a rotation is a genuinely
 * baffling failure: the operator fixes the credential, the errors continue, and
 * nothing on screen explains why.
 *
 * WHY A HASH RATHER THAN THE VALUES JOINED. Keying on the raw tuple would park
 * a plaintext copy of the secret access key on a long-lived instance field for
 * the life of the process, where a heap dump or a careless
 * `JSON.stringify(this)` in a debug log would find it. SHA-256 detects change
 * exactly as well and carries nothing back out. (The `S3Client` itself must
 * hold the secret in order to sign; that is unavoidable, and it is not a reason
 * to add a second copy beside it.) This is the same reasoning, and the same
 * shape, as `SmtpEmailProvider`'s transport fingerprint.
 *
 * ⚠ NEVER LOG THE RETURN VALUE. It is a hash of a secret; publishing it invites
 * exactly the offline guessing attack the hash is otherwise immune to. Use
 * {@link describeStorageConfig} for anything a human will read.
 *
 * Every field that changes the bytes on the wire is an input, and nothing else
 * is: two configurations with the same fingerprint are two configurations the
 * same client can serve.
 */
export function fingerprintStorageConfig(config: ResolvedStorageConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        config.provider,
        config.bucket,
        config.region,
        // `?? null` rather than leaving the key absent: `JSON.stringify` drops
        // `undefined` from an array as `null` anyway, and saying so here means
        // the tuple's arity cannot change with the data.
        config.endpoint ?? null,
        config.forcePathStyle,
        config.accessKeyId,
        config.secretAccessKey,
      ]),
    )
    .digest('hex');
}

/**
 * A one-line, SECRET-FREE description of a configuration, for log lines.
 *
 * Exists so that "which storage is this process using?" is answerable from the
 * logs without anybody being tempted to interpolate the config object itself —
 * which would put the secret access key in the log pipeline, in whatever
 * aggregator ships it, and in every retention window downstream.
 *
 * `accessKeyId` is included deliberately: it is an identifier that travels in
 * the clear in every SigV4 `Authorization` header, and it is the one field that
 * distinguishes "the key was rotated" from "the key was mistyped" when both
 * look the same from the outside. See `storage-credential.constants.ts`.
 */
export function describeStorageConfig(config: ResolvedStorageConfig): string {
  const where = config.endpoint ?? `${config.region} (AWS)`;

  return `${config.provider} bucket=${config.bucket} at=${where} keyId=${config.accessKeyId}`;
}
