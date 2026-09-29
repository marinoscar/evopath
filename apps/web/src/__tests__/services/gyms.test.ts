/** `services/gyms.ts` (E3.3): paths, query strings and client-side checks. */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  clampQuantity,
  categoryLabel,
  deleteGymPhoto,
  gymPhotoRejection,
  gymPhotoTypeRejection,
  listEquipmentTypes,
  listGyms,
  setDefaultGym,
  uploadGymPhoto,
} from '../../services/gyms';

function capture(method: 'get' | 'post' | 'delete', path: string, data: unknown = null) {
  const seen: { url?: string; body?: unknown } = {};
  server.use(
    http[method](`*/api${path}`, async ({ request }) => {
      seen.url = request.url;
      if (method === 'post') seen.body = await request.clone().json().catch(() => undefined);
      return method === 'delete' ? new HttpResponse(null, { status: 204 }) : HttpResponse.json({ data });
    }),
  );
  return seen;
}

describe('services/gyms', () => {
  it('lists gyms, optionally without temporary ones', async () => {
    const seen = capture('get', '/gyms', []);
    await listGyms();
    expect(new URL(seen.url!).search).toBe('');
    await listGyms({ includeTemporary: false });
    expect(new URL(seen.url!).searchParams.get('includeTemporary')).toBe('false');
  });

  it('builds the equipment-types query and drops a blank q', async () => {
    const seen = capture('get', '/equipment-types', []);
    await listEquipmentTypes({ q: '  cross ', category: 'cardio', limit: 50 });
    const params = new URL(seen.url!).searchParams;
    expect(params.get('q')).toBe('cross');
    expect(params.get('category')).toBe('cardio');
    expect(params.get('limit')).toBe('50');
    await listEquipmentTypes({ q: '   ' });
    expect(new URL(seen.url!).search).toBe('');
  });

  it('posts to /gyms/:id/default and deletes photos by id', async () => {
    const def = capture('post', '/gyms/g1/default', { id: 'g1' });
    await setDefaultGym('g1');
    expect(def.url).toMatch(/\/api\/gyms\/g1\/default$/);
    const del = capture('delete', '/gyms/g1/photos/p1');
    await deleteGymPhoto('g1', 'p1');
    expect(del.url).toMatch(/\/api\/gyms\/g1\/photos\/p1$/);
  });

  it('uploads through storage, waits for ready, then attaches by storageObjectId', async () => {
    const attach = capture('post', '/gyms/g1/photos', { id: 'p1' });
    await uploadGymPhoto('g1', new File(['png'], 'a.png', { type: 'image/png' }), { intervalMs: 1 });
    expect(attach.body).toEqual({ storageObjectId: '33333333-3333-4333-8333-333333333333' });
  });

  it('clamps quantities to 1..99', () => {
    expect(clampQuantity(0)).toBe(1);
    expect(clampQuantity(100)).toBe(99);
    expect(clampQuantity(Number.NaN)).toBe(1);
    expect(clampQuantity(5)).toBe(5);
  });

  it('explains why a file cannot be a gym photo', () => {
    expect(gymPhotoRejection(new File(['x'], 'a.txt', { type: 'text/plain' }))).toBe('a.txt is not an image.');
    const big = new File(['x'], 'b.jpg', { type: 'image/jpeg' });
    Object.defineProperty(big, 'size', { value: 20 * 1024 * 1024 + 1 });
    expect(gymPhotoRejection(big)).toBe('b.jpg is larger than 20 MiB.');
    expect(gymPhotoRejection(new File(['x'], 'c.png', { type: 'image/png' }))).toBeNull();
    expect(gymPhotoTypeRejection(new File(['x'], 'd.heic', { type: 'image/heic' }))).toMatch(/Convert it to JPEG or PNG/);
    expect(gymPhotoTypeRejection(new File(['x'], 'e.webp', { type: 'image/webp' }))).toBeNull();
  });

  it('labels categories, including unknown ones', () => {
    expect(categoryLabel('benches_racks')).toBe('Benches and racks');
    expect(categoryLabel('sled_things')).toBe('sled things');
  });
});
