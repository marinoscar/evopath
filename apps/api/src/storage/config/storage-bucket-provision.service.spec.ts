// =============================================================================
// StorageBucketProvisionService — tests (issue #375, epic #372)
// =============================================================================
//
// Same mocking discipline as `storage-connection-test.service.spec.ts`: the AWS
// SDK is replaced at the module level before the subject imports it, so nothing
// here creates a bucket anywhere.
//
// The three things worth protecting, and each has its own block below:
//
//   1. ⚠ `ExposeHeaders: ['ETag']` reaches the bucket — on the API path AND in
//      the `guided` command block. It is the one setting whose absence breaks
//      large uploads invisibly, so it is asserted rather than trusted.
//   2. `guided` is produced for a permissions failure and NOT for anything else.
//      It is the designed-in answer for a least-privilege credential; producing
//      it for an unreachable endpoint would hand an operator commands that
//      cannot help.
//   3. `LocationConstraint` follows the rule that actually breaks
//      `create-bucket` calls: present for a non-default AWS region, absent for
//      `us-east-1`, absent for everyone else.
// =============================================================================

const s3ConstructorMock = jest.fn();
const s3SendMock = jest.fn();
const s3DestroyMock = jest.fn();

function commandMock(name: string) {
  return jest.fn().mockImplementation((input: unknown) => ({
    __command: name,
    input,
  }));
}

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation((config: unknown) => {
    s3ConstructorMock(config);
    return { send: s3SendMock, destroy: s3DestroyMock };
  }),
  CreateBucketCommand: commandMock('CreateBucketCommand'),
  PutPublicAccessBlockCommand: commandMock('PutPublicAccessBlockCommand'),
  PutBucketEncryptionCommand: commandMock('PutBucketEncryptionCommand'),
  PutBucketCorsCommand: commandMock('PutBucketCorsCommand'),
  // Pulled in transitively by `s3-storage.provider.ts`.
  HeadBucketCommand: commandMock('HeadBucketCommand'),
  ListBucketsCommand: commandMock('ListBucketsCommand'),
  GetObjectCommand: commandMock('GetObjectCommand'),
  PutObjectCommand: commandMock('PutObjectCommand'),
  DeleteObjectCommand: commandMock('DeleteObjectCommand'),
  HeadObjectCommand: commandMock('HeadObjectCommand'),
  CopyObjectCommand: commandMock('CopyObjectCommand'),
  CreateMultipartUploadCommand: commandMock('CreateMultipartUploadCommand'),
  UploadPartCommand: commandMock('UploadPartCommand'),
  CompleteMultipartUploadCommand: commandMock('CompleteMultipartUploadCommand'),
  AbortMultipartUploadCommand: commandMock('AbortMultipartUploadCommand'),
  NotFound: class MockNotFound extends Error {},
}));

jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn().mockImplementation(() => ({ done: jest.fn() })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

import { StorageBucketProvisionService } from './storage-bucket-provision.service';
import type { ProvisionStorageBucketInput } from './dto/storage-bucket-provision.dto';

const APP_URL = 'https://app.example.com';

function input(
  overrides: Partial<ProvisionStorageBucketInput> = {},
): ProvisionStorageBucketInput {
  return {
    provider: 's3',
    bucket: 'example-bucket',
    region: 'us-west-2',
    endpoint: '',
    accountId: '',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'submitted-secret-access-key-987654',
    forcePathStyle: null,
    ...overrides,
  };
}

function s3Error(name: string, status: number | null, message?: string): Error {
  const error = new Error(message ?? `${name} was returned by the endpoint`);
  error.name = name;
  if (status !== null) {
    (error as unknown as { $metadata: unknown }).$metadata = {
      httpStatusCode: status,
    };
  }
  return error;
}

function transportError(code: string): Error {
  const error = new Error(`connect ${code} 10.0.0.4:9000`);
  (error as unknown as { code: string }).code = code;
  return error;
}

/** Fail exactly the named commands; everything else succeeds. */
function failOn(failures: Record<string, Error>): void {
  s3SendMock.mockImplementation(async (command: { __command: string }) => {
    const failure = failures[command.__command];
    if (failure) throw failure;
    return {};
  });
}

/** The input a command was constructed with, or undefined if it was never sent. */
function sentInput(name: string): any {
  return s3SendMock.mock.calls
    .map(([command]: [{ __command: string; input: unknown }]) => command)
    .find((command) => command.__command === name)?.input;
}

describe('StorageBucketProvisionService', () => {
  let service: StorageBucketProvisionService;
  let prisma: { auditEvent: { create: jest.Mock } };
  let credentials: { getSecret: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    failOn({});

    prisma = { auditEvent: { create: jest.fn().mockResolvedValue({}) } };
    credentials = { getSecret: jest.fn().mockResolvedValue('stored-secret-value-123') };

    service = new StorageBucketProvisionService(
      prisma as never,
      credentials as never,
      { get: jest.fn().mockReturnValue(APP_URL) } as never,
    );
  });

  function byId(steps: Array<{ id: string }>): Record<string, any> {
    return Object.fromEntries(steps.map((step) => [step.id, step]));
  }

  // ==========================================================================
  // ⚠ The ETag exposure — the reason this endpoint exists
  // ==========================================================================

  describe('the CORS rule', () => {
    it('exposes ETag, allows PUT/GET/HEAD, and uses APP_URL as the only origin', async () => {
      const result = await service.provision(input(), 'admin-1');

      const cors = sentInput('PutBucketCorsCommand');
      const rule = cors.CORSConfiguration.CORSRules[0];

      // ⚠ Without this, browser multipart uploads transfer every byte and then
      // cannot be completed — the `ETag` header is unreadable from JavaScript.
      expect(rule.ExposeHeaders).toEqual(['ETag']);
      expect(rule.AllowedMethods).toEqual(['PUT', 'GET', 'HEAD']);
      // The origin comes from the deployment, never from the request body.
      expect(rule.AllowedOrigins).toEqual([APP_URL]);
      expect(result.corsOrigin).toBe(APP_URL);
    });

    it('normalises APP_URL to an origin — a trailing path would match nothing', async () => {
      service = new StorageBucketProvisionService(
        prisma as never,
        credentials as never,
        { get: jest.fn().mockReturnValue('https://app.example.com/some/path/') } as never,
      );

      await service.provision(input(), 'admin-1');

      expect(
        sentInput('PutBucketCorsCommand').CORSConfiguration.CORSRules[0].AllowedOrigins,
      ).toEqual(['https://app.example.com']);
    });

    it('runs for EVERY provider — it is the one step whose absence breaks the product', async () => {
      for (const provider of ['s3', 'r2', 's3compatible'] as const) {
        jest.clearAllMocks();
        failOn({});

        await service.provision(
          input(
            provider === 'r2'
              ? { provider, region: 'auto', accountId: 'abc123' }
              : provider === 's3compatible'
                ? { provider, endpoint: 'http://minio:9000', region: '' }
                : { provider },
          ),
          'admin-1',
        );

        expect(sentInput('PutBucketCorsCommand')).toBeDefined();
      }
    });
  });

  // ==========================================================================
  // LocationConstraint
  // ==========================================================================

  describe('CreateBucket', () => {
    it('sends LocationConstraint for a non-default AWS region', async () => {
      await service.provision(input({ region: 'eu-west-1' }), 'admin-1');

      expect(sentInput('CreateBucketCommand').CreateBucketConfiguration).toEqual({
        LocationConstraint: 'eu-west-1',
      });
    });

    it('⚠ omits it for us-east-1, which S3 rejects as InvalidLocationConstraint', async () => {
      await service.provision(input({ region: 'us-east-1' }), 'admin-1');

      expect(sentInput('CreateBucketCommand').CreateBucketConfiguration).toBeUndefined();
    });

    it('omits it for R2, which has one namespace per account', async () => {
      await service.provision(
        input({ provider: 'r2', region: 'auto', accountId: 'abc123' }),
        'admin-1',
      );

      expect(sentInput('CreateBucketCommand').CreateBucketConfiguration).toBeUndefined();
    });

    it('omits it for an S3-compatible server, whose region is a property of the deployment', async () => {
      await service.provision(
        input({ provider: 's3compatible', endpoint: 'http://minio:9000', region: '' }),
        'admin-1',
      );

      expect(sentInput('CreateBucketCommand').CreateBucketConfiguration).toBeUndefined();
    });
  });

  // ==========================================================================
  // Outcomes
  // ==========================================================================

  describe('outcomes', () => {
    it('created: every applicable step passes', async () => {
      const result = await service.provision(input(), 'admin-1');

      expect(result.outcome).toBe('created');
      expect(result.steps.every((step) => step.status === 'passed')).toBe(true);
      expect(result.guidance).toBeNull();
    });

    it('already_exists: a bucket this account owns is left alone and STILL hardened', async () => {
      // This is also the repair path for a bucket somebody created by hand
      // without a CORS rule, which is why the hardening must still run.
      failOn({ CreateBucketCommand: s3Error('BucketAlreadyOwnedByYou', 409) });

      const result = await service.provision(input(), 'admin-1');

      expect(result.outcome).toBe('already_exists');
      expect(byId(result.steps).create.status).toBe('passed');
      expect(sentInput('PutBucketCorsCommand')).toBeDefined();
    });

    it('failed: the name belongs to another account, and retrying cannot help', async () => {
      failOn({ CreateBucketCommand: s3Error('BucketAlreadyExists', 409) });

      const result = await service.provision(input(), 'admin-1');

      expect(result.outcome).toBe('failed');
      expect(result.guidance).toBeNull();
      expect(byId(result.steps).create.detail).toContain('already taken by another account');
      // Nothing was applied to a bucket that is not ours.
      expect(sentInput('PutBucketCorsCommand')).toBeUndefined();
    });

    it('partial: the bucket exists but a hardening step failed, and it says which', async () => {
      failOn({ PutBucketCorsCommand: s3Error('AccessDenied', 403) });

      const result = await service.provision(input(), 'admin-1');

      // ⚠ NOT `created`. Reporting success would mean nobody ever learns the
      // CORS rule did not land, and large uploads would fail silently.
      expect(result.outcome).toBe('partial');
      const steps = byId(result.steps);
      expect(steps.create.status).toBe('passed');
      expect(steps.cors.status).toBe('failed');
      expect(steps.cors.detail).toContain('FAIL TO COMPLETE');
      expect(steps.cors.detail).toContain('s3:PutBucketCORS');
    });

    it('skips the two AWS-only steps for R2 rather than failing them', async () => {
      const result = await service.provision(
        input({ provider: 'r2', region: 'auto', accountId: 'abc123' }),
        'admin-1',
      );

      const steps = byId(result.steps);
      expect(steps.publicAccessBlock.status).toBe('skipped');
      expect(steps.encryption.status).toBe('skipped');
      expect(steps.publicAccessBlock.detail).toContain('Cloudflare R2');
      // A skipped step is not a failure: the bucket is in the state we wanted.
      expect(result.outcome).toBe('created');
      expect(sentInput('PutPublicAccessBlockCommand')).toBeUndefined();
      expect(sentInput('PutBucketEncryptionCommand')).toBeUndefined();
    });

    it('attempts nothing at all for an incomplete configuration', async () => {
      const result = await service.provision(input({ bucket: '' }), 'admin-1');

      expect(result.outcome).toBe('failed');
      expect(result.steps.every((step) => step.status === 'skipped')).toBe(true);
      expect(s3SendMock).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // ⚠ The guided outcome
  // ==========================================================================

  describe('the guided outcome', () => {
    it.each([
      ['AccessDenied', 403],
      ['Forbidden', 403],
      ['NotImplemented', 501],
      ['MethodNotAllowed', 405],
    ] as Array<[string, number]>)(
      '%s on CreateBucket is guided — a credential that cannot create buckets is ordinary',
      async (code, status) => {
        failOn({ CreateBucketCommand: s3Error(code, status) });

        const result = await service.provision(input(), 'admin-1');

        expect(result.outcome).toBe('guided');
        expect(result.guidance).not.toBeNull();
        expect(result.guidance?.reason).toContain('not permitted to create buckets');
        // Later steps are SKIPPED, not failed: there is no bucket to apply them
        // to, and four failures for one cause is four wrong investigations.
        expect(
          result.steps
            .filter((step) => step.id !== 'create')
            .every((step) => step.status === 'skipped'),
        ).toBe(true);
      },
    );

    it('⚠ produces REAL values, never a placeholder, and keeps the ETag exposure', async () => {
      failOn({ CreateBucketCommand: s3Error('AccessDenied', 403) });

      const result = await service.provision(input({ region: 'eu-west-1' }), 'admin-1');
      const commands = result.guidance?.commands ?? '';

      expect(commands).toContain('aws s3api create-bucket --bucket example-bucket');
      expect(commands).toContain('LocationConstraint=eu-west-1');
      expect(commands).toContain('put-bucket-cors');
      // An operator who takes the guided route must not end up with the one
      // misconfiguration this whole endpoint exists to prevent.
      expect(commands).toContain('"ExposeHeaders"');
      expect(commands).toContain('ETag');
      expect(commands).toContain(APP_URL);
      // No `<your-bucket>`-style placeholder anywhere. (The heredoc's own `<<'JSON'`
      // is why this is a placeholder-shaped pattern rather than a bare `<`.)
      expect(commands).not.toMatch(/<[a-zA-Z][a-zA-Z0-9 _-]*>/);
    });

    it('uses wrangler for R2, and says why there is no encryption step', async () => {
      failOn({ CreateBucketCommand: s3Error('AccessDenied', 403) });

      const result = await service.provision(
        input({ provider: 'r2', region: 'auto', accountId: 'abc123' }),
        'admin-1',
      );
      const commands = result.guidance?.commands ?? '';

      expect(commands).toContain('wrangler r2 bucket create example-bucket');
      expect(commands).toContain('wrangler r2 bucket cors set');
      expect(commands).toContain('ETag');
      expect(commands).not.toContain('put-public-access-block');
    });

    it('carries the endpoint into the commands for an S3-compatible server', async () => {
      failOn({ CreateBucketCommand: s3Error('AccessDenied', 403) });

      const result = await service.provision(
        input({ provider: 's3compatible', endpoint: 'http://minio:9000', region: '' }),
        'admin-1',
      );
      const commands = result.guidance?.commands ?? '';

      expect(commands).toContain('--endpoint-url http://minio:9000');
      // No AWS-only hardening in a block for a server that does not implement it.
      expect(commands).not.toContain('put-bucket-encryption');
    });

    it('does NOT guide when the credential itself was refused', async () => {
      // Guidance that cannot help is worse than none: running the block with the
      // same broken credential fails identically.
      failOn({ CreateBucketCommand: s3Error('InvalidAccessKeyId', 403) });

      const result = await service.provision(input(), 'admin-1');

      expect(result.outcome).toBe('failed');
      expect(result.guidance).toBeNull();
      expect(byId(result.steps).create.detail).toContain('Fix the credential');
    });

    it('does NOT guide when the endpoint never answered', async () => {
      failOn({ CreateBucketCommand: transportError('ECONNREFUSED') });

      const result = await service.provision(
        input({ provider: 's3compatible', endpoint: 'http://minio:9000', region: '' }),
        'admin-1',
      );

      expect(result.outcome).toBe('failed');
      expect(result.guidance).toBeNull();
    });

    it('names the storage-configuration runbook (issue #378)', async () => {
      failOn({ CreateBucketCommand: s3Error('AccessDenied', 403) });

      const result = await service.provision(input(), 'admin-1');

      expect(result.guidance?.runbook).toBe(
        'docs/runbooks/storage-configuration.md',
      );
    });
  });

  // ==========================================================================
  // The secret, and auditing
  // ==========================================================================

  describe('the secret and the audit trail', () => {
    it('uses the stored secret when the body leaves it blank', async () => {
      await service.provision(input({ secretAccessKey: '' }), 'admin-1');

      expect(credentials.getSecret).toHaveBeenCalledWith('storage', 'default');
    });

    it('redacts the secret out of a provider error before it is returned', async () => {
      const secret = 'submitted-secret-access-key-987654';
      failOn({
        CreateBucketCommand: s3Error('InvalidAccessKeyId', 403, `bad signature for ${secret}`),
      });

      const result = await service.provision(input({ secretAccessKey: secret }), 'admin-1');

      expect(JSON.stringify(result)).not.toContain(secret);
    });

    it('records every attempt with per-step statuses and no provider error text', async () => {
      failOn({ PutBucketCorsCommand: s3Error('AccessDenied', 403, 'never store this') });

      await service.provision(input(), 'admin-1');

      const data = prisma.auditEvent.create.mock.calls[0][0].data;
      expect(data.action).toBe('storage_config:provision_bucket');
      expect(data.meta.outcome).toBe('partial');
      expect(data.meta.steps).toEqual([
        { id: 'create', status: 'passed' },
        { id: 'publicAccessBlock', status: 'passed' },
        { id: 'encryption', status: 'passed' },
        { id: 'cors', status: 'failed' },
      ]);
      expect(JSON.stringify(data.meta)).not.toContain('never store this');
    });

    it('always destroys the client it built', async () => {
      failOn({ CreateBucketCommand: s3Error('AccessDenied', 403) });

      await service.provision(input(), 'admin-1');

      expect(s3DestroyMock).toHaveBeenCalledTimes(1);
    });
  });
});
