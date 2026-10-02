/**
 * `services/intake.ts` — the routes and bodies each wrapper sends, and the
 * `uploadAndAttach` default (upload, wait ready, attach; best-effort delete
 * of the fresh object when the attach fails).
 */
import { describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  acceptAllDraftItems,
  addDraftItem,
  analyzeIntake,
  applyIntake,
  attachIntakePhoto,
  createIntake,
  deleteDraftItem,
  detachFrom,
  discardIntake,
  getIntake,
  intakeFileErrorMessage,
  listIntakes,
  removeIntakePhoto,
  updateDraftItem,
  updateIntakeRetainFiles,
  uploadAndAttach,
} from '../../services/intake';
import { ApiError } from '../../services/api';

interface Seen {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

function record(): Seen[] {
  const seen: Seen[] = [];
  server.use(
    http.all('*/api/intakes*', async ({ request }) => {
      const url = new URL(request.url);
      const text = request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text();
      seen.push({ method: request.method, path: url.pathname.replace(/^\/api/, ''), search: url.search, body: text ? JSON.parse(text) : null });
      if (request.method === 'DELETE') return new HttpResponse(null, { status: 204 });
      return HttpResponse.json({ data: { ok: true } });
    }),
  );
  return seen;
}

describe('services/intake', () => {
  it('sends each route with its body', async () => {
    const seen = record();
    await createIntake({ kind: 'gym_equipment', context: { gymId: 'g1' }, subjectType: 'gym', subjectId: 'g1' });
    await listIntakes({ kind: 'gym_equipment', status: ['draft', 'ready'], limit: 5 });
    await getIntake('in 1');
    await attachIntakePhoto('in-1', 'obj-1');
    await removeIntakePhoto('in-1', 'obj-1');
    await analyzeIntake('in-1');
    await addDraftItem('in-1', { kind: 'equipment', value: { name: 'Rack' } });
    await updateDraftItem('in-1', 'it-1', { status: 'rejected' });
    await deleteDraftItem('in-1', 'it-1');
    await acceptAllDraftItems('in-1');
    await acceptAllDraftItems('in-1', { only: 'high_confidence' });
    await applyIntake('in-1');
    await discardIntake('in-1');

    expect(seen.map(({ method, path, search, body }) => [method, path + search, body])).toEqual([
      ['POST', '/intakes', { kind: 'gym_equipment', context: { gymId: 'g1' }, subjectType: 'gym', subjectId: 'g1' }],
      ['GET', '/intakes?kind=gym_equipment&status=draft%2Cready&limit=5', null],
      ['GET', '/intakes/in%201', null],
      ['POST', '/intakes/in-1/photos', { storageObjectId: 'obj-1' }],
      ['DELETE', '/intakes/in-1/photos/obj-1', null],
      ['POST', '/intakes/in-1/analyze', {}],
      ['POST', '/intakes/in-1/items', { kind: 'equipment', value: { name: 'Rack' } }],
      ['PATCH', '/intakes/in-1/items/it-1', { status: 'rejected' }],
      ['DELETE', '/intakes/in-1/items/it-1', null],
      ['POST', '/intakes/in-1/items/accept-all', null],
      ['POST', '/intakes/in-1/items/accept-all', { only: 'high_confidence' }],
      ['POST', '/intakes/in-1/apply', null],
      ['DELETE', '/intakes/in-1', null],
    ]);
  });

  it('uploadAndAttach uploads, reports processing, waits for ready and attaches', async () => {
    const seen = record();
    const setStage = vi.fn();
    const result = await uploadAndAttach('in-1')(new File(['x'], 'a.jpg', { type: 'image/jpeg' }), { setStage });
    // The default MSW upload answers `obj-1` in `processing`; the read answers `ready`.
    expect(result.storageObjectId).toBeTruthy();
    expect(setStage).toHaveBeenCalledWith('processing');
    expect(seen).toEqual([
      expect.objectContaining({ method: 'POST', path: '/intakes/in-1/photos', body: { storageObjectId: result.storageObjectId } }),
    ]);
  });

  it('uploadAndAttach deletes the fresh object when the attach fails, and rethrows', async () => {
    const deleted: string[] = [];
    server.use(
      http.post('*/api/intakes/:id/photos', () =>
        HttpResponse.json({ code: 'CONFLICT', message: 'Already attached' }, { status: 409 }),
      ),
      http.delete('*/api/storage/objects/:id', ({ params }) => {
        deleted.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const error = await uploadAndAttach('in-1')(new File(['x'], 'a.jpg', { type: 'image/jpeg' })).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect(deleted).toHaveLength(1);
  });

  it('carries the keep-or-delete choice on create, PATCH and attach (#185)', async () => {
    const seen = record();
    await createIntake({ kind: 'body_metric_reading', retainFiles: false });
    await updateIntakeRetainFiles('in-1', true);
    await attachIntakePhoto('in-1', 'obj-1', { retainFiles: false });
    await attachIntakePhoto('in-1', 'obj-2', { retainFiles: undefined });
    expect(seen.map(({ method, path, body }) => [method, path, body])).toEqual([
      ['POST', '/intakes', { kind: 'body_metric_reading', retainFiles: false }],
      ['PATCH', '/intakes/in-1', { retainFiles: true }],
      ['POST', '/intakes/in-1/photos', { storageObjectId: 'obj-1', retainFiles: false }],
      ['POST', '/intakes/in-1/photos', { storageObjectId: 'obj-2' }],
    ]);
  });

  it('uploadAndAttach reads the choice at attach time', async () => {
    const seen = record();
    let keep = true;
    const upload = uploadAndAttach('in-1', { retainFiles: () => keep });
    keep = false;
    const result = await upload(new File(['x'], 'a.jpg', { type: 'image/jpeg' }));
    expect(seen).toEqual([
      expect.objectContaining({ path: '/intakes/in-1/photos', body: { storageObjectId: result.storageObjectId, retainFiles: false } }),
    ]);
  });

  it('detachFrom removes the photo from the intake', async () => {
    const seen = record();
    await detachFrom('in-1')('obj-9');
    expect(seen[0]).toMatchObject({ method: 'DELETE', path: '/intakes/in-1/photos/obj-9' });
  });
});

describe('intakeFileErrorMessage (H2, #186)', () => {
  const refusal = (reason: string, details: Record<string, unknown> = {}, message = 'Server words') =>
    new ApiError(message, 400, 'BAD_REQUEST', { reason, storageObjectId: 'obj-1', ...details });

  it.each([
    ['TOO_MANY_PAGES', { pages: 34, maxPages: 20 }, 'pdf', 'This PDF has 34 pages; the limit is 20.'],
    ['TOO_MANY_PAGES', { maxPages: 20 }, 'pdf', 'This PDF has too many pages; the limit is 20.'],
    [
      'PDF_UNREADABLE',
      {},
      'pdf',
      "This PDF can't be read. It may be damaged or password-protected; export it again or upload a photo instead.",
    ],
    [
      'UNSUPPORTED_MEDIA_TYPE',
      { contentMismatch: true },
      'pdf',
      "This file isn't a real PDF. Export the report as a PDF again, or upload a photo.",
    ],
    [
      'UNSUPPORTED_MEDIA_TYPE',
      { contentMismatch: true },
      'image',
      "This file isn't a real image. Use a JPEG, PNG, GIF or WebP photo.",
    ],
    ['UNSUPPORTED_MEDIA_TYPE', { allowed: ['image/png'] }, 'pdf', "PDFs can't be read here. Upload a photo instead."],
    ['OBJECT_TOO_LARGE', { maxBytes: 50 * 1024 * 1024 }, 'pdf', 'This PDF is over the size limit of 50 MiB.'],
    ['OBJECT_TOO_LARGE', { maxBytes: 20 * 1024 * 1024 }, 'image', 'This photo is over the size limit of 20 MiB.'],
  ] as const)('%s %j (%s) reads in words', (reason, details, kind, expected) => {
    expect(intakeFileErrorMessage(refusal(reason, details), kind)).toBe(expected);
  });

  it("keeps the server's message for any other refusal, and the Error's for a network failure", () => {
    expect(intakeFileErrorMessage(refusal('TOO_MANY_PHOTOS', {}, 'At most 4 photos'), 'pdf')).toBe('At most 4 photos');
    expect(intakeFileErrorMessage(new Error('Network down'))).toBe('Network down');
    expect(intakeFileErrorMessage('?')).toBe('Upload failed');
  });
});
