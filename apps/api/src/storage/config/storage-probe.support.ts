// =============================================================================
// Shared machinery for the two probing endpoints (issue #375, epic #372)
// =============================================================================
//
// `POST /test` and `POST /bucket` both take an UNSAVED configuration, resolve
// it exactly as the running application would, build a client from it, and
// report what an object store said. Everything both of them need to do that —
// and nothing either of them does with the answer — lives here, pure and
// Nest-free, for the same reason `storage-config.ts` is pure: the rules can then
// be exercised with a literal and a string.
//
// ⚠ NOTHING HERE READS `process.env`. A probe reports on THE CONFIGURATION IT
// IS BEING ASKED TO TEST — the one in the request body — and there is nowhere
// else a value could be quietly supplied from: `resolveStorageConfig` takes the
// submitted policy and the submitted (or stored) secret, and nothing else.
// =============================================================================

import type { S3ServiceException } from '@aws-sdk/client-s3';

import type {
  StorageProviderKind,
  SystemStorageValue,
} from '../../common/schemas/settings.schema';
import {
  deriveR2Endpoint,
  resolveStorageConfig,
  type StorageConfigResolution,
} from './storage-config';

/**
 * The seven settings fields a probe request carries.
 *
 * Structurally `SystemStorageValue`, and deliberately declared as a separate
 * name: the DTOs are what the wire actually carries, and tying this signature to
 * the settings type would make a future settings-only field look like something
 * a probe accepts.
 */
export type SubmittedStoragePolicy = SystemStorageValue;

/**
 * Turn a probe request body into the `storage` settings namespace shape, so it
 * can go through the SAME `resolveStorageConfig` a saved configuration does.
 *
 * ⚠ THE WHOLE POINT. A test endpoint that re-derived R2's endpoint, or decided
 * for itself that six non-empty fields means "ready", would be a second
 * definition of "configured" — and the failure mode of the second copy is a
 * settings page reporting a green tick for a configuration every upload path
 * refuses. There is one definition, it is in `storage-config.ts`, and this
 * function's only job is to hand it the right shape.
 */
export function submittedStoragePolicy(input: {
  provider: StorageProviderKind;
  bucket: string;
  region: string;
  endpoint: string;
  accountId: string;
  accessKeyId: string;
  forcePathStyle: boolean | null;
}): SubmittedStoragePolicy {
  return {
    provider: input.provider,
    bucket: input.bucket,
    region: input.region,
    endpoint: input.endpoint,
    accountId: input.accountId,
    accessKeyId: input.accessKeyId,
    forcePathStyle: input.forcePathStyle,
  };
}

/**
 * Resolve a submitted configuration against a secret.
 *
 * A one-line pass-through to `resolveStorageConfig`, and named so that the two
 * probe endpoints read as testing a SUBMITTED configuration rather than the
 * saved one. There is exactly one definition of "configured" — see this file's
 * header.
 */
export function resolveSubmittedStorageConfig(
  policy: SubmittedStoragePolicy,
  secretAccessKey: string | null,
): StorageConfigResolution {
  return resolveStorageConfig(policy, secretAccessKey);
}

/**
 * The origin a client would be pointed at, for DISPLAY, including for a
 * configuration too incomplete to resolve.
 *
 * ⚠ USE `resolution.config.endpoint` WHEN THERE IS A RESOLUTION. This exists
 * only for the case `resolveStorageConfig` deliberately refuses to answer: a
 * half-filled form on a settings page, which still has to render "this is the
 * host you are about to talk to" while the admin is typing. It mirrors two of
 * that function's rules and no more — an explicit endpoint always wins, and R2's
 * host is derived from the account id — and it returns `null` rather than
 * inventing anything for the two cases that genuinely have no answer yet
 * (`s3` uses the SDK's own regional host; `s3compatible` has no endpoint until
 * one is typed).
 */
export function displayEndpoint(policy: SubmittedStoragePolicy): string | null {
  if (policy.endpoint) return policy.endpoint;
  if (policy.provider === 'r2' && policy.accountId) {
    return deriveR2Endpoint(policy.accountId);
  }
  return null;
}

// -----------------------------------------------------------------------------
// Error description
// -----------------------------------------------------------------------------

/**
 * Below this length a secret is indistinguishable from ordinary words in an
 * error message, and blanket-replacing it would corrupt the message into
 * uselessness while still not proving the secret is gone.
 *
 * The constant, the threshold and the fallback below are a DELIBERATE SECOND
 * IMPLEMENTATION of `email/base-email.provider.ts`'s `SecretRedactor`, not an
 * oversight. Importing that class would make the storage module depend on the
 * email module's provider file to obtain a four-line string utility — a module
 * edge that exists for no reason and that a reader has to chase. The same
 * argument is already made, in this repository, by `push-config.service.ts`'s
 * own copy of `describeInvalidPaths`.
 */
const MIN_REDACTABLE_SECRET_LENGTH = 4;

/**
 * Scrub the secret access key out of a message that is about to be shown to an
 * administrator.
 *
 * ⚠ CALLED ON EVERY PATH THAT PRODUCES AN `error` STRING, without exception.
 * We do not author most of these messages: the AWS SDK builds its own text, an
 * S3-compatible server's rejection is echoed back verbatim, and a server that
 * quotes the offending `Authorization` header would put the signing key into a
 * string this API then hands to an admin screen. Scrubbing at the single exit
 * point means the guarantee holds even for errors from code we do not own.
 *
 * A secret too short to replace safely costs the caller the whole message
 * instead. An unreadable error is a bad outcome; a leaked credential is a worse
 * one, and the choice is not close.
 */
export function redactStorageSecret(text: string, secret: string | null): string {
  if (!secret || !text.includes(secret)) return text;

  if (secret.length < MIN_REDACTABLE_SECRET_LENGTH) {
    return '[error withheld: it contained the configured secret access key]';
  }

  return text.split(secret).join('[redacted]');
}

/** What an object store said, reduced to the three facts a verdict needs. */
export interface DescribedStorageError {
  /**
   * The provider's own message, redacted. Never a category and never a
   * rewritten sentence — see `StorageConnectionCheck.error`.
   */
  message: string;

  /**
   * The HTTP status the object store answered with, or `null` when there was no
   * response at all (DNS, TLS, a refused connection, a timeout).
   *
   * `null` IS THE SIGNAL FOR "unreachable", and it is why this is nullable
   * rather than defaulting to 0 or 500: "the endpoint did not answer" and "the
   * endpoint answered 500" are different problems with different fixes.
   */
  status: number | null;

  /**
   * The S3 error code, e.g. `NoSuchBucket`, `AccessDenied`,
   * `InvalidAccessKeyId`, `BucketAlreadyOwnedByYou` — or the exception's class
   * name when the body carried no code, which is the ORDINARY case for
   * `HeadBucket` (a HEAD response has no body to put a code in, so the SDK
   * yields the bare `NotFound`/`Forbidden`). Empty string when neither exists.
   *
   * ⚠ CLASSIFY ON THIS, NOT ON `status`, WHEREVER IT IS PRESENT. A `403` is
   * `AccessDenied` (the key is real and not permitted) or `InvalidAccessKeyId` /
   * `SignatureDoesNotMatch` (the key is wrong) — the same status for two
   * problems whose fixes have nothing in common.
   */
  code: string;

  /** No response was received at all. Equivalent to `status === null`. */
  unreachable: boolean;
}

/**
 * Node/undici transport failure codes: the endpoint never answered.
 *
 * Listed explicitly rather than matched by a pattern so that a new SDK error
 * whose `code` happens to start with `E` is not silently reported as an
 * unreachable host, which would send an operator to their firewall over a
 * permissions problem.
 */
const TRANSPORT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'EPROTO',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
]);

/** Abort/timeout shapes the SDK and `fetch` raise when nothing answered in time. */
const TIMEOUT_ERROR_NAMES = new Set([
  'TimeoutError',
  'AbortError',
  'RequestAbortedError',
  'ConnectTimeoutError',
]);

/**
 * Reduce anything thrown by the AWS SDK (or by `fetch`) to
 * {@link DescribedStorageError}.
 *
 * NEVER THROWS, and never assumes a shape: it is handed values produced by code
 * this repository does not own, including plain strings and objects that are not
 * `Error`s at all. A diagnostic endpoint that crashed while describing a failure
 * would be the one failure mode it must not have.
 */
export function describeStorageError(
  error: unknown,
  secret: string | null,
): DescribedStorageError {
  const candidate = error as Partial<S3ServiceException> & {
    code?: string;
    cause?: unknown;
    errno?: number;
  };

  const status =
    typeof candidate?.$metadata?.httpStatusCode === 'number'
      ? candidate.$metadata.httpStatusCode
      : null;

  // `code` first (some SDK middlewares set it), then the exception's class name,
  // which is what carries `NotFound`/`Forbidden` for the body-less HEAD request
  // `HeadBucket` actually is.
  const code =
    (typeof candidate?.code === 'string' && candidate.code) ||
    (typeof candidate?.name === 'string' && candidate.name) ||
    '';

  const rawMessage =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === 'string'
        ? error
        : 'The storage endpoint failed with an error that carried no message.';

  // A transport failure can arrive nested one level down — `fetch` wraps its
  // cause, and the SDK wraps a socket error in a request error — so the cause is
  // consulted too rather than only the top-level object.
  const nestedCode =
    typeof (candidate?.cause as { code?: string } | undefined)?.code === 'string'
      ? ((candidate.cause as { code: string }).code)
      : '';

  const unreachable =
    status === null &&
    (TRANSPORT_ERROR_CODES.has(code) ||
      TRANSPORT_ERROR_CODES.has(nestedCode) ||
      TIMEOUT_ERROR_NAMES.has(code));

  return {
    message: redactStorageSecret(rawMessage, secret),
    status,
    code: code || nestedCode,
    unreachable,
  };
}

/**
 * S3 error codes that mean THE CREDENTIAL ITSELF was refused, as opposed to a
 * real credential being denied a particular action.
 *
 * ⚠ THE DISTINCTION THE `credentials` CHECK IS BUILT ON, and the reason it is a
 * list of codes rather than `status === 403`. `AccessDenied` and
 * `InvalidAccessKeyId` are both `403`, and they are the difference between
 * "widen this key's policy" and "this key does not exist" — two fixes with
 * nothing in common, on a page whose entire job is to tell them apart.
 */
export const CREDENTIAL_REJECTION_CODES = new Set([
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'InvalidSecurity',
  'InvalidToken',
  'ExpiredToken',
  'TokenRefreshRequired',
  'UnrecognizedClientException',
  'InvalidClientTokenId',
  'AccountProblem',
]);

/** Codes meaning "this bucket does not exist at this endpoint". */
export const BUCKET_MISSING_CODES = new Set(['NoSuchBucket', 'NotFound']);

/** Codes meaning "a bucket by that name exists; this key may not inspect it". */
export const BUCKET_FORBIDDEN_CODES = new Set([
  'Forbidden',
  'AccessDenied',
  'AllAccessDisabled',
]);

/**
 * Codes meaning "the bucket is real, but not in the region this configuration
 * names".
 *
 * Its own outcome rather than a flavour of "forbidden" because the fix is a
 * one-word edit to the `region` field, and because S3 answers this with a `301`
 * that reads as a redirect rather than as an error to anyone skimming a status
 * code.
 */
export const BUCKET_REGION_CODES = new Set([
  'PermanentRedirect',
  'IllegalLocationConstraintException',
  // ⚠ DELIBERATELY HERE AND NOT IN {@link CREDENTIAL_REJECTION_CODES}, which is
  // where the name suggests it belongs. S3 answers a signed request sent to the
  // wrong regional host with `AuthorizationHeaderMalformed` and the message
  // "the region 'us-east-1' is wrong; expecting 'eu-west-1'" — a REGION
  // mismatch wearing an authorization error's name. Classifying it as a bad
  // credential would send an operator to rotate a key that is perfectly good.
  'AuthorizationHeaderMalformed',
]);

/** Codes meaning "a bucket with this name already exists, and it is yours". */
export const BUCKET_ALREADY_OWNED_CODES = new Set(['BucketAlreadyOwnedByYou']);

/** Codes meaning "a bucket with this name exists and belongs to somebody else". */
export const BUCKET_NAME_TAKEN_CODES = new Set(['BucketAlreadyExists']);
