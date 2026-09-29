// =============================================================================
// Unit: the seeded exercise catalog, the availability truth table, DTO bounds (E4.1)
// =============================================================================
//
// No database: the catalog is validated against the seeded equipment and
// capability catalogs, and `isAvailable` is exercised over ids derived from
// those same catalogs, so a renamed slug or a typo in a requirement fails here.
// =============================================================================

import {
  CAPABILITY_CATALOG,
  EQUIPMENT_CATALOG,
  EXERCISE_CATALOG,
} from '../../prisma/seed-data';
import {
  EXERCISE_TRACKING_MODES,
  MOVEMENT_PATTERNS,
  MUSCLES,
} from '../../src/common/constants/training.constants';
import {
  createExerciseSchema,
  listExercisesQuerySchema,
  updateExerciseSchema,
} from '../../src/exercises/dto/exercise.dto';
import {
  evaluateAvailability,
  isAvailable,
  type RequirementRow,
} from '../../src/exercises/exercise-availability.service';

const equipmentSlugs = new Set(EQUIPMENT_CATALOG.map((e) => e.slug));
const capabilitySlugs = new Set(CAPABILITY_CATALOG.map((c) => c.slug));

describe('EXERCISE_CATALOG', () => {
  it('has at least 85 exercises with unique slugs and names', () => {
    expect(EXERCISE_CATALOG.length).toBeGreaterThanOrEqual(85);
    expect(new Set(EXERCISE_CATALOG.map((e) => e.slug)).size).toBe(EXERCISE_CATALOG.length);
    expect(new Set(EXERCISE_CATALOG.map((e) => e.name)).size).toBe(EXERCISE_CATALOG.length);
  });

  it.each(EXERCISE_CATALOG.map((e) => [e.slug, e] as const))('%s is well formed', (_slug, ex) => {
    expect(ex.slug).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(ex.name.trim()).not.toBe('');
    expect(ex.name.length).toBeLessThanOrEqual(80);

    expect(ex.primaryMuscles.length).toBeGreaterThanOrEqual(1);
    for (const muscle of [...ex.primaryMuscles, ...ex.secondaryMuscles]) {
      expect(MUSCLES).toContain(muscle);
    }
    expect(ex.primaryMuscles.filter((m) => ex.secondaryMuscles.includes(m))).toEqual([]);

    expect(MOVEMENT_PATTERNS).toContain(ex.movementPattern);
    expect(EXERCISE_TRACKING_MODES).toContain(ex.trackingMode);

    for (const group of ex.requirements) {
      expect(group.slugs.length).toBeGreaterThanOrEqual(1);
      const known = group.kind === 'equipment' ? equipmentSlugs : capabilitySlugs;
      for (const slug of group.slugs) {
        expect(known.has(slug)).toBe(true);
      }
    }
  });

  it('derives the tracking mode from the flags', () => {
    const by = (slug: string) => EXERCISE_CATALOG.find((e) => e.slug === slug)!;

    expect(by('barbell_bench_press').trackingMode).toBe('weight_reps');
    expect(by('push_up').trackingMode).toBe('bodyweight_reps');
    expect(by('plank').trackingMode).toBe('time');
    expect(by('treadmill_run').trackingMode).toBe('distance_time');
    expect(by('push_up').isBodyweight).toBe(true);
    expect(by('dumbbell_row').isUnilateral).toBe(true);
  });

  it('gives every exercise a requirement-free path only when it is pure bodyweight', () => {
    const needsNothing = EXERCISE_CATALOG.filter((e) => e.requirements.length === 0);
    expect(needsNothing.length).toBeGreaterThan(0);
    expect(needsNothing.map((e) => e.slug)).toEqual(expect.arrayContaining(['push_up', 'plank', 'burpee']));
  });
});

// -----------------------------------------------------------------------------
// isAvailable truth table, over ids derived from the real seeded catalogs
// -----------------------------------------------------------------------------

const equipmentId = (slug: string) => `eq:${slug}`;
const capabilityId = (slug: string) => `cap:${slug}`;

function rowsOf(slug: string): RequirementRow[] {
  const ex = EXERCISE_CATALOG.find((e) => e.slug === slug);
  if (!ex) throw new Error(`no exercise ${slug}`);
  return ex.requirements.flatMap((group, groupIndex) =>
    group.slugs.map((s) => ({
      groupIndex,
      equipmentTypeId: group.kind === 'equipment' ? equipmentId(s) : null,
      capabilityId: group.kind === 'capability' ? capabilityId(s) : null,
    })),
  );
}

/** A gym holding these equipment types: their ids plus the union of their capabilities. */
function gymWith(...types: string[]) {
  const equipmentTypeIds = types.map(equipmentId);
  const capabilityIds = types.flatMap((slug) => {
    const item = EQUIPMENT_CATALOG.find((e) => e.slug === slug);
    if (!item) throw new Error(`no equipment type ${slug}`);
    return item.capabilities.map(capabilityId);
  });
  return { equipmentTypeIds, capabilityIds };
}

describe('isAvailable', () => {
  const dumbbellGym = gymWith('adjustable_dumbbells', 'adjustable_bench');
  const cableGym = gymWith('functional_trainer');
  const emptyGym = gymWith();

  it.each(['dumbbell_bench_press', 'incline_dumbbell_press', 'dumbbell_shoulder_press', 'push_up', 'goblet_squat'])(
    'adjustable dumbbells + adjustable bench supports %s',
    (slug) => {
      expect(isAvailable(rowsOf(slug), dumbbellGym)).toBe(true);
    },
  );

  it.each(['leg_press', 'barbell_bench_press', 'lat_pulldown'])(
    'adjustable dumbbells + adjustable bench does not support %s',
    (slug) => {
      expect(isAvailable(rowsOf(slug), dumbbellGym)).toBe(false);
    },
  );

  it.each(['lat_pulldown', 'seated_cable_row', 'cable_fly', 'triceps_pushdown', 'face_pull', 'cable_curl'])(
    'a functional trainer supports %s',
    (slug) => {
      expect(isAvailable(rowsOf(slug), cableGym)).toBe(true);
    },
  );

  it('pure-bodyweight exercises are available at a gym with no equipment', () => {
    const bodyweight = EXERCISE_CATALOG.filter((e) => e.requirements.length === 0);
    expect(bodyweight.length).toBeGreaterThan(0);
    for (const ex of bodyweight) {
      expect(isAvailable(rowsOf(ex.slug), emptyGym)).toBe(true);
    }
  });

  it('an equipment-needing exercise is unavailable at an empty gym', () => {
    expect(isAvailable(rowsOf('barbell_bench_press'), emptyGym)).toBe(false);
  });

  it('requires EVERY group (AND) and ANY option inside a group (OR)', () => {
    // barbell + (flat_bench|adjustable_bench)
    const bench = rowsOf('barbell_bench_press');
    expect(isAvailable(bench, gymWith('barbell', 'flat_bench'))).toBe(true);
    expect(isAvailable(bench, gymWith('barbell', 'adjustable_bench'))).toBe(true);
    expect(isAvailable(bench, gymWith('barbell'))).toBe(false);
    expect(isAvailable(bench, gymWith('flat_bench'))).toBe(false);
  });

  it('accepts sets as well as arrays', () => {
    expect(
      isAvailable(rowsOf('leg_press'), {
        equipmentTypeIds: new Set<string>(),
        capabilityIds: new Set([capabilityId('leg_press')]),
      }),
    ).toBe(true);
  });

  it('a row with neither target never satisfies its group', () => {
    expect(isAvailable([{ groupIndex: 0, equipmentTypeId: null, capabilityId: null }], gymWith('barbell'))).toBe(false);
  });
});

describe('evaluateAvailability', () => {
  it('names the first unsatisfied group\'s options and nothing when available', () => {
    const named = [
      { groupIndex: 1, equipmentTypeId: null, capabilityId: 'c1', name: 'Leg press' },
      { groupIndex: 0, equipmentTypeId: 'e1', capabilityId: null, name: 'Barbell' },
      { groupIndex: 0, equipmentTypeId: 'e2', capabilityId: null, name: 'EZ bar' },
    ];

    // Group 0 (lowest index) is unsatisfied first, even though group 1 is also unmet.
    expect(evaluateAvailability(named, { equipmentTypeIds: [], capabilityIds: [] })).toEqual({
      available: false,
      missing: ['Barbell', 'EZ bar'],
    });
    expect(evaluateAvailability(named, { equipmentTypeIds: ['e2'], capabilityIds: [] })).toEqual({
      available: false,
      missing: ['Leg press'],
    });
    expect(evaluateAvailability(named, { equipmentTypeIds: ['e1'], capabilityIds: ['c1'] })).toEqual({
      available: true,
      missing: [],
    });
  });
});

// -----------------------------------------------------------------------------
// DTO bounds
// -----------------------------------------------------------------------------

describe('createExerciseSchema', () => {
  const valid = {
    name: 'Sled push',
    primaryMuscles: ['quads'],
    movementPattern: 'carry',
    trackingMode: 'distance_time',
  };

  it('accepts a minimal exercise and applies defaults', () => {
    const parsed = createExerciseSchema.parse({ name: 'Sled push', primaryMuscles: ['quads'], movementPattern: 'carry' });
    expect(parsed).toMatchObject({
      secondaryMuscles: [],
      trackingMode: 'weight_reps',
      isUnilateral: false,
      isBodyweight: false,
      requirements: [],
    });
  });

  it('rejects 0 primary muscles', () => {
    expect(createExerciseSchema.safeParse({ ...valid, primaryMuscles: [] }).success).toBe(false);
  });

  it('accepts 4 and rejects 5 primary muscles', () => {
    expect(createExerciseSchema.safeParse({ ...valid, primaryMuscles: ['chest', 'lats', 'abs', 'quads'] }).success).toBe(true);
    expect(
      createExerciseSchema.safeParse({ ...valid, primaryMuscles: ['chest', 'lats', 'abs', 'quads', 'calves'] }).success,
    ).toBe(false);
  });

  it('rejects an unknown muscle, pattern or tracking mode', () => {
    expect(createExerciseSchema.safeParse({ ...valid, primaryMuscles: ['wings'] }).success).toBe(false);
    expect(createExerciseSchema.safeParse({ ...valid, secondaryMuscles: ['wings'] }).success).toBe(false);
    expect(createExerciseSchema.safeParse({ ...valid, movementPattern: 'flying' }).success).toBe(false);
    expect(createExerciseSchema.safeParse({ ...valid, trackingMode: 'vibes' }).success).toBe(false);
  });

  it('accepts an 80-character name and rejects 81 or an empty one', () => {
    expect(createExerciseSchema.safeParse({ ...valid, name: 'a'.repeat(80) }).success).toBe(true);
    expect(createExerciseSchema.safeParse({ ...valid, name: 'a'.repeat(81) }).success).toBe(false);
    expect(createExerciseSchema.safeParse({ ...valid, name: '   ' }).success).toBe(false);
  });

  it('bounds secondary muscles (6), overlap and duplicates', () => {
    const six = ['chest', 'lats', 'abs', 'calves', 'biceps', 'triceps'];
    expect(createExerciseSchema.safeParse({ ...valid, secondaryMuscles: six }).success).toBe(true);
    expect(createExerciseSchema.safeParse({ ...valid, secondaryMuscles: [...six, 'traps'] }).success).toBe(false);
    expect(createExerciseSchema.safeParse({ ...valid, secondaryMuscles: ['quads'] }).success).toBe(false);
    expect(createExerciseSchema.safeParse({ ...valid, primaryMuscles: ['quads', 'quads'] }).success).toBe(false);
  });

  it('bounds notes to 1000 characters', () => {
    expect(createExerciseSchema.safeParse({ ...valid, notes: 'n'.repeat(1000) }).success).toBe(true);
    expect(createExerciseSchema.safeParse({ ...valid, notes: 'n'.repeat(1001) }).success).toBe(false);
  });

  it('bounds requirement groups: <= 4 groups, 1..6 options each, uuids only', () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const group = { equipmentTypeIds: [uuid(1)] };

    expect(createExerciseSchema.safeParse({ ...valid, requirements: [group, group, group, group] }).success).toBe(true);
    expect(createExerciseSchema.safeParse({ ...valid, requirements: [group, group, group, group, group] }).success).toBe(false);
    expect(createExerciseSchema.safeParse({ ...valid, requirements: [{}] }).success).toBe(false);
    expect(createExerciseSchema.safeParse({ ...valid, requirements: [{ equipmentTypeIds: [] }] }).success).toBe(false);
    expect(
      createExerciseSchema.safeParse({
        ...valid,
        requirements: [{ equipmentTypeIds: [1, 2, 3, 4, 5, 6].map(uuid) }],
      }).success,
    ).toBe(true);
    expect(
      createExerciseSchema.safeParse({
        ...valid,
        requirements: [{ equipmentTypeIds: [1, 2, 3, 4].map(uuid), capabilityIds: [5, 6, 7].map(uuid) }],
      }).success,
    ).toBe(false);
    expect(createExerciseSchema.safeParse({ ...valid, requirements: [{ equipmentTypeIds: ['nope'] }] }).success).toBe(false);
    expect(
      createExerciseSchema.safeParse({ ...valid, requirements: [{ equipmentTypeIds: [uuid(1), uuid(1)] }] }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(createExerciseSchema.safeParse({ ...valid, ownerUserId: 'x' }).success).toBe(false);
    expect(createExerciseSchema.safeParse({ ...valid, status: 'active' }).success).toBe(false);
  });
});

describe('updateExerciseSchema', () => {
  it('needs at least one field and applies the same bounds', () => {
    expect(updateExerciseSchema.safeParse({}).success).toBe(false);
    expect(updateExerciseSchema.safeParse({ name: 'Renamed' }).success).toBe(true);
    expect(updateExerciseSchema.safeParse({ name: 'a'.repeat(81) }).success).toBe(false);
    expect(updateExerciseSchema.safeParse({ primaryMuscles: [] }).success).toBe(false);
    expect(updateExerciseSchema.safeParse({ primaryMuscles: ['chest', 'lats', 'abs', 'quads', 'calves'] }).success).toBe(false);
  });
});

describe('listExercisesQuerySchema', () => {
  it('requires gymId with availableOnly', () => {
    expect(listExercisesQuerySchema.safeParse({ availableOnly: 'true' }).success).toBe(false);
    expect(
      listExercisesQuerySchema.safeParse({ availableOnly: 'true', gymId: '11111111-1111-4111-8111-111111111111' }).success,
    ).toBe(true);
    expect(listExercisesQuerySchema.safeParse({ availableOnly: 'false' }).success).toBe(true);
  });

  it('defaults and bounds the limit (<= 200)', () => {
    expect(listExercisesQuerySchema.parse({}).limit).toBe(100);
    expect(listExercisesQuerySchema.safeParse({ limit: '200' }).success).toBe(true);
    expect(listExercisesQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(listExercisesQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('rejects an unknown muscle, pattern or tracking filter', () => {
    expect(listExercisesQuerySchema.safeParse({ muscle: 'wings' }).success).toBe(false);
    expect(listExercisesQuerySchema.safeParse({ pattern: 'flying' }).success).toBe(false);
    expect(listExercisesQuerySchema.safeParse({ tracking: 'vibes' }).success).toBe(false);
  });
});
