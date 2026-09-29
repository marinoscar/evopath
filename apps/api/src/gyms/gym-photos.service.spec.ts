import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { mockDeep, type DeepMockProxy } from 'jest-mock-extended';

import type { PrismaService } from '../prisma/prisma.service';
import type { ObjectsService } from '../storage/objects/objects.service';
import { GymPhotosService } from './gym-photos.service';
import { GymStorageService } from './gym-storage.service';
import type { GymsService } from './gyms.service';

// =============================================================================
// GymPhotosService and GymStorageService — attach rules and object cleanup
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const GYM = '22222222-2222-4222-8222-222222222222';
const PHOTO = '33333333-3333-4333-8333-333333333333';
const OBJECT = '44444444-4444-4444-8444-444444444444';
const EQUIPMENT = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-09-29T10:00:00.000Z');

const readyImage = { id: OBJECT, status: 'ready', mimeType: 'image/jpeg', size: BigInt(1024) };

function photoRow(overrides: Record<string, unknown> = {}) {
  return { id: PHOTO, gymId: GYM, storageObjectId: OBJECT, caption: null, takenAt: null, createdAt: NOW, equipment: [], ...overrides };
}

describe('GymPhotosService', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let gyms: { findOwned: jest.Mock };
  let storage: { findOwnedObject: jest.Mock; deleteObjects: jest.Mock };
  let service: GymPhotosService;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    prisma.$transaction.mockImplementation(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)));
    gyms = { findOwned: jest.fn().mockResolvedValue({ id: GYM, userId: USER }) };
    storage = { findOwnedObject: jest.fn().mockResolvedValue(readyImage), deleteObjects: jest.fn() };
    service = new GymPhotosService(
      prisma as unknown as PrismaService,
      gyms as unknown as GymsService,
      storage as unknown as GymStorageService,
    );
    prisma.gymPhoto.count.mockResolvedValue(0);
  });

  describe('attach', () => {
    it('attaches a ready image the caller owns, with equipment links', async () => {
      prisma.gymEquipment.findMany.mockResolvedValue([{ id: EQUIPMENT }] as any);
      prisma.gymPhoto.create.mockResolvedValue(photoRow({ equipment: [{ gymEquipmentId: EQUIPMENT }] }) as any);

      const view = await service.attach(USER, GYM, { storageObjectId: OBJECT, caption: 'Rack', equipmentIds: [EQUIPMENT] });

      expect(storage.findOwnedObject).toHaveBeenCalledWith(USER, OBJECT);
      expect(prisma.gymPhoto.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            gymId: GYM,
            storageObjectId: OBJECT,
            caption: 'Rack',
            equipment: { create: [{ gymEquipmentId: EQUIPMENT }] },
          }),
        }),
      );
      expect(view.equipmentIds).toEqual([EQUIPMENT]);
    });

    it.each([
      ['a missing or foreign object', null, NotFoundException, undefined],
      ['an object not ready', { ...readyImage, status: 'uploading' }, undefined, 'OBJECT_NOT_READY'],
      ['a non-image', { ...readyImage, mimeType: 'application/pdf' }, undefined, 'UNSUPPORTED_MEDIA_TYPE'],
      ['an image over 20 MiB', { ...readyImage, size: BigInt(20 * 1024 * 1024 + 1) }, undefined, 'OBJECT_TOO_LARGE'],
    ])('refuses %s', async (_label, object, type, reason) => {
      storage.findOwnedObject.mockResolvedValue(object);

      const attempt = service.attach(USER, GYM, { storageObjectId: OBJECT });

      if (type) await expect(attempt).rejects.toBeInstanceOf(type);
      if (reason) await expect(attempt).rejects.toMatchObject({ response: { details: { reason } } });
      expect(prisma.gymPhoto.create).not.toHaveBeenCalled();
    });

    it('refuses the 101st photo with PHOTO_LIMIT', async () => {
      prisma.gymPhoto.count.mockResolvedValue(100);

      await expect(service.attach(USER, GYM, { storageObjectId: OBJECT })).rejects.toMatchObject({
        response: { details: { reason: 'PHOTO_LIMIT' } },
      });
    });

    it('refuses equipment of another gym with EQUIPMENT_NOT_IN_GYM', async () => {
      prisma.gymEquipment.findMany.mockResolvedValue([]);

      await expect(
        service.attach(USER, GYM, { storageObjectId: OBJECT, equipmentIds: [EQUIPMENT] }),
      ).rejects.toMatchObject({ response: { details: { reason: 'EQUIPMENT_NOT_IN_GYM', equipmentIds: [EQUIPMENT] } } });
    });

    it('maps the unique storage object index to 409 PHOTO_ALREADY_ATTACHED', async () => {
      prisma.gymPhoto.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }),
      );

      const attempt = service.attach(USER, GYM, { storageObjectId: OBJECT });
      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toMatchObject({ response: { details: { reason: 'PHOTO_ALREADY_ATTACHED' } } });
    });
  });

  describe('update', () => {
    it('replaces the equipment links', async () => {
      prisma.gymPhoto.findFirst.mockResolvedValue(photoRow() as any);
      prisma.gymEquipment.findMany.mockResolvedValue([{ id: EQUIPMENT }] as any);
      prisma.gymPhoto.updateMany.mockResolvedValue({ count: 1 });

      await service.update(USER, GYM, PHOTO, { equipmentIds: [EQUIPMENT], caption: null });

      expect(prisma.gymPhoto.updateMany).toHaveBeenCalledWith({ where: { id: PHOTO, gymId: GYM }, data: { caption: null } });
      expect(prisma.gymEquipmentPhoto.deleteMany).toHaveBeenCalledWith({ where: { gymPhotoId: PHOTO } });
      expect(prisma.gymEquipmentPhoto.createMany).toHaveBeenCalledWith({
        data: [{ gymEquipmentId: EQUIPMENT, gymPhotoId: PHOTO }],
      });
    });
  });

  describe('remove', () => {
    it('deletes the photo row and then its storage object', async () => {
      prisma.gymPhoto.findFirst.mockResolvedValue(photoRow() as any);
      prisma.gymPhoto.deleteMany.mockResolvedValue({ count: 1 });

      await service.remove(USER, GYM, PHOTO);

      expect(prisma.gymPhoto.deleteMany).toHaveBeenCalledWith({ where: { id: PHOTO, gymId: GYM } });
      expect(storage.deleteObjects).toHaveBeenCalledWith(USER, [OBJECT]);
    });
  });
});

describe('GymStorageService', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let objects: { delete: jest.Mock };
  let service: GymStorageService;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    objects = { delete: jest.fn().mockResolvedValue(undefined) };
    service = new GymStorageService(prisma as unknown as PrismaService, objects as unknown as ObjectsService);
  });

  it('looks up only the caller\'s objects', async () => {
    prisma.storageObject.findFirst.mockResolvedValue(null);

    await expect(service.findOwnedObject(USER, OBJECT)).resolves.toBeNull();
    expect(prisma.storageObject.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OBJECT, uploadedById: USER } }),
    );
  });

  it('deletes unreferenced objects and skips one a photo intake still links', async () => {
    prisma.gymPhoto.count.mockResolvedValue(0);
    prisma.photoIntakePhoto.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await service.deleteObjects(USER, ['a', 'b']);

    expect(objects.delete).toHaveBeenCalledTimes(1);
    expect(objects.delete).toHaveBeenCalledWith('a', USER);
  });

  it('counts only unapplied intakes as holders: an applied intake does not keep the object', async () => {
    prisma.gymPhoto.count.mockResolvedValue(0);
    prisma.photoIntakePhoto.count.mockResolvedValue(0);

    await service.deleteObjects(USER, ['a']);

    expect(prisma.photoIntakePhoto.count).toHaveBeenCalledWith({
      where: { storageObjectId: 'a', intake: { status: { not: 'applied' } } },
    });
    expect(objects.delete).toHaveBeenCalledWith('a', USER);
  });

  it('keeps an object another gym photo still links', async () => {
    prisma.gymPhoto.count.mockResolvedValue(1);
    prisma.photoIntakePhoto.count.mockResolvedValue(0);

    await service.deleteObjects(USER, ['a']);

    expect(objects.delete).not.toHaveBeenCalled();
  });

  it('is best effort: a provider failure does not stop the others', async () => {
    prisma.gymPhoto.count.mockResolvedValue(0);
    prisma.photoIntakePhoto.count.mockResolvedValue(0);
    objects.delete.mockRejectedValueOnce(new Error('provider down')).mockResolvedValueOnce(undefined);

    await expect(service.deleteObjects(USER, ['a', 'b'])).resolves.toBeUndefined();
    expect(objects.delete).toHaveBeenCalledTimes(2);
  });
});
