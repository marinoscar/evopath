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
import type { GymLocationResultData, SetGymLocationInput } from './dto/gym-location.dto';
import { GYM_REFUSALS, MAX_GYMS_PER_USER } from './gyms.constants';
import { GymStorageService } from './gym-storage.service';
import {
  GYM_EQUIPMENT_INCLUDE,
  GYM_PHOTO_INCLUDE,
  OLDEST_FIRST,
  gymNotFound,
  isUniqueViolation,
  refuse,
  roundCoordinate,
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
//
// TEMPORARY GYMS ARE NEVER THE DEFAULT (E6.2). A temporary gym (a hotel on a
// trip) is not where the user trains by default, and the daily
// `gyms.temporary.purge` job may delete it. So: creating one never makes it
// the default; "oldest remaining gym" promotion skips temporary gyms; making
// one the default is `409 TEMPORARY_GYM_NOT_DEFAULT`; marking the default gym
// temporary clears its default flag and promotes the oldest permanent gym in
// the same transaction. Saving a temporary gym (`isTemporary: false`) keeps
// its id and never REPLACES an existing default; it only fills an empty
// default slot (the user's first permanent gym), which is the create rule.
// The invariant: while a user has any permanent gym, exactly one is default.
// =============================================================================

/** What `removeTemporary` must still find true, inside its transaction, to delete. */
export interface TemporaryGymRemoval {
  /** Extra conditions on the gym row (age, relation references); `isTemporary: true` is always added. */
  where: Prisma.GymWhereInput;
  /** A holder the row filter cannot express (e.g. a scanning intake); true keeps the gym. */
  isHeld?: (tx: Prisma.TransactionClient, gymId: string) => Promise<boolean>;
}

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

    const isTemporary = input.isTemporary ?? false;
    const data = {
      userId,
      name: input.name,
      type: input.type,
      description: input.description ?? null,
      notes: input.notes ?? null,
      isTemporary,
      latitude: roundCoordinate(input.latitude ?? null),
      longitude: roundCoordinate(input.longitude ?? null),
    };

    // The first permanent gym becomes the default; a temporary gym never does.
    // Two concurrent "first" gyms both see no default; the index lets one win
    // and the other is created plain.
    const wantsDefault =
      !isTemporary && (await this.prisma.gym.count({ where: { userId, isDefault: true } })) === 0;

    let gym: Gym;
    try {
      gym = await this.prisma.gym.create({ data: { ...data, isDefault: wantsDefault } });
    } catch (error) {
      if (wantsDefault && isUniqueViolation(error)) {
        gym = await this.prisma.gym.create({ data: { ...data, isDefault: false } });
      } else {
        throw error;
      }
    }

    return { ...toGymView(gym), equipment: [], photos: [] };
  }

  async update(userId: string, gymId: string, input: UpdateGymInput): Promise<GymDetailData> {
    const current = await this.findOwned(userId, gymId);

    const data: Prisma.GymUpdateManyMutationInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.type !== undefined) data.type = input.type;
    if (input.description !== undefined) data.description = input.description;
    if (input.notes !== undefined) data.notes = input.notes;
    if (input.isTemporary !== undefined) data.isTemporary = input.isTemporary;
    if (input.latitude !== undefined) data.latitude = roundCoordinate(input.latitude);
    if (input.longitude !== undefined) data.longitude = roundCoordinate(input.longitude);

    if (input.isTemporary === undefined || input.isTemporary === current.isTemporary) {
      const { count } = await this.prisma.gym.updateMany({ where: { id: gymId, userId }, data });

      if (count === 0) {
        throw gymNotFound();
      }

      return this.get(userId, gymId);
    }

    // The temporary flag changes: the default slot moves with it, in one
    // transaction. Becoming temporary drops the default flag (the oldest
    // permanent gym takes it); being saved fills the slot only when it is empty.
    await this.withDefaultRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const { count } = await tx.gym.updateMany({
          where: { id: gymId, userId },
          data: input.isTemporary ? { ...data, isDefault: false } : data,
        });

        if (count === 0) {
          throw gymNotFound();
        }

        await this.promoteOldestIfNoDefault(tx, userId);
      }),
    );

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

        const deleted = await this.deleteWithin(tx, userId, gymId, {});

        if (!deleted) {
          throw gymNotFound();
        }

        return deleted;
      }),
    );

    await this.storage.deleteObjects(userId, storageObjectIds);
  }

  /**
   * The `gyms.temporary.purge` path of `remove`: deletes the gym only while it
   * is still temporary and still matches `removal` INSIDE the transaction that
   * deletes it (a gym referenced after the purge selected it is skipped), then
   * deletes its photos' storage objects like `DELETE /api/gyms/{id}`. Never
   * touches a permanent gym. Returns whether the gym was deleted.
   */
  async removeTemporary(userId: string, gymId: string, removal: TemporaryGymRemoval): Promise<boolean> {
    const storageObjectIds = await this.withDefaultRetry(() =>
      this.prisma.$transaction(async (tx) => {
        if (removal.isHeld && (await removal.isHeld(tx, gymId))) {
          return null;
        }

        return this.deleteWithin(tx, userId, gymId, { ...removal.where, isTemporary: true });
      }),
    );

    if (!storageObjectIds) {
      return false;
    }

    await this.storage.deleteObjects(userId, storageObjectIds);
    return true;
  }

  /** Makes this gym the caller's default; the previous default is cleared in the same transaction. */
  async setDefault(userId: string, gymId: string): Promise<GymDetailData> {
    const gym = await this.findOwned(userId, gymId);

    if (gym.isDefault) {
      return this.get(userId, gymId);
    }

    if (gym.isTemporary) {
      throw refuse(409, GYM_REFUSALS.TEMPORARY_GYM_NOT_DEFAULT, 'Save this gym before making it your default');
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

  /**
   * Sets the gym's position (E3.5), both coordinates rounded to 5 decimals.
   * `accuracyMeters` is echoed in the result only: never stored, never logged.
   * No log line here carries a coordinate.
   */
  async setLocation(userId: string, gymId: string, input: SetGymLocationInput): Promise<GymLocationResultData> {
    await this.writeLocation(userId, gymId, roundCoordinate(input.latitude), roundCoordinate(input.longitude));
    return { ...(await this.get(userId, gymId)), accuracyMeters: input.accuracyMeters ?? null };
  }

  /** Clears the gym's position (both coordinates null). Clearing an unset position is a no-op. */
  async clearLocation(userId: string, gymId: string): Promise<GymLocationResultData> {
    await this.writeLocation(userId, gymId, null, null);
    return { ...(await this.get(userId, gymId)), accuracyMeters: null };
  }

  // ---------------------------------------------------------------------------

  /** One owner-scoped write of the pair; the DB CHECK `gyms_latlng_pair_chk` backs "both or neither". */
  private async writeLocation(
    userId: string,
    gymId: string,
    latitude: number | null,
    longitude: number | null,
  ): Promise<void> {
    await this.findOwned(userId, gymId);

    const { count } = await this.prisma.gym.updateMany({ where: { id: gymId, userId }, data: { latitude, longitude } });

    if (count === 0) {
      throw gymNotFound();
    }
  }

  /**
   * Deletes the gym when it matches `where` (owner-scoped), promotes the oldest
   * permanent gym when no default is left, and answers the deleted photos'
   * storage object ids; null when nothing matched (nothing was written).
   */
  private async deleteWithin(
    tx: Prisma.TransactionClient,
    userId: string,
    gymId: string,
    where: Prisma.GymWhereInput,
  ): Promise<string[] | null> {
    const photos = await tx.gymPhoto.findMany({ where: { gymId }, select: { storageObjectId: true } });
    const { count } = await tx.gym.deleteMany({ where: { ...where, id: gymId, userId } });

    if (count === 0) {
      return null;
    }

    await this.promoteOldestIfNoDefault(tx, userId);

    return photos.map((photo) => photo.storageObjectId);
  }

  /** When the user has no default, the oldest PERMANENT gym becomes it (a temporary gym never does). */
  private async promoteOldestIfNoDefault(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    const defaults = await tx.gym.count({ where: { userId, isDefault: true } });

    if (defaults > 0) {
      return;
    }

    const next = await tx.gym.findFirst({
      where: { userId, isTemporary: false },
      orderBy: OLDEST_FIRST,
      select: { id: true },
    });

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
