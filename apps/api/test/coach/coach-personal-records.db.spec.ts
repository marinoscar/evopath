// =============================================================================
// Real-Postgres test: the coach's `get_personal_records` tool (#338)
// =============================================================================
//
// What only a real server can prove: the tool's single raw SQL query
// ($queryRaw: a CTE, three `DISTINCT ON` branches and a stats branch joined by
// `UNION ALL`) actually executes against the real schema (table and column
// names, the `::uuid` cast, `NULL::numeric` / `NULL::bigint` column typing,
// `ORDER BY 7`), and returns the right record per exercise. A mocked
// `$queryRaw` proves none of that. Also proves the working-set rule (completed,
// not a warm-up, reps >= 1, weighted or bodyweight), the completed-workout
// rule, the tracking-mode rule, the tie-breaks, and the `w.user_id` scope.
//
// `safely()` turns any thrown SQL error into the `unavailable` answer, so every
// assertion first rules that answer out.
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import type { PrismaService } from '../../src/prisma/prisma.service';
import type { CoachChatToolDeps } from '../../src/coach/chat/tools/coach-chat-tool.types';
import { createGetPersonalRecordsTool } from '../../src/coach/chat/tools/get-personal-records.tool';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('coach-personal-records.db.spec');

interface SetSeed {
  weightKg: string | null;
  reps: number | null;
  completed?: boolean;
  isWarmup?: boolean;
}

describeWithDb('coach get_personal_records (real Postgres)', () => {
  let client: PrismaClient;
  let tool: ReturnType<typeof createGetPersonalRecordsTool>;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const exerciseIds: string[] = [];
  let bench: string;
  let squat: string;
  let pullUp: string;
  let plank: string;

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({ data: { email: `pr-${label}-${run}@example.com` }, select: { id: true } });
    userIds.push(user.id);
    return user.id;
  }

  async function makeExercise(label: string, trackingMode: string): Promise<string> {
    const exercise = await client.exercise.create({
      data: {
        slug: `pr-${run}-${label}`,
        name: `PR ${label} ${run}`,
        primaryMuscles: ['chest'],
        movementPattern: 'horizontal_push',
        trackingMode,
      },
      select: { id: true },
    });
    exerciseIds.push(exercise.id);
    return exercise.id;
  }

  /** One workout of `status` on `date` holding one block per `[exerciseId, sets]`. */
  async function workout(
    userId: string,
    date: string,
    blocks: Array<[string, SetSeed[]]>,
    status: 'completed' | 'in_progress' = 'completed',
  ): Promise<void> {
    await client.workout.create({
      data: {
        userId,
        name: 'Session',
        date: new Date(`${date}T00:00:00.000Z`),
        status,
        startedAt: new Date(`${date}T10:00:00.000Z`),
        endedAt: status === 'completed' ? new Date(`${date}T11:00:00.000Z`) : null,
        exercises: {
          create: blocks.map(([exerciseId, sets], position) => ({
            exerciseId,
            position,
            sets: {
              create: sets.map((set, index) => ({
                setNumber: index + 1,
                weightKg: set.weightKg,
                reps: set.reps,
                completed: set.completed ?? true,
                isWarmup: set.isWarmup ?? false,
              })),
            },
          })),
        },
      },
    });
  }

  async function recordsOf(userId: string) {
    const result = (await tool.execute({}, { userId } as never)) as any;
    expect(result).not.toEqual(expect.objectContaining({ error: expect.anything() }));
    expect(Array.isArray(result.records)).toBe(true);
    return result as { count: number; records: Array<Record<string, any>> };
  }

  beforeAll(async () => {
    client = createDbClient();
    tool = createGetPersonalRecordsTool({ prisma: client as unknown as PrismaService } as unknown as CoachChatToolDeps);
    bench = await makeExercise('bench', 'weight_reps');
    squat = await makeExercise('squat', 'weight_reps');
    pullUp = await makeExercise('pullup', 'bodyweight_reps');
    plank = await makeExercise('plank', 'time');
  });

  afterAll(async () => {
    await client.workout.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.exercise.deleteMany({ where: { id: { in: exerciseIds } } });
    await client.$disconnect();
  });

  it('returns the right records per exercise, strongest e1RM first, and ignores everything that is not a working set', async () => {
    const userId = await makeUser('main');
    const other = await makeUser('other');

    await workout(userId, '2026-09-01', [
      [
        bench,
        [
          { weightKg: '60', reps: 10 },
          { weightKg: '100', reps: 3, isWarmup: true }, // warm-up: excluded
          { weightKg: '80', reps: 5 },
          { weightKg: '90', reps: 2, completed: false }, // incomplete: excluded
          { weightKg: null, reps: 20 }, // weighted exercise without a weight: excluded
          { weightKg: '70', reps: 0 }, // zero reps: excluded
        ],
      ],
      [squat, [{ weightKg: '100', reps: 5 }]],
      [
        pullUp,
        [
          { weightKg: null, reps: 12 },
          { weightKg: null, reps: 8 },
          { weightKg: null, reps: 15, completed: false }, // incomplete: excluded
        ],
      ],
      [plank, [{ weightKg: '5', reps: 10 }]], // time exercise: excluded entirely
    ]);
    await workout(userId, '2026-09-08', [
      [bench, [{ weightKg: '80', reps: 8 }]],
      [
        squat,
        [
          { weightKg: '120', reps: 1 },
          { weightKg: '20', reps: 13 }, // above the e1RM rep ceiling: counts for max reps only
        ],
      ],
      [pullUp, [{ weightKg: '10', reps: 6 }]],
    ]);
    // An in-progress workout never counts, however heavy.
    await workout(userId, '2026-09-15', [[bench, [{ weightKg: '200', reps: 5 }]]], 'in_progress');
    // Another user's heavier lifts on the same library exercises never leak in.
    await workout(other, '2026-09-10', [
      [bench, [{ weightKg: '150', reps: 5 }]],
      [squat, [{ weightKg: '250', reps: 3 }]],
    ]);

    const result = await recordsOf(userId);

    expect(result.count).toBe(3);
    expect(result.records.map((record) => record.name)).toEqual([`PR squat ${run}`, `PR bench ${run}`, `PR pullup ${run}`]);

    const [squatRecord, benchRecord, pullUpRecord] = result.records;

    // Squat: 120x1 is the heaviest and the best e1RM (reps = 1 -> the weight itself);
    // 20x13 is the most reps (and is not an e1RM candidate: over 12 reps).
    expect(squatRecord).toEqual({
      name: `PR squat ${run}`,
      maxWeight: { kg: 120, reps: 1, date: '2026-09-08' },
      maxReps: { reps: 13, kg: 20, date: '2026-09-08' },
      bestE1rm: { kg: 120, fromKg: 120, fromReps: 1, date: '2026-09-08' },
      sessions: 2,
      workingSets: 3,
      lastDone: '2026-09-08',
    });

    // Bench: 80 kg is hit twice; the tie goes to more reps (8 over 5). Most reps is
    // 60x10. Best e1RM is 80x8 = 80 * (1 + 8/30) = 101.3.
    expect(benchRecord).toEqual({
      name: `PR bench ${run}`,
      maxWeight: { kg: 80, reps: 8, date: '2026-09-08' },
      maxReps: { reps: 10, kg: 60, date: '2026-09-01' },
      bestE1rm: { kg: 101.3, fromKg: 80, fromReps: 8, date: '2026-09-08' },
      sessions: 2,
      workingSets: 3,
      lastDone: '2026-09-08',
    });

    // Pull-up: unweighted sets count as 0 kg (so a bodyweight exercise has records
    // without a weight); the weighted 10x6 gives the only e1RM = 10 * (1 + 6/30) = 12.
    expect(pullUpRecord).toEqual({
      name: `PR pullup ${run}`,
      maxWeight: { kg: 10, reps: 6, date: '2026-09-08' },
      maxReps: { reps: 12, kg: 0, date: '2026-09-01' },
      bestE1rm: { kg: 12, fromKg: 10, fromReps: 6, date: '2026-09-08' },
      sessions: 2,
      workingSets: 3,
      lastDone: '2026-09-08',
    });
  });

  it('answers a bodyweight-only exercise with no e1RM (null) and still counts it', async () => {
    const userId = await makeUser('bodyweight');
    await workout(userId, '2026-09-02', [[pullUp, [{ weightKg: null, reps: 9 }, { weightKg: null, reps: 11 }]]]);

    const result = await recordsOf(userId);

    expect(result.count).toBe(1);
    expect(result.records[0]).toEqual({
      name: `PR pullup ${run}`,
      maxWeight: { kg: 0, reps: 11, date: '2026-09-02' },
      maxReps: { reps: 11, kg: 0, date: '2026-09-02' },
      bestE1rm: null,
      sessions: 1,
      workingSets: 2,
      lastDone: '2026-09-02',
    });
  });

  it('scopes to the caller: another user sees only their own records, and a user with no workouts sees none', async () => {
    const mine = await makeUser('scope-a');
    const theirs = await makeUser('scope-b');
    const empty = await makeUser('scope-empty');
    await workout(mine, '2026-09-03', [[bench, [{ weightKg: '100', reps: 3 }]]]);
    await workout(theirs, '2026-09-04', [[squat, [{ weightKg: '140', reps: 2 }]]]);

    const mineResult = await recordsOf(mine);
    expect(mineResult.records.map((record) => record.name)).toEqual([`PR bench ${run}`]);
    expect(mineResult.records[0].maxWeight).toEqual({ kg: 100, reps: 3, date: '2026-09-03' });

    const theirResult = await recordsOf(theirs);
    expect(theirResult.records.map((record) => record.name)).toEqual([`PR squat ${run}`]);
    expect(theirResult.records[0].maxWeight).toEqual({ kg: 140, reps: 2, date: '2026-09-04' });

    expect(await recordsOf(empty)).toMatchObject({ count: 0, records: [] });
  });

  it('breaks an equal-weight, equal-reps tie toward the earliest date', async () => {
    const userId = await makeUser('tie');
    await workout(userId, '2026-09-20', [[bench, [{ weightKg: '90', reps: 4 }]]]);
    await workout(userId, '2026-09-05', [[bench, [{ weightKg: '90', reps: 4 }]]]);

    const { records } = await recordsOf(userId);

    expect(records).toHaveLength(1);
    expect(records[0].maxWeight.date).toBe('2026-09-05');
    expect(records[0].maxReps.date).toBe('2026-09-05');
    expect(records[0].bestE1rm.date).toBe('2026-09-05');
    expect(records[0]).toMatchObject({ sessions: 2, workingSets: 2, lastDone: '2026-09-20' });
  });
});
