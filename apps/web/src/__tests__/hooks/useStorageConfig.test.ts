/**
 * `hooks/useStorageConfig.ts` — issue #376, epic #372.
 *
 * Four things are worth asserting here that no page test can:
 *
 *   * A BAD DIAGNOSIS IS NOT A FAILED CALL. `POST /test` and `POST /bucket`
 *     both answer HTTP 200 carrying the answer, so a refused `HeadBucket` must
 *     land in `testResult` — not in `probeError`, and certainly not as a
 *     rejected promise. Getting this backwards is how a page announces that
 *     storage works over a bucket it could not reach.
 *
 *   * THE 409 IS TWO DIFFERENT ANSWERS. A version mismatch reloads the form;
 *     `STORAGE_LOCATION_IN_USE` does NOT, because re-sending the identical body
 *     with the confirmation is the whole remedy and a reload would throw away
 *     the edit the admin is being asked to confirm.
 *
 *   * THE CONFIRMED RE-SEND CARRIES THE LITERAL, and the unconfirmed one does
 *     not — asserted on the actual call argument rather than on a comment.
 *
 *   * A FAILED WRITE RESOLVES `false`. Every caller is a click handler that
 *     needs to branch, not a place to handle an exception already captured for
 *     display.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../services/storageConfig', async () => {
  const actual = await vi.importActual<typeof import('../../services/storageConfig')>(
    '../../services/storageConfig',
  );
  return {
    ...actual,
    getStorageConfig: vi.fn(),
    updateStorageConfig: vi.fn(),
    testStorageConfig: vi.fn(),
    provisionStorageBucket: vi.fn(),
  };
});

import {
  getStorageConfig,
  provisionStorageBucket,
  testStorageConfig,
  updateStorageConfig,
  STORAGE_SWITCH_CONFIRMATION,
} from '../../services/storageConfig';
import type {
  StorageBucketProvisionResult,
  StorageConfigInput,
  StorageConfigView,
  StorageConnectionTestResult,
} from '../../services/storageConfig';
import { ApiError } from '../../services/api';
import { useStorageConfig } from '../../hooks/useStorageConfig';

const mockGet = vi.mocked(getStorageConfig);
const mockUpdate = vi.mocked(updateStorageConfig);
const mockTest = vi.mocked(testStorageConfig);
const mockProvision = vi.mocked(provisionStorageBucket);

const storedConfig: StorageConfigView = {
  provider: 's3',
  bucket: 'app-objects',
  region: 'us-east-1',
  endpoint: '',
  accountId: '',
  accessKeyId: 'AKIAEXAMPLE',
  forcePathStyle: null,
  effectiveEndpoint: null,
  configured: true,
  missing: [],
  secretStatus: {
    configured: true,
    hint: '••••ab12',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByUserId: 'admin-user-id',
  },
  version: 3,
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: { id: 'admin-user-id', email: 'admin@example.com' },
};

const input: StorageConfigInput = {
  provider: 's3',
  bucket: 'app-objects',
  region: 'us-east-1',
  endpoint: '',
  accountId: '',
  accessKeyId: 'AKIAEXAMPLE',
  forcePathStyle: null,
};

const failingTest: StorageConnectionTestResult = {
  success: false,
  provider: 's3',
  bucket: 'app-objects',
  region: 'us-east-1',
  effectiveEndpoint: null,
  usedStoredSecret: true,
  checks: [
    {
      id: 'credentials',
      label: 'Credentials',
      status: 'passed',
      code: 'ok',
      detail: 'The provider accepted the key pair.',
      error: null,
    },
    {
      id: 'bucket',
      label: 'Bucket',
      status: 'failed',
      code: 'bucket_missing',
      detail: 'No bucket named app-objects exists.',
      error: 'NoSuchBucket: The specified bucket does not exist',
    },
  ],
  attemptedAt: '2026-01-01T00:00:00.000Z',
};

const createdBucket: StorageBucketProvisionResult = {
  outcome: 'created',
  provider: 's3',
  bucket: 'app-objects',
  region: 'us-east-1',
  effectiveEndpoint: null,
  steps: [
    { id: 'create', label: 'Create bucket', status: 'passed', detail: 'Created.', error: null },
  ],
  guidance: null,
  corsOrigin: 'https://app.example.com',
  attemptedAt: '2026-01-01T00:00:00.000Z',
};

async function renderLoaded() {
  const view = renderHook(() => useStorageConfig());
  await waitFor(() => expect(view.result.current.isLoading).toBe(false));
  return view;
}

describe('useStorageConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(storedConfig);
    mockUpdate.mockResolvedValue({ ...storedConfig, version: 4 });
    mockTest.mockResolvedValue(failingTest);
    mockProvision.mockResolvedValue(createdBucket);
  });

  it('loads the configuration on mount', async () => {
    const { result } = await renderLoaded();
    expect(result.current.config).toEqual(storedConfig);
    expect(result.current.loadError).toBeNull();
  });

  it('names a 403 on load rather than surfacing a bare message', async () => {
    mockGet.mockRejectedValueOnce(new ApiError('Forbidden', 403));
    const { result } = await renderLoaded();
    expect(result.current.loadError).toMatch(/do not have permission/i);
  });

  describe('save', () => {
    it('sends the current version as If-Match and adopts the response as the new baseline', async () => {
      const { result } = await renderLoaded();

      let ok: boolean | undefined;
      await act(async () => {
        ok = await result.current.save(input);
      });

      expect(ok).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith(input, 3, {});
      expect(result.current.config?.version).toBe(4);
    });

    it('resolves false and records the message when the save fails', async () => {
      mockUpdate.mockRejectedValueOnce(new ApiError('Bucket name is not valid', 400));
      const { result } = await renderLoaded();

      let ok: boolean | undefined;
      await act(async () => {
        ok = await result.current.save(input);
      });

      expect(ok).toBe(false);
      expect(result.current.saveError).toBe('Bucket name is not valid');
      expect(result.current.switchRequired).toBeNull();
    });

    it('treats a plain 409 as a version conflict: reload the form, explain, do not ask for a word', async () => {
      mockUpdate.mockRejectedValueOnce(new ApiError('Storage settings version mismatch', 409));
      const { result } = await renderLoaded();
      mockGet.mockResolvedValue({ ...storedConfig, version: 9 });

      await act(async () => {
        await result.current.save(input);
      });

      expect(result.current.saveError).toMatch(/someone else changed/i);
      expect(result.current.switchRequired).toBeNull();
      // Reloaded — the next save asserts against the row that is actually live.
      expect(result.current.config?.version).toBe(9);
    });

    it('treats a STORAGE_LOCATION_IN_USE 409 as a request for confirmation, NOT an error, and does not reload', async () => {
      const details = {
        confirmation: STORAGE_SWITCH_CONFIRMATION,
        from: { provider: 's3' as const, bucket: 'old', endpoint: null },
        to: { provider: 'r2' as const, bucket: 'new', endpoint: 'https://acct.r2.cloudflarestorage.com' },
        storageObjects: 12,
        databaseBackupRuns: 3,
        total: 15,
      };
      mockUpdate.mockRejectedValueOnce(
        new ApiError('12 stored object(s) still point at s3/old.', 409, 'STORAGE_LOCATION_IN_USE', details),
      );
      const { result } = await renderLoaded();
      const getCallsBefore = mockGet.mock.calls.length;

      let ok: boolean | undefined;
      await act(async () => {
        ok = await result.current.save(input);
      });

      expect(ok).toBe(false);
      // NOT an error — the save is legitimate and the API is asking for a word.
      expect(result.current.saveError).toBeNull();
      expect(result.current.switchRequired?.message).toMatch(/still point at/);
      expect(result.current.switchRequired?.details).toEqual(details);
      // ⚠ NOT reloaded: a reload would discard the very edit being confirmed.
      expect(mockGet.mock.calls.length).toBe(getCallsBefore);
    });

    it('re-sends with confirmSwitch when the page confirms, and clears the prompt on success', async () => {
      mockUpdate.mockRejectedValueOnce(
        new ApiError('in use', 409, 'STORAGE_LOCATION_IN_USE', undefined),
      );
      const { result } = await renderLoaded();

      await act(async () => {
        await result.current.save(input);
      });
      expect(result.current.switchRequired).not.toBeNull();

      await act(async () => {
        await result.current.save(input, { confirmSwitch: true });
      });

      expect(mockUpdate).toHaveBeenLastCalledWith(input, 3, { confirmSwitch: true });
      expect(result.current.switchRequired).toBeNull();
    });
  });

  describe('the two probes', () => {
    it('records a FAILED diagnosis as a result, never as a probe error', async () => {
      const { result } = await renderLoaded();

      await act(async () => {
        await result.current.test(input);
      });

      expect(result.current.testResult).toEqual(failingTest);
      expect(result.current.testResult?.success).toBe(false);
      // The call worked perfectly. The configuration did not.
      expect(result.current.probeError).toBeNull();
    });

    it('records a rejected CALL as a probe error, and never fabricates a result', async () => {
      mockTest.mockRejectedValueOnce(new ApiError('Internal server error', 500));
      const { result } = await renderLoaded();

      await act(async () => {
        await result.current.test(input);
      });

      expect(result.current.testResult).toBeNull();
      expect(result.current.probeError).toBe('Internal server error');
    });

    it('sends the configuration on screen, unsaved, exactly as given', async () => {
      const { result } = await renderLoaded();
      const unsaved = { ...input, bucket: 'not-saved-yet', secretAccessKey: 'typed-now' };

      await act(async () => {
        await result.current.test(unsaved);
      });

      expect(mockTest).toHaveBeenCalledWith(unsaved);
    });

    it('keeps a guided bucket outcome as a result rather than an error', async () => {
      mockProvision.mockResolvedValueOnce({
        ...createdBucket,
        outcome: 'guided',
        steps: [],
        guidance: {
          reason: 'This key cannot create buckets.',
          commands: 'aws s3api create-bucket --bucket app-objects',
          runbook: null,
        },
      });
      const { result } = await renderLoaded();

      await act(async () => {
        await result.current.createBucket(input);
      });

      expect(result.current.bucketResult?.outcome).toBe('guided');
      expect(result.current.probeError).toBeNull();
    });

    it('clears a stale "bucket missing" test once the bucket has actually been created', async () => {
      const { result } = await renderLoaded();

      await act(async () => {
        await result.current.test(input);
      });
      expect(result.current.testResult).not.toBeNull();

      await act(async () => {
        await result.current.createBucket(input);
      });

      // The evidence that offered the button has been superseded; the admin
      // re-tests to learn the new truth rather than reading the old one.
      expect(result.current.testResult).toBeNull();
      expect(result.current.bucketResult?.outcome).toBe('created');
    });

    it('leaves the test in place when the bucket action was only GUIDED — nothing changed', async () => {
      mockProvision.mockResolvedValueOnce({
        ...createdBucket,
        outcome: 'guided',
        steps: [],
        guidance: { reason: 'no permission', commands: 'aws s3api create-bucket', runbook: null },
      });
      const { result } = await renderLoaded();

      await act(async () => {
        await result.current.test(input);
      });
      await act(async () => {
        await result.current.createBucket(input);
      });

      expect(result.current.testResult).not.toBeNull();
    });
  });
});
