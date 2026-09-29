import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateGymEquipmentInput,
  GymEquipmentViewData,
  UpdateGymEquipmentInput,
} from './dto/gym-equipment.dto';
import { GymsService } from './gyms.service';
import {
  GYM_EQUIPMENT_INCLUDE,
  OLDEST_FIRST,
  equipmentNotFound,
  equipmentTypeNotFound,
  toGymEquipmentView,
} from './gym-views';

// =============================================================================
// GymEquipmentService — equipment rows of the caller's gyms (E3.3)
// =============================================================================
//
// A row names an equipment type the caller can see: a catalog type
// (`owner_user_id` null) or one of their own custom types. Anyone else's
// custom type is indistinguishable from a missing one (404).
//
// PROVENANCE. Manual rows are `origin: 'manual'`, `userVerified: true`. The
// first edit of an `origin: 'ai'` row snapshots what the AI proposed into
// `originalAiValue` (conditionally, so a concurrent second edit cannot
// overwrite the snapshot with an already-edited value) and marks it verified.
// =============================================================================

/** What `originalAiValue` holds: the row as the AI wrote it. */
export interface OriginalAiEquipmentValue {
  equipmentTypeId: string;
  quantity: number;
  brand: string | null;
  model: string | null;
  notes: string | null;
}

@Injectable()
export class GymEquipmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gyms: GymsService,
  ) {}

  async list(userId: string, gymId: string): Promise<GymEquipmentViewData[]> {
    await this.gyms.findOwned(userId, gymId);

    const rows = await this.prisma.gymEquipment.findMany({
      where: { gymId },
      orderBy: OLDEST_FIRST,
      include: GYM_EQUIPMENT_INCLUDE,
    });

    return rows.map(toGymEquipmentView);
  }

  async add(userId: string, gymId: string, input: CreateGymEquipmentInput): Promise<GymEquipmentViewData> {
    await this.gyms.findOwned(userId, gymId);
    await this.assertTypeVisible(userId, input.equipmentTypeId);

    const row = await this.prisma.gymEquipment.create({
      data: {
        gymId,
        equipmentTypeId: input.equipmentTypeId,
        quantity: input.quantity,
        brand: input.brand ?? null,
        model: input.model ?? null,
        notes: input.notes ?? null,
        origin: 'manual',
        userVerified: true,
      },
      include: GYM_EQUIPMENT_INCLUDE,
    });

    return toGymEquipmentView(row);
  }

  async update(
    userId: string,
    gymId: string,
    equipmentId: string,
    input: UpdateGymEquipmentInput,
  ): Promise<GymEquipmentViewData> {
    await this.gyms.findOwned(userId, gymId);
    const row = await this.findInGym(gymId, equipmentId);

    if (input.equipmentTypeId !== undefined && input.equipmentTypeId !== row.equipmentTypeId) {
      await this.assertTypeVisible(userId, input.equipmentTypeId);
    }

    const data: Prisma.GymEquipmentUncheckedUpdateManyInput = { userVerified: true };
    if (input.equipmentTypeId !== undefined) data.equipmentTypeId = input.equipmentTypeId;
    if (input.quantity !== undefined) data.quantity = input.quantity;
    if (input.brand !== undefined) data.brand = input.brand;
    if (input.model !== undefined) data.model = input.model;
    if (input.notes !== undefined) data.notes = input.notes;

    await this.prisma.$transaction(async (tx) => {
      if (row.origin === 'ai' && row.originalAiValue === null) {
        const original: OriginalAiEquipmentValue = {
          equipmentTypeId: row.equipmentTypeId,
          quantity: row.quantity,
          brand: row.brand,
          model: row.model,
          notes: row.notes,
        };

        // Only while still unset: a concurrent first edit keeps its snapshot.
        await tx.gymEquipment.updateMany({
          where: { id: equipmentId, gymId, originalAiValue: { equals: Prisma.DbNull } },
          data: { originalAiValue: original as unknown as Prisma.InputJsonValue },
        });
      }

      const { count } = await tx.gymEquipment.updateMany({ where: { id: equipmentId, gymId }, data });

      if (count === 0) {
        throw equipmentNotFound();
      }
    });

    return toGymEquipmentView(await this.findInGym(gymId, equipmentId));
  }

  async remove(userId: string, gymId: string, equipmentId: string): Promise<void> {
    await this.gyms.findOwned(userId, gymId);

    const { count } = await this.prisma.gymEquipment.deleteMany({ where: { id: equipmentId, gymId } });

    if (count === 0) {
      throw equipmentNotFound();
    }
  }

  // ---------------------------------------------------------------------------

  private async findInGym(gymId: string, equipmentId: string) {
    const row = await this.prisma.gymEquipment.findFirst({
      where: { id: equipmentId, gymId },
      include: GYM_EQUIPMENT_INCLUDE,
    });

    if (!row) {
      throw equipmentNotFound();
    }

    return row;
  }

  /** A catalog type or the caller's own custom type; anything else is a 404. */
  private async assertTypeVisible(userId: string, equipmentTypeId: string): Promise<void> {
    const type = await this.prisma.equipmentType.findFirst({
      where: { id: equipmentTypeId, OR: [{ ownerUserId: null }, { ownerUserId: userId }] },
      select: { id: true },
    });

    if (!type) {
      throw equipmentTypeNotFound();
    }
  }
}
