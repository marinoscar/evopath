// =============================================================================
// POST /api/admin/storage-config/bucket — request and response (issue #375)
// =============================================================================
//
// Creates the bucket the submitted configuration names, and applies the four
// settings this application actually needs it to have. It is the remedy the
// connection test's `bucket_missing` code points at.
//
// -----------------------------------------------------------------------------
// ⚠ `guided` IS A 200, AND INVENTING A STATUS CODE FOR IT WOULD BE THE BUG
// -----------------------------------------------------------------------------
//
// This is the same argument `db-backup/dto/db-backup-node-credential.dto.ts`
// and `restore-preflight.service.ts` make for `CREATEROLE` and `CREATEDB`, and
// it holds here for the same reason: AN APPLICATION CREDENTIAL WITHOUT
// `s3:CreateBucket` IS THE ORDINARY CONFIGURATION, NOT A FAULT. A
// least-privilege IAM policy scoped to one bucket's objects is what a
// well-run deployment issues, and Cloudflare R2 API tokens are routinely minted
// object-read-write with no bucket-admin scope at all.
//
// A `4xx` would tell an administrator their setup is unsupported when it is
// exactly right. A `5xx` would tell them something is broken when nothing is.
// What is true is smaller and more useful: this key cannot make buckets, here
// are the three commands that make one with a key that can, and once it exists
// everything else works untouched. So the STATUS is 200 and the ANSWER is
// `outcome`, with real names already substituted into `guidance.commands` — a
// block with a placeholder in it is not a deliverable, it is homework.
//
// -----------------------------------------------------------------------------
// PER-STEP OUTCOMES, BECAUSE PARTIAL SUCCESS IS THE COMMON CASE
// -----------------------------------------------------------------------------
//
// Creating a bucket and hardening it are four API calls against four different
// IAM actions, and a key permitted the first is frequently not permitted the
// rest. Reporting one boolean would mean an operator whose bucket was created
// but left publicly listable is told either "failed" (and creates a second
// bucket) or "created" (and never learns). Every step reports its own status,
// and `outcome: 'partial'` exists precisely so the answer can be "the bucket is
// there, and here is the one thing you must still do yourself".
//
// ⚠ CORS `ExposeHeaders: ['ETag']` IS NOT OPTIONAL POLISH. The browser
// multipart path reads the `ETag` off each `UploadPart` response and sends the
// list back to `POST /storage/objects/:id/upload/complete` (see
// `objects.service.ts`). A cross-origin `XMLHttpRequest`/`fetch` cannot read a
// response header that is not in `Access-Control-Expose-Headers`, so a bucket
// whose CORS rule omits it produces uploads that transfer every byte
// successfully and then fail to complete, with a browser-side error that names
// neither CORS nor the bucket. See {@link STORAGE_BUCKET_STEP_IDS}.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { STORAGE_PROVIDER_KINDS } from '../../../common/schemas/settings.schema';
import { testStorageConfigSchema } from './storage-connection-test.dto';

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * The configuration whose bucket to create — the SUBMITTED, UNSAVED one, for
 * the same reason the connection test takes one: an operator provisions the new
 * bucket before pointing the deployment at it, not after.
 *
 * Reuses the test request's schema rather than restating it. No `confirmation`:
 * creating a bucket strands nothing, and a bucket that already exists is
 * reported as `already_exists` rather than touched.
 */
export const provisionStorageBucketSchema = testStorageConfigSchema;

export class ProvisionStorageBucketDto extends createZodDto(
  provisionStorageBucketSchema,
) {}

export type ProvisionStorageBucketInput = z.output<typeof provisionStorageBucketSchema>;

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * The four steps, in the order they are attempted.
 *
 * `publicAccessBlock` and `encryption` are **AWS S3 only** and are reported as
 * `skipped` for `r2` and `s3compatible`. That is not laziness: R2 buckets are
 * private by default and encrypted at rest by default, and `PutPublicAccessBlock`
 * /`PutBucketEncryption` are AWS-specific APIs that an S3-compatible server is
 * free not to implement. Calling them anyway would turn "this vendor does not
 * have that API" into a failed step on a bucket that is already in the state the
 * step wanted.
 *
 * `cors` runs for every provider: it is the one step whose absence breaks the
 * product rather than loosening it, and every S3-compatible implementation this
 * application supports has `PutBucketCors`.
 */
export const STORAGE_BUCKET_STEP_IDS = [
  'create',
  'publicAccessBlock',
  'encryption',
  'cors',
] as const;

export type StorageBucketStepId = (typeof STORAGE_BUCKET_STEP_IDS)[number];

/**
 * `skipped` covers two different, both-honest cases, and the step's `detail`
 * says which: the step does not apply to this provider, or an earlier step
 * failed so hard that attempting it would be meaningless.
 */
export const STORAGE_BUCKET_STEP_STATUSES = ['passed', 'failed', 'skipped'] as const;

/**
 * Five outcomes, and none of them is an HTTP error. See this file's header.
 *
 * `created`        every applicable step succeeded, and the bucket is new.
 * `already_exists` the bucket was already there and owned by this key; the
 *                  hardening steps still ran, and every applicable one passed.
 * `partial`        the bucket exists now, but at least one hardening step
 *                  failed. `steps` says which, and it is the operator's to
 *                  finish.
 * `guided`         the credential may not create buckets. `guidance` carries
 *                  the commands that do it elsewhere. ⚠ NOT AN ERROR.
 * `failed`         the bucket does not exist and this is not a permissions
 *                  question — the name is taken by another account, the
 *                  endpoint is unreachable, the credential is wrong.
 */
export const STORAGE_BUCKET_OUTCOMES = [
  'created',
  'already_exists',
  'partial',
  'guided',
  'failed',
] as const;

export type StorageBucketOutcome = (typeof STORAGE_BUCKET_OUTCOMES)[number];

export const storageBucketStepSchema = z.object({
  id: z.enum(STORAGE_BUCKET_STEP_IDS),
  label: z.string(),
  status: z.enum(STORAGE_BUCKET_STEP_STATUSES),
  /** Authored here: what this step did, or why it did not. */
  detail: z.string(),
  /** The provider's own message, verbatim, with any secret redacted. Null on success. */
  error: z.string().nullable(),
});

/**
 * The ready-to-paste answer the `guided` outcome exists to deliver. Same three
 * fields, same meanings, as `guidedJobRoleInstructionsSchema` in
 * `db-backup/dto/db-backup-node-credential.dto.ts` — a second shape for
 * "here is what to run instead" would be a second thing to render.
 */
export const guidedBucketInstructionsSchema = z.object({
  /** What sent the operator here, in one sentence. */
  reason: z.string(),

  /**
   * A complete command block with this deployment's REAL bucket, region and
   * endpoint already substituted — `aws s3api` for `s3` and `s3compatible`,
   * `wrangler` for `r2`.
   */
  commands: z.string(),

  /**
   * Repository-relative path to the runbook that explains the block.
   *
   * NULLABLE — kept that way even now that issue #378 has written
   * `docs/runbooks/storage-configuration.md` and
   * `StorageBucketProvisionService` fills this in (`STORAGE_RUNBOOK_PATH`).
   * The nullability is what let #375 ship the endpoint before the runbook
   * existed without ever pointing at a file that was not there — the same
   * shape `guidedJobRoleInstructionsSchema` uses non-nullably only because its
   * runbook already existed the day that schema was written. Leaving this
   * field nullable rather than tightening it to `z.string()` costs nothing and
   * keeps the type honest for a fork that removes the runbook or ships this
   * response before writing one of its own.
   */
  runbook: z.string().nullable(),
});

export const storageBucketProvisionResultSchema = z.object({
  /** ⚠ THE ANSWER. Never inferred from the status code, which is always 200. */
  outcome: z.enum(STORAGE_BUCKET_OUTCOMES),

  provider: z.enum(STORAGE_PROVIDER_KINDS),
  bucket: z.string(),
  region: z.string(),
  effectiveEndpoint: z.string().nullable(),

  /** Always all four, in attempt order, whatever the outcome. */
  steps: z.array(storageBucketStepSchema),

  /** Present exactly when `outcome` is `guided`. */
  guidance: guidedBucketInstructionsSchema.nullable(),

  /**
   * The CORS origin the `cors` step allowed, echoed so an operator can see it
   * without reading the bucket back.
   *
   * It is `APP_URL`, taken from this deployment's own configuration and never
   * from the request: a caller-supplied origin would make this endpoint a
   * "grant any website write access to our bucket" button.
   */
  corsOrigin: z.string().nullable(),

  attemptedAt: z.iso.datetime(),
});

export class StorageBucketProvisionResultDto extends createZodDto(
  storageBucketProvisionResultSchema,
) {}

export type StorageBucketStep = z.infer<typeof storageBucketStepSchema>;
export type StorageBucketProvisionResult = z.infer<
  typeof storageBucketProvisionResultSchema
>;
