/**
 * `services/storage.ts` — issue #445. The playground's slice of the storage
 * API: upload, read back until `ready`, and the signed download URL.
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { mockStorageObject } from '../mocks/fixtures/ai';
import {
  StorageObjectNotReadyError,
  getStorageObjectDownloadUrl,
  uploadStorageObjectAndWait,
  waitForStorageObjectReady,
  type StorageObjectStatus,
} from '../../services/storage';

function scriptStatuses(statuses: StorageObjectStatus[]) {
  const reads: string[] = [];
  server.use(
    http.get('*/api/storage/objects/:id', ({ params }) => {
      reads.push(String(params.id));
      const status = statuses[Math.min(reads.length - 1, statuses.length - 1)];
      return HttpResponse.json({ data: mockStorageObject({ id: String(params.id), status }) });
    }),
  );
  return reads;
}

describe('storage service', () => {
  it('uploads as multipart and resolves once the object is ready', async () => {
    let contentType: string | null = null;
    server.use(
      http.post('*/api/storage/objects', ({ request }) => {
        contentType = request.headers.get('content-type');
        return HttpResponse.json({ data: mockStorageObject({ id: 'obj-1' }) }, { status: 201 });
      }),
    );
    const reads = scriptStatuses(['processing', 'ready']);

    const object = await uploadStorageObjectAndWait(new File(['x'], 'a.png', { type: 'image/png' }), { intervalMs: 1 });

    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(object).toMatchObject({ id: 'obj-1', status: 'ready' });
    expect(reads).toEqual(['obj-1', 'obj-1']);
  });

  it('does not read an object that is already ready', async () => {
    const reads = scriptStatuses(['ready']);
    await waitForStorageObjectReady(mockStorageObject({ status: 'ready' }));
    expect(reads).toHaveLength(0);
  });

  it('throws when processing fails', async () => {
    scriptStatuses(['failed']);
    await expect(waitForStorageObjectReady(mockStorageObject(), { intervalMs: 1 })).rejects.toMatchObject({
      name: 'StorageObjectNotReadyError',
      status: 'failed',
    });
  });

  it('gives up after the timeout', async () => {
    scriptStatuses(['processing']);
    const error = await waitForStorageObjectReady(mockStorageObject(), { intervalMs: 1, timeoutMs: 5 }).catch((e) => e);
    expect(error).toBeInstanceOf(StorageObjectNotReadyError);
    expect(error.status).toBe('timeout');
  });

  it('reads the signed download URL', async () => {
    await expect(getStorageObjectDownloadUrl('obj-2')).resolves.toEqual({
      url: 'https://storage.example.test/objects/obj-2?signature=test',
      expiresIn: 300,
    });
  });
});
