/**
 * The storage-config wire contract (issue #376, epic #372).
 *
 * The failure mode of a thin service module is not a crash — it is a request
 * that is quietly the wrong shape and a 400 the page reports as "Failed to save
 * the storage configuration". So each of the four routes is exercised against
 * msw and the REQUEST is asserted: method, path, headers, body.
 *
 * Three of those assertions are load-bearing rather than routine:
 *
 *   1. `If-Match: 0` IS SENT. The check is `expectedVersion === undefined`,
 *      never a truthiness test, so the first save on a fresh deployment still
 *      asserts "nothing is stored yet" instead of being the one unguarded write.
 *
 *   2. `forcePathStyle: null` SURVIVES SERIALISATION. It is the tri-state's
 *      whole point, and `JSON.stringify` drops `undefined` while keeping
 *      `null` — a conversion that turned one into the other would silently
 *      hand the API an explicit `false` nobody chose (#374's bug).
 *
 *   3. A BAD DIAGNOSIS STILL RESOLVES. Both probes answer 200 carrying the
 *      answer; a client that threw on `success: false` would make the page's
 *      entire reason for existing unreachable.
 *
 * The confirmation literal and the provider kinds are checked against the API's
 * own DTOs ON DISK rather than against a copy, the same technique
 * `services/broadcasts.test.ts` and `services/maintenance.test.ts` use: a
 * dialog comparing against a drifted literal would offer a confirmation the API
 * will refuse.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  MISSING_STORAGE_CONFIG_FIELDS,
  STORAGE_BUCKET_OUTCOMES,
  STORAGE_PROVIDER_KINDS,
  STORAGE_SWITCH_CONFIRMATION,
  STORAGE_TEST_CHECK_CODES,
  getStorageConfig,
  provisionStorageBucket,
  reportsBucketMissing,
  testStorageConfig,
  updateStorageConfig,
} from '../../services/storageConfig';
import type {
  StorageConfigInput,
  StorageConfigView,
  StorageConnectionTestResult,
} from '../../services/storageConfig';

const API_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../api/src');
const CONFIG_DIR = resolve(API_SRC, 'storage/config');

const storedConfig: StorageConfigView = {
  provider: 's3compatible',
  bucket: 'app-objects',
  region: 'us-east-1',
  endpoint: 'https://minio.example.com:9000',
  accountId: '',
  accessKeyId: 'AKIAEXAMPLE',
  forcePathStyle: null,
  effectiveEndpoint: 'https://minio.example.com:9000',
  configured: true,
  missing: [],
  secretStatus: {
    configured: true,
    hint: '••••ab12',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByUserId: 'admin-user-id',
  },
  version: 7,
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: { id: 'admin-user-id', email: 'admin@example.com' },
};

const input: StorageConfigInput = {
  provider: 's3compatible',
  bucket: 'app-objects',
  region: 'us-east-1',
  endpoint: 'https://minio.example.com:9000',
  accountId: '',
  accessKeyId: 'AKIAEXAMPLE',
  forcePathStyle: null,
};

interface Captured {
  body: Record<string, unknown>;
  ifMatch: string | null;
}

function captureWrite(
  method: 'put' | 'post',
  path: string,
  response: unknown,
): { seen: Captured | null } {
  const box: { seen: Captured | null } = { seen: null };
  server.use(
    http[method](path, async ({ request }) => {
      box.seen = {
        body: (await request.json()) as Record<string, unknown>,
        ifMatch: request.headers.get('If-Match'),
      };
      return HttpResponse.json({ data: response });
    }),
  );
  return box;
}

describe('services/storageConfig — the wire contract', () => {
  beforeEach(() => {
    server.resetHandlers();
  });

  it('GET reads /admin/storage-config and unwraps the envelope', async () => {
    server.use(
      http.get('*/api/admin/storage-config', () => HttpResponse.json({ data: storedConfig })),
    );

    await expect(getStorageConfig()).resolves.toEqual(storedConfig);
  });

  it('PUT sends the seven fields and the current version as If-Match', async () => {
    const captured = captureWrite('put', '*/api/admin/storage-config', storedConfig);

    await updateStorageConfig(input, 7);

    expect(captured.seen?.ifMatch).toBe('7');
    expect(captured.seen?.body).toEqual(input);
    // No confirmation unless it was asked for.
    expect(captured.seen?.body).not.toHaveProperty('confirmation');
  });

  it('sends If-Match: 0, because 0 is an assertion and not an absence', async () => {
    const captured = captureWrite('put', '*/api/admin/storage-config', storedConfig);

    await updateStorageConfig(input, 0);

    expect(captured.seen?.ifMatch).toBe('0');
  });

  it('omits If-Match entirely when no version is given', async () => {
    const captured = captureWrite('put', '*/api/admin/storage-config', storedConfig);

    await updateStorageConfig(input);

    expect(captured.seen?.ifMatch).toBeNull();
  });

  it('adds the SWITCH literal only when the caller confirms', async () => {
    const captured = captureWrite('put', '*/api/admin/storage-config', storedConfig);

    await updateStorageConfig(input, 7, { confirmSwitch: true });

    expect(captured.seen?.body.confirmation).toBe(STORAGE_SWITCH_CONFIRMATION);
  });

  it('serialises forcePathStyle: null as null, never dropping it', async () => {
    const captured = captureWrite('put', '*/api/admin/storage-config', storedConfig);

    await updateStorageConfig({ ...input, forcePathStyle: null }, 7);

    expect(Object.prototype.hasOwnProperty.call(captured.seen!.body, 'forcePathStyle')).toBe(true);
    expect(captured.seen?.body.forcePathStyle).toBeNull();
  });

  it('carries an explicit false through as false', async () => {
    const captured = captureWrite('put', '*/api/admin/storage-config', storedConfig);

    await updateStorageConfig({ ...input, forcePathStyle: false }, 7);

    expect(captured.seen?.body.forcePathStyle).toBe(false);
  });

  it('posts the submitted configuration to /test, and resolves a FAILED diagnosis rather than throwing', async () => {
    const failing: StorageConnectionTestResult = {
      success: false,
      provider: 's3compatible',
      bucket: 'app-objects',
      region: 'us-east-1',
      effectiveEndpoint: 'https://minio.example.com:9000',
      usedStoredSecret: true,
      checks: [
        {
          id: 'bucket',
          label: 'Bucket',
          status: 'failed',
          code: 'bucket_missing',
          detail: 'No such bucket.',
          error: 'NoSuchBucket',
        },
      ],
      attemptedAt: '2026-01-01T00:00:00.000Z',
    };
    const captured = captureWrite('post', '*/api/admin/storage-config/test', failing);

    const result = await testStorageConfig(input);

    expect(captured.seen?.body).toEqual(input);
    expect(result.success).toBe(false);
  });

  it('posts to /bucket, and resolves a GUIDED outcome rather than throwing', async () => {
    const guided = {
      outcome: 'guided',
      provider: 's3compatible',
      bucket: 'app-objects',
      region: 'us-east-1',
      effectiveEndpoint: 'https://minio.example.com:9000',
      steps: [],
      guidance: {
        reason: 'This credential cannot create buckets.',
        commands: 'aws s3api create-bucket --bucket app-objects',
        runbook: null,
      },
      corsOrigin: null,
      attemptedAt: '2026-01-01T00:00:00.000Z',
    };
    const captured = captureWrite('post', '*/api/admin/storage-config/bucket', guided);

    const result = await provisionStorageBucket(input);

    expect(captured.seen?.body).toEqual(input);
    expect(result.outcome).toBe('guided');
    expect(result.guidance?.commands).toContain('create-bucket');
  });

  it('omits secretAccessKey when the caller did not supply one, and sends it when they did', async () => {
    const blank = captureWrite('put', '*/api/admin/storage-config', storedConfig);
    await updateStorageConfig(input, 7);
    expect(Object.prototype.hasOwnProperty.call(blank.seen!.body, 'secretAccessKey')).toBe(false);

    const typed = captureWrite('put', '*/api/admin/storage-config', storedConfig);
    await updateStorageConfig({ ...input, secretAccessKey: 'typed-secret' }, 7);
    expect(typed.seen?.body.secretAccessKey).toBe('typed-secret');
  });
});

describe('reportsBucketMissing', () => {
  function withCode(code: string): StorageConnectionTestResult {
    return {
      success: false,
      provider: 's3',
      bucket: 'b',
      region: 'us-east-1',
      effectiveEndpoint: null,
      usedStoredSecret: true,
      checks: [
        {
          id: 'bucket',
          label: 'Bucket',
          status: 'failed',
          code: code as StorageConnectionTestResult['checks'][number]['code'],
          detail: '',
          error: null,
        },
      ],
      attemptedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('is true only for bucket_missing', () => {
    expect(reportsBucketMissing(withCode('bucket_missing'))).toBe(true);
  });

  it('is FALSE for bucket_forbidden — the two need opposite actions', () => {
    // 403 means the bucket exists and this key may not see it. Offering to
    // create it would send an admin to make a bucket that is already there and
    // is not theirs. This is the single assertion that keeps the two apart.
    expect(reportsBucketMissing(withCode('bucket_forbidden'))).toBe(false);
  });

  it('is false for no result at all', () => {
    expect(reportsBucketMissing(null)).toBe(false);
  });
});

describe('the constants mirror the API DTOs on disk', () => {
  // Read off the API workspace rather than restated, so a rename on either side
  // fails here rather than as a 400 the page reports as a generic failure.
  const updateDto = readFileSync(resolve(CONFIG_DIR, 'dto/update-storage-config.dto.ts'), 'utf8');
  const testDto = readFileSync(resolve(CONFIG_DIR, 'dto/storage-connection-test.dto.ts'), 'utf8');
  const bucketDto = readFileSync(
    resolve(CONFIG_DIR, 'dto/storage-bucket-provision.dto.ts'),
    'utf8',
  );
  const storageConfigSource = readFileSync(resolve(CONFIG_DIR, 'storage-config.ts'), 'utf8');

  it('uses the API’s own confirmation literal', () => {
    expect(updateDto).toContain(
      `export const STORAGE_SWITCH_CONFIRMATION = '${STORAGE_SWITCH_CONFIRMATION}'`,
    );
  });

  it('lists every provider kind the API accepts', () => {
    for (const kind of STORAGE_PROVIDER_KINDS) {
      expect(updateDto.includes(kind) || storageConfigSource.includes(`'${kind}'`)).toBe(true);
    }
    expect([...STORAGE_PROVIDER_KINDS]).toEqual(['s3', 'r2', 's3compatible']);
  });

  it('lists every check code the API can report, bucket_missing and bucket_forbidden included', () => {
    for (const code of STORAGE_TEST_CHECK_CODES) {
      expect(testDto, `${code} is not a code the API declares`).toContain(`'${code}'`);
    }
    expect(STORAGE_TEST_CHECK_CODES).toContain('bucket_missing');
    expect(STORAGE_TEST_CHECK_CODES).toContain('bucket_forbidden');
  });

  it('lists every bucket outcome, including guided', () => {
    for (const outcome of STORAGE_BUCKET_OUTCOMES) {
      expect(bucketDto, `${outcome} is not an outcome the API declares`).toContain(`'${outcome}'`);
    }
  });

  it('lists every field the API can report as missing', () => {
    for (const field of MISSING_STORAGE_CONFIG_FIELDS) {
      expect(storageConfigSource).toContain(`'${field}'`);
    }
  });
});
