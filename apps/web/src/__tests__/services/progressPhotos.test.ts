/**
 * The progress photos service (E7.9, #249): the list query, the strict create
 * body, delete, the upload-then-create order, the error messages, the month
 * grouping and the alternative text (date and pose only).
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { ApiError } from '../../services/api';
import {
  createProgressPhoto,
  deleteProgressPhoto,
  getLatestProgressPhoto,
  groupProgressPhotosByMonth,
  listProgressPhotos,
  progressPhotoAlt,
  progressPhotoErrorMessage,
  progressPhotoPreparedRejection,
  progressPhotoRejection,
  uploadProgressPhoto,
} from '../../services/progressPhotos';
import { mockProgressPhoto, mockProgressPhotoSet, progressPhotosApi } from '../mocks/fixtures/progressPhotos';

describe('progressPhotos service', () => {
  it('lists with pose, limit and cursor in the query, and none when not given', async () => {
    const calls = progressPhotosApi(mockProgressPhotoSet());
    const all = await listProgressPhotos();
    expect(all.items).toHaveLength(4);
    expect(all.nextCursor).toBeNull();

    const page = await listProgressPhotos({ pose: 'front', limit: 2 });
    expect(page.items.map((p) => p.localDate)).toEqual(['2026-09-28', '2026-08-20']);
    expect(page.nextCursor).toBe('2');
    await listProgressPhotos({ pose: 'front', limit: 2, cursor: page.nextCursor });

    expect(calls.lists).toEqual(['', 'pose=front&limit=2', 'pose=front&limit=2&cursor=2']);
  });

  it('reads the latest photo of a pose with limit=1, or null', async () => {
    const calls = progressPhotosApi(mockProgressPhotoSet());
    expect((await getLatestProgressPhoto('side'))?.localDate).toBe('2026-09-14');
    expect(await getLatestProgressPhoto('back')).toBeNull();
    expect(calls.lists).toEqual(['pose=side&limit=1', 'pose=back&limit=1']);
  });

  it('sends exactly the strict body, dropping a blank note and trimming a real one', async () => {
    const calls = progressPhotosApi([]);
    await createProgressPhoto({ storageObjectId: 'obj-1', localDate: '2026-10-01', pose: 'back', note: '   ' });
    await createProgressPhoto({ storageObjectId: 'obj-2', localDate: '2026-10-01', pose: 'side', note: ' Week 4 ' });
    expect(calls.creates).toEqual([
      { storageObjectId: 'obj-1', localDate: '2026-10-01', pose: 'back' },
      { storageObjectId: 'obj-2', localDate: '2026-10-01', pose: 'side', note: 'Week 4' },
    ]);
  });

  it('deletes by id', async () => {
    const photo = mockProgressPhoto();
    const calls = progressPhotosApi([photo]);
    await deleteProgressPhoto(photo.id);
    expect(calls.deletes).toEqual([photo.id]);
  });

  it('uploads to storage first, then adds the object as a progress photo', async () => {
    const calls = progressPhotosApi([]);
    const file = new File(['x'], 'me.jpg', { type: 'image/jpeg' });
    const photo = await uploadProgressPhoto(file, { localDate: '2026-10-01', pose: 'front', note: null });
    expect(calls.uploads).toBe(1);
    expect(calls.creates).toEqual([
      { storageObjectId: '22222222-2222-4222-8222-222222222222', localDate: '2026-10-01', pose: 'front' },
    ]);
    expect(photo.storageObjectId).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('explains each refusal by its details.reason', async () => {
    server.use(
      http.post('*/api/progress-photos', () =>
        HttpResponse.json(
          { code: 'BAD_REQUEST', message: 'nope', details: { reason: 'PROGRESS_PHOTO_NOT_IMAGE' } },
          { status: 400 },
        ),
      ),
    );
    const err = await createProgressPhoto({ storageObjectId: 'o', localDate: '2026-10-01', pose: 'front' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(progressPhotoErrorMessage(err, 'x')).toBe('That file is not a JPEG, PNG or WebP image.');

    const tooLarge = new ApiError('big', 413, 'PAYLOAD_TOO_LARGE', { reason: 'PROGRESS_PHOTO_TOO_LARGE' });
    expect(progressPhotoErrorMessage(tooLarge, 'x')).toBe('The image is larger than 10 MiB.');
    expect(progressPhotoErrorMessage(new ApiError('', 413), 'x')).toBe('The image is larger than 10 MiB.');
    expect(progressPhotoErrorMessage(new ApiError('', 409, undefined, { reason: 'PROGRESS_PHOTO_ALREADY_ADDED' }), 'x')).toBe(
      'That photo has already been added.',
    );
    expect(progressPhotoErrorMessage(null, 'Fallback')).toBe('Fallback');
  });

  it('refuses a non-image or a GIF before preparing, and an unsupported or oversized prepared file', () => {
    expect(progressPhotoRejection(new File(['x'], 'a.pdf', { type: 'application/pdf' }))).toMatch(/not a photo/);
    expect(progressPhotoRejection(new File(['x'], 'a.gif', { type: 'image/gif' }))).toMatch(/not a photo/);
    expect(progressPhotoRejection(new File(['x'], 'a.jpg', { type: 'image/jpeg' }))).toBeNull();

    expect(progressPhotoPreparedRejection(new File(['x'], 'a.heic', { type: 'image/heic' }))).toMatch(/Convert it/);
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.jpg', { type: 'image/jpeg' });
    expect(progressPhotoPreparedRejection(big)).toMatch(/larger than 10 MiB/);
    expect(progressPhotoPreparedRejection(new File(['x'], 'a.png', { type: 'image/png' }))).toBeNull();
  });

  it('groups by month, newest month first, keeping the order inside a month', () => {
    const months = groupProgressPhotosByMonth([
      mockProgressPhoto({ localDate: '2026-08-20' }),
      mockProgressPhoto({ localDate: '2026-09-28' }),
      mockProgressPhoto({ localDate: '2026-09-14' }),
      mockProgressPhoto({ localDate: '2025-12-31' }),
    ]);
    expect(months.map((m) => m.key)).toEqual(['2026-09', '2026-08', '2025-12']);
    expect(months[0].photos.map((p) => p.localDate)).toEqual(['2026-09-28', '2026-09-14']);
    expect(months[0].label).toMatch(/September.*2026/);
  });

  it('describes a photo by date and pose only', () => {
    expect(progressPhotoAlt({ localDate: '2026-09-15', pose: 'side' })).toMatch(
      /^Progress photo, side pose, Sep 15, 2026$/,
    );
  });
});
