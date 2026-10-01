import { randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { PlanTree } from './contracts/plan-tree.contract';
import { requireIfMatchVersion } from './if-match';
import { ACTIVE_PROGRAM_INDEX_NAME, isActiveProgramConflict } from './programs.constants';
import { ProgramsService } from './programs.service';
import { createInMemoryProgramsPrisma } from './testing/in-memory-programs-prisma';

const USER = randomUUID();
const OTHER = randomUUID();
const EX = randomUUID();

function setup() {
  const db = createInMemoryProgramsPrisma();
  db.tables.exercise.push({ id: EX, name: 'Bench press', slug: 'bench', status: 'active', ownerUserId: null, trackingMode: 'weight_reps' });
  const service = new ProgramsService(db.prisma as never);
  return { db, service };
}

async function manualProgram(service: ProgramsService) {
  return service.createWithTree({
    userId: USER,
    header: { name: 'Plan', goal: 'strength', source: 'manual' },
    tree: { blocks: [{ position: 0, name: 'Block 1', weeks: [{ weekNumber: 1, workouts: [] }] }] },
    origin: 'initial',
    actor: 'user',
    summary: 'Created by you',
  });
}

const addWorkout = (weekday: number, name = `Day ${weekday}`) => (tree: PlanTree): PlanTree => {
  tree.blocks[0].weeks[0].workouts.push({
    position: tree.blocks[0].weeks[0].workouts.length,
    weekday,
    name,
    estimatedMinutes: null,
    rationale: null,
    exercises: [
      {
        exerciseId: EX,
        position: 0,
        isPriority: false,
        targetSets: 3,
        repMin: 5,
        repMax: 8,
        targetLoadKg: 60,
        targetRpe: null,
        restSeconds: 120,
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

function change(programId: string, expectedVersion: number, mutate: (tree: PlanTree) => PlanTree) {
  return {
    userId: USER,
    programId,
    expectedVersion,
    origin: 'manual_edit' as const,
    actor: 'user' as const,
    kind: 'edited' as const,
    mutate,
    summary: 'Edited by you',
  };
}

const rejection = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);

describe('ProgramsService.createWithTree', () => {
  it('writes the tree, version 1 and one "created" change-log entry', async () => {
    const { db, service } = setup();
    const result = await manualProgram(service);

    expect(result.versionNumber).toBe(1);
    expect(db.tables.program).toHaveLength(1);
    expect(db.tables.programBlock).toHaveLength(1);
    expect(db.tables.programWeek).toHaveLength(1);
    expect(db.tables.programVersion).toEqual([expect.objectContaining({ versionNumber: 1, origin: 'initial' })]);
    expect(db.tables.programChangeLog).toEqual([
      expect.objectContaining({ id: result.changeLogId, kind: 'created', actor: 'user', fromVersion: null, toVersion: 1 }),
    ]);
    const snapshot = db.tables.programVersion[0].snapshot;
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.tree.blocks[0].id).toBe(db.tables.programBlock[0].id);
  });
});

describe('ProgramsService.applyChange', () => {
  it('bumps the version and writes exactly one version and one change-log row', async () => {
    const { db, service } = setup();
    const { programId } = await manualProgram(service);

    const result = await service.applyChange({ ...change(programId, 1, addWorkout(1)), rationale: 'More pressing', planRationale: 'Strength first' });

    expect(result.versionNumber).toBe(2);
    expect(db.tables.program[0]).toMatchObject({ currentVersion: 2, rationale: 'Strength first' });
    expect(db.tables.programWorkout).toHaveLength(1);
    expect(db.tables.programExercise).toHaveLength(1);
    expect(db.tables.programVersion.map((v) => [v.versionNumber, v.origin])).toEqual([
      [1, 'initial'],
      [2, 'manual_edit'],
    ]);
    const log = db.tables.programChangeLog.find((row) => row.id === result.changeLogId);
    expect(log).toMatchObject({ kind: 'edited', actor: 'user', status: 'applied', fromVersion: 1, toVersion: 2, rationale: 'More pressing' });
  });

  it('answers 409 TRAINING_STALE_PLAN with currentVersion on a stale expectedVersion, and changes nothing', async () => {
    const { db, service } = setup();
    const { programId } = await manualProgram(service);
    await service.applyChange(change(programId, 1, addWorkout(1)));
    const before = structuredClone(db.tables);

    const error = await rejection(service.applyChange(change(programId, 1, addWorkout(2))));

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      details: { reason: 'TRAINING_STALE_PLAN', currentVersion: 2 },
    });
    expect(db.tables).toEqual(before);
  });

  it('answers 404 for another user\'s program, never revealing it', async () => {
    const { service } = setup();
    const { programId } = await manualProgram(service);
    const error = await rejection(service.applyChange({ ...change(programId, 1, addWorkout(1)), userId: OTHER }));
    expect(error).toBeInstanceOf(NotFoundException);
  });

  it('answers 409 PROGRAM_ARCHIVED on an archived program', async () => {
    const { db, service } = setup();
    const { programId } = await manualProgram(service);
    db.tables.program[0].status = 'archived';
    const error = await rejection(service.applyChange(change(programId, 1, addWorkout(1))));
    expect((error as ConflictException).getResponse()).toMatchObject({ details: { reason: 'PROGRAM_ARCHIVED' } });
  });

  it('rolls everything back when the mutated tree is invalid (400 with field issues)', async () => {
    const { db, service } = setup();
    const { programId } = await manualProgram(service);
    const before = structuredClone(db.tables);

    const error = await rejection(
      service.applyChange(change(programId, 1, (tree) => addWorkout(1, 'Twin')(addWorkout(1)(tree)))),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    const body = (error as BadRequestException).getResponse() as { details: { reason: string; issues: { path: string }[] } };
    expect(body.details.reason).toBe('INVALID_PLAN');
    expect(body.details.issues.some((issue) => issue.path.endsWith('weekday'))).toBe(true);
    expect(db.tables).toEqual(before);
  });

  it('lists unknown exercise ids with 400 UNKNOWN_EXERCISES', async () => {
    const { service } = setup();
    const { programId } = await manualProgram(service);
    const missing = randomUUID();
    const error = await rejection(
      service.applyChange(
        change(programId, 1, (tree) => {
          addWorkout(1)(tree).blocks[0].weeks[0].workouts[0].exercises[0].exerciseId = missing;
          return tree;
        }),
      ),
    );
    expect((error as BadRequestException).getResponse()).toMatchObject({
      details: { reason: 'UNKNOWN_EXERCISES', exerciseIds: [missing] },
    });
  });

  it('refuses another user\'s custom exercise as unknown', async () => {
    const { db, service } = setup();
    const theirs = randomUUID();
    db.tables.exercise.push({ id: theirs, name: 'Theirs', slug: 'theirs', status: 'active', ownerUserId: OTHER });
    const { programId } = await manualProgram(service);
    const error = await rejection(
      service.applyChange(
        change(programId, 1, (tree) => {
          addWorkout(1)(tree).blocks[0].weeks[0].workouts[0].exercises[0].exerciseId = theirs;
          return tree;
        }),
      ),
    );
    expect((error as BadRequestException).getResponse()).toMatchObject({ details: { reason: 'UNKNOWN_EXERCISES' } });
  });

  it('refuses a new row id that belongs to another program', async () => {
    const { db, service } = setup();
    const { programId } = await manualProgram(service);
    const other = await manualProgram(service);
    const foreignBlock = db.tables.programBlock.find((row) => row.programId === other.programId)!.id;

    const error = await rejection(
      service.applyChange(
        change(programId, 1, (tree) => {
          tree.blocks.push({ id: foreignBlock, position: 1, name: 'Stolen', focus: null, rationale: null, weeks: [{ weekNumber: 2, isDeload: false, workouts: [] }] });
          return tree;
        }),
      ),
    );
    expect((error as BadRequestException).getResponse()).toMatchObject({ details: { reason: 'ROW_ID_CONFLICT' } });
  });

  it('archives a removed workout with logged history and restores it with the same id on revert', async () => {
    const { db, service } = setup();
    const { programId } = await manualProgram(service);
    await service.applyChange(change(programId, 1, addWorkout(1)));
    const workoutId = db.tables.programWorkout[0].id;
    db.tables.workout.push({ id: randomUUID(), userId: USER, programWorkoutId: workoutId });

    await service.applyChange(change(programId, 2, (tree) => ({ blocks: tree.blocks.map((b) => ({ ...b, weeks: b.weeks.map((w) => ({ ...w, workouts: [] })) })) })));
    expect(db.tables.programWorkout).toEqual([expect.objectContaining({ id: workoutId, archivedAt: expect.any(Date) })]);
    expect(db.tables.programExercise).toHaveLength(1);

    const restored = await service.revert({ userId: USER, programId, expectedVersion: 3, toVersion: 2 });
    expect(restored.versionNumber).toBe(4);
    expect(db.tables.programWorkout).toEqual([expect.objectContaining({ id: workoutId, archivedAt: null })]);
    expect(db.tables.programVersion.at(-1)).toMatchObject({ versionNumber: 4, origin: 'revert' });
  });

  it('archives (never deletes) a removed workout that only a planned session points at', async () => {
    const { db, service } = setup();
    const { programId } = await manualProgram(service);
    await service.applyChange(change(programId, 1, addWorkout(1)));
    const workoutId = db.tables.programWorkout[0].id;
    db.tables.programSession.push({ id: randomUUID(), userId: USER, programId, programWorkoutId: workoutId, workoutId: randomUUID() });

    await service.applyChange(change(programId, 2, (tree) => ({ blocks: tree.blocks.map((b) => ({ ...b, weeks: b.weeks.map((w) => ({ ...w, workouts: [] })) })) })));
    expect(db.tables.programWorkout).toEqual([expect.objectContaining({ id: workoutId, archivedAt: expect.any(Date) })]);
  });
});

describe('ProgramsService.revert', () => {
  async function threeVersions() {
    const t = setup();
    const { programId } = await manualProgram(t.service);
    const v2 = await t.service.applyChange(change(programId, 1, addWorkout(1)));
    const v3 = await t.service.applyChange({ ...change(programId, 2, addWorkout(3)), origin: 'ai_adapt', actor: 'ai', kind: 'adapted' });
    return { ...t, programId, v2, v3 };
  }

  it('restores an older tree as a NEW version with origin revert', async () => {
    const { db, service, programId } = await threeVersions();
    const result = await service.revert({ userId: USER, programId, expectedVersion: 3, toVersion: 1 });

    expect(result.versionNumber).toBe(4);
    expect(db.tables.programWorkout.filter((row) => !row.archivedAt)).toHaveLength(0);
    expect(db.tables.programVersion).toHaveLength(4);
    expect(db.tables.programChangeLog.at(-1)).toMatchObject({ kind: 'reverted', fromVersion: 3, toVersion: 4, revertsLogId: null });
  });

  it('undoes the latest applied change by changeLogId and marks it reverted', async () => {
    const { db, service, programId, v3 } = await threeVersions();
    const result = await service.revert({ userId: USER, programId, expectedVersion: 3, changeLogId: v3.changeLogId });

    expect(result.versionNumber).toBe(4);
    expect(db.tables.programWorkout.map((row) => row.weekday)).toEqual([1]);
    expect(db.tables.programChangeLog.find((row) => row.id === v3.changeLogId)).toMatchObject({ status: 'reverted' });
    expect(db.tables.programChangeLog.at(-1)).toMatchObject({ kind: 'reverted', revertsLogId: v3.changeLogId });
  });

  it('answers 409 NOT_LATEST with latestLogId for an older change, and changes nothing', async () => {
    const { db, service, programId, v2, v3 } = await threeVersions();
    const before = structuredClone(db.tables);

    const error = await rejection(service.revert({ userId: USER, programId, expectedVersion: 3, changeLogId: v2.changeLogId }));

    expect((error as ConflictException).getResponse()).toMatchObject({
      details: { reason: 'NOT_LATEST', latestLogId: v3.changeLogId },
    });
    expect(db.tables).toEqual(before);
  });

  it('answers 409 NOT_REVERTIBLE for the entry that created the plan', async () => {
    const { db, service, programId } = await threeVersions();
    const created = db.tables.programChangeLog.find((row) => row.kind === 'created')!;
    const error = await rejection(service.revert({ userId: USER, programId, expectedVersion: 3, changeLogId: created.id }));
    expect((error as ConflictException).getResponse()).toMatchObject({ details: { reason: 'NOT_REVERTIBLE' } });
  });

  it('answers 409 SNAPSHOT_UNSUPPORTED for a snapshot from a newer format', async () => {
    const { db, service, programId } = await threeVersions();
    db.tables.programVersion.find((row) => row.versionNumber === 1)!.snapshot = { schemaVersion: 99 };
    const error = await rejection(service.revert({ userId: USER, programId, expectedVersion: 3, toVersion: 1 }));
    expect((error as ConflictException).getResponse()).toMatchObject({ details: { reason: 'SNAPSHOT_UNSUPPORTED' } });
  });

  it('answers 409 TRAINING_STALE_PLAN when If-Match is stale', async () => {
    const { service, programId } = await threeVersions();
    const error = await rejection(service.revert({ userId: USER, programId, expectedVersion: 2, toVersion: 1 }));
    expect((error as ConflictException).getResponse()).toMatchObject({ details: { reason: 'TRAINING_STALE_PLAN', currentVersion: 3 } });
  });

  it('answers 404 for an unknown version or another user\'s program', async () => {
    const { service, programId } = await threeVersions();
    expect(await rejection(service.revert({ userId: USER, programId, expectedVersion: 3, toVersion: 9 }))).toBeInstanceOf(NotFoundException);
    expect(await rejection(service.revert({ userId: OTHER, programId, expectedVersion: 3, toVersion: 1 }))).toBeInstanceOf(NotFoundException);
  });
});

describe('ProgramsService lifecycle', () => {
  it('refuses to activate a plan without a scheduled workout, then activates and pauses the previous active plan', async () => {
    const { db, service } = setup();
    const a = await manualProgram(service);
    const b = await manualProgram(service);
    const today = new Date('2026-09-30T12:00:00Z');

    const empty = await rejection(service.activate(USER, a.programId, '2026-09-30', today));
    expect((empty as ConflictException).getResponse()).toMatchObject({ details: { reason: 'PLAN_NOT_SCHEDULABLE' } });

    await service.applyChange(change(a.programId, 1, addWorkout(1)));
    await service.applyChange(change(b.programId, 1, addWorkout(2)));
    await service.activate(USER, a.programId, '2026-09-30', today);
    expect(db.tables.program.find((p) => p.id === a.programId)!.status).toBe('active');

    await service.activate(USER, b.programId, '2026-10-01', today);
    expect(db.tables.program.find((p) => p.id === a.programId)!.status).toBe('paused');
    expect(db.tables.program.find((p) => p.id === b.programId)!.status).toBe('active');
  });

  // E7.12: the coach's kickoff listens for this; ids only, after the commit.
  it('emits program.activated once per successful activation, and never for a refused one', async () => {
    const db = createInMemoryProgramsPrisma();
    db.tables.exercise.push({ id: EX, name: 'Bench press', slug: 'bench', status: 'active', ownerUserId: null, trackingMode: 'weight_reps' });
    const events = { emit: jest.fn() };
    const service = new ProgramsService(db.prisma as never, events as never);
    const a = await manualProgram(service);
    const today = new Date('2026-09-30T12:00:00Z');

    await rejection(service.activate(USER, a.programId, '2026-09-30', today));
    expect(events.emit).not.toHaveBeenCalled();

    await service.applyChange(change(a.programId, 1, addWorkout(1)));
    await service.activate(USER, a.programId, '2026-09-30', today);
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith('program.activated', { userId: USER, programId: a.programId });
  });

  it('a throwing listener does not fail the activation (it already committed)', async () => {
    const db = createInMemoryProgramsPrisma();
    db.tables.exercise.push({ id: EX, name: 'Bench press', slug: 'bench', status: 'active', ownerUserId: null, trackingMode: 'weight_reps' });
    const events = { emit: jest.fn(() => { throw new Error('listener boom'); }) };
    const service = new ProgramsService(db.prisma as never, events as never);
    const a = await manualProgram(service);
    await service.applyChange(change(a.programId, 1, addWorkout(1)));

    await expect(service.activate(USER, a.programId, '2026-09-30', new Date('2026-09-30T12:00:00Z'))).resolves.toMatchObject({
      status: 'active',
    });
  });

  it('refuses a start date outside the window and an illegal transition', async () => {
    const { service } = setup();
    const { programId } = await manualProgram(service);
    const today = new Date('2026-09-30T00:00:00Z');
    const early = await rejection(service.activate(USER, programId, '2026-09-22', today));
    expect((early as BadRequestException).getResponse()).toMatchObject({ details: { reason: 'START_DATE_OUT_OF_RANGE' } });

    const pause = await rejection(service.pause(USER, programId));
    expect((pause as ConflictException).getResponse()).toMatchObject({ details: { reason: 'ILLEGAL_TRANSITION', status: 'draft' } });
  });

  it('refuses to delete a program with logged history (409), deletes one without', async () => {
    const { db, service } = setup();
    const { programId } = await manualProgram(service);
    await service.applyChange(change(programId, 1, addWorkout(1)));
    db.tables.workout.push({ id: randomUUID(), userId: USER, programWorkoutId: db.tables.programWorkout[0].id });

    const error = await rejection(service.remove(USER, programId));
    expect((error as ConflictException).getResponse()).toMatchObject({ details: { reason: 'PROGRAM_HAS_HISTORY' } });

    db.tables.workout.length = 0;
    await service.remove(USER, programId);
    expect(db.tables.program).toHaveLength(0);
    expect(db.tables.programVersion).toHaveLength(0);
  });

  it('refuses to delete a program a planned session points into (409)', async () => {
    const { db, service } = setup();
    const { programId } = await manualProgram(service);
    db.tables.programSession.push({ id: randomUUID(), userId: USER, programId, programWorkoutId: null, workoutId: randomUUID() });

    const error = await rejection(service.remove(USER, programId));
    expect((error as ConflictException).getResponse()).toMatchObject({ details: { reason: 'PROGRAM_HAS_HISTORY' } });
  });
});

describe('isActiveProgramConflict', () => {
  const p2002 = (meta: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x', meta });

  it('matches only the one-active index by name', () => {
    expect(isActiveProgramConflict(p2002({ target: ACTIVE_PROGRAM_INDEX_NAME }))).toBe(true);
    expect(
      isActiveProgramConflict(p2002({ driverAdapterError: { cause: { constraint: { index: ACTIVE_PROGRAM_INDEX_NAME } } } })),
    ).toBe(true);
    expect(isActiveProgramConflict(p2002({ target: ['program_id', 'version_number'] }))).toBe(false);
    expect(isActiveProgramConflict(new Error(ACTIVE_PROGRAM_INDEX_NAME))).toBe(false);
  });
});

describe('requireIfMatchVersion', () => {
  it.each([
    ['4', 4],
    ['"4"', 4],
    ['W/"12"', 12],
  ])('parses %s', (header, expected) => {
    expect(requireIfMatchVersion(header)).toBe(expected);
  });

  it.each([undefined, '', 'abc', '0', '"-1"', '*'])('refuses %p with 400 IF_MATCH_REQUIRED', (header) => {
    const error = (() => {
      try {
        return requireIfMatchVersion(header);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ details: { reason: 'IF_MATCH_REQUIRED' } });
  });
});
