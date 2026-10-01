import { buildTrainingRunContext, type PlannerContextSource } from '../context/build-planner-context';
import type { ImplementClass, LibraryExercise, TrainingRunContext } from '../context/planner-context.contract';
import type { TrainingIntakeInput } from '../contracts/training-intake.contract';
import { intakeFixture } from './intake-fixtures';

// =============================================================================
// A small exercise library, gyms and a context source for context, compiler,
// guardrail and planner specs. Ids are fixed so expectations can name them.
// =============================================================================

/** A stable uuid from a small number (`fixtureId(7)` -> `00000000-0000-4000-8000-000000000007`). */
export function fixtureId(n: number, prefix = '0'): string {
  return `${prefix.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

let nextEquipment = 1;
const et = () => fixtureId(nextEquipment++, 'e');
/** Equipment type ids. */
export const ET = {
  barbell: et(),
  dumbbells: et(),
  flat_bench: et(),
  squat_rack: et(),
  cable_machine: et(),
  leg_press_machine: et(),
  resistance_bands: et(),
  pullup_bar: et(),
  treadmill: et(),
  chest_press_machine: et(),
  assisted_pullup_machine: et(),
} as const;

let nextCapability = 1;
const cap = () => fixtureId(nextCapability++, 'c');
/** Capability ids. */
export const CAP = {
  leg_press: cap(),
  lat_pulldown: cap(),
  triceps_pushdown: cap(),
  pull_up: cap(),
  chest_press: cap(),
  cable_fly: cap(),
  goblet_squat: cap(),
  assisted_pull_up: cap(),
} as const;

type Req = Array<Array<{ e?: keyof typeof ET; c?: keyof typeof CAP }>>;

let nextExercise = 1;
function ex(
  key: string,
  movementPattern: string,
  primaryMuscles: string[],
  implement: ImplementClass,
  requirements: Req,
  extra: Partial<LibraryExercise> = {},
): LibraryExercise {
  const id = fixtureId(nextExercise++, 'a');
  const isBodyweight = implement === 'bodyweight';
  return {
    id,
    key,
    name: key
      .split('_')
      .map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w))
      .join(' '),
    primaryMuscles,
    secondaryMuscles: [],
    movementPattern,
    trackingMode: isBodyweight ? 'bodyweight_reps' : 'weight_reps',
    isCompound: !['isolation', 'core', 'cardio'].includes(movementPattern),
    isUnilateral: false,
    isBodyweight,
    implement,
    requirements: requirements.flatMap((group, groupIndex) =>
      group.map((option) => ({
        groupIndex,
        equipmentTypeId: option.e ? ET[option.e] : null,
        capabilityId: option.c ? CAP[option.c] : null,
      })),
    ),
    ...extra,
  };
}

export const LIBRARY: LibraryExercise[] = [
  ex('barbell_back_squat', 'squat', ['quads', 'glutes'], 'barbell', [[{ e: 'barbell' }], [{ e: 'squat_rack' }]]),
  ex('goblet_squat', 'squat', ['quads', 'glutes'], 'dumbbell', [[{ c: 'goblet_squat' }]]),
  ex('leg_press', 'squat', ['quads', 'glutes'], 'machine', [[{ c: 'leg_press' }]]),
  ex('bodyweight_squat', 'squat', ['quads', 'glutes'], 'bodyweight', []),
  ex('barbell_bench_press', 'horizontal_push', ['chest', 'triceps'], 'barbell', [[{ e: 'barbell' }], [{ e: 'flat_bench' }]]),
  ex('dumbbell_bench_press', 'horizontal_push', ['chest', 'triceps'], 'dumbbell', [[{ e: 'dumbbells' }], [{ e: 'flat_bench' }]]),
  ex('machine_chest_press', 'horizontal_push', ['chest', 'triceps'], 'machine', [[{ c: 'chest_press' }]]),
  ex('push_up', 'horizontal_push', ['chest', 'triceps'], 'bodyweight', []),
  ex('cable_fly', 'isolation', ['chest'], 'cable', [[{ c: 'cable_fly' }]]),
  ex('barbell_row', 'horizontal_pull', ['upper_back', 'lats'], 'barbell', [[{ e: 'barbell' }]]),
  ex('dumbbell_row', 'horizontal_pull', ['upper_back', 'lats'], 'dumbbell', [[{ e: 'dumbbells' }]]),
  ex('seated_cable_row', 'horizontal_pull', ['upper_back', 'lats'], 'cable', [[{ e: 'cable_machine' }]]),
  ex('machine_row', 'horizontal_pull', ['upper_back', 'lats'], 'machine', [[{ c: 'chest_press' }]]),
  ex('inverted_row', 'horizontal_pull', ['upper_back'], 'bodyweight', [[{ e: 'squat_rack' }, { e: 'pullup_bar' }]]),
  ex('band_row', 'horizontal_pull', ['upper_back', 'lats'], 'band', [[{ e: 'resistance_bands' }]]),
  ex('lat_pulldown', 'vertical_pull', ['lats', 'biceps'], 'cable', [[{ c: 'lat_pulldown' }]]),
  ex('pull_up', 'vertical_pull', ['lats', 'biceps'], 'bodyweight', [[{ c: 'pull_up' }]]),
  ex('assisted_pull_up', 'vertical_pull', ['lats', 'biceps'], 'machine', [[{ c: 'assisted_pull_up' }]]),
  ex('band_pulldown', 'vertical_pull', ['lats', 'biceps'], 'band', [[{ e: 'resistance_bands' }]]),
  ex('barbell_overhead_press', 'vertical_push', ['shoulders', 'triceps'], 'barbell', [[{ e: 'barbell' }]]),
  ex('dumbbell_shoulder_press', 'vertical_push', ['shoulders', 'triceps'], 'dumbbell', [[{ e: 'dumbbells' }]]),
  ex('pike_push_up', 'vertical_push', ['shoulders', 'triceps'], 'bodyweight', []),
  ex('romanian_deadlift', 'hinge', ['hamstrings', 'glutes'], 'barbell', [[{ e: 'barbell' }]]),
  ex('dumbbell_romanian_deadlift', 'hinge', ['hamstrings', 'glutes'], 'dumbbell', [[{ e: 'dumbbells' }]]),
  ex('glute_bridge', 'hinge', ['glutes'], 'bodyweight', []),
  ex('dumbbell_curl', 'isolation', ['biceps'], 'dumbbell', [[{ e: 'dumbbells' }]]),
  ex('cable_curl', 'isolation', ['biceps'], 'cable', [[{ e: 'cable_machine' }]]),
  ex('triceps_pushdown', 'isolation', ['triceps'], 'cable', [[{ c: 'triceps_pushdown' }]]),
  ex('dumbbell_lateral_raise', 'isolation', ['shoulders'], 'dumbbell', [[{ e: 'dumbbells' }]]),
  ex('plank', 'core', ['abs'], 'bodyweight', [], { trackingMode: 'time' }),
  ex('walking_lunge', 'lunge', ['quads', 'glutes'], 'bodyweight', []),
  ex('dumbbell_lunge', 'lunge', ['quads', 'glutes'], 'dumbbell', [[{ e: 'dumbbells' }]]),
  ex('treadmill_run', 'cardio', ['full_body'], 'machine', [[{ e: 'treadmill' }]], { trackingMode: 'distance_time' }),
];

/** The library by key. */
export const LIB: Readonly<Record<string, LibraryExercise>> = Object.fromEntries(LIBRARY.map((e) => [e.key, e]));

export type FixtureGym = NonNullable<PlannerContextSource['gym']>;

function gymOf(equipment: Array<[keyof typeof ET, string]>, capabilities: Array<keyof typeof CAP>): FixtureGym {
  return {
    equipment: equipment.map(([slug, category]) => ({ equipmentTypeId: ET[slug], slug, category })),
    capabilities: capabilities.map((slug) => ({ id: CAP[slug], slug })),
  };
}

/** Everything but the treadmill. */
export const FULL_GYM: FixtureGym = gymOf(
  [
    ['barbell', 'free_weights'],
    ['dumbbells', 'free_weights'],
    ['flat_bench', 'benches_racks'],
    ['squat_rack', 'benches_racks'],
    ['cable_machine', 'cable'],
    ['leg_press_machine', 'plate_loaded'],
    ['resistance_bands', 'accessories'],
    ['pullup_bar', 'bodyweight'],
    ['chest_press_machine', 'selectorized'],
    ['assisted_pullup_machine', 'selectorized'],
  ],
  ['leg_press', 'lat_pulldown', 'triceps_pushdown', 'pull_up', 'chest_press', 'cable_fly', 'goblet_squat', 'assisted_pull_up'],
);

/** Dumbbells and a bench. */
export const DUMBBELL_GYM: FixtureGym = gymOf(
  [
    ['dumbbells', 'free_weights'],
    ['flat_bench', 'benches_racks'],
  ],
  ['goblet_squat'],
);

/** The gym fixture as the inventory ids the guardrails read. */
export function inventoryOf(gym: FixtureGym | null) {
  return gym
    ? { equipmentTypeIds: gym.equipment.map((e) => e.equipmentTypeId).sort(), capabilityIds: gym.capabilities.map((c) => c.id).sort() }
    : null;
}

export const FIXTURE_NOW = new Date('2026-09-30T12:00:00.000Z');

/** A context source: the full gym, no profile, no history, no check-ins. */
export function contextSourceFixture(
  over: Omit<Partial<PlannerContextSource>, 'intake'> & { intake?: Partial<TrainingIntakeInput> } = {},
): PlannerContextSource {
  const { intake, ...rest } = over;
  return {
    now: FIXTURE_NOW,
    kind: 'create',
    intake: intakeFixture({ gymId: fixtureId(900, 'b'), ...intake }),
    revise: null,
    profile: null,
    weights: [],
    latestBodyFatPercent: null,
    gym: FULL_GYM,
    library: LIBRARY,
    workouts: [],
    checkIns: [],
    ...rest,
  };
}

/** A stored, ready opt-in health summary as `HealthSummaryReader.forTraining` returns it (H8, #192). */
export const HEALTH_SUMMARY_FIXTURE = {
  narrative:
    'Blood pressure has been above the usual range over the last month; a clinician follow-up is recommended. ' +
    'Ferritin is below its reference range; recommend discussing it with a clinician. Wellness scores are steady.',
  trainingConsiderations: [
    { text: 'Keep intensity moderate and avoid maximal efforts while blood pressure is reviewed.', severity: 'caution' as const, conservative: true },
    { text: 'Normal progression is otherwise supported.', severity: 'info' as const, conservative: false },
  ],
  dataAsOf: '2026-09-28',
};

/** A built run context from `contextSourceFixture(over)`. */
export function runContextFixture(over: Parameters<typeof contextSourceFixture>[0] = {}): TrainingRunContext {
  return buildTrainingRunContext(contextSourceFixture(over));
}
