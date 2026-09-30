// =============================================================================
// Real-Postgres test: temporary gyms (E6.2) — the purge's reference-safety and
// the "a temporary gym is never the default" rule
// =============================================================================
//
// What only a real server can prove: that the relation filters in the purge's
// selection and in the delete's own WHERE (`workouts: none`, `workoutAdaptations:
// none { status in queued|running|ready }`, `programs: none { draft|active|paused }`)
// plus the scanning-intake check keep exactly the gyms they should, against the
// real FKs and the partial unique default index; and that a purged gym's photos'
// storage objects are gone.
//
// `ObjectsService` is replaced by a stub that deletes the `storage_objects` row
// (the provider is not what is under test).
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// The purge is global: assertions are about this suite's own rows only.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { GymStorageService } from '../../src/gyms/gym-storage.service';
import { TEMPORARY_GYM_RETENTION_DAYS } from '../../src/gyms/gyms.constants';
import { GymsService } from '../../src/gyms/gyms.service';
import {
  TemporaryGymPurgeHandler,
  isHeldByScanningIntake,
  purgeableTemporaryGymWhere,
} from '../../src/gyms/handlers/temporary-gym-purge.handler';
import type { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { ObjectsService } from '../../src/storage/objects/objects.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('temporary-gym-purge.db.spec');

const DAY = 24 * 60 * 60 * 1000;

describeWithDb('temporary gyms (real Postgres)', () => {
  let client: PrismaClient;
  let gyms: GymsService;
  let handler: TemporaryGymPurgeHandler;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const now = new Date();
  const old = new Date(now.getTime() - (TEMPORARY_GYM_RETENTION_DAYS + 1) * DAY);
  const young = new Date(now.getTime() - (TEMPORARY_GYM_RETENTION_DAYS - 1) * DAY);

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({
      data: { email: `tmp-gym-${label}-${run}@example.com` },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  }

  /** A gym whose `updated_at` is `updatedAt` (Prisma honours an explicit value on create). */
  const makeGym = (userId: string, data: { isTemporary?: boolean; isDefault?: boolean; updatedAt?: Date; createdAt?: Date } = {}) =>
    client.gym.create({
      data: { userId, name: 'Hotel gym', type: 'hotel', isTemporary: true, updatedAt: old, ...data },
      select: { id: true },
    });

  async function makeObject(userId: string) {
    return client.storageObject.create({
      data: {
        name: 'room.jpg',
        size: BigInt(1024),
        mimeType: 'image/jpeg',
        status: 'ready',
        storageKey: `tmp-gym-${run}-${randomUUID()}`,
        uploadedById: userId,
      },
      select: { id: true },
    });
  }

  const exists = async (gymId: string) => (await client.gym.count({ where: { id: gymId } })) === 1;

  const workout = (userId: string, gymId: string) =>
    client.workout.create({
      data: { userId, gymId, name: 'Hotel session', date: new Date('2026-09-01T00:00:00.000Z'), startedAt: old, status: 'completed' },
    });

  const adaptation = (userId: string, gymId: string, status: string) =>
    client.workoutAdaptation.create({
      data: { userId, gymId, status, request: { minutes: 30 }, expiresAt: new Date(now.getTime() + 30 * DAY) },
      select: { id: true },
    });

  const program = (userId: string, gymId: string, status: string) =>
    client.program.create({ data: { userId, gymId, name: 'Trip plan', goal: 'general', status }, select: { id: true } });

  const intake = (userId: string, gymId: string, status: string) =>
    client.photoIntake.create({
      data: { userId, kind: 'gym_equipment', status, subjectType: 'gym', subjectId: gymId, context: { gymId } },
    });

  beforeAll(() => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    const objects = {
      delete: async (id: string) => {
        await client.storageObject.delete({ where: { id } });
      },
    } as unknown as ObjectsService;
    gyms = new GymsService(prisma, new GymStorageService(prisma, objects));
    handler = new TemporaryGymPurgeHandler({ register: () => undefined } as unknown as JobHandlerRegistry, prisma, gyms);
  });

  afterAll(async () => {
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.storageObject.deleteMany({ where: { storageKey: { startsWith: `tmp-gym-${run}` } } });
    await client.$disconnect();
  });

  describe('gyms.temporary.purge selection', () => {
    const cases: Record<string, string> = {};
    const objectIds: Record<string, string> = {};

    beforeAll(async () => {
      // --- purged ---
      const plain = await makeUser('plain');
      cases.oldUnreferenced = (await makeGym(plain)).id;
      const object = await makeObject(plain);
      objectIds.oldUnreferenced = object.id;
      await client.gymPhoto.create({ data: { gymId: cases.oldUnreferenced, storageObjectId: object.id } });

      for (const status of ['failed', 'cancelled', 'applied', 'discarded', 'blocked_safety']) {
        const u = await makeUser(`adapt-${status}`);
        cases[`adaptation-${status}`] = (await makeGym(u)).id;
        await adaptation(u, cases[`adaptation-${status}`], status);
      }
      for (const status of ['archived', 'completed']) {
        const u = await makeUser(`program-${status}`);
        cases[`program-${status}`] = (await makeGym(u)).id;
        await program(u, cases[`program-${status}`], status);
      }
      for (const status of ['draft', 'ready', 'failed', 'applied']) {
        const u = await makeUser(`intake-${status}`);
        cases[`intake-${status}`] = (await makeGym(u)).id;
        await intake(u, cases[`intake-${status}`], status);
      }

      // --- kept ---
      const keep = await makeUser('keep');
      cases.young = (await makeGym(keep, { updatedAt: young })).id;
      cases.permanent = (await makeGym(keep, { isTemporary: false })).id;
      cases.workout = (await makeGym(keep)).id;
      await workout(keep, cases.workout);

      for (const status of ['queued', 'running', 'ready']) {
        const u = await makeUser(`live-${status}`);
        cases[`live-adaptation-${status}`] = (await makeGym(u)).id;
        await adaptation(u, cases[`live-adaptation-${status}`], status);
      }
      for (const status of ['draft', 'active', 'paused']) {
        const u = await makeUser(`plan-${status}`);
        cases[`plan-${status}`] = (await makeGym(u)).id;
        await program(u, cases[`plan-${status}`], status);
      }
      const scanner = await makeUser('scanning');
      cases.scanning = (await makeGym(scanner)).id;
      await intake(scanner, cases.scanning, 'scanning');

      await handler.purge(now);
    });

    it('deletes an old unreferenced temporary gym, its photos and their storage objects', async () => {
      expect(await exists(cases.oldUnreferenced)).toBe(false);
      expect(await client.gymPhoto.count({ where: { gymId: cases.oldUnreferenced } })).toBe(0);
      expect(await client.storageObject.count({ where: { id: objectIds.oldUnreferenced } })).toBe(0);
    });

    it.each(['failed', 'cancelled', 'applied', 'discarded', 'blocked_safety'])(
      'deletes a gym whose only adaptation is %s (the adaptation keeps its row, gym id nulled)',
      async (status) => {
        expect(await exists(cases[`adaptation-${status}`])).toBe(false);
        expect(await client.workoutAdaptation.count({ where: { gymId: cases[`adaptation-${status}`] } })).toBe(0);
      },
    );

    it.each(['archived', 'completed'])('deletes a gym only an %s plan points at', async (status) => {
      expect(await exists(cases[`program-${status}`])).toBe(false);
    });

    it.each(['draft', 'ready', 'failed', 'applied'])('deletes a gym whose intake is %s (not scanning)', async (status) => {
      expect(await exists(cases[`intake-${status}`])).toBe(false);
    });

    it('keeps a temporary gym younger than the retention', async () => {
      expect(await exists(cases.young)).toBe(true);
    });

    it('never touches a permanent gym', async () => {
      expect(await exists(cases.permanent)).toBe(true);
    });

    it('keeps a gym any workout references', async () => {
      expect(await exists(cases.workout)).toBe(true);
    });

    it.each(['queued', 'running', 'ready'])('keeps a gym a %s adaptation references', async (status) => {
      expect(await exists(cases[`live-adaptation-${status}`])).toBe(true);
    });

    it.each(['draft', 'active', 'paused'])('keeps a gym a %s plan references', async (status) => {
      expect(await exists(cases[`plan-${status}`])).toBe(true);
    });

    it('keeps a gym a scanning intake targets', async () => {
      expect(await exists(cases.scanning)).toBe(true);
    });

    it('a second run changes nothing (idempotent)', async () => {
      const result = await handler.purge(now);
      for (const key of ['young', 'permanent', 'workout', 'scanning', 'live-adaptation-ready', 'plan-active']) {
        expect(await exists(cases[key])).toBe(true);
      }
      expect(result.failed).toBe(0);
    });
  });

  describe('removeTemporary re-checks inside its transaction', () => {
    it('skips a gym that gained a workout after it was selected', async () => {
      const u = await makeUser('race');
      const gym = await makeGym(u);
      const where = purgeableTemporaryGymWhere(new Date(now.getTime() - TEMPORARY_GYM_RETENTION_DAYS * DAY));
      const selected = await client.gym.findMany({ where: { ...where, id: gym.id }, select: { id: true } });
      expect(selected).toHaveLength(1);

      await workout(u, gym.id); // referenced after selection

      await expect(gyms.removeTemporary(u, gym.id, { where, isHeld: isHeldByScanningIntake })).resolves.toBe(false);
      expect(await exists(gym.id)).toBe(true);
    });

    it('skips a gym whose scan started after it was selected', async () => {
      const u = await makeUser('race-scan');
      const gym = await makeGym(u);
      const where = purgeableTemporaryGymWhere(new Date(now.getTime() - TEMPORARY_GYM_RETENTION_DAYS * DAY));
      await intake(u, gym.id, 'scanning');

      await expect(gyms.removeTemporary(u, gym.id, { where, isHeld: isHeldByScanningIntake })).resolves.toBe(false);
      expect(await exists(gym.id)).toBe(true);
    });

    it('purging a (legacy) default temporary gym promotes the oldest permanent gym, never another temporary one', async () => {
      const u = await makeUser('legacy-default');
      const legacy = await makeGym(u, { isDefault: true, createdAt: new Date(now.getTime() - 90 * DAY) });
      await makeGym(u, { createdAt: new Date(now.getTime() - 80 * DAY), updatedAt: young }); // older temporary, kept
      const permanent = await makeGym(u, { isTemporary: false, createdAt: new Date(now.getTime() - 70 * DAY) });
      const where = purgeableTemporaryGymWhere(new Date(now.getTime() - TEMPORARY_GYM_RETENTION_DAYS * DAY));

      await expect(gyms.removeTemporary(u, legacy.id, { where })).resolves.toBe(true);

      const defaults = await client.gym.findMany({ where: { userId: u, isDefault: true }, select: { id: true } });
      expect(defaults).toEqual([{ id: permanent.id }]);
    });
  });

  describe('a temporary gym is never the default', () => {
    it('the first gym, temporary, is not the default; the first permanent gym then is', async () => {
      const u = await makeUser('first');
      const hotel = await gyms.create(u, { name: 'Hotel gym', type: 'hotel', isTemporary: true });
      expect(hotel.isDefault).toBe(false);

      const home = await gyms.create(u, { name: 'Home', type: 'home' });
      expect(home.isDefault).toBe(true);
    });

    it('saving a temporary gym keeps its id and does not change an existing default', async () => {
      const u = await makeUser('save');
      const home = await gyms.create(u, { name: 'Home', type: 'home' });
      const hotel = await gyms.create(u, { name: 'Hotel gym', type: 'hotel', isTemporary: true });
      await workout(u, hotel.id);

      const saved = await gyms.update(u, hotel.id, { isTemporary: false, name: 'Hilton Lisbon' });

      expect(saved).toMatchObject({ id: hotel.id, isTemporary: false, isDefault: false, name: 'Hilton Lisbon' });
      expect(await client.gym.findMany({ where: { userId: u, isDefault: true }, select: { id: true } })).toEqual([{ id: home.id }]);
      expect(await client.workout.count({ where: { gymId: hotel.id } })).toBe(1);
    });

    it('saving the only gym fills the empty default slot', async () => {
      const u = await makeUser('only');
      const hotel = await gyms.create(u, { name: 'Hotel gym', type: 'hotel', isTemporary: true });

      await expect(gyms.update(u, hotel.id, { isTemporary: false })).resolves.toMatchObject({ id: hotel.id, isDefault: true });
    });

    it('marking the default temporary hands the default to the oldest permanent gym', async () => {
      const u = await makeUser('demote');
      const first = await gyms.create(u, { name: 'Home', type: 'home' });
      const second = await gyms.create(u, { name: 'Club', type: 'club' });

      await expect(gyms.update(u, first.id, { isTemporary: true })).resolves.toMatchObject({ isDefault: false, isTemporary: true });
      expect(await client.gym.findMany({ where: { userId: u, isDefault: true }, select: { id: true } })).toEqual([{ id: second.id }]);
    });

    it('POST /default on a temporary gym is 409 TEMPORARY_GYM_NOT_DEFAULT', async () => {
      const u = await makeUser('set-default');
      await gyms.create(u, { name: 'Home', type: 'home' });
      const hotel = await gyms.create(u, { name: 'Hotel gym', type: 'hotel', isTemporary: true });

      await expect(gyms.setDefault(u, hotel.id)).rejects.toMatchObject({
        status: 409,
        response: { details: { reason: 'TEMPORARY_GYM_NOT_DEFAULT' } },
      });
    });
  });
});
