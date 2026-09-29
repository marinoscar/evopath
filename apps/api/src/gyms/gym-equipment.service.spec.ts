import { NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { mockDeep, type DeepMockProxy } from 'jest-mock-extended';

import type { PrismaService } from '../prisma/prisma.service';
import { GymEquipmentService } from './gym-equipment.service';
import type { GymsService } from './gyms.service';

// =============================================================================
// GymEquipmentService — provenance and type visibility, over a mocked Prisma
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const GYM = '22222222-2222-4222-8222-222222222222';
const ROW = '33333333-3333-4333-8333-333333333333';
const TYPE = '44444444-4444-4444-8444-444444444444';
const NEW_TYPE = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-09-29T10:00:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ROW,
    gymId: GYM,
    equipmentTypeId: TYPE,
    quantity: 2,
    brand: 'Precor',
    model: null,
    notes: null,
    origin: 'manual',
    confidence: null,
    userVerified: true,
    originalAiValue: null,
    createdAt: NOW,
    updatedAt: NOW,
    equipmentType: {
      id: TYPE,
      slug: 'elliptical',
      name: 'Elliptical',
      category: 'cardio',
      aliases: [],
      description: null,
      sortOrder: 0,
      ownerUserId: null,
      createdAt: NOW,
      capabilities: [],
    },
    ...overrides,
  };
}

describe('GymEquipmentService', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let gyms: { findOwned: jest.Mock };
  let service: GymEquipmentService;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    prisma.$transaction.mockImplementation(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)));
    gyms = { findOwned: jest.fn().mockResolvedValue({ id: GYM, userId: USER }) };
    service = new GymEquipmentService(prisma as unknown as PrismaService, gyms as unknown as GymsService);
  });

  it('adds a manual, verified row after checking the gym and the type', async () => {
    prisma.equipmentType.findFirst.mockResolvedValue({ id: TYPE } as any);
    prisma.gymEquipment.create.mockResolvedValue(row() as any);

    await service.add(USER, GYM, { equipmentTypeId: TYPE, quantity: 2, brand: 'Precor' });

    expect(gyms.findOwned).toHaveBeenCalledWith(USER, GYM);
    expect(prisma.equipmentType.findFirst).toHaveBeenCalledWith({
      where: { id: TYPE, OR: [{ ownerUserId: null }, { ownerUserId: USER }] },
      select: { id: true },
    });
    expect(prisma.gymEquipment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ origin: 'manual', userVerified: true, quantity: 2, brand: 'Precor', model: null }),
      }),
    );
  });

  it('refuses a type that is neither catalog nor the caller\'s (404)', async () => {
    prisma.equipmentType.findFirst.mockResolvedValue(null);

    await expect(service.add(USER, GYM, { equipmentTypeId: TYPE, quantity: 1 })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.gymEquipment.create).not.toHaveBeenCalled();
  });

  it('snapshots an AI row into originalAiValue on its first edit and marks it verified', async () => {
    const aiRow = row({ origin: 'ai', confidence: 'medium', userVerified: false, brand: null, quantity: 1 });
    prisma.gymEquipment.findFirst.mockResolvedValue(aiRow as any);
    prisma.gymEquipment.updateMany.mockResolvedValue({ count: 1 });

    await service.update(USER, GYM, ROW, { quantity: 3, brand: 'Life Fitness' });

    expect(prisma.gymEquipment.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: ROW, gymId: GYM, originalAiValue: { equals: Prisma.DbNull } },
      data: { originalAiValue: { equipmentTypeId: TYPE, quantity: 1, brand: null, model: null, notes: null } },
    });
    expect(prisma.gymEquipment.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: ROW, gymId: GYM },
      data: { userVerified: true, quantity: 3, brand: 'Life Fitness' },
    });
  });

  it('never overwrites an existing snapshot', async () => {
    prisma.gymEquipment.findFirst.mockResolvedValue(
      row({ origin: 'ai', originalAiValue: { equipmentTypeId: TYPE, quantity: 1 } }) as any,
    );
    prisma.gymEquipment.updateMany.mockResolvedValue({ count: 1 });

    await service.update(USER, GYM, ROW, { quantity: 4 });

    expect(prisma.gymEquipment.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.gymEquipment.updateMany).toHaveBeenCalledWith({
      where: { id: ROW, gymId: GYM },
      data: { userVerified: true, quantity: 4 },
    });
  });

  it('takes no snapshot of a manual row', async () => {
    prisma.gymEquipment.findFirst.mockResolvedValue(row() as any);
    prisma.gymEquipment.updateMany.mockResolvedValue({ count: 1 });

    await service.update(USER, GYM, ROW, { notes: 'Wobbly' });

    expect(prisma.gymEquipment.updateMany).toHaveBeenCalledTimes(1);
  });

  it('checks the visibility of a new equipment type', async () => {
    prisma.gymEquipment.findFirst.mockResolvedValue(row() as any);
    prisma.equipmentType.findFirst.mockResolvedValue(null);

    await expect(service.update(USER, GYM, ROW, { equipmentTypeId: NEW_TYPE })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.gymEquipment.updateMany).not.toHaveBeenCalled();
  });

  it('removes only a row of this gym', async () => {
    prisma.gymEquipment.deleteMany.mockResolvedValue({ count: 0 });

    await expect(service.remove(USER, GYM, ROW)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.gymEquipment.deleteMany).toHaveBeenCalledWith({ where: { id: ROW, gymId: GYM } });
  });
});
