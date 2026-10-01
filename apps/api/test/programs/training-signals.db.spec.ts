// =============================================================================
// Real-Postgres test: the plan signals loader and service (E5.9)
// =============================================================================
//
// What only a real server can prove: the loader's queries return the right
// rows for a seeded plan (sessions linked by `program_sessions` and by
// `workouts.program_workout_id`, ad-hoc work, warm-ups, pain flags, check-ins,
// weights, PR history before the range); nothing of another user leaks in and
// another user's program is a 404; the set-row cap moves `from` forward; the
// workouts query can use the `workouts(user_id, date desc)` index; and a
// 26-week history is computed within the time budget.
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { CheckInsService } from '../../src/check-ins/check-ins.service';
import { addDays } from '../../src/check-ins/local-date';
import { HealthProfileService } from '../../src/health-profile/health-profile.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { PlanTree } from '../../src/programs/contracts/plan-tree.contract';
import { ProgramsService } from '../../src/programs/programs.service';
import { SignalsLoader } from '../../src/programs/signals/signals.loader';
import { TrainingSignalsService } from '../../src/programs/signals/signals.service';
import { WorkoutHistoryService } from '../../src/workouts/workout-history.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('training-signals.db.spec');

// Monday 2026-08-31 start; signals as of Monday 2026-09-28 (UTC, no time zone).
const START = '2026-08-31';
const AS_OF = '2026-09-28';
const START_NOW = new Date('2026-08-31T12:00:00.000Z');
const NOW = new Date('2026-09-28T12:00:00.000Z');
const RANGE = { from: '2026-08-31', to: '2026-09-27' };

/** The time budget for a 26-week signals read (generous for a CI runner). */
const BUDGET_MS = 3000;

describeWithDb('training signals (real Postgres)', () => {
  let client: PrismaClient;
  let programs: ProgramsService;
  let loader: SignalsLoader;
  let signals: TrainingSignalsService;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const exerciseIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({ data: { email: `signals-${label}-${run}@example.com` }, select: { id: true } });
    userIds.push(user.id);
    return user.id;
  }

  async function makeExercise(label: string, primaryMuscles: string[], trackingMode = 'weight_reps'): Promise<string> {
    const exercise = await client.exercise.create({
      data: { slug: `signals-${run}-${label}`, name: `Signals ${label}`, primaryMuscles, movementPattern: 'squat', trackingMode },
      select: { id: true },
    });
    exerciseIds.push(exercise.id);
    return exercise.id;
  }

  function tree(weeks: number, perDay: string[]): PlanTree {
    return {
      blocks: [
        {
          position: 0,
          name: 'Block',
          focus: null,
          rationale: null,
          weeks: Array.from({ length: weeks }, (_, index) => ({
            weekNumber: index + 1,
            isDeload: false,
            workouts: [1, 3, 5].map((weekday, position) => ({
              position,
              weekday,
              name: `W${index + 1} D${weekday}`,
              estimatedMinutes: 45,
              rationale: null,
              exercises: perDay.map((exerciseId, slot) => ({
                exerciseId,
                position: slot,
                isPriority: false,
                targetSets: 3,
                repMin: 5,
                repMax: 8,
                targetDurationSeconds: null,
                targetDistanceMeters: null,
                targetLoadKg: null,
                targetRpe: null,
                restSeconds: 120,
                loadGuidance: 'choose_start' as const,
                rationale: null,
                evidenceRefs: [],
                notes: null,
                equipmentTypeId: null,
              })),
            })),
          })),
        },
      ],
    };
  }

  async function activePlan(userId: string, weeks: number, perDay: string[], start = START, now = START_NOW) {
    const { programId } = await programs.createWithTree({
      userId,
      header: { name: 'Plan', goal: 'strength', source: 'manual' },
      tree: tree(weeks, perDay),
      origin: 'initial',
      actor: 'user',
      summary: 'Created by you',
    });
    await programs.activate(userId, programId, start, now);
    const rows = await client.programWorkout.findMany({
      where: { week: { programId } },
      select: { id: true, weekday: true, week: { select: { weekNumber: true } } },
    });
    const id = (week: number, weekday: number) => rows.find((row) => row.week.weekNumber === week && row.weekday === weekday)!.id;
    return { programId, id };
  }

  interface SetSpec {
    weightKg?: string | null;
    reps?: number | null;
    completed?: boolean;
    isWarmup?: boolean;
    rpe?: string | null;
    painFlag?: boolean;
    painNote?: string | null;
  }

  async function logWorkout(
    userId: string,
    date: string,
    entries: Array<{ exerciseId: string; sets: SetSpec[] }>,
    link: { programId?: string; programWorkoutId?: string; session?: boolean; status?: string } = {},
  ): Promise<string> {
    const workout = await client.workout.create({
      data: {
        userId,
        name: 'Logged',
        date: new Date(`${date}T00:00:00.000Z`),
        status: link.status ?? 'completed',
        startedAt: new Date(`${date}T17:00:00.000Z`),
        endedAt: link.status === 'in_progress' ? null : new Date(`${date}T18:00:00.000Z`),
        programWorkoutId: link.programWorkoutId ?? null,
        exercises: {
          create: entries.map((entry, position) => ({
            exerciseId: entry.exerciseId,
            position,
            sets: {
              create: entry.sets.map((set, index) => ({
                setNumber: index + 1,
                weightKg: set.weightKg === undefined ? '100' : set.weightKg,
                reps: set.reps === undefined ? 5 : set.reps,
                completed: set.completed ?? true,
                isWarmup: set.isWarmup ?? false,
                rpe: set.rpe ?? null,
                painFlag: set.painFlag ?? false,
                painNote: set.painNote ?? null,
              })),
            },
          })),
        },
      },
      select: { id: true },
    });
    if (link.session && link.programId && link.programWorkoutId) {
      await client.programSession.create({
        data: {
          userId,
          programId: link.programId,
          programWorkoutId: link.programWorkoutId,
          workoutId: workout.id,
          versionNumber: 1,
          plannedSnapshot: [{ exerciseId: entries[0]?.exerciseId, sets: 3 }, { exerciseId: entries[1]?.exerciseId, sets: 3 }],
          plannedFor: new Date(`${date}T00:00:00.000Z`),
        },
      });
    }
    return workout.id;
  }

  const working = (count: number, weightKg: string, rpe: string | null = null): SetSpec[] =>
    Array.from({ length: count }, () => ({ weightKg, reps: 5, rpe }));

  async function measurement(userId: string, metricKey: string, value: number, date: string, unit: string) {
    await client.measurement.create({
      data: {
        userId,
        entryId: randomUUID(),
        metricKey,
        value,
        unit,
        measuredAt: new Date(`${date}T07:00:00.000Z`),
        localDate: new Date(`${date}T00:00:00.000Z`),
        notes: metricKey === 'energy' ? 'private note' : null,
      },
    });
  }

  beforeAll(async () => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    const checkIns = new CheckInsService(prisma, new HealthProfileService(prisma));
    programs = new ProgramsService(prisma);
    loader = new SignalsLoader(prisma, new WorkoutHistoryService(prisma, checkIns));
    signals = new TrainingSignalsService(prisma, checkIns, loader);
    await makeExercise('squat', ['quads', 'glutes']);
    await makeExercise('bench', ['chest']);
  });

  afterAll(async () => {
    await client.workout.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.exercise.deleteMany({ where: { id: { in: exerciseIds } } });
    await client.$disconnect();
  });

  it('loads and aggregates a seeded plan, scoped to its owner', async () => {
    const [squat, bench] = exerciseIds;
    const userId = await makeUser('owner');
    const otherId = await makeUser('other');
    const { programId, id } = await activePlan(userId, 4, [squat, bench]);

    // Heavier history before the range: squat earns no PR in range; bench does.
    await logWorkout(userId, '2026-08-20', [{ exerciseId: squat, sets: working(1, '200') }]);

    const done = (date: string, week: number, weekday: number, squatKg: string, session = true) =>
      logWorkout(
        userId,
        date,
        [
          { exerciseId: squat, sets: [{ weightKg: '60', isWarmup: true }, ...working(3, squatKg, '8')] },
          { exerciseId: bench, sets: working(3, '70', '8') },
        ],
        { programId, programWorkoutId: id(week, weekday), session },
      );
    await done('2026-08-31', 1, 1, '100');
    await done('2026-09-02', 1, 3, '100');
    await done('2026-09-04', 1, 5, '102.5');
    // Linked only through workouts.program_workout_id (no session row).
    await done('2026-09-07', 2, 1, '105', false);
    // 2026-09-09 skipped.
    await done('2026-09-11', 2, 5, '107.5');
    await logWorkout(userId, '2026-09-12', [{ exerciseId: bench, sets: working(3, '72.5') }]);
    await done('2026-09-14', 3, 1, '110');
    await done('2026-09-16', 3, 3, '110');
    // 2026-09-18 skipped.
    // Partial: 2 of 6 planned sets, one pain-flagged (with a note that must never surface).
    await logWorkout(
      userId,
      '2026-09-21',
      [
        { exerciseId: squat, sets: [{ weightKg: '112.5', reps: 5, painFlag: true, painNote: 'sharp knee' }, { weightKg: '112.5', reps: 5 }] },
        { exerciseId: bench, sets: [{ weightKg: '75', reps: 8, completed: false }] },
      ],
      { programId, programWorkoutId: id(4, 1), session: true },
    );
    await done('2026-09-23', 4, 3, '112.5');
    // Friday of week 4 is in progress.
    await logWorkout(userId, '2026-09-25', [{ exerciseId: squat, sets: [{ completed: false }] }], {
      programId,
      programWorkoutId: id(4, 5),
      session: true,
      status: 'in_progress',
    });

    for (const [date, energy, sleep, soreness, stress] of [
      ['2026-09-26', 2, 3, 3, 3],
      ['2026-09-27', 3, 3, 4, 3],
      ['2026-09-28', 4, 4, 2, 2],
    ] as const) {
      await measurement(userId, 'energy', energy, date, 'score');
      await measurement(userId, 'sleep_quality', sleep, date, 'score');
      await measurement(userId, 'muscle_soreness', soreness, date, 'score');
      await measurement(userId, 'stress', stress, date, 'score');
    }
    await measurement(userId, 'weight', 82, '2026-09-07', 'kg');
    await measurement(userId, 'weight', 81.5, '2026-09-14', 'kg');
    await measurement(userId, 'weight', 81, '2026-09-21', 'kg');

    // The other user trains in the same range and checks in: none of it may leak.
    await logWorkout(otherId, '2026-09-10', [{ exerciseId: squat, sets: working(5, '300') }]);
    await measurement(otherId, 'energy', 1, '2026-09-28', 'score');
    await measurement(otherId, 'weight', 120, '2026-09-21', 'kg');

    const result = await signals.forUser(userId, { programId, ...RANGE, asOf: AS_OF }, NOW);

    expect(result).toMatchObject({ programId, planVersion: 1, range: RANGE, asOf: AS_OF, truncated: false, weeksInRange: 4 });
    expect(result.sessions.map((session) => [session.plannedFor, session.status])).toEqual([
      ['2026-08-31', 'done'],
      ['2026-09-02', 'done'],
      ['2026-09-04', 'done'],
      ['2026-09-07', 'done'],
      ['2026-09-09', 'missed'],
      ['2026-09-11', 'done'],
      ['2026-09-14', 'done'],
      ['2026-09-16', 'done'],
      ['2026-09-18', 'missed'],
      ['2026-09-21', 'partial'],
      ['2026-09-23', 'done'],
      ['2026-09-25', 'in_progress'],
    ]);
    expect(result.adherence.totals).toEqual({ planned: 12, completed: 9, partialSessions: 1, missed: 2, extra: 1, adherencePct: 75 });
    expect(result.frequency.perWeek.map((week) => week.sessions)).toEqual([3, 3, 2, 2]);

    const quads = result.volume.find((row) => row.muscle === 'quads')!;
    expect(quads.weeks.map((week) => [week.plannedSets, week.hardSets])).toEqual([
      [9, 9],
      [9, 6],
      [9, 6],
      [9, 5],
    ]);

    const bySlug = Object.fromEntries(result.performance.map((lift) => [lift.slug, lift]));
    expect(bySlug[`signals-${run}-squat`]).toMatchObject({ sessions: 9, prInRange: false, best: { weightKg: 112.5, reps: 5 } });
    expect(bySlug[`signals-${run}-bench`]).toMatchObject({ prInRange: true });

    expect(result.pain).toEqual([
      expect.objectContaining({ slug: `signals-${run}-squat`, lastFlaggedOn: '2026-09-21', flaggedSessions28d: 1, consecutiveFlaggedSessions: 0 }),
    ]);
    expect(result.readiness).toEqual({
      days: 3,
      avg: { energy: 3, sleepQuality: 3.33, soreness: 3, stress: 2.67 },
      lowDays: 2,
      lowStreak: 0,
    });
    expect(result.body.weightKg).toEqual({ latest: 81, changePerWeek: -0.5, points: 3 });

    const json = JSON.stringify(result);
    expect(json).not.toContain('sharp knee');
    expect(json).not.toContain('private note');
  });

  it('answers 404 for another user\'s program and empty signals without a program', async () => {
    const owner = await makeUser('owner404');
    const intruder = await makeUser('intruder');
    const { programId } = await activePlan(owner, 1, [exerciseIds[0]]);

    await expect(signals.forUser(intruder, { programId, asOf: AS_OF }, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(signals.forEvaluator(intruder, programId, NOW)).rejects.toBeInstanceOf(NotFoundException);

    const empty = await signals.forUser(intruder, {}, NOW);
    expect(empty).toMatchObject({ programId: null, sessions: [], performance: [], range: { from: '2026-08-10', to: AS_OF } });
  });

  it('forEvaluator covers the last 6 complete weeks plus the current one', async () => {
    const userId = await makeUser('evaluator');
    const { programId } = await activePlan(userId, 4, [exerciseIds[0]]);
    const result = await signals.forEvaluator(userId, programId, new Date('2026-09-30T12:00:00.000Z'));
    expect(result.range).toEqual({ from: '2026-08-17', to: '2026-09-30' });
    expect(result.weeksInRange).toBe(7);
    expect(result.adherence.weeks[6].partial).toBe(true);
  });

  it('moves `from` forward when the range holds more set rows than the cap', async () => {
    const userId = await makeUser('cap');
    for (const date of ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22']) {
      await logWorkout(userId, date, [{ exerciseId: exerciseIds[0], sets: working(4, '80') }]);
    }
    const input = await loader.load(userId, { program: null, ...RANGE, asOf: AS_OF, maxSetRows: 10 });
    expect(input.truncated).toBe(true);
    expect(input.range).toEqual({ from: '2026-09-09', to: RANGE.to });
    expect(input.workouts.map((row) => row.date)).toEqual(['2026-09-15', '2026-09-22']);

    const untouched = await loader.load(userId, { program: null, ...RANGE, asOf: AS_OF, maxSetRows: 16 });
    expect(untouched).toMatchObject({ truncated: false, range: RANGE });
  });

  it('the range query is index-backed, never a sequential scan of workouts', async () => {
    const userId = await makeUser('explain');
    const plan = await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN SELECT w."id" FROM "workouts" w
          WHERE w."user_id" = '${userId}'::uuid AND w."date" BETWEEN '2026-03-30'::date AND '2026-09-27'::date`,
      );
    });
    // With sequential scans priced out, the planner must find a user-leading
    // index (the (user_id, date) one or the (user_id, status) one); a table
    // this small makes the choice between them a coin toss.
    const text = plan.map((row) => row['QUERY PLAN']).join('\n');
    expect(text).toMatch(/using workouts_user_id_(date|status)_idx/);
    expect(text).not.toMatch(/Seq Scan on workouts/);
  });

  it(`computes 26 weeks of history within ${BUDGET_MS} ms`, async () => {
    const [squat, bench] = exerciseIds;
    const userId = await makeUser('long');
    const start = '2026-03-30';
    const { programId, id } = await activePlan(userId, 26, [squat, bench], start, new Date('2026-03-30T12:00:00.000Z'));

    for (let week = 1; week <= 26; week += 1) {
      for (const weekday of [1, 3, 5]) {
        const date = addDays(start, (week - 1) * 7 + weekday - 1);
        await logWorkout(
          userId,
          date,
          [
            { exerciseId: squat, sets: working(4, String(80 + week)) },
            { exerciseId: bench, sets: working(4, String(50 + week)) },
          ],
          { programId, programWorkoutId: id(week, weekday), session: true },
        );
      }
    }

    const started = performance.now();
    const result = await signals.forUser(userId, { programId, from: start, to: '2026-09-27', asOf: AS_OF }, NOW);
    const elapsed = performance.now() - started;

    expect(result.weeksInRange).toBe(26);
    expect(result.adherence.totals).toMatchObject({ planned: 78, completed: 78, missed: 0 });
    expect(result.performance.map((lift) => lift.sessions)).toEqual([78, 78]);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  }, 120_000);
});
