import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateBucketCommand,
  PutBucketCorsCommand,
  PutBucketEncryptionCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Prisma } from '@prisma/client';

import { CredentialsService } from '../../credentials/credentials.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { StorageProviderKind } from '../../common/schemas/settings.schema';
import { buildS3ClientConfig } from '../providers/s3/s3-storage.provider';
import {
  STORAGE_CREDENTIAL_NAME,
  STORAGE_CREDENTIAL_PURPOSE,
} from '../storage-credential.constants';
import type { ResolvedStorageConfig } from './storage-config';
import {
  BUCKET_ALREADY_OWNED_CODES,
  BUCKET_NAME_TAKEN_CODES,
  CREDENTIAL_REJECTION_CODES,
  describeStorageError,
  displayEndpoint,
  resolveSubmittedStorageConfig,
  submittedStoragePolicy,
  type DescribedStorageError,
} from './storage-probe.support';
import type {
  ProvisionStorageBucketInput,
  StorageBucketOutcome,
  StorageBucketProvisionResult,
  StorageBucketStep,
  StorageBucketStepId,
} from './dto/storage-bucket-provision.dto';

// =============================================================================
// StorageBucketProvisionService — create the bucket, correctly (#375, epic #372)
// =============================================================================
//
// The remedy the connection test's `bucket_missing` verdict points at, and the
// one place in this application that knows what a bucket has to LOOK LIKE for
// this product to work:
//
//   1. it exists, in the right region;
//   2. it is not public (AWS only — R2 buckets are private by default and there
//      is no equivalent API to call);
//   3. it encrypts at rest (AWS only — R2 does this unconditionally);
//   4. ⚠ its CORS rule lets the browser read `ETag` back.
//
// Step 4 is the one that is easy to get wrong and impossible to diagnose. The
// browser multipart path reads the `ETag` off each `UploadPart` response and
// posts the list to `POST /storage/objects/:id/upload/complete`
// (`objects.service.ts`), and a cross-origin `fetch` CANNOT READ a response
// header that is absent from `Access-Control-Expose-Headers`. A bucket whose
// CORS rule omits `ExposeHeaders: ['ETag']` therefore transfers every byte of a
// large upload successfully and then fails to complete it, with a browser-side
// error that mentions neither CORS nor the bucket. That is why this endpoint
// exists at all rather than a documentation page saying "create a bucket".
//
// -----------------------------------------------------------------------------
// ⚠ `guided` IS A 200 AND IS A DESIGNED-IN PATH, NOT A FALLBACK
// -----------------------------------------------------------------------------
//
// An application credential without `s3:CreateBucket` is the ORDINARY
// least-privilege configuration, and R2 API tokens are routinely minted with
// object permissions and no bucket admin at all. See the header of
// `dto/storage-bucket-provision.dto.ts` for the full argument; it is the same
// one `db-backup`'s `CREATEROLE` and `CREATEDB` gates make, and this service is
// deliberately consistent with them down to the shape of the guidance object.
//
// -----------------------------------------------------------------------------
// THE CORS ORIGIN COMES FROM `APP_URL`, NEVER FROM THE REQUEST
// -----------------------------------------------------------------------------
//
// A caller-supplied origin would make this a "grant any website write access to
// our bucket" button, reachable by anyone holding `storage_config:write`. The
// deployment already knows its own origin; there is nothing for a request to
// add, and a field for one is a field somebody will eventually fill in.
// =============================================================================

/** Human labels for the four steps. Sent in the response, like the test's. */
const STEP_LABELS: Record<StorageBucketStepId, string> = {
  create: 'Create the bucket',
  publicAccessBlock: 'Block all public access',
  encryption: 'Enable default encryption at rest',
  cors: 'Apply the CORS rule browsers need',
};

/**
 * The region AWS treats as "no location constraint".
 *
 * ⚠ `us-east-1` MUST NOT BE SENT AS A `LocationConstraint`. S3 rejects
 * `CreateBucket` with `InvalidLocationConstraint` when the constraint names the
 * default region — the one region for which the field must be omitted entirely.
 * It is the single most common way a hand-written `create-bucket` call fails.
 */
const S3_DEFAULT_REGION = 'us-east-1';

/**
 * The methods a browser performs directly against the bucket.
 *
 * `PUT` for each multipart part and for a simple upload, `GET` for a download,
 * `HEAD` because the SDK and several browsers preflight one. `POST` and
 * `DELETE` are deliberately absent: nothing in this application asks a browser
 * to do either directly, and a CORS rule is a grant, not documentation.
 */
const BROWSER_METHODS = ['PUT', 'GET', 'HEAD'];

/**
 * ⚠ THE ONE HEADER THE BROWSER MUST BE ABLE TO READ BACK. See this file's
 * header — without it, large uploads transfer completely and then cannot be
 * completed.
 */
const EXPOSED_HEADERS = ['ETag'];

/** How long a browser may cache the preflight. One hour. */
const CORS_MAX_AGE_SECONDS = 3600;

/**
 * Repository-relative path to the storage-configuration runbook.
 *
 * Mirrors `RESTORE_RUNBOOK_PATH` (`db-backup/restore-preflight.service.ts`) and
 * `NODE_JOB_SECRETS_RUNBOOK_PATH` (`db-backup/pg-job-role.broker.ts`): one
 * exported constant, read by the `guided` outcome below, so the string is
 * never retyped at the point of use. Wired up by this epic's documentation
 * issue (#378) once the file it names actually exists — see
 * `docs/runbooks/storage-configuration.md`. Before that file existed this was
 * `null`, on purpose: a link to a runbook that is not there is worse than no
 * link, and `test/docs-links.spec.ts` would not have caught a stale path
 * pointing at prose rather than a real endpoint response.
 */
export const STORAGE_RUNBOOK_PATH = 'docs/runbooks/storage-configuration.md';

@Injectable()
export class StorageBucketProvisionService {
  private readonly logger = new Logger(StorageBucketProvisionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Create and harden the bucket the submitted configuration names.
   *
   * NEVER THROWS for a storage failure — see the DTO's header for why every
   * outcome, including `guided` and `failed`, travels as a 200 payload.
   */
  async provision(
    input: ProvisionStorageBucketInput,
    actorUserId: string,
  ): Promise<StorageBucketProvisionResult> {
    const attemptedAt = new Date();
    const policy = submittedStoragePolicy(input);

    // Blank preserves, identically to `PUT` and `POST /test`.
    const submittedSecret = input.secretAccessKey ?? '';
    const secret = submittedSecret
      ? submittedSecret
      : await this.credentials.getSecret(
          STORAGE_CREDENTIAL_PURPOSE,
          STORAGE_CREDENTIAL_NAME,
        );

    const resolution = resolveSubmittedStorageConfig(policy, secret);

    if (!resolution.configured) {
      const detail =
        `Nothing was attempted: ${resolution.missing.join(', ')} ` +
        `${resolution.missing.length === 1 ? 'is' : 'are'} not set.`;

      return this.record(
        {
          outcome: 'failed',
          provider: policy.provider,
          bucket: policy.bucket,
          region: policy.region,
          effectiveEndpoint: displayEndpoint(policy),
          steps: (
            ['create', 'publicAccessBlock', 'encryption', 'cors'] as const
          ).map((id) => this.step(id, 'skipped', detail)),
          guidance: null,
          corsOrigin: null,
          attemptedAt: attemptedAt.toISOString(),
        },
        actorUserId,
      );
    }

    const config = resolution.config;
    const client = new S3Client(buildS3ClientConfig(config));

    try {
      return this.record(
        await this.runSteps(client, config, secret, attemptedAt),
        actorUserId,
      );
    } finally {
      client.destroy();
    }
  }

  // ---------------------------------------------------------------------------
  // The steps
  // ---------------------------------------------------------------------------

  private async runSteps(
    client: S3Client,
    config: ResolvedStorageConfig,
    secret: string | null,
    attemptedAt: Date,
  ): Promise<StorageBucketProvisionResult> {
    const base = {
      provider: config.provider,
      bucket: config.bucket,
      region: config.region,
      effectiveEndpoint: config.endpoint ?? null,
      attemptedAt: attemptedAt.toISOString(),
    };

    const create = await this.createBucket(client, config, secret);

    if (create.verdict === 'guided') {
      // ⚠ NOT AN ERROR. The bucket does not exist and this credential cannot
      // make one; the commands say who can. Every later step is skipped because
      // there is nothing to apply them to — and saying "skipped" rather than
      // "failed" is what keeps an operator from believing four things are wrong
      // when one is.
      return {
        ...base,
        outcome: 'guided',
        steps: [
          create.step,
          this.blocked('publicAccessBlock'),
          this.blocked('encryption'),
          this.blocked('cors'),
        ],
        guidance: {
          reason: create.reason,
          commands: buildGuidedBucketCommands(config, this.corsOrigin()),
          // See STORAGE_RUNBOOK_PATH above — this epic's documentation issue
          // (#378) wrote the file, so the guided path now names it, the same
          // way the db-backup guided paths name theirs.
          runbook: STORAGE_RUNBOOK_PATH,
        },
        corsOrigin: this.corsOrigin(),
      };
    }

    if (create.verdict === 'failed') {
      return {
        ...base,
        outcome: 'failed',
        steps: [
          create.step,
          this.blocked('publicAccessBlock'),
          this.blocked('encryption'),
          this.blocked('cors'),
        ],
        guidance: null,
        corsOrigin: this.corsOrigin(),
      };
    }

    const hardening = await this.harden(client, config, secret);
    const steps = [create.step, ...hardening];
    const anyFailed = hardening.some((step) => step.status === 'failed');

    return {
      ...base,
      // ⚠ `partial` EXISTS SO A HALF-HARDENED BUCKET IS NEVER REPORTED AS
      // `created`. The bucket is there and usable; something an operator must
      // finish by hand is not. Reporting success would mean nobody ever learns
      // that the CORS rule did not land.
      outcome: anyFailed
        ? 'partial'
        : create.verdict === 'already_exists'
          ? 'already_exists'
          : 'created',
      steps,
      guidance: null,
      corsOrigin: this.corsOrigin(),
    };
  }

  /**
   * `CreateBucket`, with the `LocationConstraint` rule that is the usual reason
   * a hand-written create fails.
   *
   * ── WHO GETS A `LocationConstraint` ────────────────────────────────────────
   *
   *   `s3`           — only when the region is NOT `us-east-1`. Sending it for
   *                    the default region is an `InvalidLocationConstraint`
   *                    error; omitting it for any other region silently creates
   *                    the bucket in `us-east-1` instead.
   *   `r2`           — never. R2 has one namespace per account and rejects the
   *                    constraint; its `region` is the literal `auto`, which is
   *                    not a location at all.
   *   `s3compatible` — never. On MinIO, Ceph and the rest the server's region is
   *                    a property of the DEPLOYMENT, fixed by its own
   *                    configuration, and a bucket does not get to choose one.
   *                    Several of them reject the element outright.
   *
   * ── WHY "ALREADY EXISTS AND IS YOURS" IS A PASS ────────────────────────────
   *
   * `BucketAlreadyOwnedByYou` means the goal — a bucket of this name, owned by
   * this account — is already met, so the step passed and the hardening below
   * still runs. This is what makes the endpoint safe to press twice, and it is
   * also the repair path for a bucket created by hand without a CORS rule.
   * `BucketAlreadyExists` is the opposite and is a hard failure: the name
   * belongs to somebody else, and no amount of retrying changes that.
   */
  private async createBucket(
    client: S3Client,
    config: ResolvedStorageConfig,
    secret: string | null,
  ): Promise<
    | { verdict: 'created' | 'already_exists'; step: StorageBucketStep }
    | { verdict: 'failed'; step: StorageBucketStep }
    | { verdict: 'guided'; step: StorageBucketStep; reason: string }
  > {
    const needsLocationConstraint =
      config.provider === 's3' && config.region !== S3_DEFAULT_REGION;

    try {
      await client.send(
        new CreateBucketCommand({
          Bucket: config.bucket,
          ...(needsLocationConstraint
            ? {
                CreateBucketConfiguration: {
                  LocationConstraint: config.region as never,
                },
              }
            : {}),
        }),
      );

      return {
        verdict: 'created',
        step: this.step(
          'create',
          'passed',
          `Created bucket "${config.bucket}"` +
            (needsLocationConstraint ? ` in region ${config.region}.` : '.'),
        ),
      };
    } catch (error) {
      const described = describeStorageError(error, secret);

      if (BUCKET_ALREADY_OWNED_CODES.has(described.code)) {
        return {
          verdict: 'already_exists',
          step: this.step(
            'create',
            'passed',
            `Bucket "${config.bucket}" already exists and belongs to this account; it was ` +
              `left as it is. The settings below were still applied.`,
          ),
        };
      }

      if (BUCKET_NAME_TAKEN_CODES.has(described.code)) {
        return {
          verdict: 'failed',
          step: this.step(
            'create',
            'failed',
            `The name "${config.bucket}" is already taken by another account. Bucket names ` +
              `are global per provider — choose a different one.`,
            described.message,
          ),
        };
      }

      if (CREDENTIAL_REJECTION_CODES.has(described.code)) {
        return {
          verdict: 'failed',
          step: this.step(
            'create',
            'failed',
            `The endpoint refused access key ${config.accessKeyId}. Fix the credential ` +
              `first — this is not a bucket-permissions problem.`,
            described.message,
          ),
        };
      }

      if (described.unreachable) {
        return {
          verdict: 'failed',
          step: this.step(
            'create',
            'failed',
            `No response from ${config.endpoint ?? 'the AWS regional endpoint'}. ` +
              `Nothing was created.`,
            described.message,
          ),
        };
      }

      if (isBucketCreationDenied(described)) {
        const reason =
          `Access key ${config.accessKeyId} is not permitted to create buckets on this ` +
          `${config.provider === 'r2' ? 'Cloudflare account' : 'endpoint'}. That is the ` +
          `ordinary shape of a least-privilege credential, not a fault — create the bucket ` +
          `with an administrative credential using the commands below, then run the ` +
          `connection test again.`;

        return {
          verdict: 'guided',
          step: this.step('create', 'failed', reason, described.message),
          reason,
        };
      }

      return {
        verdict: 'failed',
        step: this.step(
          'create',
          'failed',
          'The bucket could not be created, and the error is not one this page recognises. ' +
            "The provider's own message is below.",
          described.message,
        ),
      };
    }
  }

  /**
   * The three settings applied to a bucket that now exists.
   *
   * ⚠ `publicAccessBlock` AND `encryption` ARE SKIPPED FOR `r2` AND
   * `s3compatible`, AND THAT IS NOT LAZINESS. `PutPublicAccessBlock` and
   * `PutBucketEncryption` are AWS-specific APIs. R2 buckets are private by
   * default and encrypted at rest unconditionally, so the goal each step exists
   * for is already met; an S3-compatible server is free not to implement either
   * call. Sending them anyway would turn "this vendor does not have that API"
   * into a failed step and a `partial` outcome on a bucket that is in exactly
   * the state we wanted.
   *
   * `cors` runs everywhere: it is the only one of the three whose absence BREAKS
   * the product rather than loosening it.
   */
  private async harden(
    client: S3Client,
    config: ResolvedStorageConfig,
    secret: string | null,
  ): Promise<StorageBucketStep[]> {
    const awsOnly = config.provider === 's3';
    const steps: StorageBucketStep[] = [];

    steps.push(
      awsOnly
        ? await this.attempt(
            'publicAccessBlock',
            () =>
              client.send(
                new PutPublicAccessBlockCommand({
                  Bucket: config.bucket,
                  PublicAccessBlockConfiguration: {
                    BlockPublicAcls: true,
                    IgnorePublicAcls: true,
                    BlockPublicPolicy: true,
                    RestrictPublicBuckets: true,
                  },
                }),
              ),
            'All four public-access blocks are on; nothing in this bucket can be made ' +
              'public by an ACL or a bucket policy.',
            `The bucket exists but public access could not be blocked. The credential needs ` +
              `s3:PutBucketPublicAccessBlock — apply it by hand before putting anything in ` +
              `this bucket.`,
            secret,
          )
        : this.step(
            'publicAccessBlock',
            'skipped',
            providerSkipReason(config.provider, 'buckets are private by default'),
          ),
    );

    steps.push(
      awsOnly
        ? await this.attempt(
            'encryption',
            () =>
              client.send(
                new PutBucketEncryptionCommand({
                  Bucket: config.bucket,
                  ServerSideEncryptionConfiguration: {
                    Rules: [
                      {
                        ApplyServerSideEncryptionByDefault: {
                          // SSE-S3 rather than SSE-KMS, deliberately: KMS needs a
                          // key this application does not own, adds a per-request
                          // charge and a second permission to every reader, and
                          // buys nothing for the threat this default addresses
                          // (media at rest on somebody else's disk). A deployment
                          // that needs KMS configures it on the bucket itself.
                          SSEAlgorithm: 'AES256',
                        },
                        BucketKeyEnabled: true,
                      },
                    ],
                  },
                }),
              ),
            'Default server-side encryption (AES256) is on for every new object.',
            `The bucket exists but default encryption could not be set. The credential needs ` +
              `s3:PutEncryptionConfiguration.`,
            secret,
          )
        : this.step(
            'encryption',
            'skipped',
            providerSkipReason(config.provider, 'objects are encrypted at rest by default'),
          ),
    );

    const origin = this.corsOrigin();

    steps.push(
      await this.attempt(
        'cors',
        () =>
          client.send(
            new PutBucketCorsCommand({
              Bucket: config.bucket,
              CORSConfiguration: {
                CORSRules: [
                  {
                    AllowedOrigins: [origin],
                    AllowedMethods: BROWSER_METHODS,
                    // `*` because the SDK sends `x-amz-*`, `content-type` and
                    // `content-md5` on an upload and the exact set varies by
                    // command; enumerating them is a list that goes stale
                    // silently, and a REQUEST header allowance grants nothing a
                    // caller could not already send.
                    AllowedHeaders: ['*'],
                    // ⚠ NOT OPTIONAL. See this file's header.
                    ExposeHeaders: EXPOSED_HEADERS,
                    MaxAgeSeconds: CORS_MAX_AGE_SECONDS,
                  },
                ],
              },
            }),
          ),
        `Browsers at ${origin} may PUT, GET and HEAD objects, and can read the ETag back — ` +
          `which multipart uploads need in order to complete.`,
        `The bucket exists but the CORS rule could not be applied. ⚠ Browser uploads will ` +
          `transfer fully and then FAIL TO COMPLETE until a rule exposing the ETag header is ` +
          `in place. The credential needs s3:PutBucketCORS.`,
        secret,
      ),
    );

    return steps;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Run one hardening call and turn its outcome into a step. Never throws. */
  private async attempt(
    id: StorageBucketStepId,
    run: () => Promise<unknown>,
    successDetail: string,
    failureDetail: string,
    secret: string | null,
  ): Promise<StorageBucketStep> {
    try {
      await run();
      return this.step(id, 'passed', successDetail);
    } catch (error) {
      const described = describeStorageError(error, secret);
      return this.step(id, 'failed', failureDetail, described.message);
    }
  }

  /**
   * The origin the CORS rule allows: this deployment's own `APP_URL`.
   *
   * Normalised to an ORIGIN — scheme, host and port, no path and no trailing
   * slash — because that is what the CORS specification compares and what S3
   * matches on. `https://app.example.com/` with a trailing slash matches
   * nothing, silently, which is the same class of invisible failure the missing
   * `ExposeHeaders` produces.
   */
  private corsOrigin(): string {
    const appUrl = this.config.get<string>('appUrl') ?? '';

    try {
      return new URL(appUrl).origin;
    } catch {
      // `appUrl` always has a default in `configuration.ts`, so reaching this
      // means somebody set `APP_URL` to something that is not a URL. Returning
      // it unchanged puts the bad value in front of the administrator in the
      // response rather than hiding it behind an exception.
      return appUrl;
    }
  }

  private step(
    id: StorageBucketStepId,
    status: StorageBucketStep['status'],
    detail: string,
    error?: string,
  ): StorageBucketStep {
    return { id, label: STEP_LABELS[id], status, detail, error: error ?? null };
  }

  /** A step skipped because the bucket it would configure does not exist. */
  private blocked(id: StorageBucketStepId): StorageBucketStep {
    return this.step(
      id,
      'skipped',
      'Not attempted: there is no bucket to apply it to yet.',
    );
  }

  /**
   * Record the attempt and return it.
   *
   * Every attempt, whatever the outcome — creating a bucket is a change to
   * infrastructure, and "who added this bucket, and when?" is a question an
   * audit log should be able to answer. `error` strings are not stored: they are
   * the provider's words, they belong in the response the administrator is
   * reading, and a table that outlives the incident is not where they help.
   */
  private async record(
    result: StorageBucketProvisionResult,
    actorUserId: string,
  ): Promise<StorageBucketProvisionResult> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action: 'storage_config:provision_bucket',
        targetType: 'system_settings',
        targetId: 'storage',
        meta: {
          provider: result.provider,
          bucket: result.bucket,
          region: result.region,
          outcome: result.outcome,
          corsOrigin: result.corsOrigin,
          steps: result.steps.map((step) => ({ id: step.id, status: step.status })),
        } as unknown as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      `Bucket provisioning by user ${actorUserId}: ${result.outcome} ` +
        `(provider=${result.provider} bucket=${result.bucket || '(none)'})`,
    );

    return result;
  }
}

/**
 * Does this error mean "this credential may not create buckets", as opposed to
 * "something else went wrong"?
 *
 * ⚠ THE PREDICATE THE `guided` OUTCOME TURNS ON, so it is deliberately narrow.
 * `AccessDenied` and a `403` are the permission answer. `NotImplemented` and
 * `MethodNotAllowed` are an S3-compatible endpoint that does not offer bucket
 * creation over the API at all, which needs the same remedy (create it with the
 * vendor's own tool) and would be actively misleading as a generic failure.
 * Everything else falls through to `failed`, because guidance that cannot help
 * is worse than none: an operator who runs a `create-bucket` by hand against an
 * unreachable endpoint learns nothing they did not already know.
 */
function isBucketCreationDenied(described: DescribedStorageError): boolean {
  return (
    described.code === 'AccessDenied' ||
    described.code === 'Forbidden' ||
    described.code === 'AllAccessDisabled' ||
    described.code === 'NotImplemented' ||
    described.code === 'MethodNotAllowed' ||
    described.status === 403 ||
    described.status === 405 ||
    described.status === 501
  );
}

/** Why an AWS-only step does not apply to this provider. */
function providerSkipReason(provider: StorageProviderKind, because: string): string {
  const vendor = provider === 'r2' ? 'Cloudflare R2' : 'this S3-compatible endpoint';

  return (
    `Not applicable: this is an AWS S3 API, and on ${vendor} ${because}. Nothing was ` +
    `sent, and nothing needs to be.`
  );
}

/**
 * The ready-to-paste command block for the `guided` outcome.
 *
 * ⚠ REAL VALUES, NO PLACEHOLDERS. This deployment's bucket, region, endpoint and
 * origin are substituted in. A block with `<your-bucket>` in it is not a
 * deliverable, it is homework — the same standard `buildCreateRoleGrantCommands`
 * holds itself to in `db-backup/pg-job-role.broker.ts`.
 *
 * Exported for the spec, which asserts the ETag exposure survives into the
 * guided path too: an operator who takes this route must not end up with the
 * one misconfiguration this whole endpoint exists to prevent.
 */
export function buildGuidedBucketCommands(
  config: ResolvedStorageConfig,
  corsOrigin: string,
): string {
  const corsJson = JSON.stringify(
    {
      CORSRules: [
        {
          AllowedOrigins: [corsOrigin],
          AllowedMethods: BROWSER_METHODS,
          AllowedHeaders: ['*'],
          // ⚠ Carried into the guided path deliberately. See this file's header.
          ExposeHeaders: EXPOSED_HEADERS,
          MaxAgeSeconds: CORS_MAX_AGE_SECONDS,
        },
      ],
    },
    null,
    2,
  );

  if (config.provider === 'r2') {
    return [
      '# Run with a Cloudflare account that may administer R2 buckets.',
      '',
      `wrangler r2 bucket create ${config.bucket}`,
      '',
      '# The CORS rule. ⚠ ExposeHeaders must include ETag, or multipart uploads',
      '# transfer completely and then fail to complete in the browser.',
      `cat > cors.json <<'JSON'`,
      corsJson,
      'JSON',
      `wrangler r2 bucket cors set ${config.bucket} --file cors.json`,
      '',
      '# R2 buckets are private and encrypted at rest by default, so there is no',
      '# public-access block or encryption step to run.',
    ].join('\n');
  }

  const endpointFlag = config.endpoint ? ` --endpoint-url ${config.endpoint}` : '';
  const locationFlag =
    config.provider === 's3' && config.region !== S3_DEFAULT_REGION
      ? ` --create-bucket-configuration LocationConstraint=${config.region}`
      : '';

  const lines = [
    '# Run with a credential that may create buckets (your platform or root account).',
    '',
    `aws s3api create-bucket --bucket ${config.bucket} --region ${config.region}` +
      `${locationFlag}${endpointFlag}`,
  ];

  if (config.provider === 's3') {
    lines.push(
      '',
      `aws s3api put-public-access-block --bucket ${config.bucket} \\`,
      '  --public-access-block-configuration ' +
        'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true',
      '',
      `aws s3api put-bucket-encryption --bucket ${config.bucket} \\`,
      '  --server-side-encryption-configuration ' +
        `'{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'`,
    );
  }

  lines.push(
    '',
    '# The CORS rule. ⚠ ExposeHeaders must include ETag, or multipart uploads',
    '# transfer completely and then fail to complete in the browser.',
    `cat > cors.json <<'JSON'`,
    corsJson,
    'JSON',
    `aws s3api put-bucket-cors --bucket ${config.bucket}${endpointFlag} \\`,
    '  --cors-configuration file://cors.json',
  );

  return lines.join('\n');
}
