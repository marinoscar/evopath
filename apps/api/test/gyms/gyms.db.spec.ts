// =============================================================================
// Real-Postgres test: gyms, equipment catalog and capabilities (E3.2)
// =============================================================================
//
// What only a real server can prove: the raw-SQL partial unique index
// `gyms_user_default_uniq_idx` and the CHECK constraints (declared in migration
// SQL only), the cascade/restrict rules, and that re-running the seed leaves
// row counts unchanged and never touches a custom equipment type.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. The seed suite needs a
// database migrated AND seeded by this suite (it runs the seed itself).
// =============================================================================

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { PrismaClient } from '@prisma/client';

import { CAPABILITY_CATALOG, EQUIPMENT_CATALOG } from '../../prisma/seed-data';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('gyms.db.spec');

describeWithDb('gyms and equipment (real Postgres)', () => {
  let client: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const u = await client.user.create({
      data: { email: `gyms-${label}-${run}@example.com` },
      select: { id: true },
    });
    userIds.push(u.id);
    return u.id;
  }

  const makeGym = (userId: string, data: Record<string, unknown> = {}) =>
    client.gym.create({ data: { userId, name: 'Gym', ...data } });

  async function makeType(slug: string, ownerUserId?: string) {
    return client.equipmentType.create({
      data: { slug: `t-${slug}-${run}`, name: slug, category: 'accessories', ownerUserId },
    });
  }

  async function makeStorageObject(userId: string) {
    return client.storageObject.create({
      data: {
        name: 'p.jpg',
        size: BigInt(1),
        mimeType: 'image/jpeg',
        storageKey: `gyms-${run}-${randomUUID()}`,
        uploadedById: userId,
      },
    });
  }

  beforeAll(() => {
    client = createDbClient();
  });

  afterAll(async () => {
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.equipmentType.deleteMany({ where: { slug: { endsWith: `-${run}` } } });
    await client.storageObject.deleteMany({ where: { storageKey: { startsWith: `gyms-${run}` } } });
    await client.$disconnect();
  });

  describe('gyms_user_default_uniq_idx', () => {
    it('refuses a second default gym for one user', async () => {
      const u = await makeUser('dup');
      await makeGym(u, { isDefault: true });
      await expect(makeGym(u, { isDefault: true })).rejects.toThrow(/gyms_user_default_uniq_idx|Unique constraint/);
    });

    it('allows many non-default gyms and one default per user', async () => {
      const a = await makeUser('a');
      const b = await makeUser('b');
      await makeGym(a, { isDefault: true });
      await makeGym(a);
      await makeGym(a);
      await expect(makeGym(b, { isDefault: true })).resolves.toBeDefined();
    });
  });

  describe('CHECK constraints', () => {
    it('rejects latitude without longitude and the reverse', async () => {
      const u = await makeUser('pair');
      await expect(makeGym(u, { latitude: 10 })).rejects.toThrow();
      await expect(makeGym(u, { longitude: 10 })).rejects.toThrow();
      await expect(makeGym(u, { latitude: 10, longitude: 20 })).resolves.toBeDefined();
    });

    it('rejects out-of-range coordinates', async () => {
      const u = await makeUser('range');
      await expect(makeGym(u, { latitude: 91, longitude: 0 })).rejects.toThrow();
      await expect(makeGym(u, { latitude: 0, longitude: -181 })).rejects.toThrow();
      await expect(makeGym(u, { latitude: -90, longitude: 180 })).resolves.toBeDefined();
    });

    it('rejects quantity 0 and 100 but accepts 1 and 99', async () => {
      const u = await makeUser('qty');
      const g = await makeGym(u);
      const t = await makeType('qty');
      const add = (quantity: number) =>
        client.gymEquipment.create({ data: { gymId: g.id, equipmentTypeId: t.id, quantity } });
      await expect(add(0)).rejects.toThrow();
      await expect(add(100)).rejects.toThrow();
      await expect(add(1)).resolves.toBeDefined();
      await expect(add(99)).resolves.toBeDefined();
    });
  });

  describe('cascade and restrict', () => {
    it('deleting a user cascades gyms, equipment, photo links and custom types', async () => {
      const u = await makeUser('casc');
      const g = await makeGym(u);
      const custom = await makeType('custom', u);
      const eq = await client.gymEquipment.create({ data: { gymId: g.id, equipmentTypeId: custom.id } });
      const so = await makeStorageObject(u);
      const photo = await client.gymPhoto.create({ data: { gymId: g.id, storageObjectId: so.id } });
      await client.gymEquipmentPhoto.create({ data: { gymEquipmentId: eq.id, gymPhotoId: photo.id } });

      await client.user.delete({ where: { id: u } });

      expect(await client.gym.count({ where: { id: g.id } })).toBe(0);
      expect(await client.gymEquipment.count({ where: { id: eq.id } })).toBe(0);
      expect(await client.gymPhoto.count({ where: { id: photo.id } })).toBe(0);
      expect(await client.gymEquipmentPhoto.count({ where: { gymPhotoId: photo.id } })).toBe(0);
      expect(await client.equipmentType.count({ where: { id: custom.id } })).toBe(0);
    });

    it('deleting a gym cascades equipment and photo links but keeps the StorageObject', async () => {
      const u = await makeUser('gymdel');
      const g = await makeGym(u);
      const t = await makeType('gymdel');
      const eq = await client.gymEquipment.create({ data: { gymId: g.id, equipmentTypeId: t.id } });
      const so = await makeStorageObject(u);
      const photo = await client.gymPhoto.create({ data: { gymId: g.id, storageObjectId: so.id } });
      await client.gymEquipmentPhoto.create({ data: { gymEquipmentId: eq.id, gymPhotoId: photo.id } });

      await client.gym.delete({ where: { id: g.id } });

      expect(await client.gymEquipment.count({ where: { gymId: g.id } })).toBe(0);
      expect(await client.gymPhoto.count({ where: { id: photo.id } })).toBe(0);
      expect(await client.gymEquipmentPhoto.count({ where: { gymEquipmentId: eq.id } })).toBe(0);
      expect(await client.storageObject.count({ where: { id: so.id } })).toBe(1);
    });

    it('deleting a StorageObject cascades only its GymPhoto link', async () => {
      const u = await makeUser('sodel');
      const g = await makeGym(u);
      const so = await makeStorageObject(u);
      await client.gymPhoto.create({ data: { gymId: g.id, storageObjectId: so.id } });

      await client.storageObject.delete({ where: { id: so.id } });

      expect(await client.gymPhoto.count({ where: { gymId: g.id } })).toBe(0);
      expect(await client.gym.count({ where: { id: g.id } })).toBe(1);
    });

    it('refuses to delete an EquipmentType a GymEquipment uses', async () => {
      const u = await makeUser('restrict');
      const g = await makeGym(u);
      const t = await makeType('restrict');
      await client.gymEquipment.create({ data: { gymId: g.id, equipmentTypeId: t.id } });
      await expect(client.equipmentType.delete({ where: { id: t.id } })).rejects.toThrow();
    });

    it('refuses to delete a Capability an equipment type links to', async () => {
      const cap = await client.capability.create({
        data: { slug: `cap-${run}`, name: 'c', movementPattern: 'core', primaryMuscles: ['abs'] },
      });
      const t = await makeType('capres');
      await client.equipmentTypeCapability.create({
        data: { equipmentTypeId: t.id, capabilityId: cap.id },
      });
      await expect(client.capability.delete({ where: { id: cap.id } })).rejects.toThrow();
      await client.equipmentType.delete({ where: { id: t.id } });
      await client.capability.delete({ where: { id: cap.id } });
    });
  });

  describe('catalog seed', () => {
    const seed = () => {
      const { DATABASE_URL: _ignored, ...env } = process.env;
      execFileSync('node', ['scripts/prisma-env.js', 'db', 'seed'], {
        cwd: join(__dirname, '..', '..'),
        env: env as NodeJS.ProcessEnv,
        stdio: 'pipe',
        timeout: 120_000,
      });
    };
    const counts = async () => ({
      capabilities: await client.capability.count(),
      equipment: await client.equipmentType.count({ where: { ownerUserId: null } }),
      links: await client.equipmentTypeCapability.count(),
    });

    it('is idempotent, matches the catalog, and never touches custom types', async () => {
      const u = await makeUser('seed');
      const custom = await client.equipmentType.create({
        data: { slug: `custom-${run}`, name: 'Mine', category: 'accessories', ownerUserId: u, aliases: ['x'] },
      });

      seed();
      const first = await counts();
      seed();
      const second = await counts();

      expect(second).toEqual(first);
      expect(first.capabilities).toBeGreaterThanOrEqual(CAPABILITY_CATALOG.length);
      expect(first.equipment).toBeGreaterThanOrEqual(EQUIPMENT_CATALOG.length);

      const curl = await client.equipmentType.findUniqueOrThrow({
        where: { slug: 'leg_curl_machine' },
        include: { capabilities: { include: { capability: true } } },
      });
      expect(curl.capabilities.map((l) => l.capability.slug)).toEqual(['leg_curl']);

      const after = await client.equipmentType.findUniqueOrThrow({ where: { id: custom.id } });
      expect(after).toMatchObject({ name: 'Mine', aliases: ['x'], ownerUserId: u });
    }, 180_000);
  });
});
