# Runbook: Configure Object Storage

This runbook covers the operator-facing lifecycle of object storage on this
deployment: choosing a provider, entering credentials, proving the
configuration works, creating the bucket if it is not there yet, rotating an
access key with no restart, and recovering from a misconfiguration or an
accidental provider switch. It does not cover the design — see
[`docs/specs/storage-providers.md`](../specs/storage-providers.md) for why
the configuration is split between the settings namespace and the encrypted
credential store, how the resolver and its cache work, why the two probe
endpoints always answer `200`, and what the switch confirmation does and
does not do.

**Object storage is configured entirely through the admin UI**, at
`/admin/settings/storage`. There is no environment-variable path. A fresh deployment starts with **no**
object storage configured; uploads, avatar uploads, job artifacts, and
database backups all answer `503` until an administrator fills in the form
below. See §6 for what that looks like and how to tell it apart from other outages.

Source of truth for every claim below:

- `apps/api/src/storage/config/storage-config.ts` — `resolveStorageConfig`,
  the single definition of "configured," and its per-provider field
  requirements.
- `apps/api/src/storage/config/storage-config-admin.service.ts` — the read
  and write path behind the admin API, including the switch gate.
- `apps/api/src/storage/config/storage-connection-test.service.ts` — the
  four checks `POST /test` runs.
- `apps/api/src/storage/config/storage-bucket-provision.service.ts` — the
  four steps `POST /bucket` runs, and the `guided` fallback.
- `apps/api/src/storage/providers/s3/s3-storage.provider.ts` —
  `buildS3ClientConfig`, the one function that turns a resolved
  configuration into what the AWS SDK actually does per provider.
- `apps/api/src/storage/config/storage-not-configured.error.ts` — the `503`
  every storage call answers with while nothing is configured.
- `apps/web/src/pages/Admin/StorageConfigPage.tsx` and
  `apps/web/src/components/admin/StorageSwitchConfirmDialog.tsx` — the admin
  UI.
- `infra/compose/.env.example` — confirms there is nothing storage-specific
  to set there.

You need `storage_config:read` to view the configuration and
`storage_config:write` to change it, test it, or create the bucket — a
permission pair of its own, **not** a reuse of `system_settings:*` or
`storage:*`. The permissions section of
[`docs/specs/storage-providers.md`](../specs/storage-providers.md) explains
why. Both are seeded Admin-only.

---

## 1. Before you start

Decide, before opening the page:

- **Which provider**: AWS S3, Cloudflare R2, or an S3-compatible endpoint
  (MinIO, Backblaze B2, Wasabi, Ceph RGW, LocalStack, …). All three speak
  the same protocol through the same SDK; the differences the form asks
  about are covered per provider in §2.
- **A bucket name.** This application never invents or guesses one — there
  is no default, on purpose (a guessed name is either a 404 on every
  request or, worse, somebody else's bucket). Decide the name before you
  start, whether or not it exists yet: the form accepts a bucket that does
  not exist yet, and **Create bucket** (§3) makes it.
- **Whether you already have a credential, or need to create one.** This
  application needs an access key id and a secret access key with, at
  minimum, `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and
  `s3:ListBucket`/`HeadBucket`-equivalent visibility on the bucket. If you
  also want to use **Create bucket** with that same credential, it
  additionally needs bucket-admin permissions — see §2's per-provider
  tables. A key scoped to object access only is the ordinary,
  least-privilege choice; §3 covers what happens when it cannot create a
  bucket (nothing bad — a paste-ready command block, not an error).

## 2. First-time setup, per provider

All three providers are configured on the same form
(`/admin/settings/storage`): pick the provider from the radio group at the
top, and the fields below it change to match. Every field except
`secretAccessKey` is visible and editable at any time; the secret is
write-only (§4 covers why) and the form always renders it empty.

### 2.1 AWS S3

| Field | What to enter |
|---|---|
| Provider | `s3` |
| Bucket | The bucket name. |
| Region | **Required.** The AWS region the bucket lives in (e.g. `us-east-1`, `eu-west-1`). There is no default — an empty region is reported as missing, never silently assumed, because a wrong region does not fail as "wrong region," it fails as a confusing 301/signature error days later. |
| Endpoint | Leave empty. The SDK derives AWS's own regional host from the region above. Only set this to point `s3` at a non-AWS host you are testing against (e.g. a local MinIO during development) — an explicit endpoint always wins over the SDK's own derivation. |
| Account ID | Not used by `s3`. Leave empty. |
| Access key ID / Secret access key | An IAM user or role's credential pair. See the IAM policy below. |
| Force path style | Leave as **"Use provider default"** (virtual-host style) unless you have a specific reason to override it (see the "one driver, three provider shapes" section of [`docs/specs/storage-providers.md`](../specs/storage-providers.md)). |

**Minimum IAM policy for uploads/downloads (no bucket administration):**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::YOUR-BUCKET/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::YOUR-BUCKET"
    }
  ]
}
```

**Additional actions needed for the "Create bucket" button** (§3) to
succeed rather than fall back to `guided`:

```json
{
  "Effect": "Allow",
  "Action": [
    "s3:CreateBucket",
    "s3:PutBucketPublicAccessBlock",
    "s3:PutEncryptionConfiguration",
    "s3:PutBucketCORS"
  ],
  "Resource": "arn:aws:s3:::YOUR-BUCKET"
}
```

A credential without these four is the **ordinary** least-privilege shape,
not a misconfiguration — see §3 for what happens instead.

### 2.2 Cloudflare R2

| Field | What to enter |
|---|---|
| Provider | `r2` |
| Bucket | The bucket name. |
| Region | Leave empty. R2 has no regions; the literal `auto` is applied automatically when this is unset. Only type a real region here for one of R2's jurisdiction-restricted buckets (`eu`, `fedramp`) — an explicit value always wins over `auto`. |
| Endpoint | Leave empty **if** Account ID (below) is set — the account-scoped host (`https://<accountId>.r2.cloudflarestorage.com`) is derived automatically. Set this only if you need to override the derived host. |
| Account ID | **Required** (unless you typed an explicit endpoint instead). Your Cloudflare account id — found in the R2 dashboard's overview page, or via `wrangler whoami`. |
| Access key ID / Secret access key | An R2 API token's access key id and secret. Create one in the Cloudflare dashboard under R2 → Manage API Tokens. |
| Force path style | Leave as **"Use provider default"** (virtual-host style). |

**Minimum R2 API token permissions:** "Object Read & Write," scoped to the
one bucket. This is enough for uploads, downloads and deletes — R2 buckets
are private and encrypted at rest **unconditionally**, so there is no
separate public-access-block or encryption step to grant for (unlike AWS
S3, §2.1).

**Additional permission needed for "Create bucket" to succeed:** "Admin
Read & Write" (bucket administration), or create the bucket by hand in the
dashboard / with `wrangler r2 bucket create` and let this credential handle
only objects. A token scoped to object access only is the ordinary case —
see §3.

### 2.3 S3-compatible (MinIO, Backblaze B2, Wasabi, Ceph RGW, LocalStack, …)

| Field | What to enter |
|---|---|
| Provider | `s3compatible` |
| Bucket | The bucket name. |
| Region | Optional. Falls back to `us-east-1` if left empty (a placeholder several of these servers ignore entirely, since the endpoint already says exactly which host to talk to). Backblaze B2 and Wasabi **do** check the region — type the real one for those (e.g. Wasabi's per-site regions), or expect a signature/endpoint mismatch. |
| Endpoint | **Required.** The full `https://` URL of the server, e.g. `http://minio.internal:9000` or `https://s3.us-west-004.backblazeb2.com`. |
| Account ID | Not used by `s3compatible`. Leave empty. |
| Access key ID / Secret access key | The server's own access key pair. |
| Force path style | Leave as **"Use provider default"** — `s3compatible` defaults to **path style** (`https://host/bucket/key`), which is what MinIO, Ceph RGW and most self-hosted servers require. Override only if your server specifically wants virtual-host style. |

**Permissions** vary by server; consult that server's own documentation for
the equivalent of "read/write objects in one bucket." Bucket-administration
support for **Create bucket** (§3) also varies — a server that does not
implement `CreateBucket` over the API at all (some minimal S3-compatible
implementations don't) answers exactly like a permission denial: `guided`,
with the equivalent AWS-CLI-style commands to run against whatever tool
that server provides instead.

## 3. Creating the bucket, and what to do when the credential cannot

Once the provider, bucket and credential fields are filled in, two buttons
become active:

- **Test connection** (`POST /api/admin/storage-config/test`) — runs four
  checks against **what is currently on screen**, not what is saved: the
  credential is accepted, the bucket exists and is reachable, a write/read/
  delete round trip succeeds, and a presigned URL this API would hand to a
  browser actually works. Each check is reported separately with an
  actionable one-line diagnosis and the provider's own verbatim error
  message — read the `detail` next to whichever check failed, not just
  whether the whole thing passed. **This always returns 200; read the
  result, not the HTTP status.**
- **Create bucket** (`POST /api/admin/storage-config/bucket`) — appears once
  the connection test reports the bucket is missing (`bucket_missing`).
  Creates the bucket and applies what this application needs: all public
  access blocked and default encryption on (AWS only — R2 is private and
  encrypted by default), and a CORS rule allowing `PUT`/`GET`/`HEAD` from
  this deployment's own origin with `ExposeHeaders: ["ETag"]` — **without
  which, large browser uploads transfer completely and then fail to
  complete**, with an error that names neither CORS nor the bucket. Safe to
  press more than once: a bucket that already exists and is yours is left
  alone and the hardening steps still run, which is also how you repair a
  bucket that was created by hand without a CORS rule.

**When the credential cannot create a bucket** (the ordinary case for a
least-privilege key — see §1 and §2's per-provider tables), the response is
still `200`, with `outcome: "guided"`: a ready-to-paste command block with
this deployment's **real** bucket, region, endpoint and CORS origin already
filled in, plus a link back to this runbook. Copy that block, run it with a
credential that *does* have bucket-admin rights (your AWS root/admin
account, a Cloudflare account owner, or whoever administers your
S3-compatible server), then click **Test connection** again with the
original, narrowly-scoped credential still in the form — it needs no bucket
administration to *use* a bucket that already exists.

**A `partial` outcome** means the bucket was created (or already existed)
but at least one hardening step failed — most often the CORS step, on a
credential that has `s3:CreateBucket` but not `s3:PutBucketCORS`. The
response names exactly which step failed; fix that one permission (or apply
the missing setting by hand — the same CORS JSON the `guided` path would
have shown you) and click **Create bucket** again. It is safe to re-run:
already-satisfied steps are left as they are.

## 4. Rotating an access key, with no restart

There is no separate "rotate" action — rotation is an ordinary save. On the
**Storage** page:

1. Leave every field as it is **except** paste the new secret access key
   into the (empty) secret field, and update the access key id if it also
   changed.
2. Click **Save changes**.

The secret is write-only and the form always renders it empty, whether or
not one is stored — leaving it empty and saving **preserves the stored
secret unchanged**; there is no way to accidentally blank it out by saving
with the field empty. Only a non-empty paste replaces it.

**The rotation is live immediately, with no restart of any API instance.**
`StorageConfigService` never caches the secret (it is re-read from the
encrypted credential store on every storage operation), and the built
`S3Client` is keyed by a fingerprint that includes the secret — so a new
key produces a new fingerprint, misses the client cache, and a fresh client
signed with the new credential is built on the very next call. The old
credential can be deactivated or deleted at the provider immediately after
saving; there is no window to wait out. The resolution and cache sections of
[`docs/specs/storage-providers.md`](../specs/storage-providers.md) describe
the mechanics.

**Before deactivating the old key at the provider**, click **Test
connection** once with the new secret saved, to confirm it is accepted and
has the permissions this application needs — a rotation that swaps in a
key with narrower permissions than the old one will save successfully (the
save endpoint does not probe the provider) and only surface as a failure on
the next real upload.

## 5. Un-configuring storage

There is no dedicated "disable" action. Clear the **Bucket** field (save
with it empty) to return this deployment to the unconfigured state — every
storage call will answer `503` again (§6) until a bucket is set. The secret
access key is **not** erased by this: there is deliberately no way to erase
a stored secret through this endpoint (only to overwrite it — §4). An admin
who wants storage off simply empties `bucket`; the stored credential sits
inert.

## 6. Troubleshooting: misconfigured or accidentally switched deployment

### 6.1 "Storage is not configured" / every upload returns 503

This is the expected state of a fresh install, and the expected consequence
of clearing `bucket` (§5). Every storage call — an upload, an avatar image,
a job artifact, a database backup — answers `503` with a body naming
exactly which fields are missing and pointing at
`/admin/settings/storage`. Sign in with an account holding
`storage_config:write`, fill in the missing fields (§2), save, and calls
succeed on the very next attempt — no restart needed.

If the settings page itself reports the configuration as complete
(`configured: true`) but calls still fail, that is a **different**
problem — the configuration is syntactically complete but not actually
correct (wrong bucket name, revoked key, network path blocked). Use **Test
connection** (§3) to find out which of the four checks fails and why.

### 6.2 A backup or upload references a bucket this deployment no longer talks to

This happens only after a **switch** — saving a different provider,
bucket, or effective endpoint than the one previously configured. The save
API refuses this with a `409` and the exact row counts unless you send the
typed `SWITCH` confirmation (the admin page's confirmation dialog does this
for you); the switch confirmation section of
[`docs/specs/storage-providers.md`](../specs/storage-providers.md) says exactly what counts as a switch and why `region`/`accessKeyId`/
`forcePathStyle` do not.

**⚠ Confirming the switch does not move any bytes.** Every existing
`storage_objects` row, avatar, and `database_backup_runs` archive keeps
pointing at the *old* bucket — this deployment simply no longer talks to
that location. There is no undo through the admin UI: if the switch was a
mistake, the fix is to save the configuration **back** to the previous
provider/bucket/credential (the old values, re-typed — the secret is
write-only and was never displayed, so you will need it from wherever it
was originally stored or generate a new one at the provider and update
there too). If the switch was intentional and you need the old objects
too, they remain readable at the old location with any tool that still has
a credential for it (this application will not read them once switched —
see the spec's "rejected alternatives" for why per-object legacy
resolution was not built); moving them is a deliberate migration, not a
button on this page.

**To avoid this entirely:** before changing `provider`, `bucket`, or the
effective endpoint on a deployment that has been in use, check
`GET /api/admin/storage-config` (or just attempt the save — the `409` body
names the counts) to know how many objects and backups are at stake before
confirming.

### 6.3 A rotated key breaks uploads immediately

Confirms the failure mode §4 warns about: the new secret does not have a
permission the old one had (see the `roundTrip` check's four sub-cases —
`write_denied`/`read_denied`/`delete_denied`/`read_mismatch` — in **Test
connection**'s results, §3). Fix the credential's policy at the provider
(widen it back to what §2's tables specify), then click **Test connection**
again — no further save is needed once the *provider-side* policy is
corrected, since this application already has the (correct) key id and
secret saved; only the provider's authorization needs to change.

If the rotation also lost the *old* key (deactivated or deleted at the
provider before confirming the new one worked), and the new one turns out
to be broken too, generate a **third** key at the provider with the
permissions from §2's tables, and save it the same way as §4.

## 7. Summary checklist

**First-time setup:**
- [ ] Provider decided (S3 / R2 / S3-compatible)
- [ ] Bucket name decided
- [ ] Credential created at the provider with at minimum `s3:PutObject`/
      `s3:GetObject`/`s3:DeleteObject`/list-bucket-equivalent on that bucket
      (§2)
- [ ] Signed in as a user holding `storage_config:read`/`storage_config:write`
- [ ] Configuration saved at `/admin/settings/storage`
- [ ] **Test connection** shows all four checks passed
- [ ] If the bucket did not exist: **Create bucket** ran to `created` or
      `already_exists` (not `guided`/`partial`) — or, if `guided`, the
      printed commands were run with an admin credential and **Test
      connection** re-confirms the bucket now exists

**Rotating a key:**
- [ ] New secret pasted into the (otherwise-empty) secret field, access key
      id updated if it changed too
- [ ] Saved
- [ ] **Test connection** passes with the new key, *before* deactivating
      the old one at the provider
- [ ] Old key deactivated/deleted at the provider once confirmed

**Switching provider/bucket/endpoint (understand before confirming):**
- [ ] Checked how many objects/backups are at the old location (the `409`
      body, or `GET /api/admin/storage-config`)
- [ ] Understood that confirming does **not** copy any bytes — the old
      location becomes unreachable from this deployment, permanently,
      until switched back
- [ ] Typed the `SWITCH` confirmation only after accepting that
