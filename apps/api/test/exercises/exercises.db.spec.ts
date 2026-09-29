// =============================================================================
// Real-Postgres test: the exercise library (E4.1)
// =============================================================================
//
// What only a real server can prove: the CHECK constraints (exactly one
// requirement target; at least one primary muscle; a valid tracking mode), the
// foreign-key behaviour (`ON DELETE CASCADE` from exercises and users,
// `RESTRICT` from equipment types and capabilities), that the seed is
// idempotent and re-syncs requirement rows without touching user-owned
// exercises, and that availability over the SEEDED rows matches the acceptance
// truth table through the real services.
//
// `beforeAll` runs the real seed (`npm run prisma:seed`, idempotent) so the
// catalog is exactly what production carries.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { EXERCISE_CATALOG } from '../../prisma/seed-data';
import { ExerciseAvailabilityService } from '../../src/exercises/exercise-availability.service';
import { ExerciseUsageRepository } from '../../src/exercises/exercise-usage.repository';
import { ExercisesService } from '../../src/exercises/exercises.service';
import { GymsService } from '../../src/gyms/gyms.service';
import type { GymStorageService } from '../../src/gyms/gym-storage.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('exercises.db.spec');

/** Runs the real, idempotent seed against the database the suite proved reachable. */
function runSeed(): void {
  const { DATABASE_URL: _ignored, ...env } = process.env;
  execFileSync('npm', ['run', 'prisma:seed'], {
    cwd: path.resolve(__dirname, '../..'),
    env,
    stdio: 'pipe',
    timeout: 120_000,
  });
}

describeWithDb('exercise library (real Postgres)', () => {
  let client: PrismaClient;
  let exercises: ExercisesService;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({
      data: { email: `exercises-${label}-${run}@example.com` },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  }

  const typeId = async (slug: string) =>
    (await client.equipmentType.findFirstOrThrow({ where: { slug, ownerUserId: null }, select: { id: true } })).id;
  const capId = async (slug: string) =>
    (await client.capability.findUniqueOrThrow({ where: { slug }, select: { id: true } })).id;

  /** A gym owned by `userId` holding exactly these catalog equipment types. */
  async function makeGym(userId: string, slugs: string[]): Promise<string> {
    const gym = await client.gym.create({ data: { userId, name: `Gym ${randomUUID().slice(0, 4)}`, type: 'home' } });
    for (const slug of slugs) {
      await client.gymEquipment.create({ data: { gymId: gym.id, equipmentTypeId: await typeId(slug) } });
    }
    return gym.id;
  }

  const baseInput = {
    name: 'Sled push',
    primaryMuscles: ['quads' as const],
    secondaryMuscles: [],
    movementPattern: 'carry' as const,
    trackingMode: 'distance_time' as const,
    isUnilateral: false,
    isBodyweight: false,
    requirements: [],
  };

  beforeAll(async () => {
    runSeed();
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    const gyms = new GymsService(prisma, {} as GymStorageService);
    exercises = new ExercisesService(
      prisma,
      new ExerciseAvailabilityService(prisma, gyms),
      new ExerciseUsageRepository(prisma),
    );
  }, 180_000);

  afterAll(async () => {
    await client.gym.deleteMany({ where: { userId: { in: userIds } } });
    // Custom exercises cascade with their owner.
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // CHECK constraints
  // ---------------------------------------------------------------------------

  describe('CHECK constraints', () => {
    let exerciseId: string;
    let equipmentTypeId: string;
    let capabilityId: string;

    beforeAll(async () => {
      exerciseId = (
        await client.exercise.create({
          data: { slug: `check-${run}`, name: 'Check', primaryMuscles: ['chest'], movementPattern: 'isolation' },
        })
      ).id;
      equipmentTypeId = await typeId('barbell');
      capabilityId = await capId('leg_press');
    });

    afterAll(async () => {
      await client.exercise.deleteMany({ where: { slug: { startsWith: `check-${run}` } } });
    });

    it('rejects a requirement with both targets', async () => {
      await expect(
        client.exerciseRequirement.create({ data: { exerciseId, groupIndex: 0, equipmentTypeId, capabilityId } }),
      ).rejects.toThrow(/exercise_requirements_one_target_chk|check constraint/i);
    });

    it('rejects a requirement with neither target', async () => {
      await expect(
        client.exerciseRequirement.create({ data: { exerciseId, groupIndex: 0 } }),
      ).rejects.toThrow(/exercise_requirements_one_target_chk|check constraint/i);
    });

    it('accepts exactly one target', async () => {
      await client.exerciseRequirement.create({ data: { exerciseId, groupIndex: 0, equipmentTypeId } });
      await client.exerciseRequirement.create({ data: { exerciseId, groupIndex: 1, capabilityId } });
      expect(await client.exerciseRequirement.count({ where: { exerciseId } })).toBe(2);
    });

    it('rejects an exercise with no primary muscle', async () => {
      await expect(
        client.exercise.create({
          data: { slug: `check-${run}-nomuscle`, name: 'X', primaryMuscles: [], movementPattern: 'isolation' },
        }),
      ).rejects.toThrow(/check constraint|primary_muscles/i);
    });

    it('rejects an unknown tracking mode', async () => {
      await expect(
        client.exercise.create({
          data: {
            slug: `check-${run}-mode`,
            name: 'X',
            primaryMuscles: ['chest'],
            movementPattern: 'isolation',
            trackingMode: 'vibes',
          },
        }),
      ).rejects.toThrow(/check constraint|tracking_mode/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Foreign keys
  // ---------------------------------------------------------------------------

  describe('foreign keys', () => {
    it('cascades requirements when the exercise is deleted', async () => {
      const ex = await client.exercise.create({
        data: {
          slug: `check-${run}-cascade`,
          name: 'Cascade',
          primaryMuscles: ['chest'],
          movementPattern: 'isolation',
          requirements: { create: [{ groupIndex: 0, equipmentTypeId: await typeId('barbell') }] },
        },
      });

      await client.exercise.delete({ where: { id: ex.id } });

      expect(await client.exerciseRequirement.count({ where: { exerciseId: ex.id } })).toBe(0);
    });

    it('cascades a user\'s custom exercises when the user is deleted', async () => {
      const userId = await makeUser('cascade-user');
      const created = await exercises.create(userId, baseInput);

      await client.user.delete({ where: { id: userId } });

      expect(await client.exercise.count({ where: { id: created.id } })).toBe(0);
    });

    it('restricts deleting an equipment type or capability an exercise requires', async () => {
      // A user-owned type keeps the catalog untouched.
      const owner = await makeUser('restrict');
      const type = await client.equipmentType.create({
        data: { slug: `custom-r${run}`, name: `Restrict ${run}`, category: 'accessories', ownerUserId: owner },
      });
      const created = await exercises.create(owner, {
        ...baseInput,
        requirements: [{ equipmentTypeIds: [type.id], capabilityIds: [] }],
      });

      await expect(client.equipmentType.delete({ where: { id: type.id } })).rejects.toThrow();

      await exercises.remove(owner, created.id);
      await client.equipmentType.delete({ where: { id: type.id } });

      const capabilityId = await capId('leg_press');
      expect(await client.exerciseRequirement.count({ where: { capabilityId } })).toBeGreaterThan(0);
      await expect(client.capability.delete({ where: { id: capabilityId } })).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // The seed
  // ---------------------------------------------------------------------------

  describe('seed', () => {
    async function snapshot() {
      const rows = await client.exercise.findMany({
        where: { ownerUserId: null },
        include: { requirements: true },
        orderBy: { slug: 'asc' },
      });
      return rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        primaryMuscles: row.primaryMuscles,
        secondaryMuscles: row.secondaryMuscles,
        movementPattern: row.movementPattern,
        trackingMode: row.trackingMode,
        isUnilateral: row.isUnilateral,
        isBodyweight: row.isBodyweight,
        origin: row.origin,
        status: row.status,
        requirements: row.requirements
          .map((r) => `${r.groupIndex}:${r.equipmentTypeId ?? ''}:${r.capabilityId ?? ''}`)
          .sort(),
      }));
    }

    it('writes every catalog exercise as an active seed row with its requirement rows', async () => {
      const rows = await snapshot();

      expect(rows.length).toBeGreaterThanOrEqual(85);
      expect(new Set(rows.map((r) => r.slug))).toEqual(new Set(EXERCISE_CATALOG.map((e) => e.slug)));
      expect(rows.every((r) => r.origin === 'seed' && r.status === 'active')).toBe(true);

      const expectedRows = EXERCISE_CATALOG.reduce((sum, e) => sum + e.requirements.reduce((n, g) => n + g.slugs.length, 0), 0);
      expect(rows.reduce((sum, r) => sum + r.requirements.length, 0)).toBe(expectedRows);
    });

    it('is idempotent: a second run keeps every id and requirement row, and repairs drift', async () => {
      const before = await snapshot();

      // Drift the seed must repair: a wrong name and a stray requirement row.
      await client.exercise.update({ where: { slug: 'push_up' }, data: { name: 'Drifted' } });
      const pushUp = await client.exercise.findUniqueOrThrow({ where: { slug: 'push_up' } });
      await client.exerciseRequirement.create({
        data: { exerciseId: pushUp.id, groupIndex: 0, equipmentTypeId: await typeId('barbell') },
      });

      runSeed();

      expect(await snapshot()).toEqual(before);
    }, 120_000);

    it('never touches a user-owned exercise', async () => {
      const userId = await makeUser('seed-untouched');
      const created = await exercises.create(userId, { ...baseInput, name: 'Push-up' });
      const before = await client.exercise.findUniqueOrThrow({ where: { id: created.id } });

      runSeed();

      const after = await client.exercise.findUniqueOrThrow({ where: { id: created.id } });
      expect(after).toEqual(before);
      expect(await client.exercise.count({ where: { name: 'Push-up', ownerUserId: null } })).toBe(1);
    }, 120_000);
  });

  // ---------------------------------------------------------------------------
  // Availability over the seeded rows
  // ---------------------------------------------------------------------------

  describe('availability against real seeded rows', () => {
    const list = (userId: string, gymId: string, extra: Record<string, unknown> = {}) =>
      exercises.list(userId, { includePending: false, availableOnly: true, gymId, limit: 200, ...extra } as any);

    it('a dumbbell + bench gym supports the dumbbell and bodyweight exercises, not the machines or barbell', async () => {
      const userId = await makeUser('dumbbell-gym');
      const gymId = await makeGym(userId, ['adjustable_dumbbells', 'adjustable_bench']);

      const slugs = new Set((await list(userId, gymId)).map((e) => e.slug));

      for (const slug of [
        'dumbbell_bench_press',
        'incline_dumbbell_press',
        'dumbbell_shoulder_press',
        'push_up',
        'goblet_squat',
      ]) {
        expect(slugs).toContain(slug);
      }
      for (const slug of ['leg_press', 'barbell_bench_press', 'lat_pulldown']) {
        expect(slugs).not.toContain(slug);
      }
      // Every pure-bodyweight exercise is there.
      for (const ex of EXERCISE_CATALOG.filter((e) => e.requirements.length === 0)) {
        expect(slugs).toContain(ex.slug);
      }
    });

    it('without availableOnly it returns everything with available and missing', async () => {
      const userId = await makeUser('dumbbell-gym-all');
      const gymId = await makeGym(userId, ['adjustable_dumbbells', 'adjustable_bench']);

      const all = await list(userId, gymId, { availableOnly: false });
      const legPress = all.find((e) => e.slug === 'leg_press')!;

      expect(all.length).toBeGreaterThanOrEqual(85);
      expect(legPress.available).toBe(false);
      expect(legPress.missing).toContain('Leg press');
      expect(all.find((e) => e.slug === 'push_up')).toMatchObject({ available: true, missing: [] });
    });

    it('a functional trainer supports the cable exercises', async () => {
      const userId = await makeUser('cable-gym');
      const gymId = await makeGym(userId, ['functional_trainer']);

      const slugs = new Set((await list(userId, gymId)).map((e) => e.slug));

      for (const slug of ['lat_pulldown', 'seated_cable_row', 'cable_fly', 'triceps_pushdown', 'face_pull', 'cable_curl']) {
        expect(slugs).toContain(slug);
      }
    });

    it('a gym with no equipment offers exactly the pure-bodyweight exercises', async () => {
      const userId = await makeUser('empty-gym');
      const gymId = await makeGym(userId, []);

      const slugs = (await list(userId, gymId)).map((e) => e.slug).sort();

      expect(slugs).toEqual(
        EXERCISE_CATALOG.filter((e) => e.requirements.length === 0)
          .map((e) => e.slug)
          .sort(),
      );
    });

    it('answers 404 for a gym another user owns', async () => {
      const owner = await makeUser('gym-owner');
      const other = await makeUser('gym-other');
      const gymId = await makeGym(owner, ['barbell']);

      await expect(list(other, gymId)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('keeps pending AI proposals out of availableOnly until approved', async () => {
      const userId = await makeUser('pending');
      const gymId = await makeGym(userId, []);

      const { exercise, created } = await exercises.proposeFromAi(userId, { ...baseInput, name: 'Zercher carry' }, null);
      expect(created).toBe(true);
      expect(exercise).toMatchObject({ origin: 'ai', status: 'pending_review' });

      expect((await list(userId, gymId)).map((e) => e.id)).not.toContain(exercise.id);
      expect((await exercises.list(userId, { includePending: false, availableOnly: false, limit: 200 } as any)).map((e) => e.id)).not.toContain(
        exercise.id,
      );
      expect(
        (await exercises.list(userId, { includePending: true, availableOnly: false, limit: 200 } as any)).map((e) => e.id),
      ).toContain(exercise.id);

      await exercises.approve(userId, exercise.id);

      expect((await list(userId, gymId)).map((e) => e.id)).toContain(exercise.id);
    });

    it('maps a proposal whose name matches an existing exercise onto it instead of inserting', async () => {
      const userId = await makeUser('dedupe');

      const { exercise, created } = await exercises.proposeFromAi(userId, { ...baseInput, name: 'push up' }, null);

      expect(created).toBe(false);
      expect(exercise.slug).toBe('push_up');
      expect(await client.exercise.count({ where: { ownerUserId: userId } })).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Custom exercise ownership on real rows
  // ---------------------------------------------------------------------------

  describe('custom exercises', () => {
    it('are invisible to other users (404) and library rows are read-only (403)', async () => {
      const owner = await makeUser('own');
      const other = await makeUser('stranger');
      const mine = await exercises.create(owner, baseInput);
      const library = await client.exercise.findUniqueOrThrow({ where: { slug: 'push_up' } });

      await expect(exercises.get(other, mine.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(exercises.update(other, mine.id, { name: 'Hijack' })).rejects.toBeInstanceOf(NotFoundException);
      await expect(exercises.remove(other, mine.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(exercises.approve(other, mine.id)).rejects.toBeInstanceOf(NotFoundException);
      expect((await exercises.list(other, { includePending: true, availableOnly: false, limit: 200 } as any)).map((e) => e.id)).not.toContain(
        mine.id,
      );

      await expect(exercises.update(owner, library.id, { name: 'Hijack' })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(exercises.remove(owner, library.id)).rejects.toBeInstanceOf(ForbiddenException);
      expect((await client.exercise.findUniqueOrThrow({ where: { id: library.id } })).name).toBe('Push-up');
    });

    it('replaces requirement groups on update and returns them expanded', async () => {
      const owner = await makeUser('requirements');
      const mine = await exercises.create(owner, {
        ...baseInput,
        requirements: [{ equipmentTypeIds: [await typeId('barbell'), await typeId('ez_bar')], capabilityIds: [] }],
      });
      expect(mine.requirements).toHaveLength(1);
      expect(mine.requirements[0].options.map((o) => o.slug).sort()).toEqual(['barbell', 'ez_bar']);

      const updated = await exercises.update(owner, mine.id, {
        requirements: [{ equipmentTypeIds: [], capabilityIds: [await capId('leg_press')] }],
      });

      expect(updated.requirements).toEqual([
        { groupIndex: 0, options: [expect.objectContaining({ kind: 'capability', slug: 'leg_press' })] },
      ]);
      expect(await client.exerciseRequirement.count({ where: { exerciseId: mine.id } })).toBe(1);
    });

    it('may share a library exercise\'s name and gets a custom- slug', async () => {
      const owner = await makeUser('same-name');

      const mine = await exercises.create(owner, { ...baseInput, name: 'Push-up' });

      expect(mine.slug).toMatch(/^custom-[a-z0-9]{8}$/);
      expect(mine.isCustom).toBe(true);
    });
  });
});
