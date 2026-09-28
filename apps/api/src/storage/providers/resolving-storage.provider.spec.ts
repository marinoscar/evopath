import type { ConfigService } from '@nestjs/config';

import type {
  ResolvedStorageConfig,
  StorageConfigResolution,
} from '../config/storage-config';
import type { StorageConfigService } from '../config/storage-config.service';
import { StorageNotConfiguredError } from '../config/storage-not-configured.error';
import { ResolvingStorageProvider } from './resolving-storage.provider';

// =============================================================================
// ResolvingStorageProvider — tests (issue #373, epic #372)
// =============================================================================
//
// `S3StorageProvider` is mocked: it is the class this file's whole job is to
// NOT be, and the behaviour under test here — delegate identity, rotation,
// the bounded cache, eviction, the 503 — never depends on what a real
// `S3Client` does. Each mock instance is a fresh object with its own jest.fn()
// methods, tracked in `createdInstances`, so identity checks ("same delegate
// reused" / "a new one was built") are checks on THIS test's own bookkeeping,
// not on the real AWS SDK.
// =============================================================================

interface MockS3Instance {
  exists: jest.Mock;
  upload: jest.Mock;
  destroy: jest.Mock;
}

let createdInstances: MockS3Instance[] = [];

jest.mock('./s3/s3-storage.provider', () => ({
  DEFAULT_S3_PART_SIZE: 10_485_760,
  S3StorageProvider: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { S3StorageProvider } = jest.requireMock('./s3/s3-storage.provider') as {
  S3StorageProvider: jest.Mock;
};

function resolvedConfig(
  overrides: Partial<ResolvedStorageConfig> = {},
): ResolvedStorageConfig {
  return {
    provider: 's3',
    bucket: 'bucket-a',
    region: 'us-west-2',
    accessKeyId: 'AKIA-A',
    secretAccessKey: 'secret-a',
    forcePathStyle: false,
    ...overrides,
  };
}

function configured(config: ResolvedStorageConfig): StorageConfigResolution {
  return { configured: true, config };
}

describe('ResolvingStorageProvider', () => {
  let storageConfig: {
    resolve: jest.Mock;
    lastKnownBucket: jest.Mock;
  };
  let configService: { get: jest.Mock };
  let provider: ResolvingStorageProvider;

  beforeEach(() => {
    createdInstances = [];
    S3StorageProvider.mockReset();
    S3StorageProvider.mockImplementation(() => {
      const instance: MockS3Instance = {
        exists: jest.fn().mockResolvedValue(true),
        upload: jest.fn().mockResolvedValue({ key: 'uploaded' }),
        destroy: jest.fn(),
      };
      createdInstances.push(instance);
      return instance;
    });

    storageConfig = {
      resolve: jest.fn().mockResolvedValue(configured(resolvedConfig())),
      lastKnownBucket: jest.fn().mockReturnValue(null),
    };
    configService = { get: jest.fn((_key: string, def: unknown) => def) };

    provider = new ResolvingStorageProvider(
      storageConfig as unknown as StorageConfigService,
      configService as unknown as ConfigService,
    );
  });

  // ===========================================================================
  // Construction
  // ===========================================================================

  it('does not throw at construction, even before anything is configured', () => {
    storageConfig.resolve.mockResolvedValue({
      configured: false,
      provider: 's3',
      missing: ['bucket', 'accessKeyId', 'secretAccessKey'],
    });

    expect(
      () =>
        new ResolvingStorageProvider(
          storageConfig as unknown as StorageConfigService,
          configService as unknown as ConfigService,
        ),
    ).not.toThrow();
  });

  // ===========================================================================
  // Delegation to a built client
  // ===========================================================================

  it('delegates a method call to the built client and returns its result', async () => {
    const result = await provider.upload(
      'some/key',
      {} as unknown as import('node:stream').Readable,
      {} as unknown as import('./storage-provider.types').StorageUploadOptions,
    );

    expect(result).toEqual({ key: 'uploaded' });
    expect(createdInstances).toHaveLength(1);
    expect(createdInstances[0].upload).toHaveBeenCalledWith(
      'some/key',
      expect.anything(),
      expect.anything(),
    );
  });

  it('hands the resolved provider KIND to the client it builds (#374)', async () => {
    storageConfig.resolve.mockResolvedValue(
      configured(
        resolvedConfig({
          provider: 'r2',
          region: 'auto',
          endpoint: 'https://acct.r2.cloudflarestorage.com',
        }),
      ),
    );

    await provider.exists('a');

    // Without this the driver could only INFER the vendor from the shape of
    // the configuration, and "has an endpoint" is not "is R2" — which is the
    // conflation that used to make every endpoint force path-style URLs. What
    // the kind then selects is asserted in `s3/s3-storage.provider.spec.ts`.
    expect(S3StorageProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'r2',
        region: 'auto',
        endpoint: 'https://acct.r2.cloudflarestorage.com',
      }),
    );
  });

  it('reuses the cached delegate across calls for the same configuration', async () => {
    await provider.exists('a');
    await provider.exists('b');

    expect(S3StorageProvider).toHaveBeenCalledTimes(1);
    expect(createdInstances[0].exists).toHaveBeenNthCalledWith(1, 'a');
    expect(createdInstances[0].exists).toHaveBeenNthCalledWith(2, 'b');
  });

  it('builds a NEW delegate when the secret changes (rotation without restart)', async () => {
    storageConfig.resolve.mockResolvedValue(
      configured(resolvedConfig({ secretAccessKey: 'secret-a' })),
    );
    await provider.exists('a');

    storageConfig.resolve.mockResolvedValue(
      configured(resolvedConfig({ secretAccessKey: 'rotated-secret' })),
    );
    await provider.exists('b');

    expect(S3StorageProvider).toHaveBeenCalledTimes(2);
  });

  it('does NOT build a new delegate when only the secret is unchanged across re-resolves', async () => {
    // Two separate resolve() calls, same values but different object
    // references each time — identity must come from the fingerprint, not
    // from object equality.
    storageConfig.resolve.mockResolvedValueOnce(
      configured(resolvedConfig({ bucket: 'same-bucket' })),
    );
    await provider.exists('a');

    storageConfig.resolve.mockResolvedValueOnce(
      configured(resolvedConfig({ bucket: 'same-bucket' })),
    );
    await provider.exists('b');

    expect(S3StorageProvider).toHaveBeenCalledTimes(1);
  });

  // ===========================================================================
  // The bounded delegate cache
  // ===========================================================================

  it('is bounded at 2 delegates and destroys the evicted one', async () => {
    storageConfig.resolve.mockResolvedValue(
      configured(resolvedConfig({ bucket: 'bucket-a', secretAccessKey: 'secret-a' })),
    );
    await provider.exists('a');

    storageConfig.resolve.mockResolvedValue(
      configured(resolvedConfig({ bucket: 'bucket-b', secretAccessKey: 'secret-b' })),
    );
    await provider.exists('b');

    storageConfig.resolve.mockResolvedValue(
      configured(resolvedConfig({ bucket: 'bucket-c', secretAccessKey: 'secret-c' })),
    );
    await provider.exists('c');

    expect(S3StorageProvider).toHaveBeenCalledTimes(3);
    // The first (oldest) delegate was evicted and destroyed.
    expect(createdInstances[0].destroy).toHaveBeenCalledTimes(1);
    // The two most recent survive.
    expect(createdInstances[1].destroy).not.toHaveBeenCalled();
    expect(createdInstances[2].destroy).not.toHaveBeenCalled();
  });

  it('keeps both delegates usable while only 2 configurations are in play', async () => {
    storageConfig.resolve.mockResolvedValueOnce(
      configured(resolvedConfig({ bucket: 'bucket-a', secretAccessKey: 'secret-a' })),
    );
    await provider.exists('a');

    storageConfig.resolve.mockResolvedValueOnce(
      configured(resolvedConfig({ bucket: 'bucket-b', secretAccessKey: 'secret-b' })),
    );
    await provider.exists('b');

    expect(S3StorageProvider).toHaveBeenCalledTimes(2);
    expect(createdInstances[0].destroy).not.toHaveBeenCalled();
    expect(createdInstances[1].destroy).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // Unconfigured → StorageNotConfiguredError (503, remedy names the settings page)
  // ===========================================================================

  describe('when storage is not configured', () => {
    beforeEach(() => {
      storageConfig.resolve.mockResolvedValue({
        configured: false,
        provider: 's3',
        missing: ['bucket', 'secretAccessKey'],
      });
    });

    it('throws StorageNotConfiguredError', async () => {
      await expect(provider.exists('a')).rejects.toBeInstanceOf(
        StorageNotConfiguredError,
      );
    });

    it('is a 503', async () => {
      await expect(provider.exists('a')).rejects.toMatchObject({
        // ServiceUnavailableException always maps to 503.
        status: 503,
      });
    });

    it('names /admin/settings/storage as the remedy', async () => {
      try {
        await provider.exists('a');
        throw new Error('expected provider.exists to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(StorageNotConfiguredError);
        const response = (error as StorageNotConfiguredError).getResponse() as {
          details: { remedy: string };
        };
        expect(response.details.remedy).toContain('/admin/settings/storage');
      }
    });

    it('does not build a delegate', async () => {
      await expect(provider.exists('a')).rejects.toBeInstanceOf(
        StorageNotConfiguredError,
      );

      expect(S3StorageProvider).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // getBucket()
  // ===========================================================================

  describe('getBucket()', () => {
    it('returns the last known bucket', () => {
      storageConfig.lastKnownBucket.mockReturnValue('known-bucket');

      expect(provider.getBucket()).toBe('known-bucket');
    });

    it('throws a 503 StorageNotConfiguredError, never an empty string, when no read has succeeded yet', () => {
      storageConfig.lastKnownBucket.mockReturnValue(null);

      expect(() => provider.getBucket()).toThrow(StorageNotConfiguredError);
      try {
        provider.getBucket();
        throw new Error('expected getBucket to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(StorageNotConfiguredError);
        expect((error as StorageNotConfiguredError).getStatus()).toBe(503);
      }
    });

    it('is synchronous (no await needed to get an answer or a throw)', () => {
      storageConfig.lastKnownBucket.mockReturnValue('sync-bucket');

      const result = provider.getBucket();

      expect(result).toBe('sync-bucket');
    });
  });
});
