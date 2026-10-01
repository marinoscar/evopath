import { CHECK_IN_METRIC_KEYS } from '../../check-ins/dto/check-in.dto';
import { DUMBBELL_GYM, FIXTURE_NOW, FULL_GYM, LIBRARY, fixtureId } from './context-fixtures';

// =============================================================================
// The data-minimisation canary: a user whose every private field holds a
// unique token, behind a Prisma stand-in for the context loader's reads.
// =============================================================================
//
// Rows are returned WHOLE (the stand-in ignores `select`), so a token can
// only stay out of an agent's request if the loader and the builder never
// copy it. `where` is honoured for the owner, the ids and the metric keys, so
// "another gym" and "lab values" are only reachable by a query that asks for
// them.
//
// H8 (#192): the user also has DISTINCTIVE raw lab and blood-pressure values
// (`CANARY_RAW_VALUES`), a health document with a canary file name, and a
// stored AI health summary. `opts.healthSummaryConsent` turns the opt-in on;
// the summary's narrative (`CANARY_HEALTH_SUMMARY`) is the ONLY health text
// a request may then carry, and no raw value ever.
// =============================================================================

export const CANARY = {
  name: 'CANARY-NAME-7f3a',
  email: 'canary-7f3a@example.test',
  dateOfBirth: '1987-06-05',
  checkInNote: 'CANARY-CHECKIN-NOTE-19c2',
  painNote: 'CANARY-PAIN-NOTE-5d01',
  workoutNote: 'CANARY-WORKOUT-NOTE-88ab',
  measurementNote: 'CANARY-MEASUREMENT-NOTE-2e4f',
  medication: 'CANARY-MEDICATION-44aa',
  lab: 'CANARY-LAB-VALUE-913',
  gymName: 'CANARY-GYM-NAME-0b7c',
  gymNotes: 'CANARY-GYM-NOTES-61d9',
  otherGymName: 'CANARY-OTHER-GYM-3c3c',
  otherGymCapability: 'canary_other_gym_capability',
  storageKey: 'canary/storage/key-a1b2.jpg',
  bio: 'CANARY-BIO-TEXT-6e6e',
} as const;

/** Raw lab and vital values seeded for the canary: never in any agent request, opt-in or not. */
export const CANARY_RAW_VALUES = ['487.123', '13.579', '163.33', '97.531'] as const;

/** The canary user's stored, ready AI health summary (no raw value in it, by construction of the job). */
export const CANARY_HEALTH_SUMMARY = {
  narrative:
    'CANARY-SUMMARY-NARRATIVE: blood pressure trends above the usual range; one iron marker is below its reference range, ' +
    'and a clinician follow-up is recommended. Prefer moderate intensity.',
  consideration: 'CANARY-SUMMARY-CONSIDERATION: avoid maximal efforts until blood pressure is reviewed.',
  inputsHash: 'CANARY-SUMMARY-INPUTS-HASH-77aa',
  documentName: 'CANARY-DOCUMENT-NAME-lab-results.pdf',
} as const;

/** Every token that must never reach a model (the bio only when `includeBio` is off). */
export const CANARY_TOKENS: readonly string[] = [
  CANARY.name,
  CANARY.email,
  CANARY.dateOfBirth,
  '1987',
  CANARY.checkInNote,
  CANARY.painNote,
  CANARY.workoutNote,
  CANARY.measurementNote,
  CANARY.medication,
  CANARY.lab,
  CANARY.gymName,
  CANARY.gymNotes,
  CANARY.otherGymName,
  CANARY.otherGymCapability,
  CANARY.storageKey,
];

export const CANARY_USER = fixtureId(501, 'f');
export const CANARY_GYM = fixtureId(502, 'f');
export const CANARY_OTHER_GYM = fixtureId(503, 'f');

type Where = Record<string, unknown>;
const DAY = 24 * 60 * 60 * 1000;

function metricMatches(where: Where, metricKey: string): boolean {
  const wanted = where.metricKey as string | { in?: string[] } | undefined;
  if (wanted === undefined) return true;
  if (typeof wanted === 'string') return wanted === metricKey;
  return wanted.in?.includes(metricKey) ?? true;
}

/** A Prisma stand-in holding the canary user's rows. */
export function createCanaryPrisma(opts: { userId?: string; healthSummaryConsent?: boolean } = {}) {
  const userId = opts.userId ?? CANARY_USER;
  const at = (days: number) => new Date(FIXTURE_NOW.getTime() - days * DAY);
  const measurement = (metricKey: string, value: number, days: number, notes: string, localDate?: string) => ({
    id: `${metricKey}-${days}`,
    userId,
    metricKey,
    value,
    unit: 'x',
    measuredAt: at(days),
    localDate: localDate ? new Date(`${localDate}T00:00:00.000Z`) : null,
    notes,
    sourceRef: { storageKey: CANARY.storageKey },
    supersededAt: null,
    deletedAt: null,
  });

  const measurements = [
    measurement('weight', 82, 1, CANARY.measurementNote),
    measurement('weight', 83, 20, CANARY.measurementNote),
    measurement('body_fat_pct', 22, 5, CANARY.measurementNote),
    measurement('bp_systolic', 150, 2, CANARY.lab),
    // Lab results (H3, #187): the registry's `lab` category, with range context.
    ...['ldl_cholesterol', 'hba1c', 'testosterone_total'].map((key, i) => ({
      ...measurement(key, 913 + i, 3 + i, CANARY.lab),
      referenceText: CANARY.lab,
      flag: 'high',
    })),
    measurement('medication', 1, 2, CANARY.medication),
    // H8 (#192): distinctive raw values the opt-in health summary must never let through.
    { ...measurement('ferritin', Number(CANARY_RAW_VALUES[0]), 4, CANARY.lab), referenceText: CANARY.lab, flag: 'low', referenceLow: 487.5, referenceHigh: 900 },
    { ...measurement('hemoglobin', Number(CANARY_RAW_VALUES[1]), 4, CANARY.lab), flag: 'low' },
    measurement('bp_systolic', Number(CANARY_RAW_VALUES[2]), 1, CANARY.lab),
    measurement('bp_diastolic', Number(CANARY_RAW_VALUES[3]), 1, CANARY.lab),
    ...CHECK_IN_METRIC_KEYS.map((key, i) => measurement(key, 3 + (i % 2), 1, CANARY.checkInNote, '2026-09-29')),
  ];

  const gyms = [
    { id: CANARY_GYM, userId, name: CANARY.gymName, notes: CANARY.gymNotes, latitude: 9.93, longitude: -84.08 },
    { id: CANARY_OTHER_GYM, userId, name: CANARY.otherGymName, notes: null, latitude: null, longitude: null },
  ];
  const gymEquipment = [
    ...FULL_GYM.equipment.map((e) => ({
      gymId: CANARY_GYM,
      equipmentTypeId: e.equipmentTypeId,
      notes: CANARY.gymNotes,
      equipmentType: { slug: e.slug, category: e.category, name: CANARY.gymName },
    })),
    ...DUMBBELL_GYM.equipment.map((e) => ({
      gymId: CANARY_OTHER_GYM,
      equipmentTypeId: `${e.equipmentTypeId.slice(0, -1)}9`,
      notes: null,
      equipmentType: { slug: CANARY.otherGymCapability, category: 'free_weights' },
    })),
  ];
  const capabilityOf = new Map<string, Array<{ id: string; slug: string }>>();
  for (const e of FULL_GYM.equipment) capabilityOf.set(e.equipmentTypeId, FULL_GYM.capabilities);

  const sets = (painFlag: boolean) => [
    { weightKg: 60, reps: 8, completed: true, isWarmup: false, painFlag, painNote: painFlag ? CANARY.painNote : null, notes: CANARY.workoutNote },
  ];

  const prisma = {
    user: { findUnique: jest.fn(async () => ({ id: userId, name: CANARY.name, email: CANARY.email })) },
    healthProfile: {
      findUnique: jest.fn(async (args: { where: { userId: string } }) =>
        args.where.userId === userId
          ? { userId, dateOfBirth: new Date(`${CANARY.dateOfBirth}T00:00:00.000Z`), sexAtBirth: 'male', heightMm: 1800, unitSystem: 'metric', timeZone: 'UTC', bio: CANARY.bio }
          : null,
      ),
    },
    measurement: {
      findMany: jest.fn(async (args: { where: Where }) =>
        measurements.filter((m) => args.where.userId === m.userId && metricMatches(args.where, m.metricKey)),
      ),
      findFirst: jest.fn(async (args: { where: Where }) => {
        const rows = measurements
          .filter((m) => args.where.userId === m.userId && metricMatches(args.where, m.metricKey))
          .sort((a, b) => b.measuredAt.getTime() - a.measuredAt.getTime());
        return rows[0] ?? null;
      }),
    },
    gym: {
      findFirst: jest.fn(async (args: { where: { id: string; userId: string } }) =>
        gyms.find((g) => g.id === args.where.id && g.userId === args.where.userId) ?? null,
      ),
    },
    gymEquipment: {
      findMany: jest.fn(async (args: { where: { gymId: string } }) => gymEquipment.filter((e) => e.gymId === args.where.gymId)),
    },
    equipmentTypeCapability: {
      findMany: jest.fn(async (args: { where: { equipmentTypeId: { in: string[] } } }) =>
        args.where.equipmentTypeId.in.flatMap((id) => (capabilityOf.get(id) ?? []).map((capability) => ({ capability }))),
      ),
    },
    exercise: {
      findMany: jest.fn(async () =>
        LIBRARY.map((e) => ({
          id: e.id,
          slug: e.key,
          name: e.name,
          ownerUserId: null,
          notes: CANARY.workoutNote,
          primaryMuscles: e.primaryMuscles,
          secondaryMuscles: e.secondaryMuscles,
          movementPattern: e.movementPattern,
          trackingMode: e.trackingMode,
          isUnilateral: e.isUnilateral,
          isBodyweight: e.isBodyweight,
          requirements: e.requirements.map((r) => ({ ...r, equipmentType: null, capability: null })),
        })),
      ),
    },
    workout: {
      findMany: jest.fn(async (args: { where: { userId: string } }) =>
        args.where.userId !== userId
          ? []
          : [
              {
                date: new Date('2026-09-28T00:00:00.000Z'),
                startedAt: at(2),
                status: 'completed',
                name: CANARY.workoutNote,
                notes: CANARY.workoutNote,
                gymId: CANARY_OTHER_GYM,
                exercises: [
                  { exerciseId: LIBRARY.find((e) => e.key === 'barbell_bench_press')!.id, notes: CANARY.workoutNote, sets: sets(false) },
                  { exerciseId: LIBRARY.find((e) => e.key === 'barbell_row')!.id, notes: CANARY.workoutNote, sets: sets(true) },
                ],
              },
            ],
      ),
    },
    program: { findFirst: jest.fn(async () => null) },
    healthDocument: {
      findMany: jest.fn(async () => [{ id: 'doc-1', userId, kind: 'lab_report', originalName: CANARY_HEALTH_SUMMARY.documentName }]),
    },
    healthSummarySetting: {
      findUnique: jest.fn(async (args: { where: { userId: string } }) =>
        args.where.userId === userId && opts.healthSummaryConsent !== undefined
          ? { userId, enabled: opts.healthSummaryConsent, consentedAt: at(10) }
          : null,
      ),
    },
    healthSummary: {
      findFirst: jest.fn(async (args: { where: { userId: string; status?: string } }) =>
        args.where.userId === userId
          ? {
              id: 'summary-1',
              userId,
              version: 2,
              status: 'ready',
              narrative: CANARY_HEALTH_SUMMARY.narrative,
              trainingConsiderations: [{ text: CANARY_HEALTH_SUMMARY.consideration, severity: 'caution', conservative: true }],
              dataAsOf: new Date('2026-09-29T00:00:00.000Z'),
              inputsHash: CANARY_HEALTH_SUMMARY.inputsHash,
              provider: 'openai',
              model: CANARY.storageKey,
              createdAt: at(1),
            }
          : null,
      ),
    },
  };

  return prisma;
}
