import { CAP, ET, FIXTURE_NOW, LIB, LIBRARY, fixtureId } from '../../training-agents/testing/context-fixtures';
import type { AdaptationContext, BaseExercise } from '../context/adaptation-context.contract';
import { type AdaptationContextSource, buildAdaptationContext } from '../context/build-adaptation-context';
import type { AdaptationCritiqueModel } from '../contracts/adaptation-critique.contract';
import type { AdaptationProposalModel } from '../contracts/adapted-workout.contract';
import { type AdaptationRequest, type AdaptationRequestInput, adaptationRequestSchema } from '../dto/adaptation-request.dto';

// =============================================================================
// Fixtures for adaptation specs: a planned "Upper A", gyms, requests, answers
// =============================================================================
//
// Built on the E5 kit's small exercise library (`LIB`, `ET`, `CAP`), so
// expectations can name exercises by key. Everything is deterministic
// (`FIXTURE_NOW`, fixed ids).
// =============================================================================

export const ADAPT_FIXTURE_TODAY = '2026-09-30';
export const ADAPT_PROGRAM_ID = fixtureId(700, 'p');
export const ADAPT_PROGRAM_WORKOUT_ID = fixtureId(701, 'p');
export const ADAPT_PLAN_VERSION_ID = fixtureId(702, 'p');
export const ADAPT_GYM_ID = fixtureId(703, 'b');

type Gym = NonNullable<AdaptationContextSource['gym']>;

function gym(equipment: Array<keyof typeof ET>, capabilities: Array<[keyof typeof ET, keyof typeof CAP]>): Gym {
  return {
    id: ADAPT_GYM_ID,
    type: 'commercial',
    equipment: equipment.map((slug) => ({ equipmentTypeId: ET[slug], name: slug.replace(/_/g, ' '), quantity: 1 })),
    capabilities: capabilities.map(([type, capability]) => ({ equipmentTypeId: ET[type], id: CAP[capability], slug: capability })),
  };
}

/** A full commercial gym (no treadmill). */
export const ADAPT_FULL_GYM: Gym = gym(
  ['barbell', 'dumbbells', 'flat_bench', 'squat_rack', 'cable_machine', 'leg_press_machine', 'resistance_bands', 'pullup_bar', 'chest_press_machine', 'assisted_pullup_machine'],
  [
    ['leg_press_machine', 'leg_press'],
    ['cable_machine', 'lat_pulldown'],
    ['cable_machine', 'triceps_pushdown'],
    ['cable_machine', 'cable_fly'],
    ['pullup_bar', 'pull_up'],
    ['chest_press_machine', 'chest_press'],
    ['dumbbells', 'goblet_squat'],
    ['assisted_pullup_machine', 'assisted_pull_up'],
  ],
);

function planned(key: string, over: Partial<BaseExercise> = {}): BaseExercise {
  const lib = LIB[key];
  if (!lib) throw new Error(`No fixture exercise ${key}`);
  return {
    exerciseId: lib.id,
    key,
    name: lib.name,
    primaryMuscles: [...lib.primaryMuscles],
    trackingMode: lib.trackingMode,
    isPriority: false,
    sets: 3,
    repMin: 10,
    repMax: 12,
    targetRpe: 8,
    restSeconds: 90,
    targetLoadKg: null,
    loadGuidance: 'from_history',
    lastTime: null,
    ...over,
  };
}

/** Today's planned "Upper A": 20 working sets, about 60 minutes. */
export const UPPER_A: BaseExercise[] = [
  planned('barbell_bench_press', { isPriority: true, sets: 4, repMin: 5, repMax: 8, restSeconds: 150, targetLoadKg: 80, loadGuidance: 'fixed' }),
  planned('barbell_row', { isPriority: true, sets: 4, repMin: 6, repMax: 10, restSeconds: 120 }),
  planned('dumbbell_shoulder_press', { sets: 3, repMin: 8, repMax: 12 }),
  planned('cable_fly', { sets: 3, repMin: 12, repMax: 15, restSeconds: 60 }),
  planned('triceps_pushdown', { sets: 3, repMin: 10, repMax: 15, restSeconds: 60 }),
  planned('dumbbell_curl', { sets: 3, repMin: 10, repMax: 12, restSeconds: 60 }),
];

export function adaptationRequestFixture(input: Partial<AdaptationRequestInput> = { minutes: 30 }): AdaptationRequest {
  return adaptationRequestSchema.parse(input);
}

/** A context source: the full gym, "Upper A" planned today, no check-in, no pain flags. */
export function adaptationSourceFixture(over: Partial<AdaptationContextSource> & { request?: AdaptationRequest } = {}): AdaptationContextSource {
  return {
    now: FIXTURE_NOW,
    today: ADAPT_FIXTURE_TODAY,
    request: adaptationRequestFixture(),
    program: {
      id: ADAPT_PROGRAM_ID,
      goal: 'hypertrophy',
      intake: { experience: 'intermediate', avoidExerciseKeys: [], limitations: [] },
      gymId: ADAPT_GYM_ID,
    },
    planned: {
      programId: ADAPT_PROGRAM_ID,
      planVersion: 3,
      planVersionId: ADAPT_PLAN_VERSION_ID,
      programWorkoutId: ADAPT_PROGRAM_WORKOUT_ID,
      name: 'Upper A',
      date: ADAPT_FIXTURE_TODAY,
      weekNumber: 2,
      totalWeeks: 8,
      isDeload: false,
      estimatedMinutes: 60,
      exercises: UPPER_A,
    },
    gym: ADAPT_FULL_GYM,
    library: LIBRARY,
    painFlagExerciseIds: [],
    checkIn: null,
    ...over,
  };
}

/** A built context (the same pure builder production uses). */
export function adaptationContextFixture(over: Parameters<typeof adaptationSourceFixture>[0] = {}): AdaptationContext {
  return buildAdaptationContext(adaptationSourceFixture(over));
}

/** A dumbbells-only request against the full gym ("only dumbbells", with the bench). */
export function onlyDumbbellsRequest(extra: Partial<AdaptationRequestInput> = {}): AdaptationRequest {
  return adaptationRequestFixture({
    equipment: { mode: 'only', equipmentTypeIds: [ET.dumbbells, ET.flat_bench] },
    ...extra,
  });
}

type ModelExercise = AdaptationProposalModel['exercises'][number];

export function modelExercise(key: string, over: Partial<ModelExercise> = {}): ModelExercise {
  return {
    exerciseKey: key,
    source: 'kept',
    replacesExerciseKey: null,
    isPriority: false,
    sets: 3,
    repMin: 8,
    repMax: 12,
    targetRpe: 7,
    restSeconds: 90,
    note: null,
    ...over,
  };
}

/** A planner answer (the model-facing shape). */
export function proposalAnswer(exercises: ModelExercise[], over: Partial<AdaptationProposalModel> = {}): AdaptationProposalModel {
  return {
    title: 'Upper A, 30 minutes',
    summary: 'The main presses and rows, trimmed to fit.',
    estimatedMinutes: 30,
    exercises,
    dropped: [],
    rationale: ['Kept the priority lifts.'],
    uncertainty: [],
    ...over,
  };
}

/** A good 30-minute, dumbbells-only answer for "Upper A". */
export const DUMBBELL_30_ANSWER: AdaptationProposalModel = proposalAnswer(
  [
    modelExercise('dumbbell_bench_press', { source: 'swapped', replacesExerciseKey: 'barbell_bench_press', isPriority: true, sets: 3, repMin: 8, repMax: 10, restSeconds: 90 }),
    modelExercise('dumbbell_row', { source: 'swapped', replacesExerciseKey: 'barbell_row', isPriority: true, sets: 3, repMin: 8, repMax: 10, restSeconds: 90 }),
    modelExercise('dumbbell_shoulder_press', { sets: 2, restSeconds: 60 }),
  ],
  {
    dropped: [
      { exerciseKey: 'cable_fly', reason: 'equipment' },
      { exerciseKey: 'triceps_pushdown', reason: 'equipment' },
      { exerciseKey: 'dumbbell_curl', reason: 'time' },
    ],
  },
);

export function critiqueAnswer(verdict: 'accept' | 'revise', issues: AdaptationCritiqueModel['issues'] = []): AdaptationCritiqueModel {
  return {
    verdict,
    checks: { honoursRequest: true, preservesIntent: true, avoidsSoreAreas: true, sensibleOrder: true },
    issues,
  };
}

export const ACCEPT = critiqueAnswer('accept');
export const REVISE_MAJOR = critiqueAnswer('revise', [{ code: 'misses_request', severity: 'major', note: 'Trains the sore chest too hard.' }]);
