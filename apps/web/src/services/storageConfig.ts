/**
 * The object-storage admin API (`/api/admin/storage-config`), as the web app
 * sees it.
 *
 * Issue #376, epic #372 — the client half of the controller merged in #375
 * (`apps/api/src/storage/config/`). Shaped after `services/pushConfig.ts` and
 * `services/dbBackup.ts`: `services/api.ts` stays the transport (the
 * `ApiService` instance, the refresh dance, the maintenance recogniser), and
 * this module holds the four `/admin/storage-config` calls next to the types
 * they produce. The tail of `services/api.ts` is legacy; nothing new goes
 * there.
 *
 * =============================================================================
 * THE SECRET ACCESS KEY ONLY EVER TRAVELS ONE WAY
 * =============================================================================
 *
 * No response type below carries the secret access key, because no endpoint
 * returns it — the API holds it in the encrypted credential store and answers
 * with {@link StorageSecretStatus}, a masked hint mirroring `SmtpPasswordStatus`
 * and `PrivateKeyStatus`. It appears in exactly one place in this file: the
 * optional, WRITE-ONLY `secretAccessKey` on {@link StorageConfigInput}, where
 * blank/absent means "keep the stored one". Nothing here, and nothing built on
 * it, should grow a field that could hold the real key coming back.
 *
 * `accessKeyId` IS returned, deliberately: it travels in the clear in every
 * SigV4 `Authorization` header, and an administrator who cannot see it cannot
 * tell a rotated key from a mistyped one.
 *
 * =============================================================================
 * ⚠ TWO ENDPOINTS ANSWER 200 WHEN THE ANSWER IS BAD
 * =============================================================================
 *
 * `POST /test` and `POST /bucket` both always return HTTP 200; the outcome is
 * in the BODY (`success` for the test, `outcome` for the bucket action). A
 * caller that reads the status code reports success for every misconfiguration
 * there is — see each DTO's header on the API side, and `sendTestEmail`, which
 * makes the same argument first. Neither function below rejects on a bad
 * diagnosis; both reject only when the call itself fails.
 */

import { api } from './api';

/**
 * Which object store this deployment talks to.
 *
 * Mirrors `STORAGE_PROVIDER_KINDS` in
 * `apps/api/src/common/schemas/settings.schema.ts`, as a const tuple so the
 * union and the list a form iterates are one declaration rather than two.
 */
export const STORAGE_PROVIDER_KINDS = ['s3', 'r2', 's3compatible'] as const;
export type StorageProviderKind = (typeof STORAGE_PROVIDER_KINDS)[number];

/**
 * Every field the configuration needs and might not have.
 *
 * `secretAccessKey` is in here even though it is not a settings field: from
 * "can this deployment store a file?", a missing credential row and an empty
 * bucket are the same kind of problem. Mirrors
 * `MISSING_STORAGE_CONFIG_FIELDS`.
 */
export const MISSING_STORAGE_CONFIG_FIELDS = [
  'bucket',
  'region',
  'endpoint',
  'accountId',
  'accessKeyId',
  'secretAccessKey',
] as const;
export type MissingStorageConfigField = (typeof MISSING_STORAGE_CONFIG_FIELDS)[number];

/**
 * What the UI may know about the stored secret access key. Mirrors
 * `SmtpPasswordStatus` / `PrivateKeyStatus` field for field: never the
 * plaintext, only enough to say WHICH credential is live and when it was set.
 */
export interface StorageSecretStatus {
  configured: boolean;
  /** A masked hint (e.g. `"••••ab12"`), or `null`. NEVER the real key. */
  hint: string | null;
  updatedAt: string | null;
  updatedByUserId: string | null;
}

/** `GET /api/admin/storage-config`, and the body `PUT` returns. */
export interface StorageConfigView {
  provider: StorageProviderKind;
  bucket: string;
  region: string;
  /** The operator's endpoint override, verbatim. `''` when there is none. */
  endpoint: string;
  /** Cloudflare account id — only meaningful for `r2`. */
  accountId: string;
  accessKeyId: string;
  /** TRI-STATE: `null` is "use this vendor's convention", not `false`. */
  forcePathStyle: boolean | null;
  /**
   * What an S3 client would actually be pointed at — READ-ONLY, and derived
   * server-side (for R2, from `accountId`), so a settings page never builds
   * that host itself. `null` for plain AWS S3, where the SDK builds its own.
   */
  effectiveEndpoint: string | null;
  /** The single definition of "this deployment can store a file". */
  configured: boolean;
  /** Every field standing in the way of `configured`. */
  missing: MissingStorageConfigField[];
  secretStatus: StorageSecretStatus;
  /** Bumped on every write. Pass back as `If-Match` on the next `PUT`. */
  version: number;
  updatedAt: string | null;
  updatedBy: { id: string; email: string } | null;
}

/**
 * The body of `PUT`, `POST /test` and `POST /bucket` — the same seven settings
 * fields in all three, which is what lets the two probes run against a
 * configuration that has NOT been saved yet.
 *
 * `secretAccessKey` is optional and write-only: omit it (or send it blank) to
 * keep the stored one. There is no way to erase a stored secret here.
 */
export interface StorageConfigInput {
  provider: StorageProviderKind;
  bucket: string;
  region: string;
  endpoint: string;
  accountId: string;
  accessKeyId: string;
  /** TRI-STATE — `null` means "vendor convention", and is a real saved value. */
  forcePathStyle: boolean | null;
  /** WRITE-ONLY. Omitted entirely when the admin did not retype it. */
  secretAccessKey?: string;
}

/**
 * The exact string the API's Zod literal requires when a save would repoint a
 * deployment that still holds objects (`STORAGE_SWITCH_CONFIRMATION`,
 * `dto/update-storage-config.dto.ts`). Held as a constant for the same reason
 * `RESTORE`/`ROLLBACK`/`ROTATE` are: the dialog compares what an admin typed
 * against this, never against a string re-typed in a component.
 */
export const STORAGE_SWITCH_CONFIRMATION = 'SWITCH';

/** The `details` a `409 STORAGE_LOCATION_IN_USE` carries — what is about to be stranded. */
export interface StorageLocationInUseDetails {
  confirmation: string;
  from: { provider: StorageProviderKind; bucket: string; endpoint: string | null };
  to: { provider: StorageProviderKind; bucket: string; endpoint: string | null };
  storageObjects: number;
  databaseBackupRuns: number;
  total: number;
}

/** The API's code for "this save relocates storage and you have not said SWITCH". */
export const STORAGE_LOCATION_IN_USE_CODE = 'STORAGE_LOCATION_IN_USE';

// ---------------------------------------------------------------------------
// POST /test
// ---------------------------------------------------------------------------

/** The four checks, in the order the API reports them. */
export const STORAGE_TEST_CHECK_IDS = [
  'credentials',
  'bucket',
  'roundTrip',
  'presignedUrl',
] as const;
export type StorageTestCheckId = (typeof STORAGE_TEST_CHECK_IDS)[number];

export const STORAGE_TEST_CHECK_STATUSES = ['passed', 'failed', 'skipped'] as const;
export type StorageTestCheckStatus = (typeof STORAGE_TEST_CHECK_STATUSES)[number];

/**
 * The machine-readable diagnosis of one check.
 *
 * ⚠ `bucket_missing` (404 — no such bucket, create it) and `bucket_forbidden`
 * (403 — it exists and this key may not see it, so widen the policy or fix a
 * typo that landed on somebody else's bucket) are deliberately NOT collapsed
 * together: they need opposite actions, and offering "Create bucket" for the
 * second would ask an admin to create a bucket that already exists.
 */
export const STORAGE_TEST_CHECK_CODES = [
  'ok',
  'not_configured',
  'credentials_rejected',
  'endpoint_unreachable',
  'bucket_missing',
  'bucket_forbidden',
  'bucket_region_mismatch',
  'write_denied',
  'read_denied',
  'read_mismatch',
  'delete_denied',
  'presign_unreachable',
  'presign_rejected',
  'presign_mismatch',
  'not_attempted',
  'unknown_error',
] as const;
export type StorageTestCheckCode = (typeof STORAGE_TEST_CHECK_CODES)[number];

export interface StorageConnectionCheck {
  id: StorageTestCheckId;
  label: string;
  status: StorageTestCheckStatus;
  code: StorageTestCheckCode;
  /** Actionable prose, written by the API for a human. */
  detail: string;
  /** The provider's verbatim message, or `null`. */
  error: string | null;
}

export interface StorageConnectionTestResult {
  success: boolean;
  provider: StorageProviderKind;
  bucket: string;
  region: string;
  effectiveEndpoint: string | null;
  /** True when the submitted body left `secretAccessKey` blank. */
  usedStoredSecret: boolean;
  checks: StorageConnectionCheck[];
  attemptedAt: string;
}

/**
 * Does any check in this result say the bucket is simply not there?
 *
 * The one condition under which offering "Create bucket" is honest. Exported
 * so the page and its tests agree on it rather than each re-deriving the rule.
 */
export function reportsBucketMissing(result: StorageConnectionTestResult | null): boolean {
  return !!result?.checks.some((check) => check.code === 'bucket_missing');
}

// ---------------------------------------------------------------------------
// POST /bucket
// ---------------------------------------------------------------------------

export const STORAGE_BUCKET_STEP_IDS = [
  'create',
  'publicAccessBlock',
  'encryption',
  'cors',
] as const;
export type StorageBucketStepId = (typeof STORAGE_BUCKET_STEP_IDS)[number];

export const STORAGE_BUCKET_STEP_STATUSES = ['passed', 'failed', 'skipped'] as const;
export type StorageBucketStepStatus = (typeof STORAGE_BUCKET_STEP_STATUSES)[number];

/**
 * ⚠ `guided` IS A SUCCESSFUL 200, NOT AN ERROR. A least-privilege credential
 * without `s3:CreateBucket` is the ORDINARY configuration — an IAM policy
 * scoped to one bucket's objects, or an R2 API token minted object-read-write.
 * The API answers with `guidance.commands`, a paste-ready block carrying this
 * deployment's real values, and rendering that as a failure would tell an
 * administrator their correct setup is broken.
 */
export const STORAGE_BUCKET_OUTCOMES = [
  'created',
  'already_exists',
  'partial',
  'guided',
  'failed',
] as const;
export type StorageBucketOutcome = (typeof STORAGE_BUCKET_OUTCOMES)[number];

export interface StorageBucketStep {
  id: StorageBucketStepId;
  label: string;
  status: StorageBucketStepStatus;
  detail: string;
  error: string | null;
}

export interface GuidedBucketInstructions {
  /** Why the credential could not do it — prose, for the alert's body. */
  reason: string;
  /** A ready-to-paste command block, real names already substituted. */
  commands: string;
  runbook: string | null;
}

export interface StorageBucketProvisionResult {
  outcome: StorageBucketOutcome;
  provider: StorageProviderKind;
  bucket: string;
  region: string;
  effectiveEndpoint: string | null;
  steps: StorageBucketStep[];
  /** Non-null exactly when `outcome === 'guided'`. */
  guidance: GuidedBucketInstructions | null;
  corsOrigin: string | null;
  attemptedAt: string;
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

const BASE = '/admin/storage-config';

/** `GET` — `storage_config:read`. */
export async function getStorageConfig(): Promise<StorageConfigView> {
  return api.get<StorageConfigView>(BASE);
}

/**
 * `PUT` — `storage_config:write`. Full replace of the seven settings fields.
 *
 * `expectedVersion` is passed through as-is, INCLUDING `0` — the check is
 * `!== undefined`, never a truthiness test, so the very first save on a fresh
 * deployment still asserts "nothing is stored yet" rather than being the one
 * unguarded write. Copied from `updateDbBackupConfig`'s sibling in
 * `services/pushConfig.ts`.
 *
 * `409` twice over, and the two mean different things: a version mismatch
 * (reload and re-apply) and `STORAGE_LOCATION_IN_USE` (re-send with
 * `confirmation`). The `code` on the `ApiError` tells them apart.
 */
export async function updateStorageConfig(
  input: StorageConfigInput,
  expectedVersion?: number,
  options: { confirmSwitch?: boolean } = {},
): Promise<StorageConfigView> {
  return api.put<StorageConfigView>(
    BASE,
    options.confirmSwitch
      ? { ...input, confirmation: STORAGE_SWITCH_CONFIRMATION }
      : input,
    {
      headers:
        expectedVersion === undefined
          ? undefined
          : { 'If-Match': String(expectedVersion) },
    },
  );
}

/**
 * `POST /test` — `storage_config:write`, and ALWAYS HTTP 200.
 *
 * Runs against the configuration in the BODY, saved or not, so a new bucket can
 * be proved before the deployment is committed to it. Read `success`; a
 * resolved promise is a completed diagnosis, not a working configuration.
 */
export async function testStorageConfig(
  input: StorageConfigInput,
): Promise<StorageConnectionTestResult> {
  return api.post<StorageConnectionTestResult>(`${BASE}/test`, input);
}

/**
 * `POST /bucket` — `storage_config:write`, and ALWAYS HTTP 200.
 *
 * Creates the bucket the submitted configuration names and applies the four
 * settings this application needs. Read `outcome`; `guided` is not an error.
 * Safe to repeat — an existing bucket owned by this account is left alone and
 * the hardening steps still run, which is the repair path for a bucket created
 * by hand with no CORS rule.
 */
export async function provisionStorageBucket(
  input: StorageConfigInput,
): Promise<StorageBucketProvisionResult> {
  return api.post<StorageBucketProvisionResult>(`${BASE}/bucket`, input);
}
