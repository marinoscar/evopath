// =============================================================================
// Real-Postgres test: "Prefill from photo" end to end (E4.5)
// =============================================================================
//
// The REAL `IntakeService`, `workout_prefill` kind, `WorkoutPrefillHandler`,
// `WorkoutsService` and the seeded exercise library over Postgres, with the
// AI runtime from the harness (`FakeAiProvider` answering the reference
// fixtures). Each photo exists twice: as a `storage_objects` row in Postgres
// (what the intake and workout tables reference) and, under the same id, in
// the harness's in-memory object storage (what the AI input resolver reads).
//
// What it proves:
//   - both reference examples, through create -> attach -> analyze -> the
//     job -> GET, yield exactly the expected drafts (Imperial and Metric);
//   - apply: accepted items become `WorkoutExercise` rows appended in order
//     with UNCOMPLETED sets numbered densely; an `other` item becomes ONE
//     reusable custom exercise; rejected items create nothing; every photo
//     becomes a `WorkoutPhoto`; a 31st exercise is skipped and reported;
//   - apply twice is 409 ALREADY_APPLIED; a workout deleted meanwhile is a
//     404 and the intake stays `ready`; another user's workout is a 404 on
//     create; a caller without `workouts:write` is a 403;
//   - `PATCH /intakes/:id` context: the source hint changes and is re-checked;
//   - storage: discarding an intake never deletes an object that is a
//     workout photo; deleting the workout deletes it.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a MIGRATED database;
// `beforeAll` upserts the exercise library from `prisma/seed-data.ts`
// (idempotent, the same rows the seed writes), so it does not need the seed.
// =============================================================================

import { stubFeatureResolver } from '../../src/ai/testing/feature-resolver.stub';
import { randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import type { Job, PrismaClient } from '@prisma/client';

import { EXERCISE_CATALOG } from '../../prisma/seed-data';
import { createAiRuntimeHarness, HARNESS_MODEL, HARNESS_PROVIDER } from '../../src/ai/testing/ai-runtime-harness';
import { CheckInsService } from '../../src/check-ins/check-ins.service';
import { PERMISSIONS } from '../../src/common/constants/roles.constants';
import type { GymStorageService } from '../../src/gyms/gym-storage.service';
import { GymsService } from '../../src/gyms/gyms.service';
import { HealthProfileService } from '../../src/health-profile/health-profile.service';
import { IntakeKindRegistry } from '../../src/intake/intake-kind.registry';
import { IntakeService } from '../../src/intake/intake.service';
import { StorageObjectReferences } from '../../src/intake/storage-object-references';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobsService } from '../../src/jobs/jobs.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { WorkoutPhotoObjectReferences } from '../../src/workouts/intake/workout-photo-references';
import { WorkoutPrefillIntakeKind } from '../../src/workouts/intake/workout-prefill.intake-kind';
import { ExerciseVocabularyService } from '../../src/workouts/prefill/exercise-vocabulary';
import { WorkoutPrefillHandler } from '../../src/workouts/prefill/workout-prefill.handler';
import { WorkoutHistoryService } from '../../src/workouts/workout-history.service';
import { WorkoutPhotoStorageService } from '../../src/workouts/workout-photo-storage.service';
import { WorkoutsService } from '../../src/workouts/workouts.service';
import {
  loadPlacardExpectedDrafts,
  loadPrefillModelOutput,
  notebookExpectedDrafts,
  type WorkoutPrefillExample,
} from '../fixtures/workout-prefill.fixtures';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('workout-prefill.db.spec');

const INTAKE_PERMISSIONS = [PERMISSIONS.INTAKES_READ, PERMISSIONS.INTAKES_WRITE];
const PREFILL_PERMISSIONS = [
  ...INTAKE_PERMISSIONS,
  PERMISSIONS.WORKOUTS_READ,
  PERMISSIONS.WORKOUTS_WRITE,
  PERMISSIONS.EXERCISES_WRITE,
];

/** The seeded library, upserted by slug, for a database `prisma:seed` has not run on. */
async function ensureLibrary(client: PrismaClient): Promise<void> {
  for (const ex of EXERCISE_CATALOG) {
    const data = {
      name: ex.name,
      primaryMuscles: ex.primaryMuscles,
      secondaryMuscles: ex.secondaryMuscles,
      movementPattern: ex.movementPattern,
      trackingMode: ex.trackingMode,
      isUnilateral: ex.isUnilateral,
      isBodyweight: ex.isBodyweight,
      origin: 'seed',
      status: 'active',
    };
    await client.exercise.upsert({ where: { slug: ex.slug }, update: {}, create: { slug: ex.slug, ...data } });
  }
}

describeWithDb('"Prefill from photo" end to end (real Postgres)', () => {
  let client: PrismaClient;
  let intakes: IntakeService;
  let handler: WorkoutPrefillHandler;
  let workouts: WorkoutsService;
  let harness: ReturnType<typeof createAiRuntimeHarness>;
  let nextOutput: unknown;
  const deletedObjects: string[] = [];
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  async function makeUser(label: string, unitSystem: 'metric' | 'imperial' | null = 'imperial'): Promise<string> {
    const user = await client.user.create({
      data: { email: `workout-prefill-${label}-${run}@example.com` },
      select: { id: true },
    });
    userIds.push(user.id);
    harness.addUserKey(user.id, `sk-db-${label}-${run}`, [HARNESS_MODEL]);
    if (unitSystem) {
      await client.healthProfile.create({ data: { userId: user.id, unitSystem } });
    }
    return user.id;
  }

  async function makeWorkout(userId: string, status: 'in_progress' | 'completed' = 'completed'): Promise<string> {
    const workout = await client.workout.create({
      data: {
        userId,
        name: 'Test workout',
        date: new Date('2026-09-29T00:00:00.000Z'),
        startedAt: new Date(Date.now() - 3_600_000),
        status,
        ...(status === 'completed' ? { endedAt: new Date(), durationSeconds: 3600 } : {}),
      },
      select: { id: true },
    });
    return workout.id;
  }

  /** One photo: a Postgres row and the harness's in-memory object, same id. */
  async function makePhoto(userId: string, name: string): Promise<string> {
    const row = await client.storageObject.create({
      data: {
        name,
        size: BigInt(1024),
        mimeType: 'image/jpeg',
        storageKey: `test/workout-prefill/${run}/${randomUUID()}`,
        status: 'ready',
        uploadedById: userId,
      },
      select: { id: true },
    });
    const memory = harness.storage.addObject({ uploadedById: userId, mimeType: 'image/jpeg', name });
    memory.id = row.id;
    return row.id;
  }

  /** create -> attach -> analyze -> run the queued job; returns the intake id and photo ids. */
  async function prefill(userId: string, workoutId: string, example: WorkoutPrefillExample, photoCount = 1) {
    const intake = await intakes.create(
      userId,
      { kind: 'workout_prefill', context: { workoutId, sourceHint: example === 'placard' ? 'machine_placard' : 'notebook' } },
      PREFILL_PERMISSIONS,
    );
    const photoIds: string[] = [];

    for (let i = 0; i < photoCount; i += 1) {
      const id = await makePhoto(userId, `${example}-${i}.jpg`);
      await intakes.attachPhoto(userId, intake.id, id, PREFILL_PERMISSIONS);
      photoIds.push(id);
    }

    nextOutput = loadPrefillModelOutput(example);
    const { jobId } = await intakes.analyze(
      userId,
      intake.id,
      { provider: HARNESS_PROVIDER, modelId: HARNESS_MODEL },
      PREFILL_PERMISSIONS,
    );
    const job = await client.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ type: 'ai.workout.prefill', subjectType: 'photo_intake', subjectId: intake.id });

    await handler.process(job as Job);

    return { intakeId: intake.id, photoIds };
  }

  const withoutIds = (items: Array<Record<string, unknown>>) =>
    items.map(({ id: _id, sortOrder: _sortOrder, ...rest }) => rest);

  async function libraryId(slug: string): Promise<string> {
    return (await client.exercise.findUniqueOrThrow({ where: { slug }, select: { id: true } })).id;
  }

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    harness = createAiRuntimeHarness({
      fake: { responses: () => ({ outputText: JSON.stringify(nextOutput) }) },
    });

    await ensureLibrary(client);

    const registry = new IntakeKindRegistry();
    // Deletes the `storage_objects` row, as `ObjectsService.delete` does after the provider.
    const objects = {
      delete: async (id: string) => {
        deletedObjects.push(id);
        await client.storageObject.delete({ where: { id } });
      },
    };
    new WorkoutPrefillIntakeKind(registry, prisma).onModuleInit();

    const references = new StorageObjectReferences();
    new WorkoutPhotoObjectReferences(references, prisma).onModuleInit();

    intakes = new IntakeService(
      prisma,
      registry,
      new JobsService(prisma),
      { assertUsable: jest.fn(async () => ({})) } as never,
      objects as never,
      stubFeatureResolver({ provider: HARNESS_PROVIDER, modelId: HARNESS_MODEL }) as never,
      references,
    );
    handler = new WorkoutPrefillHandler(
      new JobHandlerRegistry(),
      harness.ai,
      intakes,
      new ExerciseVocabularyService(prisma),
      prisma,
    );

    const gyms = new GymsService(prisma, {} as GymStorageService);
    const checkIns = new CheckInsService(prisma, new HealthProfileService(prisma));
    workouts = new WorkoutsService(
      prisma,
      gyms,
      checkIns,
      new WorkoutHistoryService(prisma, checkIns),
      new WorkoutPhotoStorageService(prisma, objects as never),
    );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    const intakeRows = await client.photoIntake.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    await client.job.deleteMany({
      where: { subjectType: 'photo_intake', subjectId: { in: intakeRows.map((row) => row.id) } },
    });
    // Workouts first: workout_exercises -> exercises is Restrict.
    await client.workout.deleteMany({ where: { userId: { in: userIds } } });
    await client.storageObject.deleteMany({ where: { uploadedById: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  it('Example A (placard) yields exactly the expected drafts; the intake is ready and found by its workout', async () => {
    const userId = await makeUser('placard');
    const workoutId = await makeWorkout(userId, 'in_progress');

    const { intakeId, photoIds } = await prefill(userId, workoutId, 'placard');
    const view = await intakes.get(userId, intakeId, PREFILL_PERMISSIONS);

    expect(view.status).toBe('ready');
    expect(view.subjectType).toBe('workout');
    expect(view.subjectId).toBe(workoutId);
    expect(withoutIds(view.items as never)).toEqual(loadPlacardExpectedDrafts(photoIds));
    expect(view.resultMeta).toMatchObject({ promptVersion: 1, sourceKind: 'machine_placard', failedChunks: [] });

    const listed = await intakes.list(
      userId,
      { kind: 'workout_prefill', subjectId: workoutId, status: ['draft', 'scanning', 'ready'], limit: 20 },
      PREFILL_PERMISSIONS,
    );
    expect(listed.map((row) => row.id)).toEqual([intakeId]);
  });

  it.each([
    ['imperial', 'lb'],
    ['metric', 'kg'],
  ] as const)('Example B (notebook) for a %s user yields the story table', async (unitSystem, unit) => {
    const userId = await makeUser(`notebook-${unitSystem}`, unitSystem);
    const workoutId = await makeWorkout(userId);

    const { intakeId, photoIds } = await prefill(userId, workoutId, 'notebook');
    const view = await intakes.get(userId, intakeId, PREFILL_PERMISSIONS);

    expect(withoutIds(view.items as never)).toEqual(notebookExpectedDrafts(unit, photoIds));
    expect(view.resultMeta).toMatchObject({ suggestedName: 'Push day', assumedWeightUnit: unit });
  });

  it('apply: appended in order, sets uncompleted and dense, one reusable custom exercise, rejected creates nothing, photos attached', async () => {
    const userId = await makeUser('apply');
    const workoutId = await makeWorkout(userId);
    // A manual exercise already in the workout: prefilled ones come after it.
    const manual = await client.workoutExercise.create({
      data: { workoutId, exerciseId: await libraryId('plank'), position: 0 },
    });

    const { intakeId, photoIds } = await prefill(userId, workoutId, 'notebook');
    const items = (await intakes.get(userId, intakeId, PREFILL_PERMISSIONS)).items;
    const [bench, , , plank, unreadable] = items;

    // The user corrects the bench to 140 lb on the first set, rejects Plank,
    // and adds the same unreadable exercise by hand (one custom exercise, reused).
    const benchValue = bench.value as { sets: Array<Record<string, unknown>> };
    await intakes.updateItem(
      userId,
      intakeId,
      bench.id,
      { value: { ...benchValue, sets: [{ ...benchValue.sets[0], weightKg: 63.503 }, ...benchValue.sets.slice(1)] } },
      PREFILL_PERMISSIONS,
    );
    await intakes.updateItem(userId, intakeId, plank.id, { status: 'rejected' }, PREFILL_PERMISSIONS);
    await intakes.addItem(
      userId,
      intakeId,
      { kind: 'exercise', value: { exerciseSlug: null, name: 'unreadable cable EXERCISE', sets: [{ reps: 10, weightKg: 10, durationSeconds: null, distanceMeters: null }] } },
      PREFILL_PERMISSIONS,
    );
    await intakes.acceptAll(userId, intakeId, PREFILL_PERMISSIONS);

    const result = await intakes.apply(userId, intakeId, PREFILL_PERMISSIONS);

    expect(result).toEqual({ workoutId, exercisesAdded: 5, setsAdded: 3 + 3 + 2 + 1 + 1, skipped: 0, photosAttached: 1 });

    const view = await workouts.get(userId, workoutId);
    expect(view.exercises.map((e) => [e.position, e.exercise.slug.startsWith('custom-') ? 'custom' : e.exercise.slug])).toEqual([
      [0, 'plank'],
      [1, 'barbell_bench_press'],
      [2, 'incline_dumbbell_press'],
      [3, 'triceps_pushdown'],
      [4, 'custom'],
      [5, 'custom'],
    ]);
    expect(view.exercises[0].id).toBe(manual.id);
    expect(view.exercises[1].sets.map((s) => [s.setNumber, s.weightKg, s.reps, s.completed, s.completedAt])).toEqual([
      [1, 63.503, 10, false, null],
      [2, 61.235, 10, false, null],
      [3, 61.235, 8, false, null],
    ]);
    for (const entry of view.exercises.slice(1)) {
      expect(entry.sets.every((s) => !s.completed)).toBe(true);
      expect(entry.sets.map((s) => s.setNumber)).toEqual(entry.sets.map((_, i) => i + 1));
    }

    // One custom exercise for both spellings of the unreadable line.
    expect(view.exercises[4].exerciseId).toBe(view.exercises[5].exerciseId);
    const custom = await client.exercise.findUniqueOrThrow({ where: { id: view.exercises[4].exerciseId } });
    expect(custom).toMatchObject({
      ownerUserId: userId,
      name: 'Unreadable cable exercise',
      primaryMuscles: ['full_body'],
      movementPattern: 'isolation',
      trackingMode: 'weight_reps',
      status: 'active',
    });
    expect(unreadable.value).toMatchObject({ exerciseSlug: null });

    // The photo belongs to the workout now.
    expect(view.photos.map((p) => p.storageObjectId)).toEqual(photoIds);
    expect(view.summary.setCount).toBe(0);

    // A second apply is refused and writes nothing.
    const again = await intakes.apply(userId, intakeId, PREFILL_PERMISSIONS).catch((error: unknown) => error);
    expect(again).toBeInstanceOf(ConflictException);
    expect(((again as ConflictException).getResponse() as { details: { reason: string } }).details.reason).toBe('ALREADY_APPLIED');
    expect(await client.workoutExercise.count({ where: { workoutId } })).toBe(6);

    // A later prefill reuses the custom exercise by name.
    const second = await prefill(userId, workoutId, 'notebook');
    const secondItems = (await intakes.get(userId, second.intakeId, PREFILL_PERMISSIONS)).items;
    for (const item of secondItems.slice(0, 4)) {
      await intakes.updateItem(userId, second.intakeId, item.id, { status: 'rejected' }, PREFILL_PERMISSIONS);
    }
    await intakes.acceptAll(userId, second.intakeId, PREFILL_PERMISSIONS);
    await intakes.apply(userId, second.intakeId, PREFILL_PERMISSIONS);
    expect(await client.exercise.count({ where: { ownerUserId: userId } })).toBe(1);
  });

  it('a durations-only "other" item creates a time-tracked custom exercise', async () => {
    const userId = await makeUser('tracking');
    const workoutId = await makeWorkout(userId);
    const intake = await intakes.create(userId, { kind: 'workout_prefill', context: { workoutId } }, PREFILL_PERMISSIONS);
    await intakes.addItem(
      userId,
      intake.id,
      { kind: 'exercise', value: { exerciseSlug: null, name: 'Wall sit hold', sets: [{ reps: null, weightKg: null, durationSeconds: 45, distanceMeters: null }] } },
      PREFILL_PERMISSIONS,
    );
    await intakes.addItem(
      userId,
      intake.id,
      { kind: 'exercise', value: { exerciseSlug: null, name: 'Sled push lane', sets: [{ reps: null, weightKg: null, durationSeconds: 30, distanceMeters: 20 }] } },
      PREFILL_PERMISSIONS,
    );

    await intakes.apply(userId, intake.id, PREFILL_PERMISSIONS);

    const created = await client.exercise.findMany({ where: { ownerUserId: userId }, orderBy: { name: 'asc' } });
    expect(created.map((e) => [e.name, e.trackingMode])).toEqual([
      ['Sled push lane', 'distance_time'],
      ['Wall sit hold', 'time'],
    ]);
  });

  it('a user item naming a library exercise resolves to it; an unknown slug is a 400', async () => {
    const userId = await makeUser('user-items');
    const workoutId = await makeWorkout(userId);
    const intake = await intakes.create(userId, { kind: 'workout_prefill', context: { workoutId } }, PREFILL_PERMISSIONS);

    const item = await intakes.addItem(
      userId,
      intake.id,
      { kind: 'exercise', value: { exerciseSlug: 'leg_curl', name: 'whatever' } },
      PREFILL_PERMISSIONS,
    );
    expect(item.value).toEqual({ exerciseSlug: 'leg_curl', name: 'Leg curl', rawText: null, sets: [] });

    await expect(
      intakes.addItem(userId, intake.id, { kind: 'exercise', value: { exerciseSlug: 'hovercraft_press', name: 'X' } }, PREFILL_PERMISSIONS),
    ).rejects.toBeInstanceOf(BadRequestException);

    await intakes.addItem(userId, intake.id, { kind: 'exercise', value: { exerciseSlug: null, name: 'plank' } }, PREFILL_PERMISSIONS);
    await intakes.apply(userId, intake.id, PREFILL_PERMISSIONS);

    const view = await workouts.get(userId, workoutId);
    expect(view.exercises.map((e) => e.exercise.slug)).toEqual(['leg_curl', 'plank']);
    expect(await client.exercise.count({ where: { ownerUserId: userId } })).toBe(0);
  });

  it('a 31st exercise is skipped and reported; the first 30 stay dense', async () => {
    const userId = await makeUser('cap');
    const workoutId = await makeWorkout(userId);
    const plank = await libraryId('plank');
    await client.workoutExercise.createMany({
      data: Array.from({ length: 29 }, (_, position) => ({ workoutId, exerciseId: plank, position })),
    });

    const { intakeId } = await prefill(userId, workoutId, 'notebook');
    await intakes.acceptAll(userId, intakeId, PREFILL_PERMISSIONS);

    const result = await intakes.apply(userId, intakeId, PREFILL_PERMISSIONS);

    expect(result).toMatchObject({ exercisesAdded: 1, setsAdded: 3, skipped: 4, photosAttached: 1 });
    const rows = await client.workoutExercise.findMany({ where: { workoutId }, orderBy: { position: 'asc' } });
    expect(rows.map((r) => r.position)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    // Skipped items create no custom exercise.
    expect(await client.exercise.count({ where: { ownerUserId: userId } })).toBe(0);
  });

  it('a workout deleted before apply is a 404 and the intake stays ready for a retry', async () => {
    const userId = await makeUser('deleted-workout');
    const workoutId = await makeWorkout(userId);
    const { intakeId } = await prefill(userId, workoutId, 'placard');
    await intakes.acceptAll(userId, intakeId, PREFILL_PERMISSIONS);

    await client.workout.delete({ where: { id: workoutId } });

    await expect(intakes.apply(userId, intakeId, PREFILL_PERMISSIONS)).rejects.toBeInstanceOf(NotFoundException);
    expect((await client.photoIntake.findUniqueOrThrow({ where: { id: intakeId } })).status).toBe('ready');
  });

  it("refuses another user's workout with 404 and a caller without workouts:write with 403", async () => {
    const owner = await makeUser('owner');
    const stranger = await makeUser('stranger');
    const workoutId = await makeWorkout(owner);

    await expect(
      intakes.create(stranger, { kind: 'workout_prefill', context: { workoutId } }, PREFILL_PERMISSIONS),
    ).rejects.toBeInstanceOf(NotFoundException);

    const readOnly = [...INTAKE_PERMISSIONS, PERMISSIONS.WORKOUTS_READ];
    const error = await intakes
      .create(owner, { kind: 'workout_prefill', context: { workoutId } }, readOnly)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(((error as ForbiddenException).getResponse() as { details: unknown }).details).toEqual({
      reason: 'MISSING_KIND_PERMISSIONS',
      kind: 'workout_prefill',
      permissions: [PERMISSIONS.WORKOUTS_WRITE, PERMISSIONS.EXERCISES_WRITE],
    });
    expect(await client.photoIntake.count({ where: { userId: owner } })).toBe(0);
  });

  it('PATCH context: the source hint changes, is re-validated, and cannot move to a foreign workout', async () => {
    const userId = await makeUser('context');
    const stranger = await makeUser('context-stranger');
    const workoutId = await makeWorkout(userId);
    const foreignWorkout = await makeWorkout(stranger);
    const intake = await intakes.create(userId, { kind: 'workout_prefill', context: { workoutId } }, PREFILL_PERMISSIONS);

    const updated = await intakes.updateContext(
      userId,
      intake.id,
      { context: { workoutId, sourceHint: 'whiteboard' } },
      PREFILL_PERMISSIONS,
    );
    expect(updated.context).toEqual({ workoutId, sourceHint: 'whiteboard' });

    await expect(
      intakes.updateContext(userId, intake.id, { context: { workoutId, sourceHint: 'napkin' } }, PREFILL_PERMISSIONS),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      intakes.updateContext(userId, intake.id, { context: { workoutId: foreignWorkout } }, PREFILL_PERMISSIONS),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      intakes.updateContext(stranger, intake.id, { context: { workoutId } }, PREFILL_PERMISSIONS),
    ).rejects.toBeInstanceOf(NotFoundException);

    await intakes.addItem(userId, intake.id, { kind: 'exercise', value: { exerciseSlug: 'plank', name: 'Plank' } }, PREFILL_PERMISSIONS);
    await intakes.apply(userId, intake.id, PREFILL_PERMISSIONS);
    await expect(
      intakes.updateContext(userId, intake.id, { context: { workoutId } }, PREFILL_PERMISSIONS),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('storage: an intake discard keeps an object that is a workout photo; deleting the workout deletes it', async () => {
    const userId = await makeUser('storage');
    const workoutId = await makeWorkout(userId);
    const { intakeId, photoIds } = await prefill(userId, workoutId, 'placard');
    await intakes.acceptAll(userId, intakeId, PREFILL_PERMISSIONS);
    await intakes.apply(userId, intakeId, PREFILL_PERMISSIONS);

    // The same object attached to a second, unapplied intake that is then discarded.
    const other = await intakes.create(userId, { kind: 'workout_prefill', context: { workoutId } }, PREFILL_PERMISSIONS);
    await intakes.attachPhoto(userId, other.id, photoIds[0], PREFILL_PERMISSIONS);
    await intakes.discard(userId, other.id, PREFILL_PERMISSIONS);

    expect(await client.storageObject.count({ where: { id: photoIds[0] } })).toBe(1);
    expect(await client.workoutPhoto.count({ where: { workoutId } })).toBe(1);

    await workouts.remove(userId, workoutId);

    expect(deletedObjects).toContain(photoIds[0]);
    expect(await client.storageObject.count({ where: { id: photoIds[0] } })).toBe(0);
  });
});
