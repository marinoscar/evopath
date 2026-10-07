import { DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import { StorageProvider } from '../../providers/storage-provider.interface';
import { StorageConfigService } from '../storage-config.service';
import {
  STORAGE_DOCTOR_PROBE_KEY,
  StorageBucketDoctorCheck,
  decideStorageProbeError,
} from './storage-bucket.doctor-check';
import { StorageConfigDoctorCheck, decideStorageConfig } from './storage-config.doctor-check';

function expectRemedy(outcome: DoctorCheckOutcome): void {
  expect(['warn', 'fail']).toContain(outcome.status);
  expect(outcome.remedy).toEqual(expect.stringMatching(/\S{10,}/));
}

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

function awsError(name: string, httpStatusCode?: number): Error {
  const error = new Error(`${name} happened`);
  error.name = name;
  if (httpStatusCode) (error as unknown as { $metadata: object }).$metadata = { httpStatusCode };
  return error;
}

describe('storage doctor checks', () => {
  describe('storage.config', () => {
    it('fails listing the missing field names', () => {
      const outcome = decideStorageConfig({ configured: false, provider: 's3', missing: ['bucket', 'secretAccessKey'] });

      expect(outcome.status).toBe('fail');
      expect(outcome.detail).toContain('bucket, secretAccessKey');
      expect(outcome.remedy).toContain('/admin/settings/storage');
    });

    it('passes naming provider, bucket and region — never the credential', async () => {
      const resolve = jest.fn().mockResolvedValue({
        configured: true,
        config: {
          provider: 'r2',
          bucket: 'uploads',
          region: 'auto',
          accessKeyId: 'AKIAEXAMPLEACCESSID',
          secretAccessKey: SECRET,
        },
      });
      const check = new StorageConfigDoctorCheck(new DoctorCheckRegistry(), { resolve } as unknown as StorageConfigService);
      const outcome = await check.run();

      expect(outcome).toMatchObject({ status: 'pass', data: { provider: 'r2', bucket: 'uploads' } });
      expect(resolve).toHaveBeenCalledWith({ fresh: true });
      expect(JSON.stringify(outcome)).not.toContain(SECRET);
      expect(JSON.stringify(outcome)).not.toContain('AKIAEXAMPLEACCESSID');
    });

    it('fails, with a remedy, when the configuration cannot be read', async () => {
      const resolve = jest.fn().mockRejectedValue(new Error('Unsupported state or unable to authenticate data'));
      const check = new StorageConfigDoctorCheck(new DoctorCheckRegistry(), { resolve } as unknown as StorageConfigService);

      expectRemedy(await check.run());
    });
  });

  describe('storage.bucket', () => {
    const make = (exists: jest.Mock) => {
      const registry = new DoctorCheckRegistry();
      const storage = { exists, upload: jest.fn(), delete: jest.fn(), setMetadata: jest.fn() };
      const check = new StorageBucketDoctorCheck(registry, storage as unknown as StorageProvider);
      check.onModuleInit();
      return { check, registry, storage };
    };

    it('depends on storage.config and registers itself', () => {
      const { check, registry } = make(jest.fn());
      expect(check.dependsOn).toEqual(['storage.config']);
      expect(registry.get('storage.bucket')).toBe(check);
    });

    it('passes when the probe read answers, and writes nothing', async () => {
      const { check, storage } = make(jest.fn().mockResolvedValue(false));

      await expect(check.run()).resolves.toMatchObject({ status: 'pass' });
      expect(storage.exists).toHaveBeenCalledWith(STORAGE_DOCTOR_PROBE_KEY);
      expect(storage.upload).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
      expect(storage.setMetadata).not.toHaveBeenCalled();
    });

    it('fails on a refused credential, pointing at the credential', async () => {
      const { check } = make(jest.fn().mockRejectedValue(awsError('InvalidAccessKeyId', 403)));
      const outcome = await check.run();

      expect(outcome.detail).toContain('rejected the credential');
      expectRemedy(outcome);
    });

    it.each([
      ['ECONNREFUSED', undefined, 'did not answer'],
      ['NoSuchBucket', 404, 'does not exist'],
      ['AccessDenied', 403, 'may not read'],
      ['PermanentRedirect', 301, 'different region'],
      ['InternalError', 500, 'answered with an error'],
    ])('classifies %s', (code, status, expected) => {
      const error = awsError(code, status);
      if (code === 'ECONNREFUSED') (error as unknown as { code: string }).code = code;
      const outcome = decideStorageProbeError(error);

      expect(outcome.detail).toContain(expected);
      expectRemedy(outcome);
    });
  });
});
