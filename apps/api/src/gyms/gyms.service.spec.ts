import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { mockDeep, type DeepMockProxy } from 'jest-mock-extended';

import type { PrismaService } from '../prisma/prisma.service';
import { GymStorageService } from './gym-storage.service';
import { GymsService } from './gyms.service';

// =============================================================================
// GymsService — default-gym rules, limits and delete cleanup, over a mocked Prisma
// =============================================================================
//
// Real concurrency against `gyms_user_default_uniq_idx` is proven in
// `test/gyms/gyms-api.db.spec.ts`; here the decisions: which write is made,
// that a P2002 is retried exactly once, and that storage cleanup follows the
// committed delete.
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const GYM = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-09-29T10:00:00.000Z');

function gymRow(overrides: Record<string, unknown> = {}) {
  return {
    id: GYM,
    userId: USER,
    name: 'Home Gym',
    type: 'home',
    description: null,
    notes: null,
    latitude: null,
    longitude: null,
    isDefault: false,
    isTemporary: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

describe('GymsService', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let storage: { deleteObjects: jest.Mock; findOwnedObject: jest.Mock };
  let service: GymsService;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    prisma.$transaction.mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    );
    storage = { deleteObjects: jest.fn().mockResolvedValue(undefined), findOwnedObject: jest.fn() };
    service = new GymsService(prisma as unknown as PrismaService, storage as unknown as GymStorageService);
  });

  describe('create', () => {
    const input = { name: 'Home Gym', type: 'home' as const };

    it('makes the gym the default when the user has no default', async () => {
      prisma.gym.count.mockResolvedValue(0);
      prisma.gym.create.mockResolvedValue(gymRow({ isDefault: true }) as any);

      const gym = await service.create(USER, input);

      expect(prisma.gym.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: USER, isDefault: true }) });
      expect(gym).toEqual(expect.objectContaining({ isDefault: true, equipment: [], photos: [] }));
    });

    it('does not make a second gym the default', async () => {
      prisma.gym.count.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
      prisma.gym.create.mockResolvedValue(gymRow() as any);

      await service.create(USER, input);

      expect(prisma.gym.create).toHaveBeenCalledWith({ data: expect.objectContaining({ isDefault: false }) });
    });

    it('creates a plain gym when a concurrent first gym won the default slot', async () => {
      prisma.gym.count.mockResolvedValue(0);
      prisma.gym.create.mockRejectedValueOnce(uniqueViolation()).mockResolvedValueOnce(gymRow() as any);

      await service.create(USER, input);

      expect(prisma.gym.create).toHaveBeenCalledTimes(2);
      expect(prisma.gym.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ isDefault: false }) });
    });

    it('refuses the 51st gym with GYM_LIMIT', async () => {
      prisma.gym.count.mockResolvedValue(50);

      await expect(service.create(USER, input)).rejects.toMatchObject({
        response: { details: { reason: 'GYM_LIMIT', max: 50 } },
      });
      expect(prisma.gym.create).not.toHaveBeenCalled();
    });
  });

  describe('setDefault', () => {
    it('clears the other default and sets this one in one transaction', async () => {
      prisma.gym.findFirst.mockResolvedValue({ ...gymRow(), equipment: [], photos: [] } as any);
      prisma.gym.updateMany.mockResolvedValue({ count: 1 });

      await service.setDefault(USER, GYM);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.gym.updateMany).toHaveBeenNthCalledWith(1, {
        where: { userId: USER, isDefault: true, id: { not: GYM } },
        data: { isDefault: false },
      });
      expect(prisma.gym.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: GYM, userId: USER },
        data: { isDefault: true },
      });
    });

    it('is a no-op for the current default', async () => {
      prisma.gym.findFirst.mockResolvedValue({ ...gymRow({ isDefault: true }), equipment: [], photos: [] } as any);

      await service.setDefault(USER, GYM);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('retries once after losing the race (P2002)', async () => {
      prisma.gym.findFirst.mockResolvedValue({ ...gymRow(), equipment: [], photos: [] } as any);
      prisma.gym.updateMany.mockResolvedValue({ count: 1 });
      prisma.$transaction.mockRejectedValueOnce(uniqueViolation()).mockImplementationOnce(async (arg: any) => Promise.all(arg));

      await service.setDefault(USER, GYM);

      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('answers 409 DEFAULT_CONFLICT when the retry also loses', async () => {
      prisma.gym.findFirst.mockResolvedValue({ ...gymRow(), equipment: [], photos: [] } as any);
      prisma.$transaction.mockRejectedValue(uniqueViolation());

      await expect(service.setDefault(USER, GYM)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('is a 404 for a gym the caller does not own', async () => {
      prisma.gym.findFirst.mockResolvedValue(null);

      await expect(service.setDefault(USER, GYM)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.gym.findFirst).toHaveBeenCalledWith({ where: { id: GYM, userId: USER } });
    });
  });

  describe('remove', () => {
    it('deletes the gym, promotes the oldest remaining gym, then deletes the photos\' objects', async () => {
      prisma.gym.findFirst
        .mockResolvedValueOnce(gymRow({ isDefault: true }) as any)
        .mockResolvedValueOnce({ id: OTHER } as any);
      prisma.gymPhoto.findMany.mockResolvedValue([{ storageObjectId: 'obj-1' }, { storageObjectId: 'obj-2' }] as any);
      prisma.gym.deleteMany.mockResolvedValue({ count: 1 });
      prisma.gym.count.mockResolvedValue(0);

      await service.remove(USER, GYM);

      expect(prisma.gym.deleteMany).toHaveBeenCalledWith({ where: { id: GYM, userId: USER } });
      expect(prisma.gym.findFirst).toHaveBeenLastCalledWith({
        where: { userId: USER },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      expect(prisma.gym.update).toHaveBeenCalledWith({ where: { id: OTHER }, data: { isDefault: true } });
      expect(storage.deleteObjects).toHaveBeenCalledWith(USER, ['obj-1', 'obj-2']);
    });

    it('promotes nothing while a default remains', async () => {
      prisma.gym.findFirst.mockResolvedValueOnce(gymRow() as any);
      prisma.gymPhoto.findMany.mockResolvedValue([]);
      prisma.gym.deleteMany.mockResolvedValue({ count: 1 });
      prisma.gym.count.mockResolvedValue(1);

      await service.remove(USER, GYM);

      expect(prisma.gym.update).not.toHaveBeenCalled();
    });

    it('leaves zero defaults when the last gym is deleted', async () => {
      prisma.gym.findFirst.mockResolvedValueOnce(gymRow({ isDefault: true }) as any).mockResolvedValueOnce(null);
      prisma.gymPhoto.findMany.mockResolvedValue([]);
      prisma.gym.deleteMany.mockResolvedValue({ count: 1 });
      prisma.gym.count.mockResolvedValue(0);

      await service.remove(USER, GYM);

      expect(prisma.gym.update).not.toHaveBeenCalled();
    });

    it('deletes no storage object when the gym is not the caller\'s', async () => {
      prisma.gym.findFirst.mockResolvedValue(null);

      await expect(service.remove(USER, GYM)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.gym.deleteMany).not.toHaveBeenCalled();
      expect(storage.deleteObjects).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('writes only the given fields, scoped to the caller', async () => {
      prisma.gym.findFirst.mockResolvedValue({ ...gymRow(), equipment: [], photos: [] } as any);
      prisma.gym.updateMany.mockResolvedValue({ count: 1 });

      await service.update(USER, GYM, { notes: null, isTemporary: true });

      expect(prisma.gym.updateMany).toHaveBeenCalledWith({
        where: { id: GYM, userId: USER },
        data: { notes: null, isTemporary: true },
      });
    });
  });
});
