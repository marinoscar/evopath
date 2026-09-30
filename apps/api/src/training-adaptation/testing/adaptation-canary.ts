import type { CheckInsService } from '../../check-ins/check-ins.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { TrainingTodayService } from '../../programs/today/training-today.service';
import type { PlannerContextLoader } from '../../training-agents/context/planner-context.loader';
import { ET, LIB, LIBRARY, fixtureId } from '../../training-agents/testing/context-fixtures';
import { AdaptationContextBuilder } from '../context/adaptation-context.builder';

// =============================================================================
// The adaptation data-minimisation canary
// =============================================================================
//
// The REAL `AdaptationContextBuilder` over a Prisma stand-in that returns every
// row WHOLE (it ignores `select`), each with a unique canary token in its
// private columns, plus stand-ins for every table the builder must NEVER read
// (the user, labs, medications, weight history, ...): those record the read and
// answer a row full of tokens. A token can only stay out of the context and the
// provider requests if the builder never copies the field, and
// `forbiddenReads` must stay empty.
//
// Rows are scoped: a query that does not carry the caller's id finds another
// user's row only if it asks for it.
// =============================================================================

export const CANARY = {
  displayName: 'CANARY-DISPLAY-NAME-7f3a',
  email: 'canary-7f3a@example.test',
  dateOfBirth: '1987-06-05',
  timeZone: 'Pacific/Canary',
  medication: 'CANARY-MEDICATION-44aa',
  lab: 'CANARY-LAB-VALUE-913',
  weightHistory: 'CANARY-WEIGHT-HISTORY-77.7',
  gymName: 'CANARY-GYM-NAME-0b7c',
  gymNotes: 'CANARY-GYM-NOTES-61d9',
  latitude: 9.9281,
  longitude: -84.0907,
  photo: 'canary/photos/gym-a1b2.jpg',
  storageKey: 'canary/storage/key-a1b2.jpg',
  checkInNote: 'CANARY-CHECKIN-NOTE-19c2',
  painNote: 'CANARY-PAIN-NOTE-5d01',
  workoutNote: 'CANARY-WORKOUT-NOTE-88ab',
  intakeName: 'CANARY-INTAKE-NAME',
  planName: 'CANARY-PLAN-NAME',
  exerciseNote: 'CANARY-EXERCISE-NOTE',
  otherGym: 'CANARY-OTHER-GYM',
  theirGym: 'CANARY-THEIR-GYM',
} as const;

/** Every string a model request must never contain. */
export const CANARY_TOKENS: readonly string[] = Object.values(CANARY).map(String);

export const CANARY_NOW = new Date('2026-09-30T12:00:00.000Z');
export const CANARY_SOMEONE_ELSE = fixtureId(2, 'a');
export const CANARY_PLAN_GYM = fixtureId(10, 'b');
export const CANARY_DEFAULT_GYM = fixtureId(11, 'b');
export const CANARY_OTHER_GYM = fixtureId(12, 'b');
export const CANARY_THEIR_GYM = fixtureId(13, 'b');
export const CANARY_PROGRAM = fixtureId(20, 'p');
export const CANARY_PROGRAM_WORKOUT = fixtureId(21, 'p');
export const CANARY_VERSION_ID = fixtureId(22, 'p');

/** Tables a context read has no business touching. */
export const FORBIDDEN_TABLES = ['user', 'userIdentity', 'healthProfile', 'healthMeasurement', 'medication', 'biomarker', 'healthDocument', 'userSettings', 'checkIn'] as const;

type Row = Record<string, unknown>;

export interface CanarySourceOptions {
  /** The caller. */
  userId: string;
  /** The plan's gym: a row id, `null` (none: the default gym) or a missing id. Default the plan gym. */
  programGymId?: string | null;
  hasProgram?: boolean;
  planned?: 'workout' | 'rest';
  /** The check-in scores; `null` for none. */
  checkIn?: { energy: number | null; sleepQuality: number | null; soreness: number | null; stress: number | null } | null;
}

export function createCanaryAdaptationSource(opts: CanarySourceOptions) {
  const me = opts.userId;
  const queries: Array<{ model: string; args: Row }> = [];
  const forbiddenReads: string[] = [];
  const record = (model: string, args: Row) => queries.push({ model, args });

  const gyms: Row[] = [
    { id: CANARY_PLAN_GYM, userId: me, type: 'home', isDefault: false, name: CANARY.gymName, notes: CANARY.gymNotes, latitude: CANARY.latitude, longitude: CANARY.longitude, photoKey: CANARY.photo },
    { id: CANARY_DEFAULT_GYM, userId: me, type: 'commercial', isDefault: true, name: CANARY.gymName, notes: CANARY.gymNotes, latitude: CANARY.latitude, longitude: CANARY.longitude },
    { id: CANARY_OTHER_GYM, userId: me, type: 'garage', isDefault: false, name: CANARY.otherGym, notes: null },
    { id: CANARY_THEIR_GYM, userId: CANARY_SOMEONE_ELSE, type: 'commercial', isDefault: false, name: CANARY.theirGym, notes: null },
  ];

  const equipmentByGym: Record<string, Row[]> = {
    [CANARY_PLAN_GYM]: [
      { gymId: CANARY_PLAN_GYM, equipmentTypeId: ET.dumbbells, quantity: 2, equipmentType: { name: 'Dumbbells', slug: 'dumbbells' }, notes: CANARY.gymNotes },
      { gymId: CANARY_PLAN_GYM, equipmentTypeId: ET.flat_bench, quantity: 1, equipmentType: { name: 'Flat bench', slug: 'flat_bench' }, notes: CANARY.gymNotes },
    ],
    [CANARY_DEFAULT_GYM]: [
      { gymId: CANARY_DEFAULT_GYM, equipmentTypeId: ET.dumbbells, quantity: 1, equipmentType: { name: 'Dumbbells' } },
      { gymId: CANARY_DEFAULT_GYM, equipmentTypeId: ET.flat_bench, quantity: 1, equipmentType: { name: 'Flat bench' } },
    ],
    [CANARY_OTHER_GYM]: [{ gymId: CANARY_OTHER_GYM, equipmentTypeId: ET.treadmill, quantity: 1, equipmentType: { name: 'Treadmill' } }],
  };

  const program =
    opts.hasProgram === false
      ? null
      : {
          id: CANARY_PROGRAM,
          userId: me,
          status: 'active',
          goal: 'hypertrophy',
          gymId: opts.programGymId === undefined ? CANARY_PLAN_GYM : opts.programGymId,
          currentVersion: 3,
          intake: { experience: 'intermediate', avoidExerciseKeys: [], limitations: [], displayName: CANARY.intakeName },
          name: CANARY.planName,
        };

  const prisma = {
    program: {
      findFirst: jest.fn(async (args: { where: Row }) => {
        record('program', args);
        return program && (args.where.userId === undefined || args.where.userId === me) ? program : null;
      }),
    },
    programVersion: {
      findUnique: jest.fn(async (args: Row) => {
        record('programVersion', args);
        return { id: CANARY_VERSION_ID };
      }),
    },
    gym: {
      findFirst: jest.fn(async (args: { where: Row }) => {
        record('gym', args);
        return (
          gyms.find(
            (g) =>
              (args.where.id === undefined || g.id === args.where.id) &&
              g.userId === args.where.userId &&
              (args.where.isDefault === undefined || g.isDefault === args.where.isDefault),
          ) ?? null
        );
      }),
    },
    gymEquipment: {
      findMany: jest.fn(async (args: { where: { gymId: string; gym: { userId: string } } }) => {
        record('gymEquipment', args);
        return args.where.gym.userId === me ? (equipmentByGym[args.where.gymId] ?? []) : [];
      }),
    },
    equipmentTypeCapability: {
      findMany: jest.fn(async (args: Row) => {
        record('equipmentTypeCapability', args);
        return [{ equipmentTypeId: ET.dumbbells, capability: { id: fixtureId(7, 'c'), slug: 'goblet_squat' } }];
      }),
    },
    setLog: {
      findMany: jest.fn(async (args: Row) => {
        record('setLog', args);
        return [{ painNote: CANARY.painNote, workoutNote: CANARY.workoutNote, workoutExercise: { exerciseId: LIB.dumbbell_curl.id } }];
      }),
    },
  };

  const forbiddenRow: Row = {
    name: CANARY.displayName,
    displayName: CANARY.displayName,
    email: CANARY.email,
    dateOfBirth: CANARY.dateOfBirth,
    timeZone: CANARY.timeZone,
    medication: CANARY.medication,
    lab: CANARY.lab,
    value: CANARY.lab,
    weightHistory: CANARY.weightHistory,
    notes: CANARY.checkInNote,
    storageKey: CANARY.storageKey,
  };

  /** Any table the builder should not read: recorded, and answered with a row full of tokens. */
  const guarded = new Proxy(prisma, {
    get(target, prop) {
      if (prop in target) return (target as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return new Proxy(
        {},
        {
          get: (_t, method) => async () => {
            forbiddenReads.push(`${prop}.${String(method)}`);
            return String(method) === 'findMany' ? [forbiddenRow] : forbiddenRow;
          },
        },
      );
    },
  }) as unknown as PrismaService;

  const checkIn =
    opts.checkIn === undefined
      ? { energy: 3, sleepQuality: 4, soreness: 2, stress: 2 }
      : opts.checkIn;

  const checkIns = {
    today: jest.fn(async () => '2026-09-30'),
    getForDate: jest.fn(async () =>
      checkIn ? { ...checkIn, note: CANARY.checkInNote, userId: me, timeZone: CANARY.timeZone } : null,
    ),
  };

  const session = {
    programId: CANARY_PROGRAM,
    planVersion: 3,
    programWorkoutId: CANARY_PROGRAM_WORKOUT,
    name: 'Upper A',
    weekNumber: 2,
    totalWeeks: 8,
    isDeload: false,
    estimatedMinutes: 60,
    exercises: [LIB.barbell_bench_press, LIB.dumbbell_curl].map((exercise, i) => ({
      exercise: { id: exercise.id, slug: exercise.key, name: exercise.name, primaryMuscles: exercise.primaryMuscles, trackingMode: exercise.trackingMode, notes: CANARY.exerciseNote },
      isPriority: i === 0,
      sets: 3,
      repMin: 8,
      repMax: 10,
      targetRpe: 8,
      restSeconds: 90,
      targetLoadKg: 60,
      loadGuidance: 'fixed',
      lastTime: i === 0 ? { performedOn: '2026-09-25', topSet: { weightKg: 60, reps: 8 } } : null,
    })),
  };
  const todayService = {
    today: jest.fn(async () => (opts.planned === 'rest' ? { kind: 'rest' } : { kind: 'workout', session })),
  };
  const library = { loadLibrary: jest.fn(async () => LIBRARY) };

  const builder = new AdaptationContextBuilder(
    guarded,
    checkIns as unknown as CheckInsService,
    todayService as unknown as TrainingTodayService,
    library as unknown as PlannerContextLoader,
  );

  return { builder, prisma, guarded, checkIns, todayService, library, queries, forbiddenReads, program };
}
