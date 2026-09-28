import { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  describeStorageConfig,
  fingerprintStorageConfig,
  type ResolvedStorageConfig,
} from '../config/storage-config';
import { StorageConfigService } from '../config/storage-config.service';
import { StorageNotConfiguredError } from '../config/storage-not-configured.error';
import {
  DEFAULT_S3_PART_SIZE,
  S3StorageProvider,
} from './s3/s3-storage.provider';
import type { StorageProvider } from './storage-provider.interface';
import type {
  MultipartUploadInit,
  SignedPutUrlOptions,
  SignedUrlOptions,
  StorageUploadOptions,
  StorageUploadResult,
  UploadPart,
} from './storage-provider.types';

// =============================================================================
// ResolvingStorageProvider — storage that follows the settings (issue #373)
// =============================================================================
//
// The implementation bound to `STORAGE_PROVIDER`. It implements the full
// `StorageProvider` interface and performs none of it: every method resolves
// the configuration in force RIGHT NOW, gets or builds the client for it, and
// delegates.
//
// -----------------------------------------------------------------------------
// WHY A DELEGATING PROVIDER RATHER THAN AN ASYNC FACTORY
// -----------------------------------------------------------------------------
//
// The obvious alternative is `{ provide: STORAGE_PROVIDER, useFactory: async
// () => new S3StorageProvider(await resolve()) }`. Nest supports it, it is
// three lines, and it is wrong for this feature in two ways that are not
// obvious until it breaks:
//
//   1. IT RESOLVES ONCE, AT BOOT. A factory runs when the container is built,
//      so the whole point of #373 — an administrator changing the bucket, or
//      rotating the key, WITHOUT A RESTART — is lost. Nine consumers would hold
//      an injected instance built from a configuration that stopped being true
//      the moment somebody saved the settings page.
//   2. IT MAKES AN UNCONFIGURED DEPLOYMENT UNBOOTABLE. An async factory that
//      cannot resolve must either throw (the API does not start — on a FRESH
//      INSTALL, which by definition has no storage configured yet, so nobody
//      could ever reach the settings page to fix it) or return something
//      broken. Both are worse than a 503 on the calls that actually need
//      storage.
//
// So the indirection is permanent and deliberate. It costs one object
// allocation and one `Map`-ish lookup per call; it buys live reconfiguration
// and a bootable empty install.
//
// -----------------------------------------------------------------------------
// WHAT DOES NOT CHANGE
// -----------------------------------------------------------------------------
//
// NOT ONE CONSUMER OF `STORAGE_PROVIDER` IS TOUCHED by this. All nine still
// inject the same token, call the same thirteen methods with the same
// signatures, and get the same results. That constraint is why this class
// implements the interface rather than replacing it, why `getBucket()` stays
// synchronous (see below), and why an unconfigured deployment raises an
// exception that already maps to a status code rather than a new error type
// every caller would have to learn.
// =============================================================================

/**
 * How many built clients are kept.
 *
 * TWO, not one and not many. One is not enough: a settings edit or a key
 * rotation happening while a long upload is in flight would evict the client
 * that upload is using, and `S3Client.destroy()` on a live pool aborts requests
 * mid-flight. Keeping the immediately-previous configuration lets work already
 * in progress finish against the client it started with.
 *
 * More than two buys nothing and costs sockets: configurations arrive one at a
 * time, from a human saving a form. This is a rotation window, not a cache of
 * tenants — a multi-tenant fork keying clients per tenant is a different design
 * and should say so rather than raise this number.
 */
const DELEGATE_CACHE_LIMIT = 2;

/** A built client, with the identity of the configuration that produced it. */
interface CachedDelegate {
  /** See `fingerprintStorageConfig` — a hash, never loggable. */
  fingerprint: string;
  provider: S3StorageProvider;
  /** Secret-free description, for the eviction log line. */
  label: string;
}

@Injectable()
export class ResolvingStorageProvider implements StorageProvider {
  private readonly logger = new Logger(ResolvingStorageProvider.name);

  /**
   * Built clients, most recently used first.
   *
   * An array rather than a `Map` because it holds at most
   * {@link DELEGATE_CACHE_LIMIT} entries and the order IS the eviction policy;
   * a `Map` would need a second structure to express "which one is oldest".
   */
  private delegates: CachedDelegate[] = [];

  constructor(
    private readonly storageConfig: StorageConfigService,
    private readonly configService: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // StorageProvider — all thirteen methods, each one line of delegation
  // ---------------------------------------------------------------------------
  //
  // Written out rather than generated with a `Proxy` or a loop over method
  // names. A proxy would satisfy the interface at runtime and NOT at compile
  // time: adding a fourteenth method to `StorageProvider` would type-check
  // here, ship, and fail in production as "is not a function". Thirteen
  // one-line methods make the compiler the thing that notices.

  async upload(
    key: string,
    stream: Readable,
    options: StorageUploadOptions,
  ): Promise<StorageUploadResult> {
    return (await this.delegate()).upload(key, stream, options);
  }

  async initMultipartUpload(
    key: string,
    options: StorageUploadOptions,
  ): Promise<MultipartUploadInit> {
    return (await this.delegate()).initMultipartUpload(key, options);
  }

  async getSignedUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn?: number,
  ): Promise<string> {
    return (await this.delegate()).getSignedUploadUrl(
      key,
      uploadId,
      partNumber,
      expiresIn,
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadPart[],
  ): Promise<StorageUploadResult> {
    return (await this.delegate()).completeMultipartUpload(key, uploadId, parts);
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    return (await this.delegate()).abortMultipartUpload(key, uploadId);
  }

  async download(key: string): Promise<Readable> {
    return (await this.delegate()).download(key);
  }

  async getSignedDownloadUrl(
    key: string,
    options?: SignedUrlOptions,
  ): Promise<string> {
    return (await this.delegate()).getSignedDownloadUrl(key, options);
  }

  async getSignedPutUrl(
    key: string,
    options?: SignedPutUrlOptions,
  ): Promise<string> {
    return (await this.delegate()).getSignedPutUrl(key, options);
  }

  async delete(key: string): Promise<void> {
    return (await this.delegate()).delete(key);
  }

  async getMetadata(key: string): Promise<Record<string, string> | null> {
    return (await this.delegate()).getMetadata(key);
  }

  async setMetadata(
    key: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    return (await this.delegate()).setMetadata(key, metadata);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.delegate()).exists(key);
  }

  /**
   * The active bucket — the one synchronous method on an interface whose
   * configuration is asynchronous.
   *
   * ── THE PROBLEM, STATED HONESTLY ────────────────────────────────────────────
   *
   * `StorageProvider.getBucket(): string` cannot await anything, and the bucket
   * now lives in a database row. Three of the four call sites
   * (`ObjectsService.initUpload`, `DatabaseBackupRunnerService.queueBackup` and
   * `claimRun`) write the returned value onto a ROW — `storage_objects.bucket`,
   * `database_backup_runs.bucket` — where it outlives the request and is later
   * used to find the object again.
   *
   * ── WHAT THIS DOES ──────────────────────────────────────────────────────────
   *
   * It answers from the bucket named by the last successful settings read
   * (`StorageConfigService.lastKnownBucket`), and throws
   * `StorageNotConfiguredError.unresolved()` — a 503 — when this process has no
   * such read, or that read named no bucket. The snapshot is warmed once at
   * startup and refreshed by every one of the twelve async methods above, so on
   * a configured deployment the answer is at most one storage operation (or
   * five seconds) old, and in practice is current.
   *
   * It does NOT wait for a fully resolved configuration — a deployment with a
   * bucket but no saved credential still has exactly one honest answer to "which
   * bucket?", and `queueBackup` has no async storage call to recover through.
   * Nothing is risked: every path that moves bytes goes through one of the
   * twelve methods above first, and they refuse an incomplete configuration
   * outright. See `StorageConfigService.lastPolicyBucket`.
   *
   * ── WHY NOT `''` ────────────────────────────────────────────────────────────
   *
   * Because it is a lie that is written to disk. An empty bucket on a
   * `storage_objects` row does not fail anything at the time; it fails months
   * later, when a cleanup sweep or a restore tries to address the object and
   * cannot say where it is. A 503 at the moment of the call is loud, immediate,
   * and fixable by the person who caused it.
   *
   * ── WHY NOT MAKE IT ASYNC ───────────────────────────────────────────────────
   *
   * That is the genuinely correct shape, and it is out of scope by construction:
   * it changes `StorageProvider`, and this part of #373 may not change a single
   * consumer of `STORAGE_PROVIDER`. It is also not free of judgement — the two
   * backup call sites use it to build a storage key inside a retry loop around
   * an INSERT, so awaiting there is a settings read inside a transaction-shaped
   * critical section. Worth doing deliberately, in its own change, with its own
   * tests; not as a side effect of making storage configurable.
   *
   * ── WHY NOT READ THE SETTINGS SYNCHRONOUSLY FROM A CACHE ────────────────────
   *
   * That is exactly what this does. The distinction worth stating is that the
   * snapshot is populated only by reads that SUCCEEDED and named a bucket —
   * never by the seeded defaults, which are the unconfigured state — so this
   * method returns a bucket somebody configured, or nothing at all.
   */
  getBucket(): string {
    const bucket = this.storageConfig.lastKnownBucket();

    if (!bucket) {
      throw StorageNotConfiguredError.unresolved();
    }

    return bucket;
  }

  // ---------------------------------------------------------------------------
  // Resolution and the delegate cache
  // ---------------------------------------------------------------------------

  /**
   * The client for the configuration in force, or a 503.
   *
   * ⚠ The resolved configuration holds a plaintext secret access key. It is a
   * local here and is handed only to `fingerprintStorageConfig` and to the
   * `S3StorageProvider` constructor; it is never assigned to a field, never
   * logged, and never reaches an error body.
   */
  private async delegate(): Promise<StorageProvider> {
    const resolution = await this.storageConfig.resolve();

    if (!resolution.configured) {
      // The missing FIELD NAMES travel to the caller; no value does. See
      // `StorageNotConfiguredError`.
      throw StorageNotConfiguredError.missing(
        resolution.provider,
        resolution.missing,
      );
    }

    return this.delegateFor(resolution.config);
  }

  /**
   * Get or build the client for exactly this configuration.
   *
   * The fingerprint — which includes the SECRET — is what makes a rotation take
   * effect without a restart: a new key produces a new fingerprint, misses the
   * cache, and builds a client with the new credential on the very next call.
   * See `fingerprintStorageConfig` for why it is a hash and not the values.
   */
  private delegateFor(config: ResolvedStorageConfig): StorageProvider {
    const fingerprint = fingerprintStorageConfig(config);
    const index = this.delegates.findIndex(
      (entry) => entry.fingerprint === fingerprint,
    );

    if (index >= 0) {
      // Move to front: with a limit of two, "least recently used" and "the one
      // we are not using" are the same thing, and this is what keeps an
      // in-flight upload's client from being the one evicted.
      const [hit] = this.delegates.splice(index, 1);
      this.delegates.unshift(hit);

      return hit.provider;
    }

    const label = describeStorageConfig(config);

    this.logger.log(`Building storage client: ${label}`);

    const provider = new S3StorageProvider({
      // #374: the kind travels WITH the configuration rather than being
      // inferred from it downstream. It is what selects R2's checksum flags and
      // what `S3StorageProvider.providerId` answers with; the endpoint and the
      // region in this same object were already resolved per provider by
      // `resolveStorageConfig`, so the driver never re-derives either.
      provider: config.provider,
      bucket: config.bucket,
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      // Passed through EXACTLY as resolved, `null` included: `null` is the
      // stored setting's "unset", and the per-vendor convention behind the
      // driver's `??` is the only place that decides what unset means. A
      // `?? false` here would be this layer answering a question it has no
      // basis to answer — the #374 regression, in one operator.
      forcePathStyle: config.forcePathStyle,
      // Deploy-time tuning, NOT an administrator setting: part size is about
      // this process's memory and the network between it and the provider, not
      // about which bucket is in use. It stays in `configuration.ts` beside the
      // other `storage.*` knobs that did not move into the settings row.
      partSize: this.configService.get<number>(
        'storage.partSize',
        DEFAULT_S3_PART_SIZE,
      ),
    });

    this.delegates.unshift({ fingerprint, provider, label });
    this.evictOverflow();

    return provider;
  }

  /**
   * Drop clients past the limit, closing their sockets.
   *
   * `destroy()` is not optional housekeeping: an `S3Client` holds an HTTP agent
   * with a keep-alive pool, so a deployment whose key is rotated weekly would
   * accumulate one dead pool per rotation for the life of the process. Same
   * failure, same fix, as `SmtpEmailProvider` closing the transporter it
   * replaces.
   */
  private evictOverflow(): void {
    while (this.delegates.length > DELEGATE_CACHE_LIMIT) {
      const evicted = this.delegates.pop();

      if (!evicted) {
        return;
      }

      this.logger.log(`Releasing superseded storage client: ${evicted.label}`);

      try {
        evicted.provider.destroy();
      } catch (error) {
        // A client that cannot be destroyed is a leaked socket pool, not a
        // failed request: the caller is in the middle of an upload that has
        // nothing to do with this. Log and carry on rather than turning
        // somebody else's successful configuration change into a 500.
        this.logger.warn(
          `Failed to release a superseded storage client: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
