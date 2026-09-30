// =============================================================================
// Quick workout adaptation: apply on the real database, the hard cases (E6.1)
// =============================================================================
//
// What a mocked Prisma cannot prove:
//
//   - `workouts_user_in_progress_uniq_idx` (one in-progress workout per user):
//     `apply/workout` on top of one is `409 WORKOUT_IN_PROGRESS` with its id,
//     rolls the WHOLE transaction back (no workout, no program session, the
//     adaptation still `ready`), and works once the other is finished.
//   - two applies at once (a double tap, two tabs) create ONE workout or ONE
//     plan version, and the loser gets the winner's answer or a clean 409.
//   - the staleness re-check reads REAL rows: an avoid-list edit, a pain flag
//     logged since, a plan that moved on.
//   - no base: an ad-hoc adaptation starts an unlinked workout and refuses
//     `apply/plan` with `ADAPTATION_NO_BASE`.
//   - loads are filled by the server from the plan or the last session, never
//     by the model.
//
// THIS IS A `*.db.spec.ts` FILE: skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { modelExercise } from '../../src/training-adaptation/testing/adaptation-fixtures';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';
import { type AdaptationDbRig, DB_NOW, createAdaptationDbRig, detailsOf, failure, reasonOf } from './adaptation-db.helper';

const { describeWithDb } = resolveDbSuite('adaptation-apply-edge.db.spec');

describeWithDb('quick workout adaptation: apply, the hard cases (real Postgres)', () => {
  let client: PrismaClient;
  let rig: AdaptationDbRig;

  beforeAll(async () => {
    client = createDbClient();
    rig = await createAdaptationDbRig(client);
  });

  afterAll(async () => {
    await rig.cleanup();
    await client.$disconnect();
  });

  const workoutsOf = (userId: string) => client.workout.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  const sessionsOf = (userId: string) => client.programSession.count({ where: { userId } });
  const versionOf = async (programId: string) => (await client.program.findUniqueOrThrow({ where: { id: programId } })).currentVersion;
  const rowOf = (id: string) => client.workoutAdaptation.findUniqueOrThrow({ where: { id } });

  describe('the in-progress workout index', () => {
    it('another in-progress workout: 409 WORKOUT_IN_PROGRESS with its id; nothing is written; it works once that one is finished', async () => {
      const user = await rig.user();
      const { adaptationId } = await rig.readyAdaptation(user.id);
      const other = await client.workout.create({
        data: { userId: user.id, name: 'Free session', date: new Date('2026-09-30'), status: 'in_progress', startedAt: new Date('2026-09-30T10:00:00.000Z') },
        select: { id: true },
      });

      const error = await failure(rig.service.applyWorkout(user.id, adaptationId, DB_NOW));

      expect(error.getStatus()).toBe(409);
      expect(detailsOf(error)).toEqual({ reason: 'WORKOUT_IN_PROGRESS', workoutId: other.id });
      // The whole transaction rolled back: still exactly the one workout, no session row, the adaptation unclaimed.
      expect((await workoutsOf(user.id)).map((w) => w.id)).toEqual([other.id]);
      expect(await sessionsOf(user.id)).toBe(0);
      expect(await rowOf(adaptationId)).toMatchObject({ status: 'ready', appliedAs: null, appliedWorkoutId: null, appliedAt: null });

      await client.workout.update({ where: { id: other.id }, data: { status: 'completed', endedAt: DB_NOW } });
      const result = await rig.service.applyWorkout(user.id, adaptationId, DB_NOW);

      expect(result).toMatchObject({ linkedToPlan: true });
      expect(await client.workout.count({ where: { userId: user.id, status: 'in_progress' } })).toBe(1);
      expect(await rowOf(adaptationId)).toMatchObject({ status: 'applied', appliedAs: 'one_off', appliedWorkoutId: result.workoutId });
    });

    it('only the caller\'s own in-progress workout blocks: another user\'s does not', async () => {
      const a = await rig.user();
      const b = await rig.user();
      await client.workout.create({ data: { userId: b.id, name: 'Theirs', date: new Date('2026-09-30'), status: 'in_progress', startedAt: DB_NOW } });
      const { adaptationId } = await rig.readyAdaptation(a.id);

      await expect(rig.service.applyWorkout(a.id, adaptationId, DB_NOW)).resolves.toMatchObject({ linkedToPlan: true });
    });
  });

  describe('two applies at once', () => {
    it('apply/workout twice in parallel: ONE workout and ONE program session, and BOTH callers get that workout (idempotent, not "another workout is in progress")', async () => {
      const user = await rig.user();
      const { adaptationId } = await rig.readyAdaptation(user.id);

      const [first, second] = await Promise.all([rig.service.applyWorkout(user.id, adaptationId, DB_NOW), rig.service.applyWorkout(user.id, adaptationId, DB_NOW)]);

      expect(second).toEqual(first);
      expect((await workoutsOf(user.id)).map((w) => w.id)).toEqual([first.workoutId]);
      expect(await sessionsOf(user.id)).toBe(1);
      expect(await rowOf(adaptationId)).toMatchObject({ status: 'applied', appliedAs: 'one_off', appliedWorkoutId: first.workoutId });
    });

    it('apply/plan twice in parallel: ONE new plan version, and both callers get its result', async () => {
      const user = await rig.user();
      const { adaptationId } = await rig.readyAdaptation(user.id);

      const results = await Promise.allSettled([rig.service.applyPlan(user.id, adaptationId, DB_NOW), rig.service.applyPlan(user.id, adaptationId, DB_NOW)]);

      expect(await versionOf(user.programId!)).toBe(2);
      expect(await client.programVersion.count({ where: { programId: user.programId! } })).toBe(2);
      const row = await rowOf(adaptationId);
      expect(row).toMatchObject({ status: 'applied', appliedAs: 'plan_change' });
      for (const result of results) {
        if (result.status === 'fulfilled') expect(result.value.planVersionId).toBe(row.appliedPlanVersionId);
        else expect((result.reason as { getStatus(): number }).getStatus()).toBe(409);
      }
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    });

    it('apply/workout and apply/plan in parallel: exactly one mode wins, and only its effect exists', async () => {
      const user = await rig.user();
      const { adaptationId } = await rig.readyAdaptation(user.id);

      const [workout, plan] = await Promise.allSettled([rig.service.applyWorkout(user.id, adaptationId, DB_NOW), rig.service.applyPlan(user.id, adaptationId, DB_NOW)]);

      const row = await rowOf(adaptationId);
      expect(row.status).toBe('applied');
      if (row.appliedAs === 'one_off') {
        expect(workout.status).toBe('fulfilled');
        expect(await versionOf(user.programId!)).toBe(1);
        expect((await workoutsOf(user.id)).length).toBe(1);
      } else {
        expect(plan.status).toBe('fulfilled');
        expect(await versionOf(user.programId!)).toBe(2);
        expect((await workoutsOf(user.id)).length).toBe(0);
      }
      const loser = row.appliedAs === 'one_off' ? plan : workout;
      expect(loser.status).toBe('rejected');
      expect(reasonOf((loser as PromiseRejectedResult).reason)).toBe('ADAPTATION_ALREADY_APPLIED');
    });
  });

  describe('no base (a rest day, no plan, or a fresh session)', () => {
    it('with no active plan an ad-hoc adaptation starts an UNLINKED workout; apply/plan is 409 ADAPTATION_NO_BASE', async () => {
      const user = await rig.user(false);
      const { adaptationId, programWorkoutId } = await rig.readyAdaptation(user.id, {
        request: { minutes: 30, baseWorkout: 'none' },
        answer: [modelExercise(rig.slugs[0], { source: 'added', isPriority: true, sets: 3 }), modelExercise(rig.slugs[1], { source: 'added', sets: 3 })],
      });
      expect(programWorkoutId).toBeNull();
      expect((await rowOf(adaptationId)).baseRef).toBeNull();

      const refused = await failure(rig.service.applyPlan(user.id, adaptationId, DB_NOW));
      expect(refused.getStatus()).toBe(409);
      expect(detailsOf(refused)).toEqual({ reason: 'ADAPTATION_NO_BASE' });
      expect((await rowOf(adaptationId)).status).toBe('ready');

      const result = await rig.service.applyWorkout(user.id, adaptationId, DB_NOW);

      expect(result).toEqual({ workoutId: expect.any(String), linkedToPlan: false, planChanged: false });
      const [workout] = await workoutsOf(user.id);
      expect(workout).toMatchObject({ status: 'in_progress', programWorkoutId: null });
      expect(workout.notes).toBe('Adapted: 30 min');
      expect(await sessionsOf(user.id)).toBe(0);
    });

    it('with a plan but a fresh session requested (baseWorkout: none), the plan is neither linked nor changed', async () => {
      const user = await rig.user();
      const { adaptationId } = await rig.readyAdaptation(user.id, {
        request: { minutes: 30, baseWorkout: 'none' },
        answer: [modelExercise(rig.slugs[1], { source: 'added', isPriority: true, sets: 3 })],
      });

      const result = await rig.service.applyWorkout(user.id, adaptationId, DB_NOW);

      expect(result.linkedToPlan).toBe(false);
      expect(await sessionsOf(user.id)).toBe(0);
      expect(await versionOf(user.programId!)).toBe(1);
    });
  });

  describe('staleness reads real rows', () => {
    it('an exercise added to the avoid list since is 409 ADAPTATION_STALE (pain_flagged); nothing is written', async () => {
      const user = await rig.user();
      const { adaptationId } = await rig.readyAdaptation(user.id);
      await client.program.update({ where: { id: user.programId! }, data: { intake: { experience: 'intermediate', avoidExerciseKeys: [rig.slugs[1]], limitations: [] } } });

      const error = await failure(rig.service.applyWorkout(user.id, adaptationId, DB_NOW));

      expect(error.getStatus()).toBe(409);
      expect(detailsOf(error)).toMatchObject({ reason: 'ADAPTATION_STALE', findings: [{ code: 'pain_flagged', exerciseKey: rig.slugs[1] }] });
      expect(await workoutsOf(user.id)).toHaveLength(0);
      expect((await rowOf(adaptationId)).status).toBe('ready');
      expect(reasonOf(await failure(rig.service.applyPlan(user.id, adaptationId, DB_NOW)))).toBe('ADAPTATION_STALE');
      expect(await versionOf(user.programId!)).toBe(1);
    });

    it('a pain flag logged since (the last 28 days) is 409 ADAPTATION_STALE on both routes', async () => {
      const user = await rig.user();
      const { adaptationId } = await rig.readyAdaptation(user.id);
      await rig.loggedWorkout(user.id, 1, { daysAgo: 2, painFlag: true });

      for (const call of [() => rig.service.applyWorkout(user.id, adaptationId, DB_NOW), () => rig.service.applyPlan(user.id, adaptationId, DB_NOW)]) {
        const error = await failure(call());
        expect(detailsOf(error)).toMatchObject({ reason: 'ADAPTATION_STALE', findings: [{ code: 'pain_flagged', exerciseKey: rig.slugs[1] }] });
      }
      expect((await rowOf(adaptationId)).status).toBe('ready');
    });

    it('a pain flag older than 28 days does not make it stale', async () => {
      const user = await rig.user();
      const { adaptationId } = await rig.readyAdaptation(user.id);
      await rig.loggedWorkout(user.id, 1, { daysAgo: 40, painFlag: true });

      await expect(rig.service.applyWorkout(user.id, adaptationId, DB_NOW)).resolves.toMatchObject({ linkedToPlan: true });
    });

    it('a plan that moved on: a second adaptation of the same base is STALE for apply/plan, but "today only" is still allowed (planChanged)', async () => {
      const user = await rig.user();
      const first = await rig.readyAdaptation(user.id);
      const second = await rig.readyAdaptation(user.id, { request: { minutes: 45, lowEnergy: true } });
      await rig.service.applyPlan(user.id, first.adaptationId, DB_NOW);
      expect(await versionOf(user.programId!)).toBe(2);

      const stale = await failure(rig.service.applyPlan(user.id, second.adaptationId, DB_NOW));

      expect(detailsOf(stale)).toMatchObject({ reason: 'ADAPTATION_STALE', findings: [{ code: 'plan_changed' }] });
      expect(await versionOf(user.programId!)).toBe(2);
      expect((await rowOf(second.adaptationId)).status).toBe('ready');
      const result = await rig.service.applyWorkout(user.id, second.adaptationId, DB_NOW);
      expect(result).toMatchObject({ planChanged: true });
    });

    it('a planned workout removed from the plan since: a one-off starts unlinked instead of failing', async () => {
      const user = await rig.user();
      const { adaptationId, programWorkoutId } = await rig.readyAdaptation(user.id);
      await client.programWorkout.update({ where: { id: programWorkoutId! }, data: { archivedAt: DB_NOW } });

      const result = await rig.service.applyWorkout(user.id, adaptationId, DB_NOW);

      expect(result.linkedToPlan).toBe(false);
      expect((await workoutsOf(user.id))[0].programWorkoutId).toBeNull();
    });
  });

  describe('loads are the server\'s, never the model\'s', () => {
    const weights = async (workoutId: string) => {
      const workout = await client.workout.findUniqueOrThrow({
        where: { id: workoutId },
        include: { exercises: { orderBy: { position: 'asc' }, include: { sets: { orderBy: { setNumber: 'asc' } } } } },
      });
      return workout.exercises.map((e) => e.sets.map((s) => (s.weightKg === null ? null : Number(s.weightKg))));
    };

    it('a kept "fixed" lift keeps the plan load; a "from history" lift starts from the last session\'s top set; blank when there is none', async () => {
      const withHistory = await rig.user();
      await rig.loggedWorkout(withHistory.id, 1, { weightKg: 55, reps: 8, daysAgo: 4 });
      const a = await rig.readyAdaptation(withHistory.id);
      const first = await rig.service.applyWorkout(withHistory.id, a.adaptationId, DB_NOW);
      expect(await weights(first.workoutId)).toEqual([[60, 60, 60], [55, 55, 55]]);

      const noHistory = await rig.user();
      const b = await rig.readyAdaptation(noHistory.id);
      const second = await rig.service.applyWorkout(noHistory.id, b.adaptationId, DB_NOW);
      expect(await weights(second.workoutId)).toEqual([[60, 60, 60], [null, null, null]]);
    });

    it('more reps than planned drops the prefilled load (never escalate): the lifter chooses', async () => {
      const user = await rig.user();
      const { adaptationId } = await rig.readyAdaptation(user.id, {
        answer: [modelExercise(rig.slugs[0], { isPriority: true, sets: 3, repMin: 8, repMax: 10 }), modelExercise(rig.slugs[1], { sets: 3, repMin: 6, repMax: 10 })],
      });

      const result = await rig.service.applyWorkout(user.id, adaptationId, DB_NOW);

      expect((await weights(result.workoutId))[0]).toEqual([null, null, null]);
    });

    it('a swapped-in exercise never inherits the replaced lift\'s load', async () => {
      const user = await rig.user();
      const { adaptationId } = await rig.readyAdaptation(user.id, {
        answer: [modelExercise(rig.slugs[2], { source: 'swapped', replacesExerciseKey: rig.slugs[0], isPriority: true, sets: 3 })],
      });

      const result = await rig.service.applyWorkout(user.id, adaptationId, DB_NOW);

      expect(await weights(result.workoutId)).toEqual([[null, null, null]]);
    });
  });

  describe('ownership on real rows', () => {
    it('another user\'s adaptation is a 404 for apply, and nothing of it changes', async () => {
      const owner = await rig.user();
      const intruder = await rig.user();
      const { adaptationId } = await rig.readyAdaptation(owner.id);

      expect((await failure(rig.service.applyWorkout(intruder.id, adaptationId, DB_NOW))).getStatus()).toBe(404);
      expect((await failure(rig.service.applyPlan(intruder.id, adaptationId, DB_NOW))).getStatus()).toBe(404);
      expect((await failure(rig.service.applyWorkout(intruder.id, randomUUID(), DB_NOW))).getStatus()).toBe(404);

      expect(await rowOf(adaptationId)).toMatchObject({ status: 'ready', appliedAs: null });
      expect(await workoutsOf(intruder.id)).toHaveLength(0);
      expect(await workoutsOf(owner.id)).toHaveLength(0);
    });
  });
});
