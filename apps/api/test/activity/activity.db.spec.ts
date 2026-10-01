// =============================================================================
// Real-Postgres test: activity goals and entries (#266, #267, #268)
// =============================================================================
//
// What only a real server can prove: the batch upsert through the raw-SQL
// partial unique index `activity_entries_provider_external_uniq_idx` (a
// re-sent batch updates instead of duplicating, also when two batches race),
// workout auto-credit through `activity_entries_workout_kind_uniq_idx` (one
// row per workout and kind however often the sync runs), reconciliation of an
// edited or no-longer-completed workout, the FK cascade from a deleted
// workout, source precedence over real rows, and the backdating window in the
// user's own time zone.
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated, seeded
// database (the `outdoor_walk` exercise).
// =============================================================================

import { randomUUID } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { ActivityEntriesService } from '../../src/activity/activity-entries.service';
import { batchActivityEntriesSchema, createActivityEntrySchema } from '../../src/activity/dto/activity-entry.dto';
import { GoalProgressService } from '../../src/activity/goal-progress.service';
import { GoalsService } from '../../src/activity/goals.service';
import { WorkoutActivityListener } from '../../src/activity/workout-activity.listener';
import { WorkoutActivitySyncService } from '../../src/activity/workout-activity-sync.service';
import { CheckInsService } from '../../src/check-ins/check-ins.service';
import { addDays, localDateInZone, toDbDate } from '../../src/check-ins/local-date';
import { GymsService } from '../../src/gyms/gyms.service';
import type { GymStorageService } from '../../src/gyms/gym-storage.service';
import { HealthProfileService } from '../../src/health-profile/health-profile.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createSetSchema, startWorkoutSchema } from '../../src/workouts/dto/workout.dto';
import { WorkoutEntriesService } from '../../src/workouts/workout-entries.service';
import { WorkoutHistoryService } from '../../src/workouts/workout-history.service';
import { WorkoutsService } from '../../src/workouts/workouts.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('activity.db.spec');

interface Stack {
  client: PrismaClient;
  checkIns: CheckInsService;
  entries: ActivityEntriesService;
  goals: GoalsService;
  progress: GoalProgressService;
  sync: WorkoutActivitySyncService;
  workouts: WorkoutsService;
  workoutEntries: WorkoutEntriesService;
}

function buildStack(): Stack {
  const client = createDbClient();
  const prisma = client as unknown as PrismaService;
  const checkIns = new CheckInsService(prisma, new HealthProfileService(prisma));
  const history = new WorkoutHistoryService(prisma, checkIns);
  const sync = new WorkoutActivitySyncService(prisma);
  return {
    client,
    checkIns,
    sync,
    entries: new ActivityEntriesService(prisma, checkIns, sync),
    goals: new GoalsService(prisma, checkIns),
    progress: new GoalProgressService(prisma, checkIns, sync),
    workouts: new WorkoutsService(prisma, new GymsService(prisma, {} as GymStorageService), checkIns, history),
    workoutEntries: new WorkoutEntriesService(prisma, history),
  };
}

describeWithDb('activity goals and entries (real Postgres)', () => {
  let a: Stack;
  let b: Stack;
  let client: PrismaClient;
  let walkExerciseId: string;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({ data: { email: `activity-${label}-${run}@example.com` }, select: { id: true } });
    userIds.push(user.id);
    return user.id;
  }

  /** A finished workout today with one outdoor walk of 30 min / 2.5 km. */
  async function finishedWalk(userId: string): Promise<{ workoutId: string; setId: string }> {
    const workout = await a.workouts.start(userId, startWorkoutSchema.parse({}));
    const entry = await a.workoutEntries.addExercise(userId, workout.id, { exerciseId: walkExerciseId });
    const set = await a.workoutEntries.addSet(
      userId,
      workout.id,
      entry.id,
      createSetSchema.parse({ durationSeconds: 1800, distanceMeters: 2500, completed: true }),
    );
    await a.workouts.finish(userId, workout.id, {});
    return { workoutId: workout.id, setId: set.id };
  }

  const derivedOf = (workoutId: string) =>
    client.activityEntry.findMany({ where: { workoutId }, orderBy: { activityKind: 'asc' } });

  beforeAll(async () => {
    a = buildStack();
    b = buildStack();
    client = a.client;
    const walk = await client.exercise.findUnique({ where: { slug: 'outdoor_walk' }, select: { id: true } });
    if (!walk) throw new Error('The seeded outdoor_walk exercise is missing: run the seed');
    walkExerciseId = walk.id;
  });

  afterAll(async () => {
    if (userIds.length > 0) await client.user.deleteMany({ where: { id: { in: userIds } } });
    await a.client.$disconnect();
    await b.client.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // Batch idempotency (provider/externalId partial unique index)
  // ---------------------------------------------------------------------------

  describe('batch', () => {
    const batch = (provider: string, steps: number) =>
      batchActivityEntriesSchema.parse({
        entries: [
          { activityKind: 'steps', steps, provider, externalId: 'day-1' },
          { activityKind: 'steps', steps: steps + 1, provider, externalId: 'day-2' },
          { activityKind: 'walk' },
        ],
      });

    it('inserts once and updates on re-send; unkeyed rows are always inserted', async () => {
      const userId = await makeUser('batch');

      expect(await a.entries.batch(userId, batch('oura', 1000))).toEqual({ created: 3, updated: 0 });
      expect(await a.entries.batch(userId, batch('oura', 2000))).toEqual({ created: 1, updated: 2 });

      const keyed = await client.activityEntry.findMany({ where: { userId, provider: 'oura' }, orderBy: { externalId: 'asc' } });
      expect(keyed.map((row) => [row.externalId, row.steps, row.source])).toEqual([
        ['day-1', 2000, 'manual'],
        ['day-2', 2001, 'manual'],
      ]);
      expect(await client.activityEntry.count({ where: { userId, provider: null } })).toBe(2);
    });

    it('two racing batches with the same keys leave one row per key', async () => {
      const userId = await makeUser('batch-race');

      const results = await Promise.all([a.entries.batch(userId, batch('race', 10)), b.entries.batch(userId, batch('race', 20))]);

      expect(results.reduce((sum, result) => sum + result.created + result.updated, 0)).toBe(6);
      expect(await client.activityEntry.count({ where: { userId, provider: 'race' } })).toBe(2);
    });

    it('the same pair under another user, or another provider, is a separate row', async () => {
      const first = await makeUser('batch-u1');
      const second = await makeUser('batch-u2');

      await a.entries.batch(first, batch('shared', 1));
      expect(await a.entries.batch(second, batch('shared', 1))).toEqual({ created: 3, updated: 0 });
      expect(await a.entries.batch(first, batch('other', 1))).toEqual({ created: 3, updated: 0 });
    });

    it('never overwrites an imported (integration) row', async () => {
      const userId = await makeUser('batch-integration');
      await client.activityEntry.create({
        data: {
          userId,
          occurredOn: toDbDate(await a.checkIns.today(userId)),
          activityKind: 'steps',
          steps: 9999,
          source: 'integration',
          provider: 'keep',
          externalId: 'day-1',
        },
      });

      const result = await a.entries.batch(userId, batch('keep', 5));
      expect(result).toEqual({ created: 2, updated: 0 });
      const kept = await client.activityEntry.findFirstOrThrow({ where: { userId, provider: 'keep', externalId: 'day-1' } });
      expect(kept).toMatchObject({ steps: 9999, source: 'integration' });
    });
  });

  // ---------------------------------------------------------------------------
  // Workout auto-credit
  // ---------------------------------------------------------------------------

  describe('workout auto-credit', () => {
    it('credits walk, cardio_any and workout_any on finish, idempotently, on the workout local date', async () => {
      const userId = await makeUser('credit');
      const { workoutId } = await finishedWalk(userId);

      await new WorkoutActivityListener(a.sync).onWorkoutFinished({ userId, workoutId });
      const first = await derivedOf(workoutId);

      expect(first.map((row) => [row.activityKind, row.source, row.durationSeconds, Number(row.distanceMeters)])).toEqual([
        ['walk', 'workout', 1800, 2500],
        ['cardio_any', 'workout', 1800, 2500],
        ['workout_any', 'workout', expect.any(Number), 0],
      ]);
      const workout = await client.workout.findUniqueOrThrow({ where: { id: workoutId } });
      expect(first.every((row) => row.occurredOn.getTime() === workout.date.getTime() && row.userId === userId)).toBe(true);

      // Again, and concurrently from two processes: still one row per kind, same ids.
      await Promise.all([a.sync.syncWorkout(userId, workoutId), b.sync.syncWorkout(userId, workoutId)]);
      await a.sync.reconcileRecent(userId, await a.checkIns.today(userId));
      expect((await derivedOf(workoutId)).map((row) => row.id)).toEqual(first.map((row) => row.id));
    });

    it('counts toward a walk goal, and a manual "I did it" the same day stays one session', async () => {
      const userId = await makeUser('credit-goal');
      const goal = await a.goals.create(userId, { title: 'Walks', activityKind: 'walk', metric: 'sessions', target: 4, period: 'week' });
      await a.entries.create(userId, createActivityEntrySchema.parse({ activityKind: 'walk' }));
      await finishedWalk(userId);

      // No listener here: the progress read reconciles the finished workout itself.
      const [progress] = await a.progress.progressForUser(userId);
      expect(progress.goalId).toBe(goal.id);
      expect(progress.done).toBe(1);
      expect(progress.entries.map((entry) => [entry.source, entry.superseded]).sort()).toEqual([
        ['manual', true],
        ['workout', false],
      ]);
    });

    it('follows edits to a completed workout and drops its entries when it is no longer completed', async () => {
      const userId = await makeUser('credit-edit');
      const { workoutId, setId } = await finishedWalk(userId);
      await a.sync.syncWorkout(userId, workoutId);

      await client.setLog.update({ where: { id: setId }, data: { durationSeconds: 2400 } });
      await a.sync.reconcileRecent(userId, await a.checkIns.today(userId));
      const walk = await client.activityEntry.findFirstOrThrow({ where: { workoutId, activityKind: 'walk' } });
      expect(walk.durationSeconds).toBe(2400);

      await client.workout.update({ where: { id: workoutId }, data: { status: 'in_progress' } });
      await a.sync.reconcileRecent(userId, await a.checkIns.today(userId));
      expect(await derivedOf(workoutId)).toEqual([]);
    });

    it('cascades the entries when the workout is deleted', async () => {
      const userId = await makeUser('credit-delete');
      const { workoutId } = await finishedWalk(userId);
      await a.sync.syncWorkout(userId, workoutId);
      expect((await derivedOf(workoutId)).length).toBe(3);

      await a.workouts.remove(userId, workoutId);
      expect(await client.activityEntry.count({ where: { userId } })).toBe(0);
    });

    it('refuses a second row for the same workout and kind (the partial unique index)', async () => {
      const userId = await makeUser('credit-index');
      const { workoutId } = await finishedWalk(userId);
      await a.sync.syncWorkout(userId, workoutId);

      await expect(
        client.activityEntry.create({
          data: { userId, occurredOn: new Date(), activityKind: 'walk', source: 'workout', workoutId },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  // ---------------------------------------------------------------------------
  // Precedence and the backdating window
  // ---------------------------------------------------------------------------

  it('steps: an imported 8200 supersedes a manual 6000 on the same day', async () => {
    const userId = await makeUser('precedence');
    await a.goals.create(userId, { title: 'Steps', activityKind: 'walk', metric: 'steps', target: 8000, period: 'day' });
    const today = await a.checkIns.today(userId);
    await a.entries.create(userId, createActivityEntrySchema.parse({ activityKind: 'steps', steps: 6000 }));
    await client.activityEntry.create({
      data: { userId, occurredOn: toDbDate(today), activityKind: 'steps', steps: 8200, source: 'integration', provider: 'x', externalId: today },
    });

    const [progress] = await a.progress.progressForUser(userId);
    expect(progress).toMatchObject({ done: 8200, hit: true, daysLeft: 1 });
    expect(progress.entries.find((entry) => entry.source === 'manual')?.superseded).toBe(true);
  });

  it('backdating: today-7 in the user\'s own time zone is accepted, today-8 refused', async () => {
    const userId = await makeUser('backdate');
    await client.healthProfile.create({ data: { userId, timeZone: 'Pacific/Kiritimati' } });
    const today = localDateInZone(new Date(), 'Pacific/Kiritimati');
    expect(await a.checkIns.today(userId)).toBe(today);

    const ok = await a.entries.create(userId, createActivityEntrySchema.parse({ activityKind: 'walk', occurredOn: addDays(today, -7) }));
    expect(ok.occurredOn).toBe(addDays(today, -7));

    await expect(
      a.entries.create(userId, createActivityEntrySchema.parse({ activityKind: 'walk', occurredOn: addDays(today, -8) })),
    ).rejects.toBeInstanceOf(BadRequestException);
    const refused = await a.entries
      .create(userId, createActivityEntrySchema.parse({ activityKind: 'walk', occurredOn: addDays(today, 1) }))
      .catch((error: BadRequestException) => error.getResponse());
    expect(refused).toMatchObject({ details: { reason: 'ENTRY_DATE_OUT_OF_RANGE' } });
  });

  it('caps active goals at 10 under concurrent creates', async () => {
    const userId = await makeUser('cap');
    const create = (stack: Stack, i: number) =>
      stack.goals
        .create(userId, { title: `G${i}`, activityKind: 'run', metric: 'sessions', target: 2, period: 'week' })
        .then(() => 'ok')
        .catch((error: { getStatus?: () => number }) => error.getStatus?.());

    const outcomes = await Promise.all(Array.from({ length: 12 }, (_, i) => create(i % 2 ? a : b, i)));
    expect(outcomes.filter((outcome) => outcome === 'ok')).toHaveLength(10);
    expect(outcomes.filter((outcome) => outcome === 409)).toHaveLength(2);
    expect(await client.activityGoal.count({ where: { userId, status: 'active' } })).toBe(10);
  });
});
