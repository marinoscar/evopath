import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DraftItem, PhotoIntake, PrismaClient } from '@prisma/client';
import { mockDeep, type DeepMockProxy } from 'jest-mock-extended';

import { IntakeKindRegistry } from '../../intake/intake-kind.registry';
import type { PrismaService } from '../../prisma/prisma.service';
import { WorkoutPrefillIntakeKind } from './workout-prefill.intake-kind';
import { inferTrackingMode, workoutPrefillValueSchema } from './workout-prefill.value';

// =============================================================================
// The `workout_prefill` intake kind (E4.5) — schemas, checks and apply rules
// =============================================================================
//
// Over a mocked Prisma; the real transaction, cascade and unique-index
// behaviour is `test/workouts/workout-prefill.db.spec.ts`.
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const WORKOUT = '22222222-2222-4222-8222-222222222222';
const INTAKE = '33333333-3333-4333-8333-333333333333';

const set = (overrides: Record<string, unknown> = {}) => ({
  reps: null,
  weightKg: null,
  durationSeconds: null,
  distanceMeters: null,
  ...overrides,
});

function item(value: unknown, overrides: Partial<DraftItem> = {}): DraftItem {
  return { id: `item-${Math.random()}`, value, origin: 'ai', status: 'accepted', ...overrides } as DraftItem;
}

describe('workoutPrefillValueSchema', () => {
  it('fills defaults for a user item that names only the exercise', () => {
    expect(workoutPrefillValueSchema.parse({ exerciseSlug: 'plank', name: ' Plank ' })).toEqual({
      exerciseSlug: 'plank',
      name: 'Plank',
      rawText: null,
      sets: [],
    });
  });

  it.each([
    ['an empty name', { name: '  ' }],
    ['a name over 80', { name: 'x'.repeat(81) }],
    ['rawText over 200', { name: 'A', rawText: 'x'.repeat(201) }],
    ['13 sets', { name: 'A', sets: Array(13).fill(set({ reps: 1 })) }],
    ['a weight over 1000 kg', { name: 'A', sets: [set({ weightKg: 1000.5 })] }],
    ['4 decimals of kg', { name: 'A', sets: [set({ weightKg: 61.2349 })] }],
    ['fractional reps', { name: 'A', sets: [set({ reps: 1.5 })] }],
    ['a stray property', { name: 'A', completed: true }],
    ['a set with a stray property', { name: 'A', sets: [{ ...set(), completed: true }] }],
  ])('rejects %s', (_label, value) => {
    expect(workoutPrefillValueSchema.safeParse(value).success).toBe(false);
  });
});

describe('inferTrackingMode', () => {
  it('distance -> distance_time; durations only -> time; anything else -> weight_reps', () => {
    expect(inferTrackingMode([set({ distanceMeters: 400, durationSeconds: 90 })])).toBe('distance_time');
    expect(inferTrackingMode([set({ durationSeconds: 60 })])).toBe('time');
    expect(inferTrackingMode([set({ durationSeconds: 60, reps: 10 })])).toBe('weight_reps');
    expect(inferTrackingMode([set({ weightKg: 20, reps: 10 })])).toBe('weight_reps');
    expect(inferTrackingMode([])).toBe('weight_reps');
  });
});

describe('WorkoutPrefillIntakeKind', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let tx: DeepMockProxy<PrismaClient>;
  let registry: IntakeKindRegistry;
  let kind: WorkoutPrefillIntakeKind;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    tx = mockDeep<PrismaClient>();
    registry = new IntakeKindRegistry();
    kind = new WorkoutPrefillIntakeKind(registry, prisma as unknown as PrismaService);
    kind.onModuleInit();
  });

  it('registers itself with its job, photo cap and item kind', () => {
    expect(registry.get('workout_prefill')).toBe(kind);
    expect(kind).toMatchObject({ analyzeJobType: 'ai.workout.prefill', maxPhotos: 32, itemKinds: ['exercise'] });
    expect(kind.subjectOf({ workoutId: WORKOUT })).toEqual({ subjectType: 'workout', subjectId: WORKOUT });
  });

  describe('contextSchema', () => {
    it('accepts a workout id with an optional source hint, nothing else', () => {
      expect(kind.contextSchema.safeParse({ workoutId: WORKOUT }).success).toBe(true);
      expect(kind.contextSchema.safeParse({ workoutId: WORKOUT, sourceHint: 'machine_placard' }).success).toBe(true);
      expect(kind.contextSchema.safeParse({ workoutId: WORKOUT, sourceHint: 'other' }).success).toBe(false);
      expect(kind.contextSchema.safeParse({ workoutId: 'nope' }).success).toBe(false);
      expect(kind.contextSchema.safeParse({ workoutId: WORKOUT, note: 'x' }).success).toBe(false);
    });
  });

  describe('assertContext', () => {
    it('looks the workout up by the caller and 404s when it is not theirs', async () => {
      prisma.workout.findFirst.mockResolvedValue(null);

      await expect(kind.assertContext(USER, { workoutId: WORKOUT })).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.workout.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: WORKOUT, userId: USER } }),
      );
    });

    it.each(['in_progress', 'completed'])('accepts a %s workout', async (status) => {
      prisma.workout.findFirst.mockResolvedValue({ status } as never);
      await expect(kind.assertContext(USER, { workoutId: WORKOUT })).resolves.toBeUndefined();
    });
  });

  describe('normalizeValue', () => {
    const value = { exerciseSlug: 'leg_curl', name: 'LEG CURL', rawText: 'LEG CURL', sets: [] };

    it("takes the exercise's name for a known slug (library or the workout owner's own)", async () => {
      prisma.workout.findUnique.mockResolvedValue({ userId: USER } as never);
      prisma.exercise.findFirst.mockResolvedValue({ name: 'Leg curl' } as never);

      await expect(kind.normalizeValue(value, { workoutId: WORKOUT }, 'user')).resolves.toEqual({ ...value, name: 'Leg curl' });
      expect(prisma.exercise.findFirst.mock.calls[0][0]!.where).toEqual({
        slug: 'leg_curl',
        status: 'active',
        OR: [{ ownerUserId: null }, { ownerUserId: USER }],
      });
    });

    it('an unknown slug is a 400 for a user and a named null-slug item for the analyzer', async () => {
      prisma.workout.findUnique.mockResolvedValue({ userId: USER } as never);
      prisma.exercise.findFirst.mockResolvedValue(null);

      await expect(kind.normalizeValue(value, { workoutId: WORKOUT }, 'user')).rejects.toBeInstanceOf(BadRequestException);
      await expect(kind.normalizeValue(value, { workoutId: WORKOUT }, 'analyzer')).resolves.toEqual({
        ...value,
        exerciseSlug: null,
      });
    });

    it('leaves a null-slug value alone', async () => {
      const custom = { ...value, exerciseSlug: null, name: 'Cable thing' };
      await expect(kind.normalizeValue(custom, { workoutId: WORKOUT }, 'user')).resolves.toBe(custom);
      expect(prisma.exercise.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('apply', () => {
    const intake = { id: INTAKE } as PhotoIntake;

    beforeEach(() => {
      tx.$queryRaw.mockResolvedValue([{ id: WORKOUT, status: 'in_progress', started_at: new Date() }] as never);
      tx.photoIntakePhoto.findMany.mockResolvedValue([]);
      tx.exercise.findFirst.mockResolvedValue({ id: 'lib-plank' } as never);
      tx.exercise.findMany.mockResolvedValue([]);
      tx.workoutExercise.create.mockImplementation((async (args: any) => ({ id: `we-${args.data.position}` })) as never);
      tx.setLog.createMany.mockResolvedValue({ count: 0 });
    });

    it('404s a workout that is gone (the lock finds nothing)', async () => {
      tx.$queryRaw.mockResolvedValue([] as never);

      await expect(
        kind.apply({ tx: tx as never, userId: USER, intake, context: { workoutId: WORKOUT }, accepted: [] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('appends after the existing exercises, sets uncompleted and numbered 1..n', async () => {
      tx.workoutExercise.count.mockResolvedValue(2);

      const result = await kind.apply({
        tx: tx as never,
        userId: USER,
        intake,
        context: { workoutId: WORKOUT },
        accepted: [
          item({ exerciseSlug: 'plank', name: 'Plank', rawText: null, sets: [set({ durationSeconds: 60 }), set({ durationSeconds: 45 })] }),
        ],
      });

      expect(result).toEqual({ workoutId: WORKOUT, exercisesAdded: 1, setsAdded: 2, skipped: 0, photosAttached: 0 });
      expect(tx.workoutExercise.create.mock.calls[0][0].data).toEqual({ workoutId: WORKOUT, exerciseId: 'lib-plank', position: 2 });
      expect(tx.setLog.createMany.mock.calls[0][0]!.data).toEqual([
        expect.objectContaining({ workoutExerciseId: 'we-2', setNumber: 1, durationSeconds: 60, completed: false, completedAt: null }),
        expect.objectContaining({ workoutExerciseId: 'we-2', setNumber: 2, durationSeconds: 45, completed: false, completedAt: null }),
      ]);
    });

    it('skips and counts items past the 30-exercise cap without resolving them', async () => {
      tx.workoutExercise.count.mockResolvedValue(29);

      const result = await kind.apply({
        tx: tx as never,
        userId: USER,
        intake,
        context: { workoutId: WORKOUT },
        accepted: [
          item({ exerciseSlug: 'plank', name: 'Plank', rawText: null, sets: [] }),
          item({ exerciseSlug: null, name: 'Brand new thing', rawText: null, sets: [] }),
        ],
      });

      expect(result).toMatchObject({ exercisesAdded: 1, skipped: 1 });
      expect(tx.exercise.create).not.toHaveBeenCalled();
    });

    it('refuses to create a custom exercise past the per-user limit (the transaction rolls back)', async () => {
      tx.workoutExercise.count.mockResolvedValue(0);
      tx.exercise.count.mockResolvedValue(200);

      const error = await kind
        .apply({
          tx: tx as never,
          userId: USER,
          intake,
          context: { workoutId: WORKOUT },
          accepted: [item({ exerciseSlug: null, name: 'Brand new thing', rawText: null, sets: [] })],
        })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(((error as BadRequestException).getResponse() as any).details.reason).toBe('EXERCISE_LIMIT');
    });

    it('refuses an accepted item whose stored value no longer parses', async () => {
      tx.workoutExercise.count.mockResolvedValue(0);

      await expect(
        kind.apply({
          tx: tx as never,
          userId: USER,
          intake,
          context: { workoutId: WORKOUT },
          accepted: [item({ name: '' })],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('attaches every intake photo with skipDuplicates and reports how many were new', async () => {
      tx.workoutExercise.count.mockResolvedValue(0);
      tx.photoIntakePhoto.findMany.mockResolvedValue([{ storageObjectId: 'o1' }, { storageObjectId: 'o2' }] as never);
      tx.workoutPhoto.createMany.mockResolvedValue({ count: 1 });

      const result = await kind.apply({ tx: tx as never, userId: USER, intake, context: { workoutId: WORKOUT }, accepted: [] });

      expect(result.photosAttached).toBe(1);
      expect(tx.workoutPhoto.createMany).toHaveBeenCalledWith({
        data: [
          { workoutId: WORKOUT, storageObjectId: 'o1' },
          { workoutId: WORKOUT, storageObjectId: 'o2' },
        ],
        skipDuplicates: true,
      });
    });
  });
});

