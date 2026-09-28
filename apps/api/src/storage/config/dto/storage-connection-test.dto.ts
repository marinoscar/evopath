// =============================================================================
// POST /api/admin/storage-config/test — request and response (issue #375)
// =============================================================================
//
// ⚠ THIS ENDPOINT ANSWERS 200 EVEN WHEN THE CONFIGURATION IS BROKEN. That is
// the design, and it is the single most important thing in this file.
//
// It is the same contract `POST /api/email-settings/test` states, in the same
// words, for the same reason: diagnosing a misconfiguration is this page's
// entire job, so a refused request is a SUCCESSFUL DIAGNOSIS. Returning 4xx/5xx
// for that answer loses it — this app's error envelope is `{ code, message,
// details }` produced by `HttpExceptionFilter`, which suppresses detail in
// production and which the web client funnels into generic failure handling, so
// "the bucket exists but this key may not see it" would arrive as "Request
// failed". The outcome therefore travels as a normal payload.
//
// A real 4xx/5xx still means what it always means: not authenticated, not
// permitted, a malformed body, or a bug in this API. Those are transport
// failures of the endpoint. A refused `HeadBucket` is a result.
//
// `success` IS THE ONLY SUCCESS SIGNAL, and it is true only when EVERY check
// passed.
//
// -----------------------------------------------------------------------------
// FOUR CHECKS, REPORTED SEPARATELY, NEVER COLLAPSED INTO ONE BOOLEAN
// -----------------------------------------------------------------------------
//
// "Storage does not work" is not an actionable sentence, and the four ways it
// can be untrue need four different fixes:
//
//   1. `credentials`   — was the signature accepted at all? A rejected key is
//                        fixed in the credential fields; nothing else can help.
//   2. `bucket`        — does the bucket exist, and may this key see it?
//                        ⚠ 404 AND 403 ARE NOT THE SAME ANSWER — see
//                        {@link STORAGE_TEST_CHECK_CODES}.
//   3. `roundTrip`     — write, read back, delete, on a throwaway key. This is
//                        the only check that proves the key has the PERMISSIONS
//                        an upload needs; `HeadBucket` passing proves nothing
//                        about `s3:PutObject`.
//   4. `presignedUrl`  — is the signed URL this API hands to a browser valid,
//                        and does the object store actually serve it?
//                        ⚠ IT IS FETCHED FROM THIS PROCESS, so it cannot and
//                        does not prove the host is reachable from a user's
//                        BROWSER — no server-side check can, and claiming
//                        otherwise would be worse than not checking. What it
//                        does catch is the class of failure the three checks
//                        above hide by construction: presigning is a different
//                        code path from a signed API call, so a wrong region or
//                        a wrong path-style setting can be tolerated on the
//                        direct call and produce a `SignatureDoesNotMatch` or a
//                        404 on the URL every download in the product uses.
//
// A check that could not be attempted because an earlier one failed is
// `skipped`, not `failed`: reporting four failures for one cause sends an
// operator looking for four problems.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { STORAGE_PROVIDER_KINDS } from '../../../common/schemas/settings.schema';
import { updateStorageConfigSchema } from './update-storage-config.dto';

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * The configuration to test: the SUBMITTED, UNSAVED one.
 *
 * ⚠ IT TESTS THE BODY, NOT THE STORED ROW, AND THAT IS THE POINT. An operator
 * changing buckets should be able to prove a configuration BEFORE committing
 * the deployment to it — a test that could only exercise what had already been
 * saved would mean the only way to try a new bucket is to break the running
 * one first. Nothing here writes: no settings row, no credential, no audit of a
 * configuration change (the attempt itself is audited).
 *
 * Structurally identical to the `PUT` body minus `confirmation`, and derived
 * from it with `.omit()` rather than restated: a field added to the save form
 * is then testable without a second edit, and the two can never disagree about
 * what a configuration is. `confirmation` is absent because nothing is being
 * switched — there is no old location to strand.
 *
 * `secretAccessKey` keeps the same blank-preserves meaning it has on `PUT`:
 * empty means "test with the secret already stored", which is what makes
 * "I changed only the region, does it still work?" a single click rather than a
 * re-paste of a credential the admin may not have to hand.
 */
export const testStorageConfigSchema = updateStorageConfigSchema.omit({
  confirmation: true,
});

export class TestStorageConfigDto extends createZodDto(testStorageConfigSchema) {}

export type TestStorageConfigInput = z.output<typeof testStorageConfigSchema>;

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/** The four checks, in the order they are attempted. See this file's header. */
export const STORAGE_TEST_CHECK_IDS = [
  'credentials',
  'bucket',
  'roundTrip',
  'presignedUrl',
] as const;

export type StorageTestCheckId = (typeof STORAGE_TEST_CHECK_IDS)[number];

/**
 * `skipped` is NOT a failure and NOT a pass: the check could not be attempted
 * because an earlier one failed, so this run knows nothing about it either way.
 */
export const STORAGE_TEST_CHECK_STATUSES = ['passed', 'failed', 'skipped'] as const;

/**
 * Machine-readable causes, so a UI can offer the RIGHT next action rather than
 * a generic error toast.
 *
 * ⚠ `bucket_missing` AND `bucket_forbidden` ARE THE REASON THIS ENUM EXISTS.
 * `HeadBucket` answers `404` when there is no such bucket at this endpoint and
 * `403` when there is one and this key may not inspect it. The two need
 * OPPOSITE fixes — create the bucket (which `POST /bucket` will do) versus
 * widen the key's policy, and creating a bucket that already exists under
 * somebody else's account is not a recoverable mistake — so collapsing them
 * into "bucket check failed" sends half of all operators to the wrong remedy.
 * S3 is explicit that `HeadBucket` returns `403` for a bucket that exists and
 * is not yours, which is exactly the case a name typo lands in.
 */
export const STORAGE_TEST_CHECK_CODES = [
  /** The check passed. */
  'ok',
  /** Nothing was attempted: the configuration is incomplete. */
  'not_configured',
  /** The signature itself was refused — a wrong key id or secret. */
  'credentials_rejected',
  /** No response at all: DNS, TLS, a refused connection, a timeout. */
  'endpoint_unreachable',
  /** `HeadBucket` 404 — no bucket by that name at this endpoint. */
  'bucket_missing',
  /** `HeadBucket` 403 — it exists (possibly not yours); the key cannot see it. */
  'bucket_forbidden',
  /** The bucket lives in a different region from the one configured. */
  'bucket_region_mismatch',
  /** `PutObject` refused. */
  'write_denied',
  /** `GetObject` refused. */
  'read_denied',
  /** The object read back did not match the bytes written. */
  'read_mismatch',
  /** `DeleteObject` refused — the probe object may have been left behind. */
  'delete_denied',
  /** The presigned URL could not be fetched from this process at all. */
  'presign_unreachable',
  /** The presigned URL answered, but not with a success status. */
  'presign_rejected',
  /** It answered 200 with bytes that are not the ones that were written. */
  'presign_mismatch',
  /** An earlier check failed, so this one was not attempted. */
  'not_attempted',
  /** Something else. `error` carries the provider's own words. */
  'unknown_error',
] as const;

export const storageConnectionCheckSchema = z.object({
  id: z.enum(STORAGE_TEST_CHECK_IDS),

  /** Short human label, so a client need not carry its own copy of the four. */
  label: z.string(),

  status: z.enum(STORAGE_TEST_CHECK_STATUSES),

  /** The machine-readable cause. See {@link STORAGE_TEST_CHECK_CODES}. */
  code: z.enum(STORAGE_TEST_CHECK_CODES),

  /**
   * One or two sentences an operator can act on, authored here — never the
   * provider's raw text. It says what to change, not only what went wrong.
   */
  detail: z.string(),

  /**
   * THE PROVIDER'S OWN MESSAGE, verbatim, or null.
   *
   * `NoSuchBucket`, `SignatureDoesNotMatch`, `ECONNREFUSED 10.0.0.4:9000`,
   * `PermanentRedirect: the bucket is in a different region`. Not a category and
   * not a rewritten sentence — each of those discards the one thing the
   * operator came here for, and a wrong region, a bad secret and a firewalled
   * port all collapse into the same useless toast.
   *
   * SAFE TO SURFACE: the reader already holds `storage_config:write`, so every
   * value this text could reveal about the storage configuration is one they can
   * read and change on the same page. The SECRET is a different matter, and the
   * service redacts it out of this string before it is ever set — see
   * `StorageConnectionTestService.describeError`.
   */
  error: z.string().nullable(),
});

export const storageConnectionTestResultSchema = z.object({
  /**
   * True only when all four checks passed.
   *
   * ⚠ A CALLER THAT TREATS HTTP 200 AS "STORAGE WORKS" REPORTS SUCCESS FOR
   * EVERY MISCONFIGURATION THERE IS. Read this field.
   */
  success: z.boolean(),

  /** Which vendor was tested — the SUBMITTED one, not necessarily the saved one. */
  provider: z.enum(STORAGE_PROVIDER_KINDS),

  /** The bucket that was tested. */
  bucket: z.string(),

  /** The signing region that was used. */
  region: z.string(),

  /** The origin actually talked to, or null for the SDK's own AWS host. */
  effectiveEndpoint: z.string().nullable(),

  /**
   * Whether the stored secret was used because the body left it blank.
   *
   * Worth echoing: "I pasted a new key and it still fails" and "I left the key
   * alone and it still fails" are different situations, and an admin cannot tell
   * which one they are in from the result alone.
   */
  usedStoredSecret: z.boolean(),

  /** The four checks, always all four, in attempt order. */
  checks: z.array(storageConnectionCheckSchema),

  attemptedAt: z.iso.datetime(),
});

export class StorageConnectionTestResultDto extends createZodDto(
  storageConnectionTestResultSchema,
) {}

export type StorageConnectionCheck = z.infer<typeof storageConnectionCheckSchema>;
export type StorageConnectionTestResult = z.infer<
  typeof storageConnectionTestResultSchema
>;
