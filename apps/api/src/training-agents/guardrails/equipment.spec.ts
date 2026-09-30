import { supportedBy } from '../context/build-planner-context';
import { CAP, ET, LIB } from '../testing/context-fixtures';
import { ex, guardrailContextFixture, keysOf, planTree } from '../testing/plan-fixtures';
import { checkEquipment } from './equipment';
import { fallbackTier, findSubstitutes } from './substitution';
import { normalizeTree } from './tree';
import type { GuardrailContext } from './types';

type EtKey = keyof typeof ET;
type CapKey = keyof typeof CAP;

function withGym(equipment: EtKey[], capabilities: CapKey[] = [], base: GuardrailContext = guardrailContextFixture()): GuardrailContext {
  return { ...base, gym: { equipmentTypeIds: equipment.map((e) => ET[e]).sort(), capabilityIds: capabilities.map((c) => CAP[c]).sort() } };
}

const ALL_ET = Object.keys(ET) as EtKey[];
const ALL_CAP = Object.keys(CAP) as CapKey[];
const without = (et: EtKey[], cap: CapKey[] = []) => withGym(ALL_ET.filter((e) => !et.includes(e)), ALL_CAP.filter((c) => !cap.includes(c)));

describe('equipment feasibility: requirement groups (OR inside, AND across)', () => {
  it.each([
    ['barbell bench press with barbell and bench', 'barbell_bench_press', ['barbell', 'flat_bench'], [], true],
    ['barbell bench press with a barbell only (AND fails)', 'barbell_bench_press', ['barbell'], [], false],
    ['barbell bench press with a bench only', 'barbell_bench_press', ['flat_bench'], [], false],
    ['inverted row with a rack (OR)', 'inverted_row', ['squat_rack'], [], true],
    ['inverted row with a pull-up bar (OR)', 'inverted_row', ['pullup_bar'], [], true],
    ['inverted row with neither', 'inverted_row', ['dumbbells'], [], false],
    ['leg press via its capability', 'leg_press', [], ['leg_press'], true],
    ['leg press without the capability', 'leg_press', ['barbell'], [], false],
    ['push-up needs nothing', 'push_up', [], [], true],
  ] as Array<[string, string, EtKey[], CapKey[], boolean]>)('%s', (_label, key, equipment, capabilities, expected) => {
    expect(supportedBy(LIB[key], withGym(equipment, capabilities).gym)).toBe(expected);
  });

  it('no gym means bodyweight only: exercises that need nothing', () => {
    expect(supportedBy(LIB.push_up, null)).toBe(true);
    expect(supportedBy(LIB.pull_up, null)).toBe(false);
    expect(supportedBy(LIB.dumbbell_row, null)).toBe(false);
  });
});

describe('substitution ladder', () => {
  it.each([
    ['barbell', 'dumbbell', 1],
    ['barbell', 'machine', 2],
    ['barbell', 'cable', 3],
    ['barbell', 'bodyweight', 4],
    ['barbell', 'band', 4],
    ['dumbbell', 'barbell', 1],
    ['dumbbell', 'machine', 2],
    ['dumbbell', 'cable', 3],
    ['dumbbell', 'band', 4],
    ['machine', 'dumbbell', 1],
    ['machine', 'cable', 2],
    ['machine', 'barbell', 3],
    ['machine', 'bodyweight', 4],
    ['cable', 'machine', 1],
    ['cable', 'dumbbell', 2],
    ['cable', 'band', 3],
    ['cable', 'bodyweight', 4],
    ['cable', 'barbell', 99],
    ['bodyweight', 'machine', 1],
    ['bodyweight', 'cable', 2],
    ['bodyweight', 'band', 3],
    ['bodyweight', 'dumbbell', 4],
    ['barbell', 'barbell', 0],
  ] as const)('%s -> %s is tier %i', (original, candidate, tier) => {
    expect(fallbackTier(original, candidate)).toBe(tier);
  });

  // Every row of the table, walked down tier by tier with the horizontal-pull family.
  it.each([
    ['barbell_row', without(['barbell']), 'dumbbell_row'],
    ['barbell_row', without(['barbell', 'dumbbells']), 'machine_row'],
    ['barbell_row', without(['barbell', 'dumbbells'], ['chest_press']), 'seated_cable_row'],
    ['barbell_row', without(['barbell', 'dumbbells', 'cable_machine'], ['chest_press']), 'band_row'],
    ['dumbbell_row', without(['dumbbells']), 'barbell_row'],
    ['dumbbell_row', without(['dumbbells', 'barbell']), 'machine_row'],
    ['dumbbell_row', without(['dumbbells', 'barbell'], ['chest_press']), 'seated_cable_row'],
    ['machine_row', without([], ['chest_press']), 'dumbbell_row'],
    ['machine_row', without(['dumbbells'], ['chest_press']), 'seated_cable_row'],
    ['machine_row', without(['dumbbells', 'cable_machine'], ['chest_press']), 'barbell_row'],
    ['machine_row', without(['dumbbells', 'cable_machine', 'barbell'], ['chest_press']), 'band_row'],
    ['seated_cable_row', without(['cable_machine']), 'machine_row'],
    ['seated_cable_row', without(['cable_machine'], ['chest_press']), 'dumbbell_row'],
    ['seated_cable_row', without(['cable_machine', 'dumbbells'], ['chest_press']), 'band_row'],
    ['seated_cable_row', without(['cable_machine', 'dumbbells', 'resistance_bands'], ['chest_press']), 'inverted_row'],
    ['pull_up', without([], ['pull_up']), 'assisted_pull_up'],
    ['pull_up', without([], ['pull_up', 'assisted_pull_up']), 'lat_pulldown'],
    ['pull_up', without([], ['pull_up', 'assisted_pull_up', 'lat_pulldown']), 'band_pulldown'],
  ] as Array<[string, GuardrailContext, string]>)('%s substitutes to %s', (original, ctx, expected) => {
    expect(findSubstitutes(LIB[original], ctx)[0]?.key).toBe(expected);
  });

  it('skips candidates already in the workout, on the avoid list or pain-flagged; prefers history on a tie', () => {
    const ctx = without(['barbell']);
    expect(findSubstitutes(LIB.barbell_row, ctx, new Set([LIB.dumbbell_row.id]))[0].key).toBe('machine_row');
    expect(findSubstitutes(LIB.barbell_row, { ...ctx, avoidExerciseKeys: new Set(['dumbbell_row']) })[0].key).toBe('machine_row');
    expect(findSubstitutes(LIB.barbell_row, { ...ctx, painFlagKeys: new Set(['dumbbell_row']) })[0].key).toBe('machine_row');

    const tie = without(['barbell', 'dumbbells', 'cable_machine'], ['chest_press']);
    expect(findSubstitutes(LIB.barbell_row, tie)[0].key).toBe('band_row');
    const withHistory = {
      ...tie,
      history: new Map([[LIB.inverted_row.id, { exerciseId: LIB.inverted_row.id, key: 'inverted_row', lastLoadKg: 0, lastDate: '2026-09-01', lastMinReps: 8, bestRecentLoadKg: 0, painFlagged: false }]]),
    };
    expect(findSubstitutes(LIB.barbell_row, withHistory)[0].key).toBe('inverted_row');
  });
});

describe('G2 equipment', () => {
  it('substitutes, clearing the load and keeping the prescription', () => {
    const ctx = withGym(['dumbbells', 'flat_bench'], ['goblet_squat']);
    const tree = normalizeTree(
      planTree([
        {
          workouts: [
            {
              weekday: 1,
              exercises: [
                ex('barbell_back_squat', { isPriority: true, sets: 5, repMin: 3, repMax: 5, targetLoadKg: 100, loadGuidance: 'fixed' }),
                ex('barbell_bench_press', { isPriority: true }),
              ],
            },
          ],
        },
      ]),
    );

    const violations = checkEquipment(tree, ctx);

    expect(keysOf(tree, ctx)).toEqual([[['goblet_squat', 'dumbbell_bench_press']]]);
    expect(tree.blocks[0].weeks[0].workouts[0].exercises[0]).toMatchObject({
      isPriority: true,
      targetSets: 5,
      repMin: 3,
      repMax: 5,
      targetLoadKg: null,
      loadGuidance: 'choose_start',
    });
    expect(violations.map((v) => [v.severity, v.code])).toEqual([
      ['repair', 'equipment_substituted'],
      ['repair', 'equipment_substituted'],
    ]);
  });

  it('no gym: bodyweight only; an unfillable accessory is dropped (warn), an unfillable priority lift blocks', () => {
    const ctx = { ...guardrailContextFixture(), gym: null };
    const tree = normalizeTree(
      planTree([
        {
          workouts: [
            {
              weekday: 1,
              exercises: [ex('barbell_bench_press', { isPriority: true }), ex('dumbbell_curl'), ex('barbell_overhead_press', { isPriority: true })],
            },
          ],
        },
      ]),
    );

    const violations = checkEquipment(tree, ctx);

    expect(keysOf(tree, ctx)).toEqual([[['push_up', 'pike_push_up']]]);
    expect(violations.map((v) => [v.severity, v.code])).toEqual([
      ['repair', 'equipment_substituted'],
      ['warn', 'equipment_dropped'],
      ['repair', 'equipment_substituted'],
    ]);

    const hopeless = normalizeTree(planTree([{ workouts: [{ weekday: 1, exercises: [ex('leg_press', { isPriority: true }), ex('push_up')] }] }]));
    const noLegs = { ...ctx, library: new Map([...ctx.library].filter(([, e]) => e.movementPattern !== 'squat' || e.key === 'leg_press')) };
    expect(checkEquipment(hopeless, noLegs).map((v) => [v.severity, v.code])).toEqual([['block', 'priority_unfillable']]);
  });
});
