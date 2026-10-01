import { BadRequestException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { mockDeep, type DeepMockProxy } from 'jest-mock-extended';
import { Readable } from 'node:stream';

import { AppMetricsService } from '../common/otel/app-metrics.service';
import { StorageObjectReferences } from '../intake/storage-object-references';
import type { PrismaService } from '../prisma/prisma.service';
import type { ObjectsService } from '../storage/objects/objects.service';
import type { StorageProvider } from '../storage/providers/storage-provider.interface';
import { PROGRESS_PHOTO_MAX_BYTES } from './progress-photos.constants';
import { decodePhotoCursor, encodePhotoCursor, ProgressPhotosService } from './progress-photos.service';

// =============================================================================
// ProgressPhotosService (E7.9, #249): create checks, keyset list, delete
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PHOTO = '33333333-3333-4333-8333-333333333333';
const OBJECT = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-09-29T10:00:00.000Z');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const TEXT = Buffer.from('not an image at all, just text');

function objectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: OBJECT,
    uploadedById: USER,
    status: 'ready',
    mimeType: 'image/jpeg',
    size: BigInt(2048),
    storageKey: 'uploads/u/secret-key.jpg',
    ...overrides,
  };
}

function photoRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PHOTO,
    storageObjectId: OBJECT,
    localDate: new Date('2026-09-28T00:00:00.000Z'),
    pose: 'front',
    note: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe('ProgressPhotosService', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let objects: { delete: jest.Mock };
  let references: StorageObjectReferences;
  let storage: { download: jest.Mock };
  let metrics: { progressPhotoChanged: jest.Mock };
  let service: ProgressPhotosService;

  function storedBytes(bytes: Buffer) {
    storage.download.mockImplementation(async () => Readable.from([bytes]));
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    objects = { delete: jest.fn().mockResolvedValue(undefined) };
    references = new StorageObjectReferences();
    storage = { download: jest.fn() };
    metrics = { progressPhotoChanged: jest.fn() };
    service = new ProgressPhotosService(
      prisma as unknown as PrismaService,
      objects as unknown as ObjectsService,
      references,
      storage as unknown as StorageProvider,
      metrics as unknown as AppMetricsService,
    );
    prisma.storageObject.findUnique.mockResolvedValue(objectRow() as any);
    prisma.progressPhoto.count.mockResolvedValue(0);
    prisma.progressPhoto.create.mockImplementation((async ({ data }: any) =>
      photoRow({ localDate: data.localDate, pose: data.pose, note: data.note })) as any);
    prisma.photoIntakePhoto.count.mockResolvedValue(0);
    storedBytes(JPEG);
  });

  describe('create', () => {
    const input = { storageObjectId: OBJECT, localDate: '2026-09-28', pose: 'side' as const, note: 'Fasted' };

    it.each([
      ['JPEG', 'image/jpeg', JPEG],
      ['PNG', 'image/png', PNG],
      ['WebP', 'image/webp', WEBP],
    ])('adds a ready %s the caller owns', async (_name, mimeType, bytes) => {
      prisma.storageObject.findUnique.mockResolvedValue(objectRow({ mimeType }) as any);
      storedBytes(bytes);

      const view = await service.create(USER, input);

      expect(prisma.progressPhoto.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            userId: USER,
            storageObjectId: OBJECT,
            localDate: new Date('2026-09-28T00:00:00.000Z'),
            pose: 'side',
            note: 'Fasted',
          },
        }),
      );
      expect(view).toEqual({
        id: PHOTO,
        storageObjectId: OBJECT,
        localDate: '2026-09-28',
        pose: 'side',
        note: 'Fasted',
        createdAt: NOW.toISOString(),
      });
      expect(metrics.progressPhotoChanged).toHaveBeenCalledWith('added');
    });

    it('is a 404 for an unknown object', async () => {
      prisma.storageObject.findUnique.mockResolvedValue(null);
      await expect(service.create(USER, input)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.progressPhoto.create).not.toHaveBeenCalled();
    });

    it("refuses another user's object with 403 PROGRESS_PHOTO_OBJECT_NOT_OWNED, reading no bytes", async () => {
      prisma.storageObject.findUnique.mockResolvedValue(objectRow({ uploadedById: OTHER }) as any);

      const error = await service.create(USER, input).catch((e) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getResponse().details.reason).toBe('PROGRESS_PHOTO_OBJECT_NOT_OWNED');
      expect(storage.download).not.toHaveBeenCalled();
      expect(prisma.progressPhoto.create).not.toHaveBeenCalled();
    });

    it('refuses an object that is not ready', async () => {
      prisma.storageObject.findUnique.mockResolvedValue(objectRow({ status: 'uploading' }) as any);
      const error = await service.create(USER, input).catch((e) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse().details.reason).toBe('PROGRESS_PHOTO_OBJECT_NOT_READY');
    });

    it('refuses an oversize object with 413 PROGRESS_PHOTO_TOO_LARGE', async () => {
      prisma.storageObject.findUnique.mockResolvedValue(objectRow({ size: BigInt(PROGRESS_PHOTO_MAX_BYTES + 1) }) as any);
      const error = await service.create(USER, input).catch((e) => e);
      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(413);
      expect(error.getResponse().details.reason).toBe('PROGRESS_PHOTO_TOO_LARGE');
      expect(storage.download).not.toHaveBeenCalled();
    });

    it.each([
      ['text bytes declared as JPEG', 'image/jpeg', TEXT],
      ['a GIF declared as JPEG', 'image/jpeg', GIF],
      ['a GIF declared as GIF', 'image/gif', GIF],
      ['a real JPEG declared as text', 'text/plain', JPEG],
      ['an empty file', 'image/png', Buffer.alloc(0)],
    ])('refuses %s with 400 PROGRESS_PHOTO_NOT_IMAGE', async (_name, mimeType, bytes) => {
      prisma.storageObject.findUnique.mockResolvedValue(objectRow({ mimeType }) as any);
      storedBytes(bytes);

      const error = await service.create(USER, input).catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse().details.reason).toBe('PROGRESS_PHOTO_NOT_IMAGE');
      expect(JSON.stringify(error.getResponse())).not.toContain('secret-key');
      expect(prisma.progressPhoto.create).not.toHaveBeenCalled();
    });

    it('reads only the leading bytes and releases the download', async () => {
      const stream = Readable.from([JPEG, Buffer.alloc(1024 * 1024)]);
      const destroy = jest.spyOn(stream, 'destroy');
      storage.download.mockResolvedValue(stream);

      await service.create(USER, input);

      expect(storage.download).toHaveBeenCalledWith('uploads/u/secret-key.jpg');
      expect(destroy).toHaveBeenCalled();
    });

    it('refuses an object that is already a progress photo with 409', async () => {
      prisma.progressPhoto.count.mockResolvedValue(1);
      const error = await service.create(USER, input).catch((e) => e);
      expect(error.getStatus()).toBe(409);
      expect(error.getResponse().details.reason).toBe('PROGRESS_PHOTO_ALREADY_ADDED');
      expect(prisma.progressPhoto.create).not.toHaveBeenCalled();
    });

    it('stores a missing note as null', async () => {
      await service.create(USER, { storageObjectId: OBJECT, localDate: '2026-09-28', pose: 'front' });
      expect(prisma.progressPhoto.create.mock.calls[0][0].data).toEqual(expect.objectContaining({ note: null }));
    });
  });

  describe('list', () => {
    it('lists the caller\'s photos newest first with a next cursor', async () => {
      const rows = [
        photoRow({ id: '00000000-0000-4000-8000-000000000003', localDate: new Date('2026-09-28T00:00:00Z') }),
        photoRow({ id: '00000000-0000-4000-8000-000000000002', localDate: new Date('2026-09-20T00:00:00Z') }),
        photoRow({ id: '00000000-0000-4000-8000-000000000001', localDate: new Date('2026-09-10T00:00:00Z') }),
      ];
      prisma.progressPhoto.findMany.mockResolvedValue(rows as any);

      const page = await service.list(USER, { limit: 2, pose: 'front' });

      const args = prisma.progressPhoto.findMany.mock.calls[0][0] as any;
      expect(args.where).toEqual({ userId: USER, pose: 'front' });
      expect(args.orderBy).toEqual([{ localDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]);
      expect(args.take).toBe(3);
      expect(args.select.storageObjectId).toBe(true);
      expect(page.items.map((item) => item.localDate)).toEqual(['2026-09-28', '2026-09-20']);
      expect(page.nextCursor).toBe(encodePhotoCursor(rows[1] as any));
    });

    it('continues after a cursor and ends with a null cursor', async () => {
      prisma.progressPhoto.findMany.mockResolvedValue([photoRow()] as any);
      const cursor = encodePhotoCursor(photoRow() as any);

      const page = await service.list(USER, { limit: 2, cursor });

      const where = (prisma.progressPhoto.findMany.mock.calls[0][0] as any).where;
      expect(where.userId).toBe(USER);
      expect(where.OR).toHaveLength(3);
      expect(page.nextCursor).toBeNull();
    });

    it('refuses a forged cursor as a validation error', async () => {
      await expect(service.list(USER, { limit: 2, cursor: 'bm90LWEtY3Vyc29y' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(() => decodePhotoCursor(Buffer.from('2026-09-01|nope|x').toString('base64url'))).toThrow(
        BadRequestException,
      );
    });
  });

  describe('remove', () => {
    beforeEach(() => {
      prisma.progressPhoto.findFirst.mockResolvedValue({ id: PHOTO, storageObjectId: OBJECT } as any);
      prisma.progressPhoto.deleteMany.mockResolvedValue({ count: 1 });
    });

    it('deletes the row and then the storage object', async () => {
      await service.remove(USER, PHOTO);

      expect(prisma.progressPhoto.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: PHOTO, userId: USER } }));
      expect(prisma.progressPhoto.deleteMany).toHaveBeenCalledWith({ where: { id: PHOTO, userId: USER } });
      expect(objects.delete).toHaveBeenCalledWith(OBJECT, USER);
      expect(metrics.progressPhotoChanged).toHaveBeenCalledWith('deleted');
    });

    it("is a 404 PROGRESS_PHOTO_NOT_FOUND for another user's or an unknown photo", async () => {
      prisma.progressPhoto.findFirst.mockResolvedValue(null);
      const error = await service.remove(USER, PHOTO).catch((e) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.getResponse().details.reason).toBe('PROGRESS_PHOTO_NOT_FOUND');
      expect(prisma.progressPhoto.deleteMany).not.toHaveBeenCalled();
      expect(objects.delete).not.toHaveBeenCalled();
    });

    it('keeps an object another feature still references', async () => {
      references.register({ name: 'gym_photos', isReferenced: async (id) => id === OBJECT });
      await service.remove(USER, PHOTO);
      expect(objects.delete).not.toHaveBeenCalled();
    });

    it('keeps an object an unapplied intake still links', async () => {
      prisma.photoIntakePhoto.count.mockResolvedValue(1);
      await service.remove(USER, PHOTO);
      expect(objects.delete).not.toHaveBeenCalled();
    });

    it('still succeeds when the object delete fails', async () => {
      objects.delete.mockRejectedValue(new Error('provider down'));
      await expect(service.remove(USER, PHOTO)).resolves.toBeUndefined();
    });
  });
});
