import { Logger } from '@nestjs/common';
import { Readable } from 'node:stream';

import type { SystemStorageValue } from '../../../common/schemas/settings.schema';
import { resolveStorageConfig } from '../../config/storage-config';

// =============================================================================
// S3StorageProvider — tests (issue #374, epic #372)
// =============================================================================
//
// THE FIRST SPEC THIS DRIVER HAS EVER HAD. `apps/api/src/email/providers/
// ses-email.provider.spec.ts` is the template it follows: the AWS SDK is
// mocked entirely, at the module level, BEFORE the subject imports it, and a
// constructor mock records what each `new S3Client(...)` was built with —
// which is the only way to observe client construction, since the client is
// private and nothing about it is readable afterwards. Nothing in this file
// opens a socket or makes a signed AWS request.
//
// -----------------------------------------------------------------------------
// WHY THE PROVIDER TABLE IS ASSERTED END TO END, FROM A SETTINGS LITERAL
// -----------------------------------------------------------------------------
//
// #374's table has four columns, and they are decided in TWO places:
//
//   * `endpoint` and `region` by `resolveStorageConfig` (R2's account-scoped
//     host via `deriveR2Endpoint`, R2's `auto`, an S3-compatible endpoint's
//     `us-east-1`) — because that function is the single definition of what a
//     stored configuration means, and the driver deliberately does not
//     re-derive either;
//   * `forcePathStyle` and the two checksum flags by the driver's own
//     `buildS3ClientConfig`.
//
// Asserting each half alone would leave the seam untested — which is exactly
// where a wrong answer lives, since either half can be individually correct
// while the pair disagrees. So `fromSettings()` below starts at the `storage`
// settings namespace an administrator actually saves, runs it through the real
// `resolveStorageConfig` (it is pure — no Nest, no database, no mock), and
// hands the result to the real constructor. A row of the table passes only if
// the whole chain produces it.
//
// ⚠ WHAT THESE TESTS CANNOT PROVE. That R2 accepts the resulting requests.
// There is no R2 account in this environment and no test here pretends
// otherwise: `requestChecksumCalculation: 'WHEN_REQUIRED'` is asserted as
// "this is what we ask the SDK for", never as "R2 accepted it". Only a real
// bucket can confirm the second, and the comment on those two lines in
// `s3-storage.provider.ts` is what protects them from a future cleanup in the
// meantime.
// =============================================================================

const s3ConstructorMock = jest.fn();
const s3SendMock = jest.fn();
const s3DestroyMock = jest.fn();

const uploadConstructorMock = jest.fn();
const uploadDoneMock = jest.fn();

const getSignedUrlMock = jest.fn();

/**
 * A stand-in for the SDK's `NotFound` error shape.
 *
 * A real class, because the driver's 404 handling is an `instanceof` test with
 * a duck-typed `name === 'NotFound'` fallback beside it, and both branches are
 * exercised below. A plain object mock would silently test only the fallback.
 */
class MockNotFound extends Error {
  constructor() {
    super('Not Found');
    this.name = 'NotFound';
  }
}

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
  GetObjectCommand: commandMock('GetObjectCommand'),
  DeleteObjectCommand: commandMock('DeleteObjectCommand'),
  HeadObjectCommand: commandMock('HeadObjectCommand'),
  CopyObjectCommand: commandMock('CopyObjectCommand'),
  CreateMultipartUploadCommand: commandMock('CreateMultipartUploadCommand'),
  PutObjectCommand: commandMock('PutObjectCommand'),
  UploadPartCommand: commandMock('UploadPartCommand'),
  CompleteMultipartUploadCommand: commandMock('CompleteMultipartUploadCommand'),
  AbortMultipartUploadCommand: commandMock('AbortMultipartUploadCommand'),
  NotFound: MockNotFound,
}));

jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn().mockImplementation((options: unknown) => {
    uploadConstructorMock(options);
    return { done: uploadDoneMock };
  }),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn((...args: unknown[]) => getSignedUrlMock(...args)),
}));

import {
  DEFAULT_S3_PART_SIZE,
  S3StorageProvider,
  type S3StorageProviderConfig,
} from './s3-storage.provider';

const SECRET = 'super-secret-access-key-value';

/** The `storage` settings namespace as an administrator saves it. */
function policy(overrides: Partial<SystemStorageValue> = {}): SystemStorageValue {
  return {
    provider: 's3',
    bucket: 'my-bucket',
    region: 'us-west-2',
    endpoint: '',
    accountId: '',
    accessKeyId: 'AKIAEXAMPLE',
    // `null` — the shipped default, meaning "use this vendor's convention".
    // The factory must mirror `DEFAULT_SYSTEM_SETTINGS`: with a `false` here
    // every row of the table below was asserted against a configuration no
    // operator ever has, which is how #374 shipped a driver default that could
    // not fire in production.
    forcePathStyle: null,
    ...overrides,
  };
}

/**
 * Build a driver the way the application does: settings → `resolveStorageConfig`
 * → constructor. See the header for why the chain is not short-circuited.
 */
function fromSettings(
  overrides: Partial<SystemStorageValue> = {},
): S3StorageProvider {
  const resolution = resolveStorageConfig(policy(overrides), SECRET);

  if (!resolution.configured) {
    // A test whose fixture is not configured is a broken test, not a failing
    // assertion — say so here rather than letting it surface as a confusing
    // `undefined` three lines later.
    throw new Error(
      `Test fixture is not a usable configuration; missing: ${resolution.missing.join(', ')}`,
    );
  }

  return new S3StorageProvider(resolution.config);
}

/** Build a driver directly, for the cases a settings row cannot express. */
function fromConfig(
  overrides: Partial<S3StorageProviderConfig> = {},
): S3StorageProvider {
  return new S3StorageProvider({
    provider: 's3',
    bucket: 'my-bucket',
    region: 'us-west-2',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: SECRET,
    ...overrides,
  });
}

/** What the single `new S3Client(...)` of this test was called with. */
function clientConfig(): Record<string, unknown> {
  expect(s3ConstructorMock).toHaveBeenCalledTimes(1);

  return s3ConstructorMock.mock.calls[0][0] as Record<string, unknown>;
}

/** The input of the single command sent in this test. */
function sentCommandInput(): Record<string, unknown> {
  expect(s3SendMock).toHaveBeenCalledTimes(1);

  return (s3SendMock.mock.calls[0][0] as { input: Record<string, unknown> })
    .input;
}

describe('S3StorageProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // #374's table, one describe per provider kind
  // ==========================================================================

  describe('client construction — provider: s3 (AWS)', () => {
    it('lets the SDK derive its own regional host (no endpoint)', () => {
      fromSettings({ provider: 's3', region: 'eu-central-1' });

      // ABSENT, not `''`. `S3Client` rejects an empty string as a URL, so this
      // is the difference between "use AWS's host" and a crash on the first
      // call.
      expect(clientConfig().endpoint).toBeUndefined();
    });

    it("signs with the operator's region", () => {
      fromSettings({ provider: 's3', region: 'eu-central-1' });

      // No fallback is applied for `s3` and none ever should be: `us-east-1` is
      // a real region that a bucket somewhere else answers with a redirect
      // nobody reads. An empty region is a `missing` field instead.
      expect(clientConfig().region).toBe('eu-central-1');
    });

    it('uses virtual-host-style URLs', () => {
      // From the SHIPPED default (`forcePathStyle: null`), through the real
      // `resolveStorageConfig`, to the client: unset resolves to AWS's own
      // convention rather than to whatever a stored `false` happened to say.
      fromSettings({ provider: 's3' });

      expect(clientConfig().forcePathStyle).toBe(false);
    });

    it('still honours a stored `true` (an AWS-hosted bucket addressed path-style)', () => {
      fromSettings({ provider: 's3', forcePathStyle: true });

      // An explicit value wins for EVERY provider, not only the ones whose
      // convention it contradicts.
      expect(clientConfig().forcePathStyle).toBe(true);
    });

    it("leaves the SDK's checksum defaults alone", () => {
      fromSettings({ provider: 's3' });

      expect(clientConfig().requestChecksumCalculation).toBeUndefined();
      expect(clientConfig().responseChecksumValidation).toBeUndefined();
    });

    it('still accepts an explicitly typed endpoint (S3 pointed at a local MinIO)', () => {
      fromSettings({ provider: 's3', endpoint: 'http://localhost:9000' });

      // The point of this row: an operator can develop against MinIO without
      // lying about which provider it is. The kind selects the client's
      // behaviour; it does not veto an endpoint.
      expect(clientConfig().endpoint).toBe('http://localhost:9000');
    });
  });

  describe('client construction — provider: r2 (Cloudflare)', () => {
    it('derives the account-scoped endpoint from the account id', () => {
      fromSettings({ provider: 'r2', accountId: 'abc123def456' });

      // DERIVED, never typed: a hand-written host is wrong by a character often
      // enough that "check the endpoint" is R2's commonest support answer, and
      // a typo fails at DNS or TLS, far from the field that caused it.
      expect(clientConfig().endpoint).toBe(
        'https://abc123def456.r2.cloudflarestorage.com',
      );
    });

    it('does not put the bucket in the host', () => {
      fromSettings({
        provider: 'r2',
        accountId: 'abc123def456',
        bucket: 'my-bucket',
      });

      // R2's S3 API addresses the bucket in the path. A bucket in the host here
      // would 404 every request.
      expect(clientConfig().endpoint).not.toContain('my-bucket');
    });

    it('signs with `auto` when the operator typed no region', () => {
      fromSettings({ provider: 'r2', accountId: 'abc123def456', region: '' });

      // R2 has no regions, but the SDK refuses to sign without a region string.
      expect(clientConfig().region).toBe('auto');
    });

    it("keeps the operator's region when one was typed (jurisdiction-restricted buckets)", () => {
      fromSettings({ provider: 'r2', accountId: 'abc123def456', region: 'eu' });

      // `auto` is a fallback, not an override: R2's `eu`/`fedramp` buckets are
      // addressed with a real region, and inventing `auto` over the top of one
      // would break exactly the deployment that was most careful.
      expect(clientConfig().region).toBe('eu');
    });

    it('prefers an explicitly typed endpoint over the derived one', () => {
      fromSettings({
        provider: 'r2',
        accountId: 'abc123def456',
        endpoint: 'https://custom.example.com',
      });

      expect(clientConfig().endpoint).toBe('https://custom.example.com');
    });

    it('uses virtual-host-style URLs, unlike an S3-compatible endpoint', () => {
      fromSettings({ provider: 'r2', accountId: 'abc123def456' });

      // The reason `forcePathStyle` is no longer inferred from `!!endpoint`:
      // R2 has an endpoint and does not want path style.
      expect(clientConfig().forcePathStyle).toBe(false);
    });

    it('disables the CRC32 trailer the newer SDK sends by default', () => {
      fromSettings({ provider: 'r2', accountId: 'abc123def456' });

      // ⚠ The two lines these assertions pin are the ones most likely to be
      // deleted as "restating a default". R2 REJECTS the checksum trailer
      // `@aws-sdk/client-s3` attaches by default, and the resulting error names
      // the signature rather than the checksum. See the comment on them in
      // `s3-storage.provider.ts`.
      //
      // NOT VERIFIED AGAINST A REAL R2 BUCKET — see this file's header.
      expect(clientConfig().requestChecksumCalculation).toBe('WHEN_REQUIRED');
      expect(clientConfig().responseChecksumValidation).toBe('WHEN_REQUIRED');
    });
  });

  describe('client construction — provider: s3compatible (MinIO, Ceph, Wasabi…)', () => {
    it("talks to the operator's endpoint", () => {
      fromSettings({
        provider: 's3compatible',
        endpoint: 'https://minio.internal:9000',
      });

      expect(clientConfig().endpoint).toBe('https://minio.internal:9000');
    });

    it('falls back to us-east-1 when the operator typed no region', () => {
      fromSettings({
        provider: 's3compatible',
        endpoint: 'https://minio.internal:9000',
        region: '',
      });

      // A placeholder, because the SDK will not sign without one and the
      // endpoint has already answered "which host". MinIO, Ceph RGW and
      // LocalStack ignore it entirely.
      expect(clientConfig().region).toBe('us-east-1');
    });

    it("keeps the operator's region when one was typed (Backblaze, Wasabi)", () => {
      fromSettings({
        provider: 's3compatible',
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        region: 'us-west-004',
      });

      expect(clientConfig().region).toBe('us-west-004');
    });

    it('uses path-style URLs by default, from a saved settings row', () => {
      // ⚠ THE #374 REGRESSION, PINNED. This is what an operator does: choose
      // `s3compatible`, type a MinIO endpoint, save, and touch nothing else.
      // While `forcePathStyle` was a plain boolean defaulting to `false`, that
      // journey produced an explicit `false` here and MinIO — which serves
      // path style only — rejected every request. It passes only because the
      // stored value is `null` ("unset") all the way down to the `??` below.
      fromSettings({
        provider: 's3compatible',
        endpoint: 'https://minio.internal:9000',
      });

      expect(clientConfig().forcePathStyle).toBe(true);
    });

    it('applies the same default to a directly-constructed config (absent key)', () => {
      // The other caller of the driver: a connection test built from a form
      // that has not been saved, which states no value at all. Absent and
      // `null` must reach the same answer — see the field's note.
      fromConfig({
        provider: 's3compatible',
        endpoint: 'https://minio.internal:9000',
      });

      expect(clientConfig().forcePathStyle).toBe(true);
    });

    it('lets a stored `false` win over that default', () => {
      fromSettings({
        provider: 's3compatible',
        endpoint: 'https://minio.internal:9000',
        forcePathStyle: false,
      });

      // An operator who turned path style OFF for an appliance that serves
      // virtual-host style must get what they asked for. Absent and `null`
      // mean "use the convention"; `false` means "no".
      expect(clientConfig().forcePathStyle).toBe(false);
    });

    it('honours a stored `true`', () => {
      fromSettings({
        provider: 's3compatible',
        endpoint: 'https://minio.internal:9000',
        forcePathStyle: true,
      });

      expect(clientConfig().forcePathStyle).toBe(true);
    });

    it("leaves the SDK's checksum defaults alone", () => {
      fromSettings({
        provider: 's3compatible',
        endpoint: 'https://minio.internal:9000',
      });

      // Deliberately NOT widened to every non-AWS vendor: R2 is the one known
      // to reject the trailer, and a vendor is not R2 because it is not AWS.
      expect(clientConfig().requestChecksumCalculation).toBeUndefined();
      expect(clientConfig().responseChecksumValidation).toBeUndefined();
    });
  });

  describe('client construction — shared', () => {
    it('passes the credential through to the SDK', () => {
      fromSettings();

      expect(clientConfig().credentials).toEqual({
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: SECRET,
      });
    });

    it('never logs the secret access key', () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log');

      fromSettings({ provider: 'r2', accountId: 'abc123def456' });

      const logged = logSpy.mock.calls.flat().join(' ');

      expect(logged).not.toContain(SECRET);
      // The line it DOES write names the provider, so "which vendor is this
      // process talking to?" is answerable from the logs.
      expect(logged).toContain('Provider: r2');
    });

    it('omits the credential entirely when neither half is present', () => {
      // Unreachable through `resolveStorageConfig` — anonymous access is not a
      // supported configuration — so this is asserted on the direct path, where
      // a fork could still construct one. `undefined` makes the SDK fall back
      // to its own provider chain rather than signing with `''`.
      fromConfig({ accessKeyId: '', secretAccessKey: '' });

      expect(clientConfig().credentials).toBeUndefined();
    });
  });

  // ==========================================================================
  // providerId
  // ==========================================================================

  describe('providerId', () => {
    it.each(['s3', 'r2', 's3compatible'] as const)(
      'reports the kind it was built for: %s',
      (provider) => {
        const built = fromConfig({
          provider,
          ...(provider === 's3' ? {} : { endpoint: 'https://example.com' }),
        });

        expect(built.providerId).toBe(provider);
      },
    );

    it('is not inferred from the shape of the configuration', () => {
      // An endpoint used to be the only signal there was; it is no longer a
      // signal at all. A plain `s3` pointed at MinIO is still `s3`.
      const built = fromConfig({
        provider: 's3',
        endpoint: 'http://localhost:9000',
      });

      expect(built.providerId).toBe('s3');
    });
  });

  // ==========================================================================
  // setMetadata — the CopySource encoding regression (#374)
  // ==========================================================================

  describe('setMetadata', () => {
    it('percent-encodes a key containing a space, a plus and a percent', async () => {
      s3SendMock.mockResolvedValueOnce({});
      const built = fromSettings({ bucket: 'my-bucket' });

      await built.setMetadata('reports/q1 report+final 100%.pdf', {
        owner: 'alice',
      });

      // THE REGRESSION. Sent raw, ` ` breaks the path, `+` is read back as a
      // space and `%` as the start of an escape — so this call either 404'd or,
      // worse, replaced the metadata of whatever object the mangled name hit.
      expect(sentCommandInput().CopySource).toBe(
        'my-bucket/reports/q1%20report%2Bfinal%20100%25.pdf',
      );
    });

    it('keeps the key separators as separators', async () => {
      s3SendMock.mockResolvedValueOnce({});
      const built = fromSettings({ bucket: 'my-bucket' });

      await built.setMetadata('a/b/c.txt', {});

      // Encoded segment by segment rather than with one `encodeURIComponent`
      // over the whole string: `%2F` in place of these slashes makes a prefixed
      // key unaddressable on the servers that do not decode them back.
      expect(sentCommandInput().CopySource).toBe('my-bucket/a/b/c.txt');
    });

    it('leaves `Key` unencoded — the asymmetry is the S3 API’s', async () => {
      s3SendMock.mockResolvedValueOnce({});
      const built = fromSettings();

      await built.setMetadata('q1 report.pdf', { owner: 'alice' });

      // `CopySource` is parsed as a path and must arrive encoded; every other
      // field takes the key raw and the SDK encodes it. Encoding both would
      // double-encode and address `q1%2520report.pdf`.
      expect(sentCommandInput().Key).toBe('q1 report.pdf');
    });

    it('replaces rather than merges the metadata', async () => {
      s3SendMock.mockResolvedValueOnce({});
      const built = fromSettings();

      await built.setMetadata('key.txt', { owner: 'alice' });

      expect(sentCommandInput()).toMatchObject({
        Metadata: { owner: 'alice' },
        MetadataDirective: 'REPLACE',
      });
    });

    it('rethrows a failure', async () => {
      s3SendMock.mockRejectedValueOnce(new Error('AccessDenied'));
      const built = fromSettings();

      await expect(built.setMetadata('key.txt', {})).rejects.toThrow(
        'AccessDenied',
      );
    });
  });

  // ==========================================================================
  // Keys travel raw on every other command
  // ==========================================================================

  describe('key handling', () => {
    it('passes the key and bucket through unencoded on a download', async () => {
      s3SendMock.mockResolvedValueOnce({ Body: Readable.from(['data']) });
      const built = fromSettings({ bucket: 'my-bucket' });

      await built.download('q1 report+final.pdf');

      expect(sentCommandInput()).toMatchObject({
        Bucket: 'my-bucket',
        Key: 'q1 report+final.pdf',
      });
    });

    it('passes the key through unencoded on a delete', async () => {
      s3SendMock.mockResolvedValueOnce({});
      const built = fromSettings();

      await built.delete('q1 report+final.pdf');

      expect(sentCommandInput().Key).toBe('q1 report+final.pdf');
    });
  });

  // ==========================================================================
  // 404 handling — both detections, deliberately
  // ==========================================================================

  describe('NotFound detection', () => {
    it('returns null from getMetadata for the SDK’s NotFound class', async () => {
      s3SendMock.mockRejectedValueOnce(new MockNotFound());
      const built = fromSettings();

      await expect(built.getMetadata('missing.txt')).resolves.toBeNull();
    });

    it('returns null from getMetadata for a duck-typed NotFound', async () => {
      // The second detection is not redundant: an error crossing a bundling or
      // module-duplication boundary fails `instanceof` while still carrying the
      // name, and a 404 misread as a 500 turns "this object is gone" into an
      // alert.
      s3SendMock.mockRejectedValueOnce({ name: 'NotFound' });
      const built = fromSettings();

      await expect(built.getMetadata('missing.txt')).resolves.toBeNull();
    });

    it('rethrows anything that is not a NotFound from getMetadata', async () => {
      s3SendMock.mockRejectedValueOnce(new Error('AccessDenied'));
      const built = fromSettings();

      await expect(built.getMetadata('key.txt')).rejects.toThrow('AccessDenied');
    });

    it('returns an empty object when the object exists with no metadata', async () => {
      s3SendMock.mockResolvedValueOnce({});
      const built = fromSettings();

      await expect(built.getMetadata('key.txt')).resolves.toEqual({});
    });

    it('returns false from exists for both detections', async () => {
      const built = fromSettings();

      s3SendMock.mockRejectedValueOnce(new MockNotFound());
      await expect(built.exists('missing.txt')).resolves.toBe(false);

      s3SendMock.mockRejectedValueOnce({ name: 'NotFound' });
      await expect(built.exists('missing.txt')).resolves.toBe(false);
    });

    it('rethrows anything that is not a NotFound from exists', async () => {
      s3SendMock.mockRejectedValueOnce(new Error('AccessDenied'));
      const built = fromSettings();

      await expect(built.exists('key.txt')).rejects.toThrow('AccessDenied');
    });

    it('returns true from exists when the head succeeds', async () => {
      s3SendMock.mockResolvedValueOnce({});
      const built = fromSettings();

      await expect(built.exists('key.txt')).resolves.toBe(true);
    });
  });

  // ==========================================================================
  // Part size, uploads and presigning
  // ==========================================================================

  describe('uploads', () => {
    it('uses the configured part size', async () => {
      uploadDoneMock.mockResolvedValueOnce({ Location: 'https://x/y', ETag: '"e"' });
      const built = fromConfig({ partSize: 32 * 1024 * 1024 });

      await built.upload('key.txt', Readable.from(['data']), {
        mimeType: 'text/plain',
      });

      expect(uploadConstructorMock).toHaveBeenCalledWith(
        expect.objectContaining({ partSize: 32 * 1024 * 1024 }),
      );
    });

    it('falls back to the default part size', async () => {
      uploadDoneMock.mockResolvedValueOnce({ Location: 'https://x/y', ETag: '"e"' });
      const built = fromSettings();

      await built.upload('key.txt', Readable.from(['data']), {
        mimeType: 'text/plain',
      });

      // Part size is deploy-time tuning about this process's memory, not an
      // administrator setting — it does not live in the settings namespace, so
      // a configuration resolved from one carries no value for it.
      expect(uploadConstructorMock).toHaveBeenCalledWith(
        expect.objectContaining({ partSize: DEFAULT_S3_PART_SIZE }),
      );
    });

    it('reports the active bucket on the result', async () => {
      uploadDoneMock.mockResolvedValueOnce({ ETag: '"e"' });
      const built = fromSettings({ bucket: 'my-bucket' });

      const result = await built.upload('key.txt', Readable.from(['data']), {
        mimeType: 'text/plain',
      });

      expect(result).toMatchObject({ key: 'key.txt', bucket: 'my-bucket' });
    });

    it('fails an init that returns no UploadId', async () => {
      s3SendMock.mockResolvedValueOnce({});
      const built = fromSettings();

      await expect(
        built.initMultipartUpload('key.txt', { mimeType: 'text/plain' }),
      ).rejects.toThrow('no UploadId');
    });
  });

  describe('presigned URLs', () => {
    it('signs a PUT without a Content-Type when the caller supplied none', async () => {
      getSignedUrlMock.mockResolvedValueOnce('https://signed.example/put');
      const built = fromSettings();

      await built.getSignedPutUrl('key.txt');

      // S3 signs the headers it is given: presigning with a `Content-Type` the
      // uploader then does not send produces `SignatureDoesNotMatch` on a
      // machine nobody is watching.
      const command = getSignedUrlMock.mock.calls[0][1] as {
        input: Record<string, unknown>;
      };

      expect(command.input).not.toHaveProperty('ContentType');
    });

    it('signs a PUT with the Content-Type the caller supplied', async () => {
      getSignedUrlMock.mockResolvedValueOnce('https://signed.example/put');
      const built = fromSettings();

      await built.getSignedPutUrl('key.txt', { contentType: 'image/png' });

      const command = getSignedUrlMock.mock.calls[0][1] as {
        input: Record<string, unknown>;
      };

      expect(command.input.ContentType).toBe('image/png');
    });

    it('never logs the signed URL', async () => {
      const debugSpy = jest.spyOn(Logger.prototype, 'debug');
      getSignedUrlMock.mockResolvedValueOnce('https://signed.example/put?X-Amz-Signature=abc');
      const built = fromSettings();

      await built.getSignedPutUrl('key.txt');

      // The URL is a bearer write capability for `key` until it expires.
      const logged = debugSpy.mock.calls.flat().join(' ');

      expect(logged).not.toContain('X-Amz-Signature');
    });
  });

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  describe('destroy', () => {
    it('releases the client’s socket pool', () => {
      const built = fromSettings();

      built.destroy();

      // Without this, every settings edit and every credential rotation would
      // leak a keep-alive pool for the life of the process.
      expect(s3DestroyMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getBucket', () => {
    it('reports the bucket it was configured with', () => {
      expect(fromSettings({ bucket: 'my-bucket' }).getBucket()).toBe('my-bucket');
    });
  });
});
