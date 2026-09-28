// =============================================================================
// Where a backup goes, and who is allowed to say so (issue #281, epic #254)
// =============================================================================
//
// Two pure decisions, extracted from the runner so that #283's `PUT` config
// endpoint can make the second one WITHOUT constructing a backup runner, and
// so that both can be tested without a storage provider, a database or a
// `pg_dump` binary.
//
// -----------------------------------------------------------------------------
// THE SERVER CHOOSES THE KEY. ALWAYS.
// -----------------------------------------------------------------------------
//
// No caller — not the admin who clicked, not the scheduler, not a future API
// body — supplies any part of a backup's storage key. A key is a write
// capability over exactly that object, and a key derived from anything a
// request carried is a path-traversal or an overwrite waiting to be found (the
// same rule `getSignedPutUrl` states in
// `storage/providers/storage-provider.interface.ts`).
//
// The derived key is:
//
//     database-backups/<slug>/<YYYY>/<MM>/<slug>-<YYYYMMDDTHHMMSSZ>-<runId>.dump
//
// and each part earns its place:
//
//   - `database-backups/` is a fixed, DESCRIPTIVE prefix (what these objects
//     are, not whose they are). It is what a bucket lifecycle rule, an IAM
//     policy or an operator's `aws s3 ls` targets, and it is why backups never
//     interleave with the `storage_objects` keys `ObjectsService` writes.
//   - `<slug>` is `APP_NAME` slugified — see below.
//   - `<YYYY>/<MM>` makes the prefix listable by month. A flat prefix with
//     years of nightly dumps in it is a `ListObjectsV2` that pages forever,
//     and the retention sweep in #282 is the exact caller that would pay for
//     it.
//   - The COMPACT TIMESTAMP sorts lexicographically in time order, so the
//     newest object is the last one in a listing without parsing anything.
//   - The RUN ID is what makes the key collision-free rather than merely
//     unlikely: two runs starting inside the same second (a scheduled tick and
//     a `pre_restore` backup) would otherwise derive the same key and the
//     second would silently overwrite the first. The single-active-run index
//     makes that nearly impossible; "nearly" is not a property to build an
//     overwrite on.
//
// -----------------------------------------------------------------------------
// THE NAME COMPONENT IS DERIVED FROM `APP_NAME`, NOT WRITTEN OUT
// -----------------------------------------------------------------------------
//
// This repository is a template: nothing in it may hard-code an application,
// product or repository name. `packages/shared`'s `APP_NAME` is the one line a
// fork edits to rebrand, and slugifying it here means two applications built
// from this template can share one bucket without their backups colliding —
// exactly the argument `jobs/job-temp.ts` makes for its temp-file prefix.
//
// `slugifyAppName` is a near-copy of the private helper in `job-temp.ts`
// rather than an import, and that is deliberate: `job-temp.ts` exports the
// PREFIX, not the function, and reaching into the job queue's internals to
// build a storage key would couple two subsystems that have nothing to do with
// each other. The duplicated code is nine lines with a test each.
//
// -----------------------------------------------------------------------------
// ONE ACTIVE PROVIDER AT A TIME, AND THE SETTING MUST AGREE WITH IT
// -----------------------------------------------------------------------------
//
// `StorageProvidersModule` binds exactly one implementation to
// `STORAGE_PROVIDER`, and since #373 (epic #372) that implementation follows a
// SETTING: `ResolvingStorageProvider` reads the `storage` namespace per call,
// so which provider is active — `s3`, `r2` or `s3compatible` — is a live value
// an administrator changes without a restart, not a constant compiled in.
//
// That makes `databaseBackup.storageProvider` a MORE useful field than it was,
// not a less useful one, and the rule it enforces is unchanged and still
// load-bearing: EMPTY (or absent) means "whatever is active", anything else
// must equal the ACTIVE provider's id, and a mismatch is a loud 400 rather than
// a silent write to the wrong place. What changed is only where "the active
// provider's id" comes from — `StorageConfigService.activeProvider()` rather
// than a literal — which is why {@link isUsableStorageProvider} and
// {@link assertUsableStorageProvider} take it as a REQUIRED argument. A default
// would be a hard-coded `'s3'` wearing a parameter, and it would be wrong for
// exactly the deployment that had configured something else.
//
// The setting still earns its place for two reasons, both sharpened by #373:
// it is the field a fork that registers a genuinely different provider (GCS,
// Azure Blob, a filesystem) will use, and it is the field that catches the
// operator who typed `gcs` here and believed their backups were going to Google
// Cloud Storage. It now also catches the operator who switched `storage
// .provider` from `s3` to `r2` and left this pinned to `s3` — a disagreement
// that could not exist before and is caught by the same one comparison.
//
// REJECTED: ignoring the setting when it disagrees. A backup that lands
// somewhere other than where the settings page says it lands is the single
// most dangerous kind of wrong in this subsystem, because it is only ever
// discovered during a restore.
//
// REJECTED: keeping a module-level `ACTIVE_STORAGE_PROVIDER_ID` constant and
// updating it. There is no longer any one value it could hold: two deployments
// built from this commit can be pointed at two different providers, and the
// same deployment can be pointed at a second one this afternoon. A constant
// would be a compile-time answer to a runtime question, and its failure mode is
// a `database_backup_runs` row that names the wrong provider — a lie recorded
// at the exact moment nobody is reading it.
// =============================================================================

import { DATABASE_BACKUPS_KEY_PREFIX } from '../storage/storage-key-prefixes';
import { APP_NAME } from '@app/shared';

import { DatabaseBackupStorageProviderError } from './db-backup.errors';

/** The fixed, product-neutral prefix every backup object lives under. */
// Derived, not repeated. The purge in `appctl deploy uninstall` builds its
// targets from `STORAGE_KEY_PREFIXES`, and a second literal here is exactly the
// drift that would let a purge report success while leaving every archive in
// the bucket. Kept exported under this name because it is what callers already
// import.
export const BACKUP_KEY_PREFIX = DATABASE_BACKUPS_KEY_PREFIX;

/**
 * The archive format recorded on every run, and the only one this repository
 * writes: `pg_dump -Fc`. See `buildPgDumpArgs` for why custom format is the
 * only one `pg_restore` can list, filter and restore in parallel.
 */
export const BACKUP_ARCHIVE_FORMAT = 'custom';

/**
 * The `Content-Type` a backup object is stored with.
 *
 * Deliberately opaque: a custom-format archive is compressed binary with no
 * registered media type, and claiming `application/gzip` would be a lie that
 * some client eventually acts on by trying to gunzip it.
 */
export const BACKUP_CONTENT_TYPE = 'application/octet-stream';

/** What the slug degrades to when `APP_NAME` slugifies to nothing. Carries no product name. */
const NEUTRAL_SLUG = 'app';

/**
 * A display name to a key-safe slug (`'Some Name'` → `'some-name'`).
 *
 * Falls back to {@link NEUTRAL_SLUG} rather than to an empty string, because
 * an empty component would collapse `<slug>-<timestamp>` into `-<timestamp>`
 * and produce a doubled separator in the prefix — cosmetic here, but the same
 * fallback in `job-temp.ts` is a genuine safety property, and having the two
 * behave differently is how someone later "fixes" the wrong one.
 */
function slugifyAppName(name: string = APP_NAME): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug.length > 0 ? slug : NEUTRAL_SLUG;
}

/** The slugified application name used in every backup key. Computed once; `APP_NAME` is a build-time constant. */
export const BACKUP_NAME_SLUG = slugifyAppName();

/**
 * `2026-09-07T02:00:00.000Z` → `20260907T020000Z`.
 *
 * UTC, unconditionally, and NOT the operator's `databaseBackup.timezone`. The
 * schedule is expressed in their timezone because that is when they want the
 * dump to run; the key is expressed in UTC because it is an identifier that
 * must stay sortable and unambiguous across a DST transition — a local-time
 * key repeats an hour every autumn.
 */
export function compactTimestamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The storage key for one backup run. Server-chosen, collision-free, sortable.
 *
 * @param at the run's start time — the caller's clock, so the key and the row
 * cannot disagree about when the backup happened.
 * @param runId the run's own id, generated before the insert precisely so the
 * key can contain it.
 */
export function buildBackupStorageKey(at: Date, runId: string): string {
  const year = at.getUTCFullYear().toString().padStart(4, '0');
  const month = (at.getUTCMonth() + 1).toString().padStart(2, '0');

  return (
    `${BACKUP_KEY_PREFIX}${BACKUP_NAME_SLUG}/${year}/${month}/` +
    `${BACKUP_NAME_SLUG}-${compactTimestamp(at)}-${runId}.dump`
  );
}

/**
 * Whether a `databaseBackup.storageProvider` value is usable by this
 * deployment.
 *
 * Empty/whitespace/absent is TRUE — it means "whatever provider is active",
 * which is the correct default for a deployment that has chosen one elsewhere.
 * Anything else must match `active` exactly, compared case-insensitively and
 * trimmed because the value is typed by a human into a settings form.
 *
 * SINCE #373 EMPTY IS ALSO THE SHIPPED DEFAULT, and is representable: the
 * schemas dropped `.min(1)` and `DEFAULT_SYSTEM_SETTINGS.databaseBackup
 * .storageProvider` is `''`. Before that, this branch was unreachable for a
 * fresh deployment — the default was the literal `'s3'`, so selecting R2 in the
 * `storage` namespace made this function return FALSE and failed every backup
 * on a value nobody had chosen. Nothing about the comparison below changed; a
 * mismatch an operator actually typed is still a loud 400, for the reason the
 * block comment at the top of this file gives.
 *
 * `active` IS REQUIRED AND HAS NO DEFAULT. It is the provider in force right
 * now — `StorageConfigService.activeProvider()` — and since #373 that is a
 * setting, not a constant. A default here could only be a literal `'s3'`, which
 * is precisely the wrong answer for the R2 deployment this check exists to
 * protect.
 */
export function isUsableStorageProvider(
  configured: string | null | undefined,
  active: string
): boolean {
  const trimmed = (configured ?? '').trim();

  return trimmed === '' || trimmed.toLowerCase() === active.toLowerCase();
}

/**
 * {@link isUsableStorageProvider}, as an assertion.
 *
 * THE ONE VALIDATION HELPER, called from both sides: #283's `PUT` config
 * endpoint (so a wrong value is rejected at the moment it is typed) and the
 * runner itself (so a wrong value that predates the check — a seed, a restored
 * settings blob, a provider swap — cannot quietly redirect tonight's backup).
 * Two call sites, one rule; a second copy of this comparison is how the form
 * and the runner start disagreeing.
 *
 * Both reach it through `DatabaseBackupRunnerService.assertStorageProviderUsable`,
 * which is what supplies `active` — one place that reads the live provider, so
 * the two sites cannot be handed different answers.
 *
 * @throws {DatabaseBackupStorageProviderError} which #283 maps to a 400.
 */
export function assertUsableStorageProvider(
  configured: string | null | undefined,
  active: string
): void {
  if (!isUsableStorageProvider(configured, active)) {
    throw new DatabaseBackupStorageProviderError((configured ?? '').trim(), active);
  }
}
