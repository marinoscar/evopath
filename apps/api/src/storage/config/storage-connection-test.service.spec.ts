// =============================================================================
// StorageConnectionTestService — tests (issue #375, epic #372)
// =============================================================================
//
// THE AWS SDK IS MOCKED ENTIRELY, at the module level, before the subject
// imports it — the same technique `s3-storage.provider.spec.ts` and
// `ses-email.provider.spec.ts` use, and for the same reason: nothing in this
// file may open a socket or make a signed request. `fetch` is stubbed for the
// same reason, because the presigned check really does perform an HTTP request.
//
// WHAT THESE TESTS ARE ACTUALLY ABOUT. Not "does S3 work" — no test can answer
// that here — but the VERDICT MAPPING: given what an object store said, does
// this service tell the administrator the right thing to go and fix? That
// mapping is the entire value of the endpoint, and its most important case is
// the 403/404 split, which has a test of its own for each of its three
// outcomes.
// =============================================================================

const s3ConstructorMock = jest.fn();
const s3SendMock = jest.fn();
const s3DestroyMock = jest.fn();
const getSignedUrlMock = jest.fn();

/** Records the input every command was constructed with, by command name. */
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
  // Used by this service.
  HeadBucketCommand: commandMock('HeadBucketCommand'),
  ListBucketsCommand: commandMock('ListBucketsCommand'),
  PutObjectCommand: commandMock('PutObjectCommand'),
  GetObjectCommand: commandMock('GetObjectCommand'),
  DeleteObjectCommand: commandMock('DeleteObjectCommand'),
  // Imported transitively by `s3-storage.provider.ts`, which this service pulls
  // in for `buildS3ClientConfig`. Omitting any of them makes that module fail to
  // load with an error that names none of this.
  HeadObjectCommand: commandMock('HeadObjectCommand'),
  CopyObjectCommand: commandMock('CopyObjectCommand'),
  CreateMultipartUploadCommand: commandMock('CreateMultipartUploadCommand'),
  UploadPartCommand: commandMock('UploadPartCommand'),
  CompleteMultipartUploadCommand: commandMock('CompleteMultipartUploadCommand'),
  AbortMultipartUploadCommand: commandMock('AbortMultipartUploadCommand'),
  CreateBucketCommand: commandMock('CreateBucketCommand'),
  PutBucketCorsCommand: commandMock('PutBucketCorsCommand'),
  PutBucketEncryptionCommand: commandMock('PutBucketEncryptionCommand'),
  PutPublicAccessBlockCommand: commandMock('PutPublicAccessBlockCommand'),
  NotFound: class MockNotFound extends Error {},
}));

jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn().mockImplementation(() => ({ done: jest.fn() })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn((...args: unknown[]) => getSignedUrlMock(...args)),
}));

import { StorageConnectionTestService } from './storage-connection-test.service';
import type { TestStorageConfigInput } from './dto/storage-connection-test.dto';

const STORED_SECRET = 'stored-secret-access-key-0123456789';
const PRESIGNED_URL = 'https://example-bucket.s3.us-west-2.amazonaws.com/probe?X-Amz-Signature=abc';

/** A complete, usable submitted configuration. */
function input(overrides: Partial<TestStorageConfigInput> = {}): TestStorageConfigInput {
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

/**
 * A stand-in for an AWS SDK service exception.
 *
 * `name` carries the S3 error code (or, for a body-less `HEAD`, the bare
 * status name the SDK falls back to) and `$metadata.httpStatusCode` carries the
 * status — which is exactly the pair `describeStorageError` reads.
 */
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

/** A transport failure: no response at all. */
function transportError(code: string): Error {
  const error = new Error(`connect ${code} 10.0.0.4:9000`);
  (error as unknown as { code: string }).code = code;
  return error;
}

interface SendPlan {
  head?: unknown | Error;
  list?: unknown | Error;
  put?: unknown | Error;
  get?: unknown | Error;
  delete?: unknown | Error;
}

/** The order in which commands were actually sent — the delete's position matters. */
let sentCommands: string[];

function planSends(plan: SendPlan): void {
  s3SendMock.mockImplementation(async (command: { __command: string }) => {
    sentCommands.push(command.__command);

    const outcome = {
      HeadBucketCommand: plan.head ?? {},
      ListBucketsCommand: plan.list ?? { Buckets: [] },
      PutObjectCommand: plan.put ?? {},
      GetObjectCommand: plan.get ?? {},
      DeleteObjectCommand: plan.delete ?? {},
    }[command.__command];

    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
}

/** A `GetObject` response whose body reads back as `text`. */
function objectBody(text: string) {
  return { Body: { transformToString: async () => text } };
}

describe('StorageConnectionTestService', () => {
  let service: StorageConnectionTestService;
  let prisma: { auditEvent: { create: jest.Mock } };
  let credentials: { getSecret: jest.Mock };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    sentCommands = [];

    prisma = { auditEvent: { create: jest.fn().mockResolvedValue({}) } };
    credentials = { getSecret: jest.fn().mockResolvedValue(STORED_SECRET) };

    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    getSignedUrlMock.mockResolvedValue(PRESIGNED_URL);

    service = new StorageConnectionTestService(
      prisma as never,
      credentials as never,
    );
  });

  /** Index the four checks by id, so assertions read by name rather than by position. */
  function byId(checks: Array<{ id: string }>): Record<string, any> {
    return Object.fromEntries(checks.map((check) => [check.id, check]));
  }

  /** The presigned fetch answers 200 with exactly the bytes that were written. */
  function presignServesWrittenBytes(): void {
    fetchMock.mockImplementation(async () => {
      const put = s3SendMock.mock.calls
        .map(([command]: [{ __command: string; input: { Body?: string } }]) => command)
        .find((command) => command.__command === 'PutObjectCommand');

      return {
        ok: true,
        status: 200,
        text: async () => put?.input.Body ?? '',
      };
    });
  }

  // ==========================================================================
  // Nothing to test
  // ==========================================================================

  describe('an incomplete configuration', () => {
    it('attempts nothing and reports all four checks as SKIPPED, not failed', async () => {
      const result = await service.test(input({ bucket: '' }), 'admin-1');

      expect(result.success).toBe(false);
      expect(result.checks).toHaveLength(4);
      expect(result.checks.every((check) => check.status === 'skipped')).toBe(true);
      expect(result.checks.every((check) => check.code === 'not_configured')).toBe(true);
      // Nothing was built and nothing was sent — a half-configured form must not
      // reach an object store at all.
      expect(s3SendMock).not.toHaveBeenCalled();
      // And it says WHICH field is missing, which is the only actionable part.
      expect(result.checks[0].detail).toContain('bucket');
    });
  });

  // ==========================================================================
  // The happy path
  // ==========================================================================

  describe('a working configuration', () => {
    it('passes all four checks and reports success', async () => {
      planSends({ get: objectBody('') });
      // The probe body is generated inside the service, so the fetch stub echoes
      // whatever was actually written rather than a literal this test invented.
      s3SendMock.mockImplementation(async (command: { __command: string; input: any }) => {
        sentCommands.push(command.__command);
        if (command.__command === 'GetObjectCommand') {
          const put = s3SendMock.mock.calls
            .map(([sent]: [{ __command: string; input: { Body?: string } }]) => sent)
            .find((sent) => sent.__command === 'PutObjectCommand');
          return objectBody(put?.input.Body ?? '');
        }
        return {};
      });
      presignServesWrittenBytes();

      const result = await service.test(input(), 'admin-1');

      expect(result.success).toBe(true);
      expect(result.checks.map((check) => check.status)).toEqual([
        'passed',
        'passed',
        'passed',
        'passed',
      ]);
      expect(result.checks.every((check) => check.error === null)).toBe(true);
    });

    it('deletes the probe object AFTER the presigned URL has been fetched', async () => {
      // ⚠ The ordering the two checks depend on: deleting first would leave the
      // presigned check with nothing to fetch and turn a healthy configuration
      // into a reported failure.
      s3SendMock.mockImplementation(async (command: { __command: string; input: any }) => {
        sentCommands.push(command.__command);
        if (command.__command === 'GetObjectCommand') {
          const put = s3SendMock.mock.calls
            .map(([sent]: [{ __command: string; input: { Body?: string } }]) => sent)
            .find((sent) => sent.__command === 'PutObjectCommand');
          return objectBody(put?.input.Body ?? '');
        }
        return {};
      });

      let deletedBeforeFetch = false;
      fetchMock.mockImplementation(async () => {
        deletedBeforeFetch = sentCommands.includes('DeleteObjectCommand');
        const put = s3SendMock.mock.calls
          .map(([sent]: [{ __command: string; input: { Body?: string } }]) => sent)
          .find((sent) => sent.__command === 'PutObjectCommand');
        return { ok: true, status: 200, text: async () => put?.input.Body ?? '' };
      });

      await service.test(input(), 'admin-1');

      expect(deletedBeforeFetch).toBe(false);
      expect(sentCommands[sentCommands.length - 1]).toBe('DeleteObjectCommand');
    });

    it('writes the probe under the documented prefix and destroys the client', async () => {
      s3SendMock.mockImplementation(async (command: { __command: string; input: any }) => {
        sentCommands.push(command.__command);
        if (command.__command === 'GetObjectCommand') {
          const put = s3SendMock.mock.calls
            .map(([sent]: [{ __command: string; input: { Body?: string } }]) => sent)
            .find((sent) => sent.__command === 'PutObjectCommand');
          return objectBody(put?.input.Body ?? '');
        }
        return {};
      });
      presignServesWrittenBytes();

      await service.test(input(), 'admin-1');

      const put = s3SendMock.mock.calls
        .map(([command]: [{ __command: string; input: { Key: string } }]) => command)
        .find((command) => command.__command === 'PutObjectCommand');

      expect(put?.input.Key).toMatch(/^storage-config-test\//);
      // One client per test; six clicks must not leak six connection pools.
      expect(s3DestroyMock).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // ⚠ The 403-versus-404 split — the mapping this endpoint exists for
  // ==========================================================================

  describe('the bucket check distinguishes 404 from 403', () => {
    it('404 NotFound is bucket_missing, and the credential is reported as ACCEPTED', async () => {
      planSends({ head: s3Error('NotFound', 404) });

      const checks = byId((await service.test(input(), 'admin-1')).checks);

      // The signature was evaluated — a 404 is only reachable after
      // authentication — so telling the admin to re-paste their key would be
      // wrong.
      expect(checks.credentials.status).toBe('passed');
      expect(checks.bucket.status).toBe('failed');
      expect(checks.bucket.code).toBe('bucket_missing');
      expect(checks.bucket.detail).toContain('Create it');
      // Nothing downstream was attempted, and it is reported as such.
      expect(checks.roundTrip.status).toBe('skipped');
      expect(checks.roundTrip.code).toBe('not_attempted');
      expect(checks.presignedUrl.status).toBe('skipped');
    });

    it('403 with a real credential is bucket_forbidden, and says NOT to create a bucket', async () => {
      // `ListBuckets` answering AccessDenied proves the key is real and merely
      // unprivileged — the disambiguation `HeadBucket` structurally cannot make.
      planSends({
        head: s3Error('Forbidden', 403),
        list: s3Error('AccessDenied', 403),
      });

      const checks = byId((await service.test(input(), 'admin-1')).checks);

      expect(checks.credentials.status).toBe('passed');
      expect(checks.bucket.status).toBe('failed');
      expect(checks.bucket.code).toBe('bucket_forbidden');
      expect(checks.bucket.detail).toContain('Do NOT create a new bucket');
      expect(sentCommands).toContain('ListBucketsCommand');
    });

    it('403 with an unrecognised key is credentials_rejected, NOT bucket_forbidden', async () => {
      planSends({
        head: s3Error('Forbidden', 403),
        list: s3Error('InvalidAccessKeyId', 403),
      });

      const checks = byId((await service.test(input(), 'admin-1')).checks);

      expect(checks.credentials.status).toBe('failed');
      expect(checks.credentials.code).toBe('credentials_rejected');
      // And the bucket verdict is withheld rather than guessed at: this run
      // learned nothing about whether the bucket exists.
      expect(checks.bucket.status).toBe('skipped');
      expect(checks.bucket.code).toBe('not_attempted');
    });

    it('does not spend a ListBuckets call on a healthy configuration', async () => {
      s3SendMock.mockImplementation(async (command: { __command: string; input: any }) => {
        sentCommands.push(command.__command);
        if (command.__command === 'GetObjectCommand') {
          const put = s3SendMock.mock.calls
            .map(([sent]: [{ __command: string; input: { Body?: string } }]) => sent)
            .find((sent) => sent.__command === 'PutObjectCommand');
          return objectBody(put?.input.Body ?? '');
        }
        return {};
      });
      presignServesWrittenBytes();

      await service.test(input(), 'admin-1');

      expect(sentCommands).not.toContain('ListBucketsCommand');
    });
  });

  // ==========================================================================
  // The other first-two-check verdicts
  // ==========================================================================

  describe('credential and endpoint verdicts', () => {
    it('an explicit credential-rejection code on HeadBucket needs no second call', async () => {
      planSends({ head: s3Error('SignatureDoesNotMatch', 403) });

      const checks = byId((await service.test(input(), 'admin-1')).checks);

      expect(checks.credentials.code).toBe('credentials_rejected');
      expect(sentCommands).not.toContain('ListBucketsCommand');
    });

    it('a refused connection is endpoint_unreachable, not a credential problem', async () => {
      planSends({ head: transportError('ECONNREFUSED') });

      const checks = byId((await service.test(input({ provider: 's3compatible', endpoint: 'http://minio:9000' }), 'admin-1')).checks);

      expect(checks.credentials.status).toBe('failed');
      expect(checks.credentials.code).toBe('endpoint_unreachable');
      expect(checks.credentials.detail).toContain('the credential was never evaluated');
    });

    it('a 301 PermanentRedirect is a region mismatch, not a missing bucket', async () => {
      planSends({ head: s3Error('PermanentRedirect', 301) });

      const checks = byId((await service.test(input(), 'admin-1')).checks);

      expect(checks.bucket.code).toBe('bucket_region_mismatch');
    });

    it('AuthorizationHeaderMalformed is a region mismatch, NOT a bad credential', async () => {
      // S3 reports a signed request sent to the wrong regional host with an
      // authorization-shaped code. Classifying it as a credential problem would
      // send an operator to rotate a perfectly good key.
      planSends({
        head: s3Error(
          'AuthorizationHeaderMalformed',
          400,
          "the region 'us-west-2' is wrong; expecting 'eu-west-1'",
        ),
      });

      const checks = byId((await service.test(input(), 'admin-1')).checks);

      expect(checks.credentials.status).toBe('passed');
      expect(checks.bucket.code).toBe('bucket_region_mismatch');
    });
  });

  // ==========================================================================
  // The round trip
  // ==========================================================================

  describe('the round trip', () => {
    it('reports write_denied when PutObject is refused, and skips the presigned check', async () => {
      planSends({ put: s3Error('AccessDenied', 403) });

      const checks = byId((await service.test(input(), 'admin-1')).checks);

      expect(checks.bucket.status).toBe('passed');
      expect(checks.roundTrip.code).toBe('write_denied');
      expect(checks.roundTrip.detail).toContain('s3:PutObject');
      expect(checks.presignedUrl.status).toBe('skipped');
    });

    it('reports read_denied and still cleans up the object it wrote', async () => {
      planSends({ get: s3Error('AccessDenied', 403) });

      const checks = byId((await service.test(input(), 'admin-1')).checks);

      expect(checks.roundTrip.code).toBe('read_denied');
      // The probe object must not be left behind just because the read failed.
      expect(sentCommands).toContain('DeleteObjectCommand');
    });

    it('reports read_mismatch when the bytes read back are not the bytes written', async () => {
      planSends({ get: objectBody('bytes from some other object entirely') });

      const checks = byId((await service.test(input(), 'admin-1')).checks);

      expect(checks.roundTrip.code).toBe('read_mismatch');
      expect(checks.roundTrip.detail).toContain('path-style');
    });

    it('reports delete_denied — and the presigned check still stands on its own', async () => {
      s3SendMock.mockImplementation(async (command: { __command: string; input: any }) => {
        sentCommands.push(command.__command);
        if (command.__command === 'GetObjectCommand') {
          const put = s3SendMock.mock.calls
            .map(([sent]: [{ __command: string; input: { Body?: string } }]) => sent)
            .find((sent) => sent.__command === 'PutObjectCommand');
          return objectBody(put?.input.Body ?? '');
        }
        if (command.__command === 'DeleteObjectCommand') {
          throw s3Error('AccessDenied', 403);
        }
        return {};
      });
      presignServesWrittenBytes();

      const result = await service.test(input(), 'admin-1');
      const checks = byId(result.checks);

      expect(checks.roundTrip.code).toBe('delete_denied');
      // ⚠ The delete belongs to `roundTrip`, not to `presignedUrl`. A key
      // lacking s3:DeleteObject must not be told its URLs are broken.
      expect(checks.presignedUrl.status).toBe('passed');
      expect(result.success).toBe(false);
      // And the stray object is named, with the prefix that identifies it.
      expect(checks.roundTrip.detail).toContain('storage-config-test/');
    });
  });

  // ==========================================================================
  // The presigned URL
  // ==========================================================================

  describe('the presigned URL check', () => {
    beforeEach(() => {
      s3SendMock.mockImplementation(async (command: { __command: string; input: any }) => {
        sentCommands.push(command.__command);
        if (command.__command === 'GetObjectCommand') {
          const put = s3SendMock.mock.calls
            .map(([sent]: [{ __command: string; input: { Body?: string } }]) => sent)
            .find((sent) => sent.__command === 'PutObjectCommand');
          return objectBody(put?.input.Body ?? '');
        }
        return {};
      });
    });

    it('reports presign_rejected when the URL answers a non-success status', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => '<Error><Code>SignatureDoesNotMatch</Code></Error>',
      });

      const checks = byId((await service.test(input(), 'admin-1')).checks);

      expect(checks.presignedUrl.code).toBe('presign_rejected');
      expect(checks.presignedUrl.error).toContain('SignatureDoesNotMatch');
      // The round trip itself still completed, and still says so.
      expect(checks.roundTrip.status).toBe('passed');
    });

    it('reports presign_unreachable when the fetch itself fails', async () => {
      fetchMock.mockRejectedValue(transportError('ENOTFOUND'));

      const checks = byId((await service.test(input(), 'admin-1')).checks);

      expect(checks.presignedUrl.code).toBe('presign_unreachable');
      // It is honest about what a server-side fetch can and cannot prove.
      expect(checks.presignedUrl.detail).toContain('browsers fetch');
    });

    it('reports presign_mismatch when it answers 200 with the wrong bytes', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'some entirely different object',
      });

      const checks = byId((await service.test(input(), 'admin-1')).checks);

      expect(checks.presignedUrl.code).toBe('presign_mismatch');
    });
  });

  // ==========================================================================
  // The secret
  // ==========================================================================

  describe('the secret access key', () => {
    it('uses the STORED secret when the body leaves it blank, and says so', async () => {
      planSends({ head: s3Error('NotFound', 404) });

      const result = await service.test(input({ secretAccessKey: '' }), 'admin-1');

      expect(credentials.getSecret).toHaveBeenCalledWith('storage', 'default');
      expect(result.usedStoredSecret).toBe(true);
    });

    it('does not touch the credential store when the body carries a secret', async () => {
      planSends({ head: s3Error('NotFound', 404) });

      const result = await service.test(input(), 'admin-1');

      expect(credentials.getSecret).not.toHaveBeenCalled();
      expect(result.usedStoredSecret).toBe(false);
    });

    it('⚠ redacts the secret out of a provider error that echoed it back', async () => {
      const secret = 'submitted-secret-access-key-987654';
      planSends({
        head: s3Error(
          'AccessDenied',
          403,
          `The request signature we calculated does not match: key=${secret}`,
        ),
        list: s3Error('AccessDenied', 403),
      });

      const result = await service.test(input({ secretAccessKey: secret }), 'admin-1');
      const serialised = JSON.stringify(result);

      expect(serialised).not.toContain(secret);
      expect(serialised).toContain('[redacted]');
    });
  });

  // ==========================================================================
  // Auditing
  // ==========================================================================

  describe('auditing', () => {
    it('records every attempt, including a failed one, with codes but no error text', async () => {
      planSends({ head: s3Error('NotFound', 404, 'a message that must not be stored') });

      await service.test(input(), 'admin-1');

      expect(prisma.auditEvent.create).toHaveBeenCalledTimes(1);
      const data = prisma.auditEvent.create.mock.calls[0][0].data;

      expect(data.action).toBe('storage_config:test');
      expect(data.actorUserId).toBe('admin-1');
      expect(data.targetId).toBe('storage');
      expect(data.meta.success).toBe(false);
      expect(data.meta.checks).toEqual([
        { id: 'credentials', status: 'passed', code: 'ok' },
        { id: 'bucket', status: 'failed', code: 'bucket_missing' },
        { id: 'roundTrip', status: 'skipped', code: 'not_attempted' },
        { id: 'presignedUrl', status: 'skipped', code: 'not_attempted' },
      ]);
      // Provider error text belongs in the response an admin is reading, not in
      // a table that outlives the incident.
      expect(JSON.stringify(data.meta)).not.toContain('a message that must not be stored');
    });
  });
});
