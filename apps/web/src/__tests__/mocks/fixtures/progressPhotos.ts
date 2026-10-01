/**
 * Progress photo fixtures (E7.9, #249), shaped exactly as
 * `/api/progress-photos` answers inside the `{ data }` envelope, plus a
 * stateful MSW stand-in that records every call.
 */
import { http, HttpResponse } from 'msw';
import { server } from '../server';
import type { ProgressPhoto } from '../../../services/progressPhotos';

let seq = 0;

/** One photo; override any field. Ids are unique per call. */
export function mockProgressPhoto(overrides: Partial<ProgressPhoto> = {}): ProgressPhoto {
  seq += 1;
  const n = String(seq).padStart(12, '0');
  return {
    id: `00000000-0000-4000-8000-${n}`,
    storageObjectId: `11111111-1111-4111-8111-${n}`,
    localDate: '2026-09-15',
    pose: 'front',
    note: null,
    createdAt: '2026-09-15T08:00:00.000Z',
    ...overrides,
  };
}

/** Two September photos, one August and one July, newest first. */
export function mockProgressPhotoSet(): ProgressPhoto[] {
  return [
    mockProgressPhoto({ localDate: '2026-09-28', pose: 'front', note: 'Morning' }),
    mockProgressPhoto({ localDate: '2026-09-14', pose: 'side' }),
    mockProgressPhoto({ localDate: '2026-08-20', pose: 'front' }),
    mockProgressPhoto({ localDate: '2026-07-01', pose: 'front' }),
  ];
}

export interface ProgressPhotosApiCalls {
  /** Query string of every GET. */
  lists: string[];
  /** Body of every POST. */
  creates: unknown[];
  /** Id of every DELETE. */
  deletes: string[];
  /** Number of storage uploads. */
  uploads: number;
}

export interface ProgressPhotosApiOptions {
  /** Page size the stand-in pages at, whatever `limit` asks (default: `limit`). */
  pageSize?: number;
  /** Answer the POST with this instead of creating. */
  createResponse?: Response;
  /** Answer the DELETE with this instead of deleting. */
  deleteResponse?: Response;
}

/**
 * A stateful `/api/progress-photos` over `initial` (newest first): GET filters
 * by `pose` and pages with an index cursor; POST prepends; DELETE removes. A
 * storage upload answers an already-`ready` object, so no polling is needed.
 */
export function progressPhotosApi(initial: ProgressPhoto[], options: ProgressPhotosApiOptions = {}) {
  let photos = [...initial];
  const calls: ProgressPhotosApiCalls = { lists: [], creates: [], deletes: [], uploads: 0 };
  server.use(
    http.get('*/api/progress-photos', ({ request }) => {
      const params = new URL(request.url).searchParams;
      calls.lists.push(params.toString());
      const pose = params.get('pose');
      const limit = options.pageSize ?? Number(params.get('limit') ?? 30);
      const start = Number(params.get('cursor') ?? 0);
      const matching = photos.filter((p) => !pose || p.pose === pose);
      const items = matching.slice(start, start + limit);
      const next = start + limit < matching.length ? String(start + limit) : null;
      return HttpResponse.json({ data: { items, nextCursor: next } });
    }),
    http.post('*/api/storage/objects', () => {
      calls.uploads += 1;
      return HttpResponse.json(
        {
          data: {
            id: '22222222-2222-4222-8222-222222222222',
            name: 'photo.jpg',
            size: '2048',
            mimeType: 'image/jpeg',
            status: 'ready',
            metadata: null,
            createdAt: '2026-10-01T08:00:00.000Z',
            updatedAt: '2026-10-01T08:00:00.000Z',
          },
        },
        { status: 201 },
      );
    }),
    http.post('*/api/progress-photos', async ({ request }) => {
      const body = (await request.json()) as { storageObjectId: string; localDate: string; pose: ProgressPhoto['pose']; note?: string };
      calls.creates.push(body);
      if (options.createResponse) return options.createResponse;
      const photo = mockProgressPhoto({
        storageObjectId: body.storageObjectId,
        localDate: body.localDate,
        pose: body.pose,
        note: body.note ?? null,
      });
      photos = [photo, ...photos].sort((a, b) => (a.localDate < b.localDate ? 1 : a.localDate > b.localDate ? -1 : 0));
      return HttpResponse.json({ data: photo }, { status: 201 });
    }),
    http.delete('*/api/progress-photos/:id', ({ params }) => {
      const id = String(params.id);
      calls.deletes.push(id);
      if (options.deleteResponse) return options.deleteResponse;
      photos = photos.filter((p) => p.id !== id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return calls;
}
