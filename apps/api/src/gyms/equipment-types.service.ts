import { randomBytes } from 'node:crypto';

import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type {
  CapabilityViewData,
  CreateEquipmentTypeInput,
  EquipmentTypeViewData,
  ListEquipmentTypesQuery,
  UpdateEquipmentTypeInput,
} from './dto/equipment-type.dto';
import { CUSTOM_SLUG_PREFIX, GYM_REFUSALS, MAX_CUSTOM_EQUIPMENT_TYPES_PER_USER } from './gyms.constants';
import {
  EQUIPMENT_TYPE_INCLUDE,
  equipmentTypeNotFound,
  isForeignKeyViolation,
  isUniqueViolation,
  refuse,
  toCapabilityView,
  toEquipmentTypeView,
} from './gym-views';

// =============================================================================
// EquipmentTypesService — the catalog, custom equipment and capabilities (E3.3)
// =============================================================================
//
// A caller sees the seeded catalog (`owner_user_id` null) plus their own custom
// types. Only their own custom types may be changed or deleted; a catalog
// type or another user's custom type answers 404 there.
//
// SEARCH. `q` matches case-insensitively as a substring of the name or of any
// alias. The visible set is small and bounded (the catalog plus at most 100
// custom types), so it is filtered here rather than with array SQL.
// =============================================================================

const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SLUG_RANDOM_LENGTH = 8;

/** `custom-` plus 8 random lower-case letters and digits. */
export function customSlug(): string {
  const bytes = randomBytes(SLUG_RANDOM_LENGTH);
  let suffix = '';
  for (const byte of bytes) {
    suffix += SLUG_ALPHABET[byte % SLUG_ALPHABET.length];
  }
  return `${CUSTOM_SLUG_PREFIX}${suffix}`;
}

/** Whether a type's name or one of its aliases contains `q`, ignoring case. */
export function matchesQuery(type: { name: string; aliases: readonly string[] }, q: string): boolean {
  const needle = q.toLocaleLowerCase();
  return (
    type.name.toLocaleLowerCase().includes(needle) ||
    type.aliases.some((alias) => alias.toLocaleLowerCase().includes(needle))
  );
}

@Injectable()
export class EquipmentTypesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, query: ListEquipmentTypesQuery): Promise<EquipmentTypeViewData[]> {
    const types = await this.prisma.equipmentType.findMany({
      where: {
        OR: [{ ownerUserId: null }, { ownerUserId: userId }],
        ...(query.category ? { category: query.category } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      include: EQUIPMENT_TYPE_INCLUDE,
    });

    const q = query.q;
    const matching = q ? types.filter((type) => matchesQuery(type, q)) : types;

    return matching.slice(0, query.limit).map(toEquipmentTypeView);
  }

  async create(userId: string, input: CreateEquipmentTypeInput): Promise<EquipmentTypeViewData> {
    const existing = await this.prisma.equipmentType.count({ where: { ownerUserId: userId } });

    if (existing >= MAX_CUSTOM_EQUIPMENT_TYPES_PER_USER) {
      throw refuse(
        400,
        GYM_REFUSALS.EQUIPMENT_TYPE_LIMIT,
        `You can have at most ${MAX_CUSTOM_EQUIPMENT_TYPES_PER_USER} custom equipment types`,
        { max: MAX_CUSTOM_EQUIPMENT_TYPES_PER_USER },
      );
    }

    const capabilityIds = input.capabilityIds ?? [];
    await this.assertCapabilitiesExist(capabilityIds);

    const create = () =>
      this.prisma.equipmentType.create({
        data: {
          slug: customSlug(),
          name: input.name,
          category: input.category,
          ownerUserId: userId,
          capabilities: { create: capabilityIds.map((capabilityId) => ({ capabilityId })) },
        },
        include: EQUIPMENT_TYPE_INCLUDE,
      });

    try {
      return toEquipmentTypeView(await create());
    } catch (error) {
      // A slug collision (36^8 space) gets one fresh slug.
      if (isUniqueViolation(error)) {
        return toEquipmentTypeView(await create());
      }
      throw error;
    }
  }

  async update(userId: string, typeId: string, input: UpdateEquipmentTypeInput): Promise<EquipmentTypeViewData> {
    await this.findOwnCustom(userId, typeId);

    if (input.capabilityIds) {
      await this.assertCapabilitiesExist(input.capabilityIds);
    }

    await this.prisma.$transaction(async (tx) => {
      const data: Prisma.EquipmentTypeUpdateManyMutationInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.category !== undefined) data.category = input.category;

      const { count } = await tx.equipmentType.updateMany({ where: { id: typeId, ownerUserId: userId }, data });

      if (count === 0) {
        throw equipmentTypeNotFound();
      }

      if (input.capabilityIds) {
        await tx.equipmentTypeCapability.deleteMany({ where: { equipmentTypeId: typeId } });

        if (input.capabilityIds.length > 0) {
          await tx.equipmentTypeCapability.createMany({
            data: input.capabilityIds.map((capabilityId) => ({ equipmentTypeId: typeId, capabilityId })),
          });
        }
      }
    });

    return toEquipmentTypeView(await this.findOwnCustom(userId, typeId));
  }

  /** 409 `EQUIPMENT_TYPE_IN_USE` while any gym equipment row uses it. */
  async remove(userId: string, typeId: string): Promise<void> {
    await this.findOwnCustom(userId, typeId);

    const inUse = await this.prisma.gymEquipment.count({ where: { equipmentTypeId: typeId } });

    if (inUse > 0) {
      throw this.inUse(inUse);
    }

    try {
      const { count } = await this.prisma.equipmentType.deleteMany({ where: { id: typeId, ownerUserId: userId } });

      if (count === 0) {
        throw equipmentTypeNotFound();
      }
    } catch (error) {
      // Equipment added concurrently: the `Restrict` foreign key refuses.
      if (isForeignKeyViolation(error)) {
        throw this.inUse();
      }
      throw error;
    }
  }

  async listCapabilities(): Promise<CapabilityViewData[]> {
    const capabilities = await this.prisma.capability.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    return capabilities.map(toCapabilityView);
  }

  // ---------------------------------------------------------------------------

  private async findOwnCustom(userId: string, typeId: string) {
    const type = await this.prisma.equipmentType.findFirst({
      where: { id: typeId, ownerUserId: userId },
      include: EQUIPMENT_TYPE_INCLUDE,
    });

    if (!type) {
      throw equipmentTypeNotFound();
    }

    return type;
  }

  private async assertCapabilitiesExist(capabilityIds: readonly string[]): Promise<void> {
    if (capabilityIds.length === 0) {
      return;
    }

    const found = await this.prisma.capability.findMany({
      where: { id: { in: [...capabilityIds] } },
      select: { id: true },
    });

    if (found.length !== capabilityIds.length) {
      const known = new Set(found.map((row) => row.id));
      throw refuse(400, GYM_REFUSALS.UNKNOWN_CAPABILITY, 'Unknown capability id', {
        capabilityIds: capabilityIds.filter((id) => !known.has(id)),
      });
    }
  }

  private inUse(uses?: number): ConflictException {
    return refuse(409, GYM_REFUSALS.EQUIPMENT_TYPE_IN_USE, 'This equipment type is used by gym equipment; remove it there first', {
      ...(uses !== undefined ? { uses } : {}),
    }) as ConflictException;
  }
}
