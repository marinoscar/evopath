import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { CredentialsService } from '../../credentials/credentials.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import type {
  StorageProviderKind,
  SystemStorageValue,
} from '../../common/schemas/settings.schema';
import {
  STORAGE_CREDENTIAL_NAME,
  STORAGE_CREDENTIAL_PURPOSE,
} from '../storage-credential.constants';
import {
  resolveStorageConfig,
  type ResolvedStorageConfig,
  type StorageConfigResolution,
} from './storage-config';

// =============================================================================
// StorageConfigService — the live storage configuration (issue #373, epic #372)
// =============================================================================
//
// Joins the two halves of a storage configuration, per call:
//
//     system_settings.storage        (provider, bucket, region, endpoint,
//                                     accountId, accessKeyId, forcePathStyle)
//   + credentials(storage, default)  (the secret access key, decrypted)
//   → ResolvedStorageConfig | "not configured, here is what is missing"
//
// -----------------------------------------------------------------------------
// WHY THIS RESOLVES PER CALL AND NOT AT BOOT
// -----------------------------------------------------------------------------
//
// Because the configuration is now something an administrator edits in a
// running application, and "no restart" is the entire feature. A value captured
// in a constructor is a value that is wrong from the moment the settings page
// is saved until somebody remembers to redeploy — and the two occasions this
// matters most are exactly the two where a redeploy is least welcome: an
// operator repairing a broken bucket during an incident, and a CREDENTIAL
// ROTATION, where the old key stops working the instant the new one is issued.
//
// It also removes a failure mode the environment-variable version had by
// construction: reading configuration in a constructor means an unreadable
// database (or an unconfigured deployment) can prevent the API from STARTING.
// Nothing in this file is touched at construction; a fresh install with no
// storage at all boots normally, serves every non-storage route, and answers
// storage calls with a 503 that says which field to fill in.
//
// -----------------------------------------------------------------------------
// WHY THE SECRET IS FETCHED HERE AND NEVER STORED ON THE INSTANCE
// -----------------------------------------------------------------------------
//
// `CredentialsService.getSecret` is the one method in the credential store that
// yields plaintext, and its contract is explicit: use it at the moment of use
// and let it go out of scope — "do not cache it on an instance field". This
// service holds to that literally. The CACHE BELOW HOLDS THE SETTINGS HALF
// ONLY; the secret is re-read from the store on every single resolve and is
// handed straight to the caller that needs it.
//
// That is a deliberate trade, and it is worth naming both sides:
//
//   * COST — one indexed `credentials` lookup and one AES-GCM decrypt per
//     storage operation. A batch of ten presigned part URLs is ten of them.
//     Both are microseconds against an operation that is about to talk to an
//     object store over the network.
//   * BENEFIT — no long-lived plaintext copy of the deployment's storage
//     credential sitting on a singleton where a heap dump, a `JSON.stringify`
//     in a debug log or a future `describe()`-style method would find it; and a
//     rotated key takes effect on the NEXT CALL rather than up to a TTL later.
//     A five-second window in which a revoked key is still being used is a
//     five-second window nobody would be able to explain afterwards.
//
// The settings half is cached because it is not secret, it is read on paths
// with no administrator anywhere near them (an avatar download, a job's
// presigned URL), and it changes only when somebody saves a form.
//
// REJECTED: caching the RESOLVED config, secret and all, for the same five
// seconds. It reads as the obvious optimisation and it quietly undoes both
// benefits above at once.
//
// -----------------------------------------------------------------------------
// NOTHING HERE READS `process.env`
// -----------------------------------------------------------------------------
//
// The saved settings namespace and the encrypted credential store are the only
// two sources of a storage configuration, and this service reads exactly those
// two. There is no environment variable that names a bucket, a region, an
// endpoint or a key — epic #372 removed the last of them — so there is no
// second place for an operator to have configured storage, and no precedence
// rule for anybody to have to remember.
// =============================================================================

/**
 * How long a settings read is reused before the row is consulted again.
 *
 * Deliberately the same five seconds as `MAINTENANCE_PERSISTED_CACHE_MS`, and
 * for the same reasons: short enough that an edit on one instance takes effect
 * across a fleet within a poll or two, long enough that a burst of storage
 * calls (an upload's ten presigned parts, a retention sweep's hundred deletes)
 * costs one `system_settings` read rather than a hundred. The instance that
 * HANDLED the write does not wait at all — see {@link
 * StorageConfigService.invalidateCache}.
 *
 * ⚠ THIS BOUNDS THE SETTINGS HALF ONLY. The secret access key is never cached,
 * so a rotation is never delayed by this constant. See the file header.
 */
export const STORAGE_POLICY_CACHE_MS = 5_000;

@Injectable()
export class StorageConfigService implements OnModuleInit {
  private readonly logger = new Logger(StorageConfigService.name);

  /**
   * Last successful settings read, with the time it was taken.
   *
   * Same shape as `MaintenanceModeService.cache`, deliberately: `{ value,
   * readAt }` with a module-level TTL is the pattern this repository already
   * uses for "a settings namespace read on a hot path", and a second shape for
   * the same job is a second thing to reason about at 3am.
   *
   * CARRIES NO SECRET — `SystemStorageValue` has no field capable of holding
   * one, and there is a compile-time proof of that in `settings.schema.ts`.
   */
  private cache: { value: SystemStorageValue; readAt: number } | null = null;

  /**
   * The configured bucket from the most recent successful settings read, or
   * `null` when there has not been one (or it was empty).
   *
   * Exists for exactly one caller: `StorageProvider.getBucket()`, which is
   * synchronous by interface and cannot await a settings read. See the long
   * comment on that method in `ResolvingStorageProvider` for why answering from
   * a snapshot is the honest option and what the alternatives cost.
   *
   * SET FROM THE SETTINGS HALF ALONE — it does not wait for a COMPLETE
   * resolution, and deliberately so. A deployment whose bucket is typed but
   * whose secret access key is not yet saved still has exactly one answer to
   * "which bucket is this?", and withholding it would strand the one caller
   * that cannot recover: `DatabaseBackupRunnerService.queueBackup` calls
   * `getBucket()` with no async storage call anywhere in its path, so a refusal
   * there would repeat forever rather than resolving on a retry. Nothing is
   * risked by answering: every path that actually MOVES BYTES goes through one
   * of the twelve async methods first, and those refuse an incomplete
   * configuration outright, so a bucket name recorded from here can never
   * describe an object that was written somewhere else.
   *
   * DELIBERATELY NOT CLEARED when a later read comes back empty. The rows this
   * answers for are records of where bytes went, and the last bucket this
   * process knew about remains the truthful answer for work already in flight.
   */
  private lastPolicyBucket: string | null = null;

  constructor(
    private readonly systemSettings: SystemSettingsService,
    private readonly credentials: CredentialsService,
  ) {}

  /**
   * Take one best-effort SETTINGS read at startup, so the synchronous
   * `getBucket()` has an answer before the first storage call rather than after
   * it.
   *
   * WHY THIS IS NEEDED AT ALL: `DatabaseBackupRunnerService.queueBackup` calls
   * `getBucket()` with no preceding async storage operation anywhere in its
   * path. Without a warm read, the first backup queued after a restart would be
   * refused on a correctly configured deployment — and, because nothing in that
   * path ever resolves asynchronously, refused again on every retry. A dead end
   * that only some unrelated avatar download can clear is not a failure an
   * operator can be expected to diagnose.
   *
   * ⚠ IT READS THE SETTINGS HALF ONLY, NEVER THE CREDENTIAL. Boot is not a
   * moment of use: the secret would be decrypted, not cached (this service
   * never caches it), and immediately discarded — a plaintext read with no
   * consumer, on a path with no storage operation behind it. That is precisely
   * what `CredentialsService.getSecret`'s contract rules out, and
   * `test/settings/email-settings.integration.spec.ts` asserts the equivalent
   * property for SMTP. The bucket is in the settings half, so nothing is lost.
   *
   * DETACHED AND SWALLOWED, ON PURPOSE. It is one indexed read; it must not
   * delay boot, and it must never prevent it. A database that is not up yet
   * simply leaves the snapshot empty and the next storage call reads properly.
   * This is emphatically not "work outside the queue" in the sense of the
   * job-queue rule — it is a single SELECT, not an activity with a duration
   * worth accounting for.
   */
  onModuleInit(): void {
    void this.readPolicy({ fresh: true })
      .then((policy) => {
        // Asked of the snapshot `readPolicy` has just filled rather than of
        // `policy.bucket` directly, so this line and `getBucket()` can never
        // disagree about whether this process knows a bucket.
        const bucket = this.lastKnownBucket();

        if (!bucket) {
          this.logger.warn(
            'No object storage bucket is configured. Storage operations will be ' +
              'refused with 503 until one is saved.',
          );
          return;
        }

        // The non-secret half only — this line cannot say whether the
        // credential exists, and must not pretend to. `describeStorageConfig`
        // is used on the first real resolve instead (see
        // `ResolvingStorageProvider.delegateFor`).
        this.logger.log(
          `Object storage settings loaded: ${policy.provider} bucket=${bucket}`,
        );
      })
      .catch((error) => {
        this.logger.warn(
          `Could not read the storage settings at startup; they will be read ` +
            `again on the first storage operation: ${
              error instanceof Error ? error.message : String(error)
            }`,
        );
      });
  }

  /**
   * Drop the cached settings read, so the next resolve consults the row.
   *
   * CALL THIS SYNCHRONOUSLY, BEFORE THE AUDIT WRITE, from any path that changes
   * the storage settings — exactly as `MaintenanceModeService.setMaintenance`
   * does with its own cache. The ordering is the whole point: between the
   * settings write committing and this call, this instance would still answer
   * storage questions from the value it read up to five seconds ago, and an
   * administrator who saved a corrected bucket and immediately retried an
   * upload would watch it fail against the old one. Anything that awaits in
   * between — an audit row, a notification, a log flush — widens that window
   * for no benefit; the admin write path in a later part of #373 is the caller
   * this exists for.
   *
   * It does NOT need to be called after a credential write: the secret is never
   * cached, so a rotation is already live on the next call.
   */
  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * The active configuration, or `null` when this deployment has none.
   *
   * The narrow form, for the callers that only need "can I use storage": it
   * throws away the reason. Anything that has to EXPLAIN the answer — a 503
   * body, part 3's connection test, an admin page's readiness badge — should
   * call {@link resolve} and keep the missing-field list, which is the one
   * thing a person needs and the one thing `null` cannot carry.
   *
   * ⚠ The returned object holds a plaintext secret access key. See
   * `ResolvedStorageConfig`.
   */
  async resolveActiveConfig(
    options: { fresh?: boolean } = {},
  ): Promise<ResolvedStorageConfig | null> {
    const resolution = await this.resolve(options);

    return resolution.configured ? resolution.config : null;
  }

  /**
   * The active configuration, or the list of fields that are missing.
   *
   * `fresh: true` bypasses the settings cache, and is for the caller that is
   * SHOWING the configuration to a person or TESTING it — an operator looking
   * at a settings page, or clicking "test connection", must never be answered
   * from a value up to five seconds stale, however cheap that would be. It is
   * the same option, with the same meaning, as `MaintenanceModeService.resolve`.
   *
   * Never returns a partially-built config: the completeness rules live in
   * `resolveStorageConfig`, in one place, and this method's only job is to
   * gather the two inputs they judge.
   */
  async resolve(
    options: { fresh?: boolean } = {},
  ): Promise<StorageConfigResolution> {
    const policy = await this.readPolicy(options);

    // Read on EVERY resolve, cached nowhere. See the file header — this is the
    // line that makes a key rotation take effect on the next call.
    const secretAccessKey = await this.credentials.getSecret(
      STORAGE_CREDENTIAL_PURPOSE,
      STORAGE_CREDENTIAL_NAME,
    );

    return resolveStorageConfig(policy, secretAccessKey);
  }

  /**
   * Which vendor's flavour of the S3 protocol this deployment is pointed at,
   * right now.
   *
   * ── WHAT IT IS FOR ──────────────────────────────────────────────────────────
   *
   * The rows that RECORD WHERE BYTES WENT — `storage_objects.storage_provider`
   * and `database_backup_runs.storage_provider` — plus the one rule that
   * compares `databaseBackup.storageProvider` against the provider actually in
   * force (`assertUsableStorageProvider`). Before #373 all four of those read a
   * hard-coded `'s3'`, which stopped being true the moment an operator could
   * select `r2`.
   *
   * ── WHY ASYNC, WHEN `getBucket()` IS NOT ────────────────────────────────────
   *
   * Because nothing forces this one to be synchronous, and `getBucket()`'s own
   * comment says plainly that async "is the genuinely correct shape" — it stays
   * synchronous only because `StorageProvider.getBucket(): string` is fixed by
   * an interface. There is no interface method returning a provider kind, and
   * all four recording sites above are already `async`, so the honest read is
   * available to every one of them and {@link lastKnownBucket}'s snapshot
   * machinery is not needed a second time.
   *
   * It goes through the SAME cached {@link readPolicy} the snapshot is filled
   * from, deliberately: a row whose `bucket` came from `getBucket()` and whose
   * provider came from here then names one configuration rather than two, and a
   * change an administrator saves reaches both within the same five seconds.
   *
   * ── WHY THERE IS NO "DON'T KNOW" ANSWER ─────────────────────────────────────
   *
   * Unlike the bucket, which genuinely may not have been configured yet (and
   * whose absence `getBucket()` must raise a 503 for rather than invent), this
   * namespace ALWAYS names a provider: `provider` is a closed enum with a
   * schema default, and a damaged row degrades to that default field by field.
   * "No storage configured" is `bucket === ''`, never a missing provider — so
   * there is nothing here for a caller to handle and no fallback for one to get
   * wrong.
   */
  async activeProvider(
    options: { fresh?: boolean } = {},
  ): Promise<StorageProviderKind> {
    return (await this.readPolicy(options)).provider;
  }

  /**
   * The configured bucket as of the last successful settings read, or `null`.
   *
   * SYNCHRONOUS, and that is its entire reason for existing: `StorageProvider
   * .getBucket()` is synchronous by interface. This method reads nothing, waits
   * for nothing, falls back to no default and guesses at nothing — `null` means
   * "this process does not know", which the caller must surface rather than
   * paper over with an empty string.
   */
  lastKnownBucket(): string | null {
    return this.lastPolicyBucket;
  }

  /**
   * Read the `storage` settings namespace, through the cache.
   *
   * Goes through `SystemSettingsService.getStoragePolicy`, which is narrow by
   * design: it does not create the settings row as a side effect of serving a
   * file, and it projects the stored value through `readKnownSettings`, so a
   * damaged row degrades field by field to `DEFAULT_SYSTEM_SETTINGS.storage` —
   * the UNCONFIGURED state — rather than to a half-built client pointed
   * somewhere nobody chose.
   *
   * UNLIKE `MaintenanceModeService.readPersisted`, A FAILED READ IS NOT
   * SWALLOWED HERE. That service degrades to its last known value because a
   * global guard runs on every request and an unreadable database must not turn
   * every call into a 500. This one is different in the way that matters: a
   * storage call that cannot read its configuration has nothing useful to do
   * with a stale one — it would build a client, talk to an object store and
   * possibly WRITE BYTES using a configuration this process can no longer
   * confirm. Letting the error surface (as the 500 it is) is the honest
   * outcome, and the cache above still absorbs the ordinary case.
   */
  private async readPolicy(
    options: { fresh?: boolean } = {},
  ): Promise<SystemStorageValue> {
    const now = Date.now();

    if (
      !options.fresh &&
      this.cache &&
      now - this.cache.readAt < STORAGE_POLICY_CACHE_MS
    ) {
      return this.cache.value;
    }

    const value = await this.systemSettings.getStoragePolicy();

    this.cache = { value, readAt: now };

    // The synchronous snapshot is refreshed HERE — on every settings read,
    // whether it came from a resolve, the startup warm or a `fresh` admin read
    // — rather than at the end of a complete resolution. See
    // `lastPolicyBucket` for why the credential's presence is not a condition.
    if (value.bucket) {
      this.lastPolicyBucket = value.bucket;
    }

    return value;
  }
}
