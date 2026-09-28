# Object Storage Providers

> **Status:** shipped · **Code:** `apps/api/src/storage/config/`, `apps/api/src/storage/providers/`, `apps/web/src/pages/Admin/StorageConfigPage.tsx` · **API:** `/api/admin/storage-config/*` (see `/api/docs`) · **Admin UI:** `/admin/settings/storage` · **Runbook:** [storage-configuration.md](../runbooks/storage-configuration.md)

Object storage (AWS S3, Cloudflare R2, or an S3-compatible endpoint) is
configured at runtime by an administrator, with no restart. The `storage`
system-settings namespace holds the non-secret fields, the encrypted
credential store holds the secret access key, and every storage call resolves
the two into a client configuration. Every consumer injects the same
`STORAGE_PROVIDER` token and never sees the difference.

## 1. Purpose

A deployment needs one place to put files: uploads, avatars, job artifacts,
AI outputs and database backups. This feature lets an operator choose the
provider, bucket and credential from the admin UI, prove the configuration
works before saving it, create and harden the bucket, and rotate the key
without a restart.

There are no storage environment variables. No variable names a provider,
bucket, region, endpoint or credential; the admin UI is the only source.

What it is not:

- **Not a migration tool.** Switching bucket or provider does not copy
  objects (§2.7).
- **Not multi-bucket.** One configuration is live at a time. Objects written
  under an earlier configuration keep their recorded `bucket` and
  `storage_provider`, but are not readable through the new one.
- **Not a local-disk provider.** Every deployment needs an S3-protocol store.

## 2. How it works

### 2.1 Configuration model: settings plus a separate secret

The `storage` namespace (`systemStorageSchema` in
`apps/api/src/common/schemas/settings.schema.ts`) holds seven fields:

| Field | Notes |
|---|---|
| `provider` | `s3`, `r2` or `s3compatible` (`STORAGE_PROVIDER_KINDS`) |
| `bucket` | No default, ever. `''` means "not configured". |
| `region` | Required for `s3`. |
| `endpoint` | Required for `s3compatible`. An explicit value always wins, for every provider. |
| `accountId` | R2 only; the endpoint is derived from it (`deriveR2Endpoint`). |
| `accessKeyId` | An identifier, shown in the UI. Not a secret. |
| `forcePathStyle` | Tri-state: `true`, `false`, or `null` (use the vendor default; §2.4). |

- Every string defaults to `''`, and `readNamespace` validates each field
  independently, so one corrupted field does not lose the others.
- The **secret access key is not in the namespace.** It lives in
  `CredentialsService` at `(purpose: 'storage', name: 'default')`
  (`apps/api/src/storage/storage-credential.constants.ts`).
- A compile-time proof, `StorageSettingsCarriesNoSecret`, breaks the build if
  `secretAccessKey`, `secretKey`, `password` or similar names are added to
  `systemStorageSchema`.

### 2.2 Resolution and its cache

`StorageConfigService.resolve()` joins the namespace and the decrypted secret
into a `StorageConfigResolution`:

- `{ configured: true, config }` — a fully resolved `ResolvedStorageConfig`
  (R2 endpoint derived, fallback region applied).
- `{ configured: false, provider, missing }` — every missing field, not just
  the first.

Caching is asymmetric:

- **The settings half is cached** for `STORAGE_POLICY_CACHE_MS` (5 s).
- **The secret is never cached.** It is re-read from
  `CredentialsService.getSecret` on every call, so a rotated key is live on
  the next call and no plaintext copy sits on a singleton.
- **A failed settings read propagates** as a `500`. There is no safe fallback
  for a call that may write bytes.
- **`invalidateCache()`** must run synchronously after a settings write and
  before the audit row. A credential-only rotation does not need it.

`resolveStorageConfig` (`apps/api/src/storage/config/storage-config.ts`) is
the single, pure definition of "configured". It injects nothing; the secret
is an argument. The provider, the 503 path, the connection test and the
bucket provisioner all ask it. It requires:

| Provider | Always | Plus | Fallback region |
|---|---|---|---|
| `s3` | `bucket`, `accessKeyId`, secret | `region` | none |
| `r2` | same | `accountId`, unless `endpoint` is set | `auto` |
| `s3compatible` | same | `endpoint` | `us-east-1` |

Anonymous access is not supported: a public bucket cannot serve a presigned
URL or complete a multipart upload.

### 2.3 `ResolvingStorageProvider`

`STORAGE_PROVIDER` is bound with `useClass: ResolvingStorageProvider`
(`storage-providers.module.ts`). Each of its thirteen `StorageProvider`
methods is one line: resolve the delegate, call the same method. Consumers
(`ObjectsService`, `ProfileImageService`, `AvatarService`,
`ObjectProcessingService`, `StorageCleanupHandler`, the database-backup
services, `ExampleChecksumHandler`, `NodeDataPlaneService`, AI storage) are
unaware of it.

- **It never throws at construction**, so an unconfigured install boots.
- **Delegate cache:** at most two built clients (`DELEGATE_CACHE_LIMIT = 2`),
  least recently used. Evicted clients are closed with `S3Client.destroy()`.
  Two lets an upload in flight finish on the previous client after a save.
- **Cache key:** a SHA-256 fingerprint of the resolved configuration,
  including the secret (`fingerprintStorageConfig`). A new secret means a new
  client on the next call. Never log the fingerprint; use
  `describeStorageConfig` for log lines.

#### The `getBucket()` snapshot

`StorageProvider.getBucket(): string` is synchronous, and callers
(`ObjectsService.initUpload`, the database-backup runner) write its result
onto rows that outlive the request. It answers from
`StorageConfigService.lastKnownBucket()`: the bucket named by the last
successful settings read that named one. That value is warmed once at startup
(best-effort) and refreshed by every async method. A later empty read does
not clear it. If nothing is known, `getBucket()` throws
`StorageNotConfiguredError.unresolved()` (a `503`); it never returns `''`.

### 2.4 One driver, three provider shapes

`S3StorageProvider` is one class for all three vendors.
`buildS3ClientConfig` (`apps/api/src/storage/providers/s3/s3-storage.provider.ts`)
turns a resolved configuration into `S3ClientConfig`. Endpoint and region are
already resolved (§2.2); this function adds the path-style default and the
checksum flags.

| Provider | Endpoint | Region | `forcePathStyle` default | Checksums |
|---|---|---|---|---|
| `s3` | SDK default host | operator's | `false` | SDK default |
| `r2` | derived from `accountId` | `auto` | `false` | `WHEN_REQUIRED` |
| `s3compatible` | operator's | `us-east-1` | `true` | SDK default |

- **`forcePathStyle` is tri-state.** `null` (the shipped default) applies the
  table's default. An explicit `true` or `false` always wins, for every
  provider. A plain boolean cannot say "unset", and a stored `false` breaks
  MinIO, which requires path style.
- **R2 checksum flags.** `@aws-sdk/client-s3` v3.729.0+ sends a CRC32
  `x-amz-trailer` by default, which R2 rejects with a misleading signature
  error. `requestChecksumCalculation` and `responseChecksumValidation` are set
  to `'WHEN_REQUIRED'` for `r2` only. Do not widen this condition.
- **`CopySource` encoding.** `setMetadata` uses `CopyObjectCommand` with
  `MetadataDirective: 'REPLACE'`. The SDK does not encode `CopySource`, so
  `encodeCopySource` percent-encodes the key segment by segment and keeps `/`.
  `Key` stays raw.
- `buildS3ClientConfig` is exported so the connection test and the bucket
  provisioner build clients exactly as the real provider does.

### 2.5 Unconfigured deployments answer 503

A fresh install has no storage until an administrator fills in the form.
Every storage call in that state throws `StorageNotConfiguredError`, a `503`:

- `.missing(provider, missing)` — the ordinary case. The body names every
  missing field (never a value) and the remedy path `/admin/settings/storage`.
- `.unresolved()` — only from `getBucket()` (§2.3).

Not `500`: nothing is broken, and the same request succeeds once the form is
saved. Not `''`: an empty bucket written to a row fails months later, when a
sweep or a restore cannot find the object.

### 2.6 Admin probes answer 200

`POST /api/admin/storage-config/test` and `POST /api/admin/storage-config/bucket`
run against the **submitted, unsaved** body, so an operator can prove a new
bucket before committing to it. A blank submitted secret uses the stored one.

**Both answer HTTP `200` even when the diagnosis is bad.** The result is in
the body: `success` for the test, `outcome` for the bucket action. The
production error envelope hides detail, so a diagnosis sent as a 4xx would
arrive as "Request failed". Only real transport failures (auth, RBAC,
malformed body, a bug) are 4xx/5xx. Read the field, not the status.

**Connection test.** Four checks, reported separately, in order:
`credentials` → `bucket` → `roundTrip` → `presignedUrl`. A check that could
not run because an earlier one failed is `skipped`, not `failed`.

- `bucket` distinguishes `bucket_missing` (HeadBucket 404) from
  `bucket_forbidden` (403). On a 403 only, a second `ListBuckets` call
  disambiguates `credentials_rejected`.
- `roundTrip` writes a throwaway object under a probe prefix and deletes it.
- Every error string is redacted; every attempt is audited.

**Bucket provisioning.** Four steps, reported separately: `create`,
`publicAccessBlock`, `encryption`, `cors`.

- `publicAccessBlock` and `encryption` are AWS-only and `skipped` for `r2` and
  `s3compatible` (R2 buckets are private and encrypted already).
- `cors` runs for every provider. The rule allows `PUT`/`GET`/`HEAD` from
  `APP_URL`'s origin and exposes `ETag`. Without `ETag` exposed, the browser
  multipart upload transfers every byte and then cannot complete.
- `LocationConstraint` is sent only for a non-`us-east-1` `s3` region.
- `outcome` is `created`, `already_exists`, `partial`, `guided` or `failed`.

**`guided` is a designed-in path, not an error.** A credential without
`s3:CreateBucket` is ordinary least privilege (and R2 tokens usually lack
bucket-admin scope). `guided` carries `guidance.reason`, `guidance.commands`
(a paste-ready block with this deployment's real bucket, region, endpoint and
CORS origin), and `guidance.runbook` (`STORAGE_RUNBOOK_PATH`,
`docs/runbooks/storage-configuration.md`). It fires only on a permission or
unsupported-API denial, never on a rejected credential or an unreachable
endpoint. The shape matches the database backup's `guided` outcomes.

### 2.7 The SWITCH confirmation

`PUT /api/admin/storage-config` answers `409` when a save would **relocate**
a configured deployment while rows still point at the old location:

- Relocation means a different `provider`, `bucket`, or *effective* endpoint
  (the derived R2 host counts). `region`, `accessKeyId` and `forcePathStyle`
  do not.
- The 409 names the counts, for example
  `1,284 object(s) and 30 database backup(s) still point at s3 bucket "old-bucket"`.
- Re-send with `{"confirmation":"SWITCH"}` to proceed.
- Silent on a first configuration (`bucket` was `''`) and when nothing would
  be stranded.

**The confirmation acknowledges; it does not migrate.** No object is copied.
Existing `storage_objects` rows, avatars and `database_backup_runs` archives
keep addressing the old bucket. Downloads 404 and old backups become
unrestorable, with no error logged.

`PUT` is a full replace of the seven fields plus an optional secret rotation
(blank preserves the stored secret). It checks `If-Match` before touching the
credential and re-checks it inside the settings write. A rotation is audited
with the actor; the value never is.

## 3. Configuration and permissions

**Settings:** the `storage` namespace (§2.1) and the `storage` credential.

**Environment:** only four deployment limits, in
`apps/api/src/config/configuration.ts`. None of them names a location or a
credential (§1):

| Variable | Default | Meaning |
|---|---|---|
| `MAX_FILE_SIZE` | 10 GB | Largest upload accepted; enforced on resumable-upload init (`413`) and caps the simple upload's multipart limit (the smaller of 100 MB and this) |
| `ALLOWED_MIME_TYPES` | empty (allow every type) | Upload type allowlist; exact types or `type/*` wildcards, else `415` |
| `SIGNED_URL_EXPIRY` | 3600 s | Presigned URL lifetime |
| `STORAGE_PART_SIZE` | 10 MB | Multipart part size |

`SECRETS_ENCRYPTION_KEY` is required in practice: the storage secret lives
in the encrypted store. `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` and
`SES_REGION` belong to the SES email transport only.

**Permissions:** `storage_config:read` and `storage_config:write`, seeded
Admin only. They are distinct from `system_settings:*` and from `storage:*`
(§6). The matrix lives in [ARCHITECTURE.md](../ARCHITECTURE.md). The
`Storage` card in `apps/web/src/config/adminSections.tsx` is gated on
`storage_config:read`; write controls are disabled inside the page without
`storage_config:write`.

| Route | Purpose | Permission |
|---|---|---|
| `GET /api/admin/storage-config` | Namespace, `configured`, `missing`, `effectiveEndpoint`, masked `secretStatus`. Never decrypts the secret. | `storage_config:read` |
| `PUT /api/admin/storage-config` | Full replace; blank secret preserves; `If-Match`; `409` + `SWITCH` on relocation | `storage_config:write` |
| `POST /api/admin/storage-config/test` | Four checks against the submitted config; always `200` | `storage_config:write` |
| `POST /api/admin/storage-config/bucket` | Create and harden the bucket; always `200`, may be `guided` | `storage_config:write` |

## 4. Extending it in a fork

- **Use storage:** inject `STORAGE_PROVIDER` and call the `StorageProvider`
  interface (`apps/api/src/storage/providers/storage-provider.interface.ts`).
  Handle `StorageNotConfiguredError` as the `503` it is.
- **Add a vendor that speaks S3:** it usually needs nothing new; use
  `s3compatible` with an endpoint. If it needs a driver tweak (as R2's
  checksums did), add a modelled setting or a narrow branch in
  `buildS3ClientConfig`, and cover it in `s3-storage.provider.spec.ts`.
- **Add a non-S3 backend:** implement `StorageProvider`, add a kind to
  `STORAGE_PROVIDER_KINDS`, teach `resolveStorageConfig` its required fields,
  and have `ResolvingStorageProvider` build it.
- **Never** add an environment variable for provider, bucket, region,
  endpoint or credential.

## 5. Guardrails

| Invariant | Test |
|---|---|
| Required fields per provider; every missing field reported; region/endpoint fallbacks; `deriveR2Endpoint`; fingerprint changes with the secret | `apps/api/src/storage/config/storage-config.spec.ts` |
| Settings cache TTL, `fresh: true`, `invalidateCache()`; secret never cached; `lastKnownBucket()` rules; failed read propagates | `apps/api/src/storage/config/storage-config.service.spec.ts` |
| Never throws at construction; delegate reuse, rotation and bounded eviction; unconfigured 503; `getBucket()` never returns `''` | `apps/api/src/storage/providers/resolving-storage.provider.spec.ts` |
| Provider table; explicit `forcePathStyle` wins; R2-only checksum flags; `CopySource` encoding | `apps/api/src/storage/providers/s3/s3-storage.provider.spec.ts` |
| Masked secret; `If-Match`; blank-preserves rotation; switch gate; invalidation ordering | `apps/api/src/storage/config/storage-config-admin.service.spec.ts` |
| Four checks, `skipped` vs `failed`, 404 vs 403, redaction, auditing | `apps/api/src/storage/config/storage-connection-test.service.spec.ts` |
| CORS rule, `LocationConstraint`, all outcomes, `guided` with real values, runbook path | `apps/api/src/storage/config/storage-bucket-provision.service.spec.ts` |
| Permissions per route; no secret in any response; probes answer `200` | `apps/api/test/settings/storage-config.integration.spec.ts` |

The unit suites mock the AWS SDK. They prove request shapes and error
classification, not live vendor behaviour.

## 6. Design decisions

- **Secret outside the namespace.** `GET /api/system-settings` returns the
  whole document and every write is copied into an audit row's `meta`. A
  secret there would be one admin `GET` from a browser and one audit query
  from a permanent plaintext copy.
- **`accessKeyId` in the namespace.** It is an identifier sent in clear in
  every SigV4 request. Showing it lets an operator tell a rotated key from a
  mistyped one.
- **A delegating provider, not `useFactory`.** A factory resolves once at boot,
  losing live reconfiguration, and cannot boot an unconfigured install.
- **One driver, not three classes.** All three vendors use the same protocol
  and SDK; only a few config lines differ.
- **Secret never cached.** One indexed lookup and one AES-GCM decrypt per call
  is cheap next to a network round trip, and a revoked key stops working on
  the next call.
- **`storage_config:*`, not `system_settings:*`.** A wrong bucket or secret
  breaks every upload, avatar, artifact and backup at once. Same "distinct
  blast radius" argument as `push:*`, `nodes:*` and `broadcasts:*`.
- **`storage_config:*`, not `storage:*`.** `storage:*` gates object access and
  is seeded to Viewer and Contributor; reusing it would show the credential
  screen to every user.
- **No permanent env fallback.** Two sources of truth for the live credential
  is the ambiguity this design removes. A fallback only some deployments use
  is untested until a rotation depends on it.
- **Switch gated, not blocked.** Blocking would leave a deployment that must
  change vendor no path forward. The count makes "are you sure?" answerable.
- **No copy on switch.** A bucket-to-bucket copy of unbounded data is a queue
  job with its own design (resumability, conflicts, uploads mid-copy), not a
  clause in a `PUT`.
- **No per-object historical provider resolution.** It would thread a
  provider identity through every method or cache a client per past
  configuration. `storage_objects.bucket`/`.storage_provider` already record
  where each object is.
- **`getBucket()` stays synchronous.** Making it async is the right long-term
  fix but touches every consumer, including backup call sites inside a retry
  loop around an `INSERT`.

## 7. Verification

```bash
cd apps/api
npm test -- storage-config resolving-storage s3-storage storage-connection-test storage-bucket-provision
```

Against a real provider, follow the
[runbook](../runbooks/storage-configuration.md):

1. Open `/admin/settings/storage`, fill in the form and click **Test connection**. All
   four checks should pass.
2. If the bucket does not exist, use **Create bucket**. Expect `created`, or
   `guided` with paste-ready commands.
3. Save, then upload a profile picture. It should appear without a restart.
4. Rotate the secret and upload again. The new key is used immediately.

## History

- #108 added the encrypted credential store that holds the storage secret.
- #373 (epic #372) added the `storage` namespace, the encrypted secret,
  `StorageConfigService` and `ResolvingStorageProvider`, with a temporary
  environment bridge.
- #374 added one driver for three provider shapes, tri-state
  `forcePathStyle`, R2's checksum flags and the `CopySource` fix.
- #375 added the `/api/admin/storage-config` API: read, replace, test,
  create bucket, and the SWITCH gate.
- #376 added the `/admin/settings/storage` page.
- #377 removed `STORAGE_PROVIDER`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`
  and the bridge, and moved the SES region fallback to `SES_REGION`.
- #378 added the operator runbook and wired `guidance.runbook` to it.
- #519 enforced `MAX_FILE_SIZE` on resumable-upload init and the simple
  upload's multipart limit, and changed the `ALLOWED_MIME_TYPES` default to
  empty (allow every type).
