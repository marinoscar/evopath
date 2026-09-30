// =============================================================================
// Real-Postgres test: the ProgramsService chokepoint (E5.1)
// =============================================================================
//
// What only a real server can prove: two concurrent `applyChange` calls with
// the same `expectedVersion` produce exactly one version (the conditional
// `updateMany` row lock); a failure mid-way leaves tree and version untouched;
// history-preserving deletes against real `workouts` rows and restore by id;
// concurrent activation leaves exactly one active program (the partial unique
// index `programs_one_active_per_user_uniq_idx`, matched by name); cascade on
// user delete.
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { ConflictException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import type { PlanTree } from '../../src/programs/contracts/plan-tree.contract';
import { ProgramsService } from '../../src/programs/programs.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('programs.db.spec');

describeWithDb('ProgramsService chokepoint (real Postgres)', () => {
  let client: PrismaClient;
  let service: ProgramsService;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  let exerciseId: string;

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({ data: { email: `programs-svc-${label}-${run}@example.com` }, select: { id: true } });
    userIds.push(user.id);
    return user.id;
  }

  async function draft(userId: string) {
    return service.createWithTree({
      userId,
      header: { name: 'Plan', goal: 'strength', source: 'manual' },
      tree: { blocks: [{ position: 0, name: 'Block 1', weeks: [{ weekNumber: 1, workouts: [] }] }] },
      origin: 'initial',
      actor: 'user',
      summary: 'Created by you',
    });
  }

  const withWorkout = (weekday: number) => (tree: PlanTree): PlanTree => {
    tree.blocks[0].weeks[0].workouts.push({
      position: tree.blocks[0].weeks[0].workouts.length,
      weekday,
      name: `Day ${weekday}`,
      estimatedMinutes: 60,
      rationale: null,
      exercises: [
        {
          exerciseId,
          position: 0,
          isPriority: true,
          targetSets: 3,
          repMin: 5,
          repMax: 8,
          targetLoadKg: 62.5,
          targetRpe: 7.5,
          restSeconds: 150,
          loadGuidance: 'fixed',
          rationale: null,
          evidenceRefs: [],
          notes: null,
          equipmentTypeId: null,
        },
      ],
    });
    return tree;
  };

  const edit = (userId: string, programId: string, expectedVersion: number, mutate: (tree: PlanTree) => PlanTree) =>
    service.applyChange({
      userId,
      programId,
      expectedVersion,
      origin: 'manual_edit',
      actor: 'user',
      kind: 'edited',
      mutate,
      summary: 'Edited by you',
    });

  const counts = async (programId: string) => ({
    version: (await client.program.findUniqueOrThrow({ where: { id: programId } })).currentVersion,
    versions: await client.programVersion.count({ where: { programId } }),
    logs: await client.programChangeLog.count({ where: { programId } }),
    workouts: await client.programWorkout.count({ where: { week: { programId } } }),
  });

  beforeAll(async () => {
    client = createDbClient();
    service = new ProgramsService(client as never);
    const exercise = await client.exercise.create({
      data: { slug: `pgsvc-${run}`, name: `Chokepoint test ${run}`, primaryMuscles: ['chest'], movementPattern: 'horizontal_push' },
      select: { id: true },
    });
    exerciseId = exercise.id;
  });

  afterAll(async () => {
    await client.workout.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.exercise.deleteMany({ where: { id: exerciseId } });
    await client.$disconnect();
  });

  it('writes one version and one change-log row per change, with decimals and ids round-tripping', async () => {
    const userId = await makeUser('basic');
    const { programId } = await draft(userId);

    const result = await edit(userId, programId, 1, withWorkout(1));

    expect(result.versionNumber).toBe(2);
    expect(await counts(programId)).toEqual({ version: 2, versions: 2, logs: 2, workouts: 1 });
    const view = await service.get(userId, programId);
    const exercise = view.tree.blocks[0].weeks[0].workouts[0].exercises[0];
    expect(exercise).toMatchObject({ targetLoadKg: 62.5, targetRpe: 7.5, exerciseUnavailable: false });
    const version = await client.programVersion.findUniqueOrThrow({ where: { programId_versionNumber: { programId, versionNumber: 2 } } });
    expect((version.snapshot as any).tree.blocks[0].weeks[0].workouts[0].exercises[0].id).toBe(exercise.id);
  });

  it('two concurrent applyChange calls with the same expectedVersion produce exactly one version', async () => {
    const userId = await makeUser('race');
    const { programId } = await draft(userId);

    const results = await Promise.allSettled([edit(userId, programId, 1, withWorkout(1)), edit(userId, programId, 1, withWorkout(2))]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);
    expect(rejected[0].reason.getResponse()).toMatchObject({ details: { reason: 'TRAINING_STALE_PLAN', currentVersion: 2 } });
    expect(await counts(programId)).toEqual({ version: 2, versions: 2, logs: 2, workouts: 1 });
  });

  it('a failure mid-way leaves the tree, version and log untouched', async () => {
    const userId = await makeUser('rollback');
    const { programId } = await draft(userId);
    await edit(userId, programId, 1, withWorkout(1));
    const before = await counts(programId);

    // Passes the contract, then fails in the database: an exercise id that vanished.
    const missing = randomUUID();
    await expect(
      edit(userId, programId, 2, (tree) => {
        withWorkout(3)(tree).blocks[0].weeks[0].workouts[1].exercises[0].exerciseId = missing;
        return tree;
      }),
    ).rejects.toMatchObject({ response: { details: { reason: 'UNKNOWN_EXERCISES', exerciseIds: [missing] } } });
    await expect(edit(userId, programId, 2, () => { throw new Error('boom'); })).rejects.toThrow('boom');

    expect(await counts(programId)).toEqual(before);
  });

  it('archives a removed workout with a logged workout, never deletes it, and restores it by id', async () => {
    const userId = await makeUser('history');
    const { programId } = await draft(userId);
    await edit(userId, programId, 1, (tree) => withWorkout(3)(withWorkout(1)(tree)));
    const [kept, logged] = await client.programWorkout.findMany({ where: { week: { programId } }, orderBy: { position: 'asc' } });
    await client.workout.create({
      data: { userId, name: 'Logged', date: new Date('2026-09-30T00:00:00.000Z'), startedAt: new Date(), status: 'completed', programWorkoutId: logged.id },
    });

    // Remove every workout: the logged one is archived, the other deleted.
    await edit(userId, programId, 2, (tree) => {
      tree.blocks[0].weeks[0].workouts = [];
      return tree;
    });
    const rows = await client.programWorkout.findMany({ where: { week: { programId } } });
    expect(rows.map((row) => [row.id, row.archivedAt !== null])).toEqual([[logged.id, true]]);
    expect(rows.find((row) => row.id === kept.id)).toBeUndefined();
    expect((await service.get(userId, programId)).tree.blocks[0].weeks[0].workouts).toEqual([]);

    // Replace the whole block: the week and block holding the archived workout are archived too.
    await edit(userId, programId, 3, () => ({
      blocks: [{ position: 0, name: 'New', focus: null, rationale: null, weeks: [{ weekNumber: 1, isDeload: false, workouts: [] }] }],
    }));
    const week = await client.programWeek.findUniqueOrThrow({ where: { id: logged.weekId } });
    expect(week.archivedAt).not.toBeNull();
    expect((await client.programBlock.findUniqueOrThrow({ where: { id: week.blockId } })).archivedAt).not.toBeNull();

    // Restoring version 2 un-archives the same rows by id and re-creates the deleted one.
    const restored = await service.revert({ userId, programId, expectedVersion: 4, toVersion: 2 });
    expect(restored.versionNumber).toBe(5);
    const back = await client.programWorkout.findUniqueOrThrow({ where: { id: logged.id } });
    expect(back.archivedAt).toBeNull();
    expect((await client.programWeek.findUniqueOrThrow({ where: { id: logged.weekId } })).archivedAt).toBeNull();
    const view = await service.get(userId, programId);
    expect(view.tree.blocks.map((block) => block.id)).toEqual([week.blockId]);
    expect(view.tree.blocks[0].weeks[0].workouts.map((w) => w.id)).toEqual([kept.id, logged.id]);
    expect((await client.workout.findFirstOrThrow({ where: { userId } })).programWorkoutId).toBe(logged.id);

    await expect(service.remove(userId, programId)).rejects.toMatchObject({ response: { details: { reason: 'PROGRAM_HAS_HISTORY' } } });
  });

  it('revert by changeLogId: only the latest applied change, which becomes reverted', async () => {
    const userId = await makeUser('revert');
    const { programId } = await draft(userId);
    const v2 = await edit(userId, programId, 1, withWorkout(1));
    const v3 = await edit(userId, programId, 2, withWorkout(2));

    await expect(service.revert({ userId, programId, expectedVersion: 3, changeLogId: v2.changeLogId })).rejects.toMatchObject({
      response: { details: { reason: 'NOT_LATEST', latestLogId: v3.changeLogId } },
    });
    expect(await counts(programId)).toMatchObject({ version: 3, versions: 3 });

    const undone = await service.revert({ userId, programId, expectedVersion: 3, changeLogId: v3.changeLogId });
    expect(undone.versionNumber).toBe(4);
    expect((await client.programChangeLog.findUniqueOrThrow({ where: { id: v3.changeLogId } })).status).toBe('reverted');
    const latest = await client.programVersion.findUniqueOrThrow({ where: { programId_versionNumber: { programId, versionNumber: 4 } } });
    expect(latest.origin).toBe('revert');
    expect(await client.programWorkout.count({ where: { week: { programId } } })).toBe(1);
  });

  it('activating B while A is active pauses A; concurrent activations never leave two active', async () => {
    const userId = await makeUser('activate');
    const a = await draft(userId);
    const b = await draft(userId);
    const c = await draft(userId);
    for (const id of [a.programId, b.programId, c.programId]) await edit(userId, id, 1, withWorkout(1));
    const today = new Date().toISOString().slice(0, 10);

    await service.activate(userId, a.programId, today);
    await service.activate(userId, b.programId, today);
    const status = async (id: string) => (await client.program.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(a.programId)).toBe('paused');
    expect(await status(b.programId)).toBe('active');

    await service.pause(userId, b.programId);
    const results = await Promise.allSettled([
      service.activate(userId, a.programId, today),
      service.activate(userId, c.programId, today),
    ]);
    const active = await client.program.count({ where: { userId, status: 'active' } });
    expect(active).toBe(1);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason.getResponse()).toMatchObject({ details: { reason: 'ACTIVE_PROGRAM_CONFLICT' } });
      }
    }
  });

  it('deleting the user cascades programs, versions and change log', async () => {
    const userId = await makeUser('cascade');
    const { programId } = await draft(userId);
    await edit(userId, programId, 1, withWorkout(1));

    await client.user.delete({ where: { id: userId } });

    expect(await client.program.count({ where: { id: programId } })).toBe(0);
    expect(await client.programVersion.count({ where: { programId } })).toBe(0);
    expect(await client.programChangeLog.count({ where: { programId } })).toBe(0);
  });
});
