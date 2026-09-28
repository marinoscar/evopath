import { STORAGE_TEST_KEY_PREFIX } from '../storage-key-prefixes';
import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Prisma } from '@prisma/client';

import { CredentialsService } from '../../credentials/credentials.service';
import { PrismaService } from '../../prisma/prisma.service';
import { buildS3ClientConfig } from '../providers/s3/s3-storage.provider';
import {
  STORAGE_CREDENTIAL_NAME,
  STORAGE_CREDENTIAL_PURPOSE,
} from '../storage-credential.constants';
import type { ResolvedStorageConfig } from './storage-config';
import {
  BUCKET_FORBIDDEN_CODES,
  BUCKET_MISSING_CODES,
  BUCKET_REGION_CODES,
  CREDENTIAL_REJECTION_CODES,
  describeStorageError,
  displayEndpoint,
  redactStorageSecret,
  resolveSubmittedStorageConfig,
  submittedStoragePolicy,
} from './storage-probe.support';
import type {
  StorageConnectionCheck,
  StorageConnectionTestResult,
  StorageTestCheckId,
  TestStorageConfigInput,
} from './dto/storage-connection-test.dto';

// =============================================================================
// StorageConnectionTestService — "does this configuration actually work?" (#375)
// =============================================================================
//
// THIS IS A DIAGNOSTIC, AND EVERY DECISION BELOW FOLLOWS FROM THAT. It is the
// storage counterpart of `EmailTestSendService`, deliberately built to the same
// contract, and that file's header is worth reading first: it returns a RESULT
// rather than throwing, because a refused request is a successful diagnosis and
// this app's error envelope would discard the one fact worth having.
//
// -----------------------------------------------------------------------------
// IT TESTS THE SUBMITTED BODY, NOT THE SAVED ROW
// -----------------------------------------------------------------------------
//
// An operator moving to a new bucket must be able to prove a configuration
// BEFORE committing the deployment to it. A test that could only exercise what
// had already been saved would mean the only way to try a new bucket is to break
// the running one first — and then discover, with uploads already failing, that
// the new key lacks `s3:PutObject`.
//
// Nothing here writes a settings row or a credential. The ONE thing it writes is
// a throwaway object in the target bucket, which it then deletes; that is not a
// side effect to be avoided, it is the only way to learn whether the credential
// has the permissions an upload needs.
//
// -----------------------------------------------------------------------------
// WHY `:write` AND NOT `:read`
// -----------------------------------------------------------------------------
//
// Because it is side-effecting: it puts an object into a bucket and asks a
// third-party endpoint to do work at the caller's request. `:read` is held by
// anyone who may LOOK at the configuration, and looking is not writing —
// the identical argument `EmailSettingsController` makes for its test send.
//
// -----------------------------------------------------------------------------
// ⚠ THE SECRET, AND WHERE IT IS ALLOWED TO GO
// -----------------------------------------------------------------------------
//
// This service is one of the two places in #375 that legitimately holds the
// plaintext secret access key: an S3 client cannot sign without it. It obeys
// `CredentialsService.getSecret`'s contract literally — read at the moment of
// use, held in a local, never stored on an instance field, never logged, and
// never returned. Every string that leaves here as an `error` goes through
// `redactStorageSecret` first, at a single exit point, because most of these
// messages are authored by the AWS SDK rather than by this repository.
// =============================================================================

/**
 * Key prefix for the throwaway probe object.
 *
 * A PREFIX RATHER THAN A BARE UUID so an operator (or a lifecycle rule) reading
 * a bucket listing can see at a glance what these are and that they are safe to
 * delete. Every probe object is deleted by the same request that created it;
 * this prefix exists for the case where the delete step itself is the one that
 * was denied, which is precisely when a stray object gets left behind and
 * somebody has to work out what it is.
 */
// Derived from the shared list. These probe objects are deleted on a
// BEST-EFFORT basis, so they genuinely linger after a failed round trip -- which
// is exactly why the prefix must be one the purge knows about rather than a
// literal only this file has ever seen.
export const STORAGE_PROBE_KEY_PREFIX = STORAGE_TEST_KEY_PREFIX;

/** How long the probe's presigned URL is valid. Seconds. */
const PRESIGNED_PROBE_TTL_SECONDS = 60;

/**
 * How long to wait for the presigned URL to answer.
 *
 * Short on purpose: this runs inside an HTTP request an administrator is
 * watching, and "the endpoint is not answering" is itself the diagnosis. A long
 * timeout would turn an unreachable host into a hung settings page.
 */
const PRESIGNED_PROBE_TIMEOUT_MS = 10_000;

/** Human labels for the four checks. Sent in the response so a client need not carry them. */
const CHECK_LABELS: Record<StorageTestCheckId, string> = {
  credentials: 'Credentials accepted',
  bucket: 'Bucket exists and is reachable',
  roundTrip: 'Write, read back and delete',
  presignedUrl: 'Presigned URL is valid and serves the object',
};

@Injectable()
export class StorageConnectionTestService {
  private readonly logger = new Logger(StorageConnectionTestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
  ) {}

  /**
   * Run the four checks against `input` and report each one separately.
   *
   * NEVER THROWS for a configuration or connectivity problem — every such
   * outcome is a check with `status: 'failed'`. It can still reject for a
   * genuine fault (the database being down while writing the audit row), which
   * is a 500 and correctly so.
   */
  async test(
    input: TestStorageConfigInput,
    actorUserId: string,
  ): Promise<StorageConnectionTestResult> {
    const attemptedAt = new Date();
    const policy = submittedStoragePolicy(input);

    // BLANK PRESERVES, exactly as on `PUT`. An admin who changed only the region
    // must not have to re-paste a credential they may not have to hand — and
    // "I did not retype it" is the overwhelmingly common case on a form that
    // always renders the field empty.
    const submittedSecret = input.secretAccessKey ?? '';
    const usedStoredSecret = submittedSecret.length === 0;
    const secret = usedStoredSecret
      ? await this.credentials.getSecret(
          STORAGE_CREDENTIAL_PURPOSE,
          STORAGE_CREDENTIAL_NAME,
        )
      : submittedSecret;

    const resolution = resolveSubmittedStorageConfig(policy, secret);

    if (!resolution.configured) {
      // ALL FOUR ARE `skipped`, NOT `failed`. Nothing was attempted, so this run
      // knows nothing about any of them — reporting four failures for a form
      // that is simply not finished would send an operator looking for four
      // problems they do not have. `success` is still false.
      const detail =
        `Nothing was attempted: ${resolution.missing.join(', ')} ` +
        `${resolution.missing.length === 1 ? 'is' : 'are'} not set.`;

      return this.assemble(
        policy,
        null,
        usedStoredSecret,
        attemptedAt,
        (['credentials', 'bucket', 'roundTrip', 'presignedUrl'] as const).map((id) =>
          this.check(id, 'skipped', 'not_configured', detail),
        ),
        actorUserId,
      );
    }

    const config = resolution.config;
    const client = new S3Client(buildS3ClientConfig(config));

    try {
      const checks = await this.runChecks(client, config, secret);

      return this.assemble(
        policy,
        config,
        usedStoredSecret,
        attemptedAt,
        checks,
        actorUserId,
      );
    } finally {
      // Always. One `S3Client` per test means one connection pool per test, and
      // a settings page an admin clicks six times would otherwise leak six.
      client.destroy();
    }
  }

  // ---------------------------------------------------------------------------
  // The checks
  // ---------------------------------------------------------------------------

  private async runChecks(
    client: S3Client,
    config: ResolvedStorageConfig,
    secret: string | null,
  ): Promise<StorageConnectionCheck[]> {
    const { credentials, bucket } = await this.checkCredentialsAndBucket(
      client,
      config,
      secret,
    );

    if (credentials.status !== 'passed' || bucket.status !== 'passed') {
      return [
        credentials,
        bucket,
        this.notAttempted('roundTrip'),
        this.notAttempted('presignedUrl'),
      ];
    }

    const { roundTrip, presignedUrl } = await this.checkRoundTrip(client, config, secret);

    return [credentials, bucket, roundTrip, presignedUrl];
  }

  /**
   * One `HeadBucket` answers both of the first two checks — and a second call,
   * on exactly one branch, answers the question `HeadBucket` structurally
   * cannot.
   *
   * ⚠ THE 403 PROBLEM, WHICH IS THE WHOLE REASON THIS METHOD IS NOT FOUR LINES.
   * `HeadBucket` is an HTTP `HEAD`, so its error responses HAVE NO BODY and
   * therefore no S3 error code — the SDK can only surface the bare status as
   * `NotFound` or `Forbidden`. A `404` is unambiguous: the request was
   * authenticated and there is no such bucket. A `403` is not, because it is the
   * status for BOTH "this key is real and not permitted on that bucket" and
   * "this endpoint does not recognise this key at all", and those have opposite
   * fixes.
   *
   * So on the `403` branch — and ONLY on that branch, so an ordinary healthy
   * configuration costs exactly one round trip — a `ListBuckets` is sent purely
   * as a CREDENTIAL PROBE. `ListBuckets` is a `GET` and its errors do carry a
   * code, so `InvalidAccessKeyId`/`SignatureDoesNotMatch` (the key is wrong)
   * separates cleanly from `AccessDenied` (the key is real and the policy does
   * not allow listing, which is what a well-scoped key looks like).
   *
   * Region mismatch is tested BEFORE missing and forbidden: S3 reports a signed
   * request sent to the wrong regional host as `AuthorizationHeaderMalformed` or
   * a `301 PermanentRedirect`, and both would otherwise be misread — the first
   * as a bad credential, the second as a missing bucket.
   */
  private async checkCredentialsAndBucket(
    client: S3Client,
    config: ResolvedStorageConfig,
    secret: string | null,
  ): Promise<{ credentials: StorageConnectionCheck; bucket: StorageConnectionCheck }> {
    try {
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }));

      return {
        credentials: this.check(
          'credentials',
          'passed',
          'ok',
          `The endpoint accepted the signature for access key ${config.accessKeyId}.`,
        ),
        bucket: this.check(
          'bucket',
          'passed',
          'ok',
          `Bucket "${config.bucket}" exists and this credential can inspect it.`,
        ),
      };
    } catch (error) {
      const described = describeStorageError(error, secret);

      if (described.unreachable) {
        return {
          credentials: this.check(
            'credentials',
            'failed',
            'endpoint_unreachable',
            `No response from ${config.endpoint ?? 'the AWS regional endpoint'}. ` +
              `Check the endpoint, DNS, TLS and any firewall between this server and the ` +
              `object store — the credential was never evaluated.`,
            described.message,
          ),
          bucket: this.notAttempted('bucket'),
        };
      }

      if (CREDENTIAL_REJECTION_CODES.has(described.code)) {
        return {
          credentials: this.check(
            'credentials',
            'failed',
            'credentials_rejected',
            `The endpoint refused access key ${config.accessKeyId}. Re-check the key id and ` +
              `paste the secret access key again — this is not a permissions problem, the ` +
              `credential itself was not accepted.`,
            described.message,
          ),
          bucket: this.notAttempted('bucket'),
        };
      }

      const credentialsAccepted = this.check(
        'credentials',
        'passed',
        'ok',
        `The endpoint evaluated the signature for access key ${config.accessKeyId}, so the ` +
          `credential itself is recognised.`,
      );

      if (BUCKET_REGION_CODES.has(described.code) || described.status === 301) {
        return {
          credentials: credentialsAccepted,
          bucket: this.check(
            'bucket',
            'failed',
            'bucket_region_mismatch',
            `Bucket "${config.bucket}" exists, but not in region "${config.region}". ` +
              `Correct the region — the provider's message below usually names the right one.`,
            described.message,
          ),
        };
      }

      if (BUCKET_MISSING_CODES.has(described.code) || described.status === 404) {
        return {
          credentials: credentialsAccepted,
          bucket: this.check(
            'bucket',
            'failed',
            'bucket_missing',
            `There is no bucket named "${config.bucket}" at this endpoint. Create it (the ` +
              `"Create bucket" action does this, or your provider's console will) or correct ` +
              `the name.`,
            described.message,
          ),
        };
      }

      if (BUCKET_FORBIDDEN_CODES.has(described.code) || described.status === 403) {
        // ⚠ The disambiguating second call. See this method's header.
        const credentialProbe = await this.probeCredentialValidity(client, secret);

        if (credentialProbe === 'rejected') {
          return {
            credentials: this.check(
              'credentials',
              'failed',
              'credentials_rejected',
              `The endpoint answered 403, and a follow-up request confirmed the credential ` +
                `itself is not recognised. Re-check the key id and paste the secret access ` +
                `key again.`,
              described.message,
            ),
            bucket: this.notAttempted('bucket'),
          };
        }

        return {
          credentials: credentialsAccepted,
          bucket: this.check(
            'bucket',
            'failed',
            'bucket_forbidden',
            `A bucket named "${config.bucket}" exists, and this credential may not inspect ` +
              `it — it is either owned by another account or the key's policy does not cover ` +
              `it. ⚠ Do NOT create a new bucket: widen the key's policy, or check the name ` +
              `for a typo that landed on somebody else's bucket.`,
            described.message,
          ),
        };
      }

      return {
        credentials: credentialsAccepted,
        bucket: this.check(
          'bucket',
          'failed',
          'unknown_error',
          `The endpoint refused the bucket check with an error this page does not recognise. ` +
            `The provider's own message is below.`,
          described.message,
        ),
      };
    }
  }

  /**
   * Is the credential itself valid, independently of any one bucket?
   *
   * `ListBuckets` is chosen because it is account-scoped rather than
   * bucket-scoped and because it is a `GET`, so its error response carries an S3
   * error code — which is the thing `HeadBucket` cannot provide and the only
   * reason this call exists. A SUCCESS and an `AccessDenied` are the SAME answer
   * here: both prove the signature was verified against a real key. Only an
   * explicit credential-rejection code is `'rejected'`.
   *
   * Anything else — an unreachable endpoint on the second call, an S3-compatible
   * server that does not implement `ListBuckets` at all — resolves to
   * `'accepted'`, deliberately. This probe exists to DOWNGRADE a bucket verdict
   * to a credential verdict when it can prove it should; when it cannot prove
   * anything, the original `bucket_forbidden` verdict stands rather than being
   * replaced by a guess.
   */
  private async probeCredentialValidity(
    client: S3Client,
    secret: string | null,
  ): Promise<'accepted' | 'rejected'> {
    try {
      await client.send(new ListBucketsCommand({}));
      return 'accepted';
    } catch (error) {
      const described = describeStorageError(error, secret);
      return CREDENTIAL_REJECTION_CODES.has(described.code) ? 'rejected' : 'accepted';
    }
  }

  /**
   * Write a throwaway object, read it back, fetch it through a presigned URL,
   * then delete it.
   *
   * ⚠ WHY THE DELETE HAPPENS LAST, AFTER THE PRESIGNED CHECK, AND IS STILL
   * REPORTED UNDER `roundTrip`. The two checks share ONE probe object: creating a
   * second one would double the writes into an administrator's bucket and prove
   * nothing extra. So the ordering is put -> get -> presign -> delete, while the
   * delete's outcome belongs to the check it is part of. The alternative
   * orderings are both worse: deleting before the presign leaves that check with
   * nothing to fetch, and reporting the delete under `presignedUrl` would tell an
   * operator whose key lacks `s3:DeleteObject` that their URLs are broken.
   *
   * ⚠ WHY THIS CHECK EXISTS WHEN `bucket` ALREADY PASSED. `HeadBucket` succeeding
   * proves `s3:ListBucket`-ish visibility and NOTHING about `s3:PutObject`,
   * `s3:GetObject` or `s3:DeleteObject`. A read-only key passes the first two
   * checks and fails every upload in the product.
   */
  private async checkRoundTrip(
    client: S3Client,
    config: ResolvedStorageConfig,
    secret: string | null,
  ): Promise<{ roundTrip: StorageConnectionCheck; presignedUrl: StorageConnectionCheck }> {
    const key = `${STORAGE_PROBE_KEY_PREFIX}${randomUUID()}.txt`;
    // Unique per run, so a stale object served from a cache (or from the wrong
    // bucket entirely, on a misconfigured path-style endpoint) cannot be mistaken
    // for this run's own bytes.
    const body = `storage-config-test ${randomUUID()}`;

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: 'text/plain',
        }),
      );
    } catch (error) {
      const described = describeStorageError(error, secret);

      return {
        roundTrip: this.check(
          'roundTrip',
          'failed',
          described.unreachable ? 'endpoint_unreachable' : 'write_denied',
          `Could not write a test object to "${config.bucket}". The bucket is reachable, so ` +
            `this is the credential's policy: it needs s3:PutObject on ${config.bucket}/*.`,
          described.message,
        ),
        presignedUrl: this.notAttempted('presignedUrl'),
      };
    }

    // From here on an object EXISTS in the administrator's bucket, and every exit
    // path below is responsible for removing it.
    try {
      const readBack = await this.readObject(client, config.bucket, key);

      if (readBack !== body) {
        await this.deleteQuietly(client, config.bucket, key);

        return {
          roundTrip: this.check(
            'roundTrip',
            'failed',
            'read_mismatch',
            `The object read back from "${config.bucket}" did not match the bytes written. ` +
              `That usually means requests are landing somewhere other than where you think ` +
              `— check the endpoint and the path-style setting.`,
          ),
          presignedUrl: this.notAttempted('presignedUrl'),
        };
      }
    } catch (error) {
      const described = describeStorageError(error, secret);
      await this.deleteQuietly(client, config.bucket, key);

      return {
        roundTrip: this.check(
          'roundTrip',
          'failed',
          described.unreachable ? 'endpoint_unreachable' : 'read_denied',
          `Wrote a test object to "${config.bucket}" but could not read it back. The ` +
            `credential needs s3:GetObject on ${config.bucket}/*.`,
          described.message,
        ),
        presignedUrl: this.notAttempted('presignedUrl'),
      };
    }

    const presignedUrl = await this.checkPresignedUrl(client, config, key, body, secret);

    try {
      await client.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
      );
    } catch (error) {
      const described = describeStorageError(error, secret);

      return {
        roundTrip: this.check(
          'roundTrip',
          'failed',
          'delete_denied',
          `Wrote and read a test object successfully, but could not delete it. The ` +
            `credential needs s3:DeleteObject on ${config.bucket}/*, and the test object ` +
            `"${key}" has been left behind — remove it by hand.`,
          described.message,
        ),
        presignedUrl,
      };
    }

    return {
      roundTrip: this.check(
        'roundTrip',
        'passed',
        'ok',
        `Wrote, read back and deleted a test object in "${config.bucket}".`,
      ),
      presignedUrl,
    };
  }

  /**
   * Presign a `GET` for the probe object and fetch it.
   *
   * ⚠ IT IS FETCHED FROM THIS PROCESS, so it proves the URL is SIGNED CORRECTLY
   * and that the object store serves it — it cannot prove the host is reachable
   * from a user's browser, and no server-side check can. What it does catch is
   * the failure class the three checks before it hide by construction:
   * presigning is a different code path from a signed API call, so a wrong region
   * or a wrong path-style setting can be tolerated on the direct call and still
   * produce a `SignatureDoesNotMatch` or a 404 on the URL every download link in
   * the product is built from.
   */
  private async checkPresignedUrl(
    client: S3Client,
    config: ResolvedStorageConfig,
    key: string,
    expected: string,
    secret: string | null,
  ): Promise<StorageConnectionCheck> {
    let url: string;

    try {
      url = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
        { expiresIn: PRESIGNED_PROBE_TTL_SECONDS },
      );
    } catch (error) {
      const described = describeStorageError(error, secret);

      return this.check(
        'presignedUrl',
        'failed',
        'unknown_error',
        'The presigned URL could not be generated at all, which is a client configuration ' +
          'problem rather than an object-store one.',
        described.message,
      );
    }

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(PRESIGNED_PROBE_TIMEOUT_MS),
      });

      if (!response.ok) {
        // ⚠ The body is read for the provider's XML error, then redacted like
        // every other message. It is capped: an endpoint that answers an error
        // with a whole HTML page must not put that page in a settings response.
        const detail = redactStorageSecret(
          (await response.text().catch(() => '')).slice(0, 500),
          secret,
        );

        return this.check(
          'presignedUrl',
          'failed',
          'presign_rejected',
          `The presigned URL answered ${response.status}. A signature error here with ` +
            `everything else passing points at the region or the path-style setting; a 404 ` +
            `points at the endpoint addressing the wrong bucket.`,
          detail || `HTTP ${response.status}`,
        );
      }

      const received = await response.text();

      if (received !== expected) {
        return this.check(
          'presignedUrl',
          'failed',
          'presign_mismatch',
          'The presigned URL answered successfully but served different bytes than were ' +
            'written. Requests are reaching an object other than the one addressed.',
        );
      }

      return this.check(
        'presignedUrl',
        'passed',
        'ok',
        'A presigned download URL was generated and served the test object correctly.',
      );
    } catch (error) {
      const described = describeStorageError(error, secret);

      return this.check(
        'presignedUrl',
        'failed',
        'presign_unreachable',
        `The presigned URL could not be fetched from this server. Note that browsers fetch ` +
          `these URLs directly, so the host must also be reachable — and CORS-enabled — from ` +
          `wherever this application is used.`,
        described.message,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** `GetObject` into a string. The probe object is a few dozen bytes. */
  private async readObject(
    client: S3Client,
    bucket: string,
    key: string,
  ): Promise<string> {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );

    // `transformToString` is the SDK's own helper and handles every stream shape
    // the runtime may hand back. Reaching into `Body` as a Node stream here would
    // be a second, weaker copy of that.
    return (await response.Body?.transformToString()) ?? '';
  }

  /**
   * Best-effort cleanup on a failure path.
   *
   * SWALLOWS ITS OWN ERROR ON PURPOSE. The caller is already returning a verdict
   * about a different, more important failure, and replacing "could not read the
   * object back" with "could not delete the object" would report the consequence
   * instead of the cause. A stray probe object is logged and named by its prefix.
   */
  private async deleteQuietly(
    client: S3Client,
    bucket: string,
    key: string,
  ): Promise<void> {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch {
      this.logger.warn(
        `Could not remove the storage test object "${key}" from bucket "${bucket}". ` +
          `It can be deleted by hand; every such key begins with "${STORAGE_PROBE_KEY_PREFIX}".`,
      );
    }
  }

  private check(
    id: StorageTestCheckId,
    status: StorageConnectionCheck['status'],
    code: StorageConnectionCheck['code'],
    detail: string,
    error?: string,
  ): StorageConnectionCheck {
    return {
      id,
      label: CHECK_LABELS[id],
      status,
      code,
      detail,
      error: error ?? null,
    };
  }

  /** A check that was not run because an earlier one failed. Not a failure. */
  private notAttempted(id: StorageTestCheckId): StorageConnectionCheck {
    return this.check(
      id,
      'skipped',
      'not_attempted',
      'Not attempted: an earlier check failed, so this one would say nothing useful.',
    );
  }

  /**
   * Build the response and record the attempt.
   *
   * EVERY ATTEMPT IS AUDITED, successful or not: "did anyone test this, and what
   * did it say?" is the first question asked when storage stops working, and an
   * audit trail that only records successes cannot answer it. The same reasoning
   * as `EmailTestSendService.audit`, and the same shape.
   */
  private async assemble(
    policy: ReturnType<typeof submittedStoragePolicy>,
    config: ResolvedStorageConfig | null,
    usedStoredSecret: boolean,
    attemptedAt: Date,
    checks: StorageConnectionCheck[],
    actorUserId: string,
  ): Promise<StorageConnectionTestResult> {
    const success = checks.every((entry) => entry.status === 'passed');

    const result: StorageConnectionTestResult = {
      success,
      provider: policy.provider,
      bucket: policy.bucket,
      region: config?.region ?? policy.region,
      effectiveEndpoint: config ? (config.endpoint ?? null) : displayEndpoint(policy),
      usedStoredSecret,
      checks,
      attemptedAt: attemptedAt.toISOString(),
    };

    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action: 'storage_config:test',
        targetType: 'system_settings',
        // The stable settings key, not a row id: a test on a fresh install runs
        // before any settings row exists, and `targetId` is non-nullable.
        targetId: 'storage',
        meta: {
          provider: policy.provider,
          bucket: policy.bucket,
          success,
          usedStoredSecret,
          // Codes only — the per-check `error` strings are the provider's words
          // and belong in the response an admin is looking at, not in a table
          // that outlives the incident.
          checks: checks.map((entry) => ({
            id: entry.id,
            status: entry.status,
            code: entry.code,
          })),
        } as unknown as Prisma.InputJsonValue,
      },
    });

    if (!success) {
      this.logger.warn(
        `Storage connection test failed for user ${actorUserId} ` +
          `(provider=${policy.provider} bucket=${policy.bucket || '(none)'}): ` +
          checks
            .filter((entry) => entry.status !== 'passed')
            .map((entry) => `${entry.id}=${entry.code}`)
            .join(' '),
      );
    }

    return result;
  }
}
