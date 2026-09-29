import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { mockDeep, type DeepMockProxy } from 'jest-mock-extended';

import type { PrismaService } from '../prisma/prisma.service';
import { customSlug, EquipmentTypesService, matchesQuery } from './equipment-types.service';

// =============================================================================
// EquipmentTypesService — search, custom types and the in-use rule
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const TYPE = '22222222-2222-4222-8222-222222222222';
const CAP_A = '33333333-3333-4333-8333-333333333333';
const CAP_B = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-09-29T10:00:00.000Z');

function typeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TYPE,
    slug: 'custom-abcdefgh',
    name: 'Prowler sled',
    category: 'accessories',
    aliases: [],
    description: null,
    sortOrder: 0,
    ownerUserId: USER,
    createdAt: NOW,
    capabilities: [],
    ...overrides,
  };
}

describe('matchesQuery', () => {
  const elliptical = { name: 'Elliptical', aliases: ['elliptical trainer', 'cross trainer'] };
  const legCurl = { name: 'Leg curl machine', aliases: ['hamstring curl machine'] };

  it('matches the name and any alias, ignoring case', () => {
    expect(matchesQuery(elliptical, 'cross')).toBe(true);
    expect(matchesQuery(elliptical, 'ELLIP')).toBe(true);
    expect(matchesQuery(legCurl, 'Curl')).toBe(true);
    expect(matchesQuery(legCurl, 'cross')).toBe(false);
  });
});

describe('customSlug', () => {
  it('is custom- plus 8 lower-case letters or digits', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(customSlug()).toMatch(/^custom-[a-z0-9]{8}$/);
    }
  });
});

describe('EquipmentTypesService', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let service: EquipmentTypesService;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    prisma.$transaction.mockImplementation(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)));
    service = new EquipmentTypesService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('searches the catalog and the caller\'s custom types, then applies the limit', async () => {
      prisma.equipmentType.findMany.mockResolvedValue([
        typeRow({ id: 'a', name: 'Elliptical', aliases: ['cross trainer'], ownerUserId: null }),
        typeRow({ id: 'b', name: 'Crossover cable', aliases: [], ownerUserId: null }),
        typeRow({ id: 'c', name: 'Treadmill', aliases: [], ownerUserId: null }),
      ] as any);

      const result = await service.list(USER, { q: 'cross', limit: 1, category: 'cardio' });

      expect(prisma.equipmentType.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { OR: [{ ownerUserId: null }, { ownerUserId: USER }], category: 'cardio' } }),
      );
      expect(result.map((t) => t.id)).toEqual(['a']);
      expect(result[0].isCustom).toBe(false);
    });
  });

  describe('create', () => {
    it('creates a custom type owned by the caller with a custom- slug and capabilities', async () => {
      prisma.equipmentType.count.mockResolvedValue(0);
      prisma.capability.findMany.mockResolvedValue([{ id: CAP_A }] as any);
      prisma.equipmentType.create.mockResolvedValue(typeRow() as any);

      const view = await service.create(USER, { name: 'Prowler sled', category: 'accessories', capabilityIds: [CAP_A] });

      expect(prisma.equipmentType.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            slug: expect.stringMatching(/^custom-[a-z0-9]{8}$/),
            ownerUserId: USER,
            capabilities: { create: [{ capabilityId: CAP_A }] },
          }),
        }),
      );
      expect(view.isCustom).toBe(true);
    });

    it('refuses an unknown capability id', async () => {
      prisma.equipmentType.count.mockResolvedValue(0);
      prisma.capability.findMany.mockResolvedValue([{ id: CAP_A }] as any);

      await expect(
        service.create(USER, { name: 'Sled', category: 'accessories', capabilityIds: [CAP_A, CAP_B] }),
      ).rejects.toMatchObject({ response: { details: { reason: 'UNKNOWN_CAPABILITY', capabilityIds: [CAP_B] } } });
    });

    it('refuses the 101st custom type', async () => {
      prisma.equipmentType.count.mockResolvedValue(100);

      await expect(service.create(USER, { name: 'Sled', category: 'accessories' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('retries once with a fresh slug on a collision', async () => {
      prisma.equipmentType.count.mockResolvedValue(0);
      prisma.equipmentType.create
        .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }))
        .mockResolvedValueOnce(typeRow() as any);

      await service.create(USER, { name: 'Sled', category: 'accessories' });

      expect(prisma.equipmentType.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('update', () => {
    it('replaces the capability set', async () => {
      prisma.equipmentType.findFirst.mockResolvedValue(typeRow() as any);
      prisma.capability.findMany.mockResolvedValue([{ id: CAP_B }] as any);
      prisma.equipmentType.updateMany.mockResolvedValue({ count: 1 });

      await service.update(USER, TYPE, { capabilityIds: [CAP_B] });

      expect(prisma.equipmentTypeCapability.deleteMany).toHaveBeenCalledWith({ where: { equipmentTypeId: TYPE } });
      expect(prisma.equipmentTypeCapability.createMany).toHaveBeenCalledWith({
        data: [{ equipmentTypeId: TYPE, capabilityId: CAP_B }],
      });
    });

    it('is a 404 for a catalog type or another user\'s type', async () => {
      prisma.equipmentType.findFirst.mockResolvedValue(null);

      await expect(service.update(USER, TYPE, { name: 'Mine' })).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.equipmentType.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: TYPE, ownerUserId: USER } }),
      );
    });
  });

  describe('remove', () => {
    it('is 409 EQUIPMENT_TYPE_IN_USE while gym equipment uses it', async () => {
      prisma.equipmentType.findFirst.mockResolvedValue(typeRow() as any);
      prisma.gymEquipment.count.mockResolvedValue(2);

      await expect(service.remove(USER, TYPE)).rejects.toMatchObject({
        response: { details: { reason: 'EQUIPMENT_TYPE_IN_USE', uses: 2 } },
      });
      expect(prisma.equipmentType.deleteMany).not.toHaveBeenCalled();
    });

    it('maps a concurrent use (foreign key restrict) to 409', async () => {
      prisma.equipmentType.findFirst.mockResolvedValue(typeRow() as any);
      prisma.gymEquipment.count.mockResolvedValue(0);
      prisma.equipmentType.deleteMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 'test' }),
      );

      await expect(service.remove(USER, TYPE)).rejects.toBeInstanceOf(ConflictException);
    });

    it('deletes an unused own type', async () => {
      prisma.equipmentType.findFirst.mockResolvedValue(typeRow() as any);
      prisma.gymEquipment.count.mockResolvedValue(0);
      prisma.equipmentType.deleteMany.mockResolvedValue({ count: 1 });

      await service.remove(USER, TYPE);

      expect(prisma.equipmentType.deleteMany).toHaveBeenCalledWith({ where: { id: TYPE, ownerUserId: USER } });
    });
  });
});
