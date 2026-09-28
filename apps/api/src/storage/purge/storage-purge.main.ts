/**
 * `appctl deploy uninstall --purge-storage`, run INSIDE the api image.
 *
 * =============================================================================
 * ⚠ WHY THIS LIVES HERE AND NOT IN THE CLI
 * =============================================================================
 *
 * The portable deploy specification assumes the bucket and credential are in
 * the `.env`, and in this application they are not: since epic #372 the
 * provider, bucket, region and endpoint are the `storage` system-settings
 * namespace, and the secret access key is an encrypted row in `credentials`
 * under a per-purpose sub-key derived by `CredentialsService`.
 *
 * The obvious port — query PostgreSQL from the CLI and decrypt there — was
 * rejected for a concrete reason: `apps/cli/tsconfig.build.json` pins `rootDir`
 * to `./src`, so the CLI PROVABLY CANNOT import from `apps/api`. Doing the
 * crypto there would duplicate the sub-key label, the envelope layout AND the
 * prefix list into a package that cannot import the originals — two modules
 * required to agree with no mechanism to make them, which is the exact shape
 * behind almost every defect this epic has fixed.
 *
 * Run inside the image, it calls the application's own cipher, its own
 * `StorageConfigService` and its own `STORAGE_KEY_PREFIXES`, with the SDK
 * already present. Credentials arrive by name through compose's `env_file`;
 * the secret access key never leaves the container.
 *
 * =============================================================================
 * ⚠ TWO PHASES, BECAUSE CONSENT NEEDS SOMETHING TO BE ABOUT
 * =============================================================================
 *
 *   1. Default (`--json`): a DRY RUN. Counts objects and bytes under each
 *      prefix and prints them. Deletes nothing. The CLI renders this and asks
 *      the operator to type the bucket's name.
 *   2. `--confirm --bucket <typed>`: re-checks the typed name against the LIVE
 *      configuration *here*, inside the container, and refuses on a mismatch.
 *      The confirmation is verified where the truth is, not only where it was
 *      typed — a CLI that compared the name against its own copy would happily
 *      approve a purge of whatever the application had been repointed at since.
 *
 * =============================================================================
 * ⚠ VERSIONED BUCKETS, AND WHY UNKNOWN COUNTS AS VERSIONED
 * =============================================================================
 *
 * A versioned bucket keeps every object version and a delete marker for each
 * deletion, so `DeleteObject` on a listing leaves the data behind while
 * reporting success. Versions are therefore enumerated and removed by id.
 *
 * When the versioning status cannot be READ — no permission, an S3-compatible
 * endpoint that does not implement it — this treats the bucket as VERSIONED.
 * Assuming the cheaper answer is exactly what produces silent retention, and
 * silent retention is the one outcome a purge must never produce.
 */
import {
  DeleteObjectsCommand,
  GetBucketVersioningCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../../app.module';
import { STORAGE_KEY_PREFIXES } from '../storage-key-prefixes';
import { StorageConfigService } from '../config/storage-config.service';
import type { ResolvedStorageConfig } from '../config/storage-config';
import {
  buildS3ClientConfig,
  type S3StorageProviderConfig,
} from '../providers/s3/s3-storage.provider';

interface PrefixReport {
  prefix: string;
  objects: number;
  bytes: number;
}

interface PurgeReport {
  bucket: string;
  provider: string;
  endpoint: string | null;
  versioning: 'enabled' | 'suspended' | 'unversioned' | 'unknown';
  prefixes: PrefixReport[];
  totals: { objects: number; bytes: number };
  deleted: number;
  dryRun: boolean;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  try {
    const storage = app.get(StorageConfigService);
    const config = await storage.resolveActiveConfig({ fresh: true });

    if (config === null) {
      // Not an error: a deployment that never configured storage has nothing
      // to purge, and saying so is more useful than failing.
      process.stdout.write(
        `${JSON.stringify({ configured: false, reason: 'object storage is not configured for this deployment' })}\n`,
      );
      return;
    }

    const confirm = flag('confirm');
    const typed = value('bucket');

    if (confirm && typed !== config.bucket) {
      // Verified HERE, against the live configuration, not against whatever the
      // CLI last read.
      process.stderr.write(
        `Refusing: --bucket was ${String(typed)} but this deployment's bucket is ${config.bucket}.\n`,
      );
      process.exitCode = 2;
      return;
    }

    const report = await purge(config, { dryRun: !confirm });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

async function purge(
  config: ResolvedStorageConfig,
  options: { dryRun: boolean },
): Promise<PurgeReport> {
  // Reuses the driver's own client builder rather than re-deriving endpoint,
  // region and forcePathStyle. A second construction here would be a second
  // opinion about how to reach this bucket.
  const client = new S3Client(buildS3ClientConfig(config as S3StorageProviderConfig));

  const versioning = await readVersioning(client, config.bucket);

  const prefixes: PrefixReport[] = [];
  let deleted = 0;

  // ⚠ Targets come ONLY from the application's own list, never from a listing
  // of the whole bucket filtered afterwards. A filter can be inverted by a
  // later edit; enumerating a fixed list cannot be.
  for (const prefix of STORAGE_KEY_PREFIXES) {
    const report: PrefixReport = { prefix, objects: 0, bytes: 0 };

    if (versioning === 'unversioned') {
      deleted += await sweepObjects(client, config.bucket, prefix, report, options.dryRun);
    } else {
      // Versioned, OR the status could not be read. Every version and delete
      // marker goes by id: a plain DeleteObject on a versioned bucket adds a
      // marker and leaves the data, while reporting success.
      deleted += await sweepVersions(client, config.bucket, prefix, report, options.dryRun);
    }

    prefixes.push(report);
  }

  return {
    bucket: config.bucket,
    provider: config.provider,
    endpoint: config.endpoint ?? null,
    versioning,
    prefixes,
    totals: {
      objects: prefixes.reduce((sum, entry) => sum + entry.objects, 0),
      bytes: prefixes.reduce((sum, entry) => sum + entry.bytes, 0),
    },
    deleted,
    dryRun: options.dryRun,
  };
}

/**
 * The bucket's versioning status.
 *
 * ⚠ AN UNREADABLE ANSWER IS TREATED AS VERSIONED. Assuming the cheaper answer
 * is exactly what produces silent retention -- the purge would report complete
 * having left every version in place -- and silent retention is the one outcome
 * this must never produce. Reported as `unknown` so the operator sees which
 * branch was taken.
 */
async function readVersioning(
  client: S3Client,
  bucket: string,
): Promise<'enabled' | 'suspended' | 'unversioned' | 'unknown'> {
  try {
    const result = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    if (result.Status === 'Enabled') return 'enabled';
    if (result.Status === 'Suspended') return 'suspended';
    return 'unversioned';
  } catch {
    return 'unknown';
  }
}

/** Plain objects, for a bucket known not to be versioned. */
async function sweepObjects(
  client: S3Client,
  bucket: string,
  prefix: string,
  report: PrefixReport,
  dryRun: boolean,
): Promise<number> {
  let token: string | undefined;
  let deleted = 0;

  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );

    const objects = page.Contents ?? [];
    for (const object of objects) {
      report.objects += 1;
      report.bytes += object.Size ?? 0;
    }

    if (!dryRun && objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects.map((object) => ({ Key: object.Key as string })) },
        }),
      );
      deleted += objects.length;
    }

    token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
  } while (token !== undefined);

  return deleted;
}

/** Every version and delete marker, by id. */
async function sweepVersions(
  client: S3Client,
  bucket: string,
  prefix: string,
  report: PrefixReport,
  dryRun: boolean,
): Promise<number> {
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  let deleted = 0;

  do {
    const page = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix,
        KeyMarker: keyMarker,
        VersionIdMarker: versionMarker,
      }),
    );

    const versions = page.Versions ?? [];
    // Delete markers carry no bytes but MUST still be removed, or the bucket
    // keeps a tombstone for every object the purge claimed to have deleted.
    const markers = page.DeleteMarkers ?? [];

    for (const version of versions) {
      report.objects += 1;
      report.bytes += version.Size ?? 0;
    }

    const targets = [...versions, ...markers].map((entry) => ({
      Key: entry.Key as string,
      VersionId: entry.VersionId as string,
    }));

    if (!dryRun && targets.length > 0) {
      await client.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: targets } }),
      );
      deleted += targets.length;
    }

    keyMarker = page.IsTruncated === true ? page.NextKeyMarker : undefined;
    versionMarker = page.IsTruncated === true ? page.NextVersionIdMarker : undefined;
  } while (keyMarker !== undefined || versionMarker !== undefined);

  return deleted;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
