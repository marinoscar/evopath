// =============================================================================
// workout_adaptations on the real database: purge batches, the partial index,
// and the foreign keys (E6.1)
// =============================================================================
//
//   - `training.adaptations.purge` deletes rows strictly past `expires_at`, in
//     batches of at most 5,000 ids, by the exact ids it read, and never a row
//     that is not expired (the boundary included).
//   - `workout_adaptations_active_per_user_uniq_idx` is a RAW-SQL partial unique
//     index (Prisma cannot express it; never "fix" the drift with `@@unique`):
//     one `queued` or `running` row per user, any number of finished ones. The
//     service recognises a violation of THAT index by name, against the real
//     driver's error shape.
//   - `gym_id` is `ON DELETE SET NULL` (a deleted gym keeps the adaptation, so
//     E6.2's purge can test references with SQL); the user's deletion cascades.
//
// THIS IS A `*.db.spec.ts` FILE: skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import {
  ACTIVE_ADAPTATION_INDEX_NAME,
  ADAPTATIONS_PURGE_BATCH_SIZE,
  isActiveAdaptationConflict,
} from '../../src/training-adaptation/adaptation.constants';
import { AdaptationsPurgeHandler } from '../../src/training-adaptation/handlers/adaptations-purge.handler';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('adaptation-purge.db.spec');

describeWithDb('workout_adaptations (real Postgres)', () => {
  let client: PrismaClient;
  const tag = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const gymIds: string[] = [];

  beforeAll(() => {
    client = createDbClient();
  });

  afterAll(async () => {
    await client.workoutAdaptation.deleteMany({ where: { userId: { in: userIds } } });
    await client.gym.deleteMany({ where: { id: { in: gymIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  async function user(): Promise<string> {
    const row = await client.user.create({ data: { email: `adapt-purge-${randomUUID().slice(0, 8)}-${tag}@example.com` } });
    userIds.push(row.id);
    return row.id;
  }

  const row = (userId: string, over: Partial<Prisma.WorkoutAdaptationUncheckedCreateInput> = {}): Prisma.WorkoutAdaptationUncheckedCreateInput => ({
    userId,
    status: 'ready',
    request: {},
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  });

  describe('training.adaptations.purge', () => {
    it('deletes only expired rows, more than one batch of them, by the exact ids read; the boundary and the future stay', async () => {
      const userId = await user();
      const now = new Date();
      const expired = ADAPTATIONS_PURGE_BATCH_SIZE + 3;
      // Distinct, long-past expiry times (the oldest go first).
      await client.workoutAdaptation.createMany({
        data: Array.from({ length: expired }, (_, i) => row(userId, { status: 'discarded', expiresAt: new Date(now.getTime() - (i + 1) * 60_000) })),
      });
      const boundary = await client.workoutAdaptation.create({ data: row(userId, { expiresAt: now }), select: { id: true } });
      const future = await client.workoutAdaptation.create({ data: row(userId, { expiresAt: new Date(now.getTime() + 1) }), select: { id: true } });
      const applied = await client.workoutAdaptation.create({ data: row(userId, { status: 'applied', expiresAt: new Date(now.getTime() + 86_400_000) }), select: { id: true } });

      const batches: string[][] = [];
      const wrapped = {
        workoutAdaptation: {
          findMany: (args: never) => client.workoutAdaptation.findMany(args),
          deleteMany: (args: { where: { id: { in: string[] } } }) => {
            batches.push(args.where.id.in);
            return client.workoutAdaptation.deleteMany(args as never);
          },
        },
      };
      const deleted = await new AdaptationsPurgeHandler(new JobHandlerRegistry(), wrapped as never).purge(now);

      expect(deleted).toBeGreaterThanOrEqual(expired);
      expect(batches.length).toBeGreaterThanOrEqual(2);
      expect(batches[0]).toHaveLength(ADAPTATIONS_PURGE_BATCH_SIZE);
      for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(ADAPTATIONS_PURGE_BATCH_SIZE);
      expect(deleted).toBe(batches.reduce((sum, batch) => sum + batch.length, 0));
      // Every expired row of this user is gone; nothing that was not expired is.
      expect(await client.workoutAdaptation.count({ where: { userId, expiresAt: { lt: now } } })).toBe(0);
      const left = await client.workoutAdaptation.findMany({ where: { userId }, select: { id: true } });
      expect(left.map((r) => r.id).sort()).toEqual([boundary.id, future.id, applied.id].sort());
    });

    it('is idempotent: a second run right after finds nothing', async () => {
      const userId = await user();
      await client.workoutAdaptation.create({ data: row(userId, { status: 'discarded', expiresAt: new Date(Date.now() - 1000) }) });
      const handler = new AdaptationsPurgeHandler(new JobHandlerRegistry(), client as never);

      await handler.purge(new Date());

      await expect(handler.purge(new Date())).resolves.toBe(0);
    });
  });

  describe('workout_adaptations_active_per_user_uniq_idx (raw SQL, partial)', () => {
    it('exists as a partial unique index on user_id, and the declared plain indexes exist too', async () => {
      const indexes = await client.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'workout_adaptations'`;
      const byName = new Map(indexes.map((i) => [i.indexname, i.indexdef]));

      const active = byName.get(ACTIVE_ADAPTATION_INDEX_NAME)!;
      expect(active).toMatch(/UNIQUE INDEX/i);
      expect(active).toMatch(/\(user_id\)/);
      expect(active).toMatch(/WHERE/i);
      expect(active).toMatch(/queued/);
      expect(active).toMatch(/running/);
      const defs = [...byName.values()].join('\n');
      expect(defs).toMatch(/\(user_id, created_at DESC\)/);
      expect(defs).toMatch(/\(status\)/);
      expect(defs).toMatch(/\(gym_id\)/);
      expect(defs).toMatch(/\(expires_at\)/);
    });

    it('a second queued or running row for the same user violates it, and isActiveAdaptationConflict recognises that error by name', async () => {
      const userId = await user();
      await client.workoutAdaptation.create({ data: row(userId, { status: 'queued' }) });

      for (const status of ['queued', 'running']) {
        const error = await client.workoutAdaptation.create({ data: row(userId, { status }) }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
        expect(isActiveAdaptationConflict(error)).toBe(true);
      }
    });

    it('a different unique violation is NOT mistaken for it', () => {
      const other = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x', meta: { target: ['email'] } });
      expect(isActiveAdaptationConflict(other)).toBe(false);
      expect(isActiveAdaptationConflict(new Error(ACTIVE_ADAPTATION_INDEX_NAME))).toBe(false);
    });

    it('finished rows never conflict: any number of ready, failed, cancelled, blocked_safety, applied or discarded next to one queued', async () => {
      const userId = await user();
      await client.workoutAdaptation.create({ data: row(userId, { status: 'running' }) });

      for (const status of ['ready', 'ready', 'failed', 'cancelled', 'blocked_safety', 'blocked_safety', 'applied', 'discarded']) {
        await client.workoutAdaptation.create({ data: row(userId, { status }) });
      }

      expect(await client.workoutAdaptation.count({ where: { userId } })).toBe(9);
    });

    it('the slot frees when the active row finishes, and other users are independent', async () => {
      const a = await user();
      const b = await user();
      const first = await client.workoutAdaptation.create({ data: row(a, { status: 'queued' }), select: { id: true } });
      await client.workoutAdaptation.create({ data: row(b, { status: 'queued' }) });

      await client.workoutAdaptation.update({ where: { id: first.id }, data: { status: 'ready' } });

      await expect(client.workoutAdaptation.create({ data: row(a, { status: 'queued' }) })).resolves.toBeTruthy();
    });

    it('moving a finished row back to queued (a rate-limit deferral) while another is active is refused by the index', async () => {
      const userId = await user();
      const finished = await client.workoutAdaptation.create({ data: row(userId, { status: 'ready' }), select: { id: true } });
      await client.workoutAdaptation.create({ data: row(userId, { status: 'queued' }) });

      const error = await client.workoutAdaptation.update({ where: { id: finished.id }, data: { status: 'queued' } }).catch((e: unknown) => e);

      expect(isActiveAdaptationConflict(error)).toBe(true);
    });
  });

  describe('foreign keys', () => {
    it('deleting the gym keeps the adaptation and clears gym_id (ON DELETE SET NULL)', async () => {
      const userId = await user();
      const gym = await client.gym.create({ data: { userId, name: `Adapt gym ${tag}` }, select: { id: true } });
      gymIds.push(gym.id);
      const adaptation = await client.workoutAdaptation.create({ data: row(userId, { gymId: gym.id }), select: { id: true } });

      await client.gym.delete({ where: { id: gym.id } });

      expect(await client.workoutAdaptation.findUniqueOrThrow({ where: { id: adaptation.id } })).toMatchObject({ gymId: null, status: 'ready' });
    });

    it('a gym_id of nobody\'s gym is refused (the column is a real reference)', async () => {
      const userId = await user();

      await expect(client.workoutAdaptation.create({ data: row(userId, { gymId: randomUUID() }) })).rejects.toMatchObject({ code: 'P2003' });
    });

    it('deleting the user deletes their adaptations (ON DELETE CASCADE)', async () => {
      const userId = await user();
      const adaptation = await client.workoutAdaptation.create({ data: row(userId), select: { id: true } });

      await client.user.delete({ where: { id: userId } });

      expect(await client.workoutAdaptation.findUnique({ where: { id: adaptation.id } })).toBeNull();
    });

    it('the applied outcome links carry no foreign key: deleting the workout it created is allowed and leaves the adaptation as it was', async () => {
      const userId = await user();
      const workout = await client.workout.create({ data: { userId, name: 'Adapted', date: new Date('2026-09-30'), status: 'completed', startedAt: new Date('2026-09-30T10:00:00Z') }, select: { id: true } });
      const adaptation = await client.workoutAdaptation.create({
        data: row(userId, { status: 'applied', appliedAs: 'one_off', appliedWorkoutId: workout.id, appliedAt: new Date() }),
        select: { id: true },
      });

      await client.workout.delete({ where: { id: workout.id } });

      expect(await client.workoutAdaptation.findUniqueOrThrow({ where: { id: adaptation.id } })).toMatchObject({ status: 'applied', appliedWorkoutId: workout.id });
    });

    it('defaults: status queued, empty JSON reports, no outcome, expires_at required', async () => {
      const userId = await user();

      const created = await client.workoutAdaptation.create({ data: { userId, request: {}, expiresAt: new Date(Date.now() + 1000) } });

      expect(created).toMatchObject({
        status: 'queued',
        contextSnapshot: {},
        guardrailReport: {},
        safety: {},
        models: {},
        proposal: null,
        criticReport: null,
        baseRef: null,
        runId: null,
        jobId: null,
        appliedAs: null,
      });
      await expect(client.$executeRaw`INSERT INTO workout_adaptations (id, user_id, request) VALUES (${randomUUID()}::uuid, ${userId}::uuid, '{}'::jsonb)`).rejects.toThrow();
    });
  });
});
