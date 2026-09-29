// =============================================================================
// Real-Postgres test: the gyms services (E3.3)
// =============================================================================
//
// What only a real server can prove: that two concurrent "make default"
// requests against `gyms_user_default_uniq_idx` leave exactly one default;
// that deleting the default promotes the oldest remaining gym and deleting the
// last leaves none; that a deleted gym's photos' storage objects are gone;
// search over the SEEDED catalog (alias match); custom-type ownership; the
// AI-row snapshot; and the in-use rule for custom types.
//
// `ObjectsService` is replaced by a stub that deletes the `storage_objects`
// row (the provider is not what is under test).
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a database migrated;
// it does not need it seeded: CI runs `test:db` before `prisma:seed`, so
// `beforeAll` idempotently writes the catalog rows it reads (the same rows the
// seed writes, from `prisma/seed-data.ts`, so a later seed run is consistent).
// =============================================================================

import { randomUUID } from 'node:crypto';

import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { EquipmentTypesService } from '../../src/gyms/equipment-types.service';
import { GymEquipmentService } from '../../src/gyms/gym-equipment.service';
import { GymPhotosService } from '../../src/gyms/gym-photos.service';
import { GymStorageService } from '../../src/gyms/gym-storage.service';
import { GymsService } from '../../src/gyms/gyms.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { ObjectsService } from '../../src/storage/objects/objects.service';
import { CAPABILITY_CATALOG, EQUIPMENT_CATALOG } from '../../prisma/seed-data';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('gyms-api.db.spec');

describeWithDb('gyms services (real Postgres)', () => {
  let client: PrismaClient;
  let gyms: GymsService;
  let equipment: GymEquipmentService;
  let photos: GymPhotosService;
  let types: EquipmentTypesService;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({
      data: { email: `gyms-api-${label}-${run}@example.com` },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function makeObject(userId: string) {
    return client.storageObject.create({
      data: {
        name: 'gym.jpg',
        size: BigInt(1024),
        mimeType: 'image/jpeg',
        status: 'ready',
        storageKey: `gyms-api-${run}-${randomUUID()}`,
        uploadedById: userId,
      },
    });
  }

  const defaults = (userId: string) => client.gym.findMany({ where: { userId, isDefault: true }, select: { id: true } });

  async function catalogType(slug: string) {
    return client.equipmentType.findUniqueOrThrow({ where: { slug } });
  }

  // Mirrors `seedCatalogs()` in prisma/seed.ts, insert-only: existing rows
  // (seeded or not) are left alone, so this never fights the seed suite.
  async function ensureCatalog() {
    await client.capability.createMany({
      data: CAPABILITY_CATALOG.map((cap) => ({
        slug: cap.slug,
        name: cap.name,
        movementPattern: cap.movementPattern,
        primaryMuscles: cap.primaryMuscles,
        description: cap.description ?? null,
        sortOrder: cap.sortOrder,
      })),
      skipDuplicates: true,
    });
    await client.equipmentType.createMany({
      data: EQUIPMENT_CATALOG.map((item) => ({
        slug: item.slug,
        name: item.name,
        category: item.category,
        aliases: item.aliases,
        description: item.description ?? null,
        sortOrder: item.sortOrder,
      })),
      skipDuplicates: true,
    });
    const capabilityIds = new Map(
      (await client.capability.findMany({ select: { id: true, slug: true } })).map((c) => [c.slug, c.id]),
    );
    const typeIds = new Map(
      (await client.equipmentType.findMany({ where: { ownerUserId: null }, select: { id: true, slug: true } })).map(
        (t) => [t.slug, t.id],
      ),
    );
    await client.equipmentTypeCapability.createMany({
      data: EQUIPMENT_CATALOG.flatMap((item) =>
        item.capabilities.map((slug) => ({
          equipmentTypeId: typeIds.get(item.slug)!,
          capabilityId: capabilityIds.get(slug)!,
        })),
      ),
      skipDuplicates: true,
    });
  }

  beforeAll(async () => {
    client = createDbClient();
    await ensureCatalog();
    const prisma = client as unknown as PrismaService;
    const objects = {
      delete: async (id: string) => {
        await client.storageObject.delete({ where: { id } });
      },
    } as unknown as ObjectsService;
    const storage = new GymStorageService(prisma, objects);
    gyms = new GymsService(prisma, storage);
    equipment = new GymEquipmentService(prisma, gyms);
    photos = new GymPhotosService(prisma, gyms, storage);
    types = new EquipmentTypesService(prisma);
  });

  afterAll(async () => {
    await client.gym.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.storageObject.deleteMany({ where: { storageKey: { startsWith: `gyms-api-${run}` } } });
    await client.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // The default gym
  // ---------------------------------------------------------------------------

  it('makes the first gym the default and not the second; POST default moves it', async () => {
    const userId = await makeUser('default');

    const first = await gyms.create(userId, { name: 'Home', type: 'home' });
    const second = await gyms.create(userId, { name: 'Hotel', type: 'hotel', isTemporary: true });

    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);

    const moved = await gyms.setDefault(userId, second.id);
    expect(moved.isDefault).toBe(true);
    expect(await defaults(userId)).toEqual([{ id: second.id }]);
  });

  it('two concurrent default requests leave exactly one default', async () => {
    const userId = await makeUser('race');
    const a = await gyms.create(userId, { name: 'A', type: 'home' });
    const b = await gyms.create(userId, { name: 'B', type: 'club' });
    const c = await gyms.create(userId, { name: 'C', type: 'office' });

    for (let round = 0; round < 5; round += 1) {
      const results = await Promise.allSettled([gyms.setDefault(userId, b.id), gyms.setDefault(userId, c.id)]);

      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(ConflictException);
        }
      }
      const now = await defaults(userId);
      expect(now).toHaveLength(1);
      expect([b.id, c.id]).toContain(now[0].id);

      await gyms.setDefault(userId, a.id);
    }
  });

  it('two concurrent first gyms produce one default', async () => {
    const userId = await makeUser('first-race');

    await Promise.all([
      gyms.create(userId, { name: 'One', type: 'home' }),
      gyms.create(userId, { name: 'Two', type: 'home' }),
    ]);

    expect(await defaults(userId)).toHaveLength(1);
  });

  it('deleting the default promotes the oldest remaining gym; deleting the last leaves none', async () => {
    const userId = await makeUser('promote');
    const home = await gyms.create(userId, { name: 'Home', type: 'home' });
    const older = await gyms.create(userId, { name: 'Zeta', type: 'club' });
    const newer = await gyms.create(userId, { name: 'Alpha', type: 'club' });

    await gyms.remove(userId, home.id);
    expect(await defaults(userId)).toEqual([{ id: older.id }]);

    await gyms.remove(userId, newer.id);
    expect(await defaults(userId)).toEqual([{ id: older.id }]);

    await gyms.remove(userId, older.id);
    expect(await client.gym.count({ where: { userId } })).toBe(0);
    expect(await defaults(userId)).toHaveLength(0);
  });

  it("deleting a gym deletes its photos' storage objects", async () => {
    const userId = await makeUser('photos');
    const gym = await gyms.create(userId, { name: 'Home', type: 'home' });
    const [one, two] = [await makeObject(userId), await makeObject(userId)];
    await photos.attach(userId, gym.id, { storageObjectId: one.id });
    await photos.attach(userId, gym.id, { storageObjectId: two.id });

    await gyms.remove(userId, gym.id);

    expect(await client.storageObject.count({ where: { id: { in: [one.id, two.id] } } })).toBe(0);
    expect(await client.gymPhoto.count({ where: { gymId: gym.id } })).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Photos
  // ---------------------------------------------------------------------------

  it('attaches a photo once (409 on a duplicate), links equipment, and removes the object on delete', async () => {
    const userId = await makeUser('attach');
    const gym = await gyms.create(userId, { name: 'Home', type: 'home' });
    const rack = await equipment.add(userId, gym.id, {
      equipmentTypeId: (await catalogType('elliptical')).id,
      quantity: 1,
    });
    const object = await makeObject(userId);

    const photo = await photos.attach(userId, gym.id, { storageObjectId: object.id, equipmentIds: [rack.id] });
    expect(photo.equipmentIds).toEqual([rack.id]);

    await expect(photos.attach(userId, gym.id, { storageObjectId: object.id })).rejects.toMatchObject({
      response: { details: { reason: 'PHOTO_ALREADY_ATTACHED' } },
    });

    const listed = await gyms.list(userId, { includeTemporary: true });
    expect(listed[0]).toEqual(
      expect.objectContaining({ photoCount: 1, equipmentCount: 1, coverPhotoId: photo.id, coverStorageObjectId: object.id }),
    );

    await photos.remove(userId, gym.id, photo.id);
    expect(await client.storageObject.count({ where: { id: object.id } })).toBe(0);
  });

  it("refuses another user's storage object and gym with 404", async () => {
    const owner = await makeUser('obj-owner');
    const other = await makeUser('obj-other');
    const gym = await gyms.create(other, { name: 'Other', type: 'home' });
    const object = await makeObject(owner);

    await expect(photos.attach(other, gym.id, { storageObjectId: object.id })).rejects.toBeInstanceOf(NotFoundException);
    await expect(gyms.get(owner, gym.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  // ---------------------------------------------------------------------------
  // Equipment and equipment types
  // ---------------------------------------------------------------------------

  it('searches the seeded catalog: q=cross finds Elliptical, q=curl finds Leg curl machine', async () => {
    const userId = await makeUser('search');

    const cross = await types.list(userId, { q: 'cross', limit: 100 });
    expect(cross.map((t) => t.slug)).toContain('elliptical');

    const curl = await types.list(userId, { q: 'curl', limit: 100 });
    expect(curl.map((t) => t.name)).toContain('Leg curl machine');

    const cardio = await types.list(userId, { category: 'cardio', limit: 100 });
    expect(cardio.every((t) => t.category === 'cardio')).toBe(true);
    expect(cardio.length).toBeGreaterThan(0);
  });

  it("a custom type of user A is invisible to user B and cannot be added to B's gym", async () => {
    const a = await makeUser('custom-a');
    const b = await makeUser('custom-b');
    const capability = await client.capability.findUniqueOrThrow({ where: { slug: 'farmer_carry' } });

    const sled = await types.create(a, { name: 'Prowler sled', category: 'accessories', capabilityIds: [capability.id] });
    expect(sled.slug).toMatch(/^custom-[a-z0-9]{8}$/);
    expect(sled.capabilities.map((c) => c.slug)).toEqual(['farmer_carry']);

    expect((await types.list(a, { q: 'prowler', limit: 100 })).map((t) => t.id)).toEqual([sled.id]);
    expect(await types.list(b, { q: 'prowler', limit: 100 })).toEqual([]);

    const gymB = await gyms.create(b, { name: 'B', type: 'home' });
    await expect(equipment.add(b, gymB.id, { equipmentTypeId: sled.id, quantity: 1 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(types.update(b, sled.id, { name: 'Mine' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(types.remove(b, sled.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deleting a custom type in use is 409; unused it is deleted', async () => {
    const userId = await makeUser('in-use');
    const gym = await gyms.create(userId, { name: 'Home', type: 'home' });
    const sled = await types.create(userId, { name: 'Sled', category: 'accessories' });
    const row = await equipment.add(userId, gym.id, { equipmentTypeId: sled.id, quantity: 1 });

    await expect(types.remove(userId, sled.id)).rejects.toMatchObject({
      response: { details: { reason: 'EQUIPMENT_TYPE_IN_USE' } },
    });

    await equipment.remove(userId, gym.id, row.id);
    await types.remove(userId, sled.id);
    expect(await client.equipmentType.count({ where: { id: sled.id } })).toBe(0);
  });

  it('editing an AI-origin row stores originalAiValue once and sets userVerified', async () => {
    const userId = await makeUser('ai-edit');
    const gym = await gyms.create(userId, { name: 'Home', type: 'home' });
    const elliptical = await catalogType('elliptical');
    const aiRow = await client.gymEquipment.create({
      data: {
        gymId: gym.id,
        equipmentTypeId: elliptical.id,
        quantity: 1,
        brand: 'Precor',
        origin: 'ai',
        confidence: 'medium',
        userVerified: false,
      },
    });

    const edited = await equipment.update(userId, gym.id, aiRow.id, { quantity: 2, brand: 'Life Fitness' });
    expect(edited).toEqual(
      expect.objectContaining({
        quantity: 2,
        brand: 'Life Fitness',
        userVerified: true,
        origin: 'ai',
        originalAiValue: { equipmentTypeId: elliptical.id, quantity: 1, brand: 'Precor', model: null, notes: null },
      }),
    );

    const again = await equipment.update(userId, gym.id, aiRow.id, { quantity: 3 });
    expect(again.originalAiValue).toEqual({ equipmentTypeId: elliptical.id, quantity: 1, brand: 'Precor', model: null, notes: null });
  });

  it('keeps the CHECK constraint and Zod in agreement on quantity (the service never writes 0)', async () => {
    const userId = await makeUser('check');
    const gym = await gyms.create(userId, { name: 'Home', type: 'home' });

    await expect(
      client.gymEquipment.create({
        data: { gymId: gym.id, equipmentTypeId: (await catalogType('elliptical')).id, quantity: 0 },
      }),
    ).rejects.toThrow();
  });
});
