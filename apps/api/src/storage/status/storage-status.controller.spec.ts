import { Logger } from '@nestjs/common';

import type { StorageConfigResolution } from '../config/storage-config';
import { StorageConfigService } from '../config/storage-config.service';
import { StorageStatusController } from './storage-status.controller';

// =============================================================================
// StorageStatusController (#204): one boolean, never provider fields
// =============================================================================

const COMPLETE: StorageConfigResolution = {
  configured: true,
  config: {
    provider: 's3',
    bucket: 'secret-bucket-name',
    region: 'eu-west-9',
    endpoint: 'https://internal.example',
    accessKeyId: 'AKIA-SECRET-ID',
    secretAccessKey: 'super-secret',
  },
} as unknown as StorageConfigResolution;

const INCOMPLETE: StorageConfigResolution = {
  configured: false,
  provider: 's3',
  missing: ['bucket', 'region'],
} as StorageConfigResolution;

describe('StorageStatusController', () => {
  let resolve: jest.Mock;
  let controller: StorageStatusController;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    resolve = jest.fn();
    controller = new StorageStatusController({ resolve } as unknown as StorageConfigService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('reports configured: true for a complete configuration', async () => {
    resolve.mockResolvedValue(COMPLETE);

    await expect(controller.getStatus()).resolves.toEqual({ configured: true });
  });

  it('reports configured: false for an incomplete configuration', async () => {
    resolve.mockResolvedValue(INCOMPLETE);

    await expect(controller.getStatus()).resolves.toEqual({ configured: false });
  });

  it('reports configured: false, not an error, when resolution throws', async () => {
    resolve.mockRejectedValue(new Error('decrypt failed: bad SECRETS_ENCRYPTION_KEY'));

    await expect(controller.getStatus()).resolves.toEqual({ configured: false });
  });

  it.each([
    ['complete', COMPLETE, undefined],
    ['incomplete', INCOMPLETE, undefined],
    ['throwing', undefined, new Error('boom AKIA-SECRET-ID')],
  ])('leaks no provider, bucket, region or credential (%s)', async (_label, resolution, error) => {
    if (error) resolve.mockRejectedValue(error);
    else resolve.mockResolvedValue(resolution);

    const result = await controller.getStatus();
    const json = JSON.stringify(result);

    expect(Object.keys(result)).toEqual(['configured']);
    for (const leak of ['s3', 'secret-bucket-name', 'eu-west-9', 'internal.example', 'AKIA', 'super-secret', 'bucket', 'region', 'missing']) {
      expect(json).not.toContain(leak);
    }
  });
});
