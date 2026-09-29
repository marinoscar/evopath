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
  listIntakes,
  removeIntakePhoto,
  updateDraftItem,
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
    await analyzeIntake('in-1', { provider: 'openai', modelId: 'gpt-5-mini' });
    await addDraftItem('in-1', { kind: 'equipment', value: { name: 'Rack' } });
    await updateDraftItem('in-1', 'it-1', { status: 'rejected' });
    await deleteDraftItem('in-1', 'it-1');
    await acceptAllDraftItems('in-1');
    await applyIntake('in-1');
    await discardIntake('in-1');

    expect(seen.map(({ method, path, search, body }) => [method, path + search, body])).toEqual([
      ['POST', '/intakes', { kind: 'gym_equipment', context: { gymId: 'g1' }, subjectType: 'gym', subjectId: 'g1' }],
      ['GET', '/intakes?kind=gym_equipment&status=draft%2Cready&limit=5', null],
      ['GET', '/intakes/in%201', null],
      ['POST', '/intakes/in-1/photos', { storageObjectId: 'obj-1' }],
      ['DELETE', '/intakes/in-1/photos/obj-1', null],
      ['POST', '/intakes/in-1/analyze', { provider: 'openai', modelId: 'gpt-5-mini' }],
      ['POST', '/intakes/in-1/items', { kind: 'equipment', value: { name: 'Rack' } }],
      ['PATCH', '/intakes/in-1/items/it-1', { status: 'rejected' }],
      ['DELETE', '/intakes/in-1/items/it-1', null],
      ['POST', '/intakes/in-1/items/accept-all', null],
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

  it('detachFrom removes the photo from the intake', async () => {
    const seen = record();
    await detachFrom('in-1')('obj-9');
    expect(seen[0]).toMatchObject({ method: 'DELETE', path: '/intakes/in-1/photos/obj-9' });
  });
});
