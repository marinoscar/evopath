import { ConflictException, Injectable } from '@nestjs/common';
import type { Gym, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateGymInput,
  GymDetailData,
  GymSummaryData,
  ListGymsQuery,
  UpdateGymInput,
} from './dto/gym.dto';
import { GYM_REFUSALS, MAX_GYMS_PER_USER } from './gyms.constants';
import { GymStorageService } from './gym-storage.service';
import {
  GYM_EQUIPMENT_INCLUDE,
  GYM_PHOTO_INCLUDE,
  OLDEST_FIRST,
  gymNotFound,
  isUniqueViolation,
  refuse,
  toGymEquipmentView,
  toGymPhotoView,
  toGymView,
} from './gym-views';

// =============================================================================
// GymsService — the caller's gyms (E3.3)
// =============================================================================
//
// Owner-scoped: every query filters by `userId`; another user's gym is a 404.
//
// THE DEFAULT GYM. The partial unique index `gyms_user_default_uniq_idx`
// (migration SQL only) allows at most one `is_default` row per user, and it is
// the arbiter: nothing here checks "is there already a default?" to decide
// whether a write is safe. A write that loses a race gets `P2002`, and the
// operation is retried once against the new state (`withDefaultRetry`).
//
//   - create: the gym is default when the user has no default yet;
//   - POST /gyms/:id/default: one transaction clears the others, then sets it;
//   - delete: in the same transaction, when no default remains, the oldest
//     remaining gym is promoted.
// =============================================================================

@Injectable()
export class GymsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: GymStorageService,
  ) {}

  /** The caller's gym, or a 404. Used by the equipment and photo services too. */
  async findOwned(userId: string, gymId: string, client: Prisma.TransactionClient = this.prisma): Promise<Gym> {
    const gym = await client.gym.findFirst({ where: { id: gymId, userId } });

    if (!gym) {
      throw gymNotFound();
    }

    return gym;
  }

  async list(userId: string, query: ListGymsQuery): Promise<GymSummaryData[]> {
    const gyms = await this.prisma.gym.findMany({
      where: { userId, ...(query.includeTemporary ? {} : { isTemporary: false }) },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }, { createdAt: 'asc' }],
      include: {
        _count: { select: { equipment: true, photos: true } },
        photos: { orderBy: OLDEST_FIRST, take: 1, select: { id: true, storageObjectId: true } },
      },
    });

    return gyms.map(({ _count, photos, ...gym }) => ({
      ...toGymView(gym),
      equipmentCount: _count.equipment,
      photoCount: _count.photos,
      coverPhotoId: photos[0]?.id ?? null,
      coverStorageObjectId: photos[0]?.storageObjectId ?? null,
    }));
  }

  async get(userId: string, gymId: string): Promise<GymDetailData> {
    const gym = await this.prisma.gym.findFirst({
      where: { id: gymId, userId },
      include: {
        equipment: { orderBy: OLDEST_FIRST, include: GYM_EQUIPMENT_INCLUDE },
        photos: { orderBy: OLDEST_FIRST, include: GYM_PHOTO_INCLUDE },
      },
    });

    if (!gym) {
      throw gymNotFound();
    }

    const { equipment, photos, ...fields } = gym;

    return {
      ...toGymView(fields),
      equipment: equipment.map(toGymEquipmentView),
      photos: photos.map(toGymPhotoView),
    };
  }

  async create(userId: string, input: CreateGymInput): Promise<GymDetailData> {
    const existing = await this.prisma.gym.count({ where: { userId } });

    if (existing >= MAX_GYMS_PER_USER) {
      throw refuse(400, GYM_REFUSALS.GYM_LIMIT, `You can have at most ${MAX_GYMS_PER_USER} gyms`, {
        max: MAX_GYMS_PER_USER,
      });
    }

    const data = {
      userId,
      name: input.name,
      type: input.type,
      description: input.description ?? null,
      notes: input.notes ?? null,
      isTemporary: input.isTemporary ?? false,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
    };

    // The first gym becomes the default. Two concurrent "first" gyms both see
    // no default; the index lets one win and the other is created plain.
    const hasDefault = (await this.prisma.gym.count({ where: { userId, isDefault: true } })) > 0;

    let gym: Gym;
    try {
      gym = await this.prisma.gym.create({ data: { ...data, isDefault: !hasDefault } });
    } catch (error) {
      if (!hasDefault && isUniqueViolation(error)) {
        gym = await this.prisma.gym.create({ data: { ...data, isDefault: false } });
      } else {
        throw error;
      }
    }

    return { ...toGymView(gym), equipment: [], photos: [] };
  }

  async update(userId: string, gymId: string, input: UpdateGymInput): Promise<GymDetailData> {
    await this.findOwned(userId, gymId);

    const data: Prisma.GymUpdateManyMutationInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.type !== undefined) data.type = input.type;
    if (input.description !== undefined) data.description = input.description;
    if (input.notes !== undefined) data.notes = input.notes;
    if (input.isTemporary !== undefined) data.isTemporary = input.isTemporary;
    if (input.latitude !== undefined) data.latitude = input.latitude;
    if (input.longitude !== undefined) data.longitude = input.longitude;

    const { count } = await this.prisma.gym.updateMany({ where: { id: gymId, userId }, data });

    if (count === 0) {
      throw gymNotFound();
    }

    return this.get(userId, gymId);
  }

  /**
   * Deletes the gym (equipment, photos and links cascade), promotes the oldest
   * remaining gym when no default is left, then deletes the photos' storage
   * objects once the transaction has committed.
   */
  async remove(userId: string, gymId: string): Promise<void> {
    const storageObjectIds = await this.withDefaultRetry(() =>
      this.prisma.$transaction(async (tx) => {
        await this.findOwned(userId, gymId, tx);

        const photos = await tx.gymPhoto.findMany({ where: { gymId }, select: { storageObjectId: true } });
        const { count } = await tx.gym.deleteMany({ where: { id: gymId, userId } });

        if (count === 0) {
          throw gymNotFound();
        }

        await this.promoteOldestIfNoDefault(tx, userId);

        return photos.map((photo) => photo.storageObjectId);
      }),
    );

    await this.storage.deleteObjects(userId, storageObjectIds);
  }

  /** Makes this gym the caller's default; the previous default is cleared in the same transaction. */
  async setDefault(userId: string, gymId: string): Promise<GymDetailData> {
    const gym = await this.findOwned(userId, gymId);

    if (gym.isDefault) {
      return this.get(userId, gymId);
    }

    const [, set] = await this.withDefaultRetry(() =>
      this.prisma.$transaction([
        this.prisma.gym.updateMany({
          where: { userId, isDefault: true, id: { not: gymId } },
          data: { isDefault: false },
        }),
        this.prisma.gym.updateMany({ where: { id: gymId, userId }, data: { isDefault: true } }),
      ]),
    );

    if (set.count === 0) {
      throw gymNotFound();
    }

    return this.get(userId, gymId);
  }

  // ---------------------------------------------------------------------------

  private async promoteOldestIfNoDefault(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    const defaults = await tx.gym.count({ where: { userId, isDefault: true } });

    if (defaults > 0) {
      return;
    }

    const next = await tx.gym.findFirst({ where: { userId }, orderBy: OLDEST_FIRST, select: { id: true } });

    if (next) {
      await tx.gym.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  }

  /** Runs `operation`; on a lost race for the default slot (`P2002`) runs it once more. */
  private async withDefaultRetry<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }

    try {
      return await operation();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw refuse(409, GYM_REFUSALS.DEFAULT_CONFLICT, 'The default gym changed concurrently; try again') as ConflictException;
      }
      throw error;
    }
  }
}
