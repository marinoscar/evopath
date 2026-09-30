import { randomUUID } from 'node:crypto';

import { NEVER_SEND_LABELS } from '../../training-agents/context/never-send';
import { ET, LIB, LIBRARY } from '../../training-agents/testing/context-fixtures';
import { ADAPTATION_CONTEXT_LIMITS } from '../adaptation.constants';
import {
  ADAPT_FULL_GYM,
  ADAPT_GYM_ID,
  ADAPT_PROGRAM_ID,
  UPPER_A,
  adaptationRequestFixture,
  adaptationSourceFixture,
  onlyDumbbellsRequest,
} from '../testing/adaptation-fixtures';
import { ADAPTATION_SENT_KEYS, AdaptationContextError } from './adaptation-context.contract';
import {
  adaptationSafetyOf,
  buildAdaptationContext,
  effectiveInventory,
  intakeFacts,
  isLowEnergy,
  summarizeAdaptationContext,
} from './build-adaptation-context';

const build = (over: Parameters<typeof adaptationSourceFixture>[0] = {}) => buildAdaptationContext(adaptationSourceFixture(over));
const sectionKeys = (context: ReturnType<typeof build>) => context.summary.sections.map((s) => s.key);
const CHECK_IN = { energy: 4, sleepQuality: 3, soreness: 2, stress: 1 };

describe('buildAdaptationContext: the inclusion table', () => {
  it('a planned workout: request, plan, today, gym, candidates, last sessions and constraints; no readiness without a check-in', () => {
    const withLastTime = UPPER_A.map((e, i) =>
      i === 0 ? { ...e, lastTime: { performedOn: '2026-09-25', topSet: { weightKg: 77.5, reps: 6 } } } : e,
    );
    const context = build({
      request: adaptationRequestFixture({ minutes: 30 }),
      planned: { ...adaptationSourceFixture().planned!, exercises: withLastTime },
    });

    expect(Object.keys(context.sent).sort()).toEqual(
      ['candidates', 'constraints', 'gym', 'lastSessions', 'plan', 'request', 'today', 'version'].sort(),
    );
    expect(context.sent.request).toEqual({
      minutes: 30,
      soreness: null,
      lowEnergy: false,
      equipment: { mode: 'gym', names: [] },
      freeText: null,
      baseWorkout: 'planned',
    });
    expect(context.sent.plan).toEqual({
      goal: 'hypertrophy',
      weekNumber: 2,
      totalWeeks: 8,
      isDeload: false,
      priorityExerciseKeys: ['barbell_bench_press', 'barbell_row'],
    });
    expect(context.sent.today?.exercises.map((e) => e.key)).toEqual(UPPER_A.map((e) => e.key));
    expect(context.sent.lastSessions).toEqual([{ key: 'barbell_bench_press', date: '2026-09-25', topSet: { weightKg: 77.5, reps: 6 } }]);
    expect(context.sent.readiness).toBeUndefined();
    expect(context.baseRef).toMatchObject({ planId: ADAPT_PROGRAM_ID, planVersion: 3, planWorkoutId: expect.any(String) });
  });

  it('the summary has one section per key, in the documented order, rendered from the sent object', () => {
    const context = build({ checkIn: CHECK_IN });

    expect(sectionKeys(context)).toEqual([...ADAPTATION_SENT_KEYS]);
    expect(context.summary).toEqual(summarizeAdaptationContext(context.sent));
    expect(context.summary.excluded).toEqual([...NEVER_SEND_LABELS]);
    // A section that is not in the sent object says so instead of inventing content.
    const rest = build({ planned: null, checkIn: null });
    expect(rest.summary.sections.find((s) => s.key === 'today')?.items.join(' ')).toMatch(/none/i);
    expect(rest.summary.sections.find((s) => s.key === 'readiness')?.items.join(' ')).toMatch(/none/i);
  });

  it('readiness carries the four scores when useReadiness is on and a check-in exists', () => {
    const context = build({ checkIn: CHECK_IN });
    expect(context.sent.readiness).toEqual({ energy: 4, sleepQuality: 3, soreness: 2, stress: 1 });
  });

  it('readiness is omitted when the request turns it off, even with a check-in', () => {
    const context = build({ request: adaptationRequestFixture({ minutes: 30, useReadiness: false }), checkIn: CHECK_IN });

    expect(context.sent.readiness).toBeUndefined();
    expect(sectionKeys(context)).toContain('readiness');
    expect(context.summary.sections.find((s) => s.key === 'readiness')?.items.join(' ')).toMatch(/none/i);
  });

  it('a check-in whose four scores are all empty adds no readiness section', () => {
    const context = build({ checkIn: { energy: null, sleepQuality: null, soreness: null, stress: null } });
    expect(context.sent.readiness).toBeUndefined();
  });

  it('with sore muscles, low energy and free text the request section says so, sorted, whitespace normalised', () => {
    const context = build({
      request: adaptationRequestFixture({
        minutes: 45,
        soreness: { muscles: ['triceps', 'chest'], level: 'moderate' },
        lowEnergy: true,
        freeText: 'my   shoulder\n is  tired',
      }),
    });

    expect(context.sent.request.soreness).toEqual({ muscles: ['chest', 'triceps'], level: 'moderate' });
    expect(context.sent.request.lowEnergy).toBe(true);
    expect(context.sent.request.freeText).toBe('my shoulder is tired');
    const requestItems = context.summary.sections.find((s) => s.key === 'request')!.items.join(' | ');
    expect(requestItems).toContain('Sore (moderate): chest, triceps');
    expect(requestItems).toContain('Low energy');
  });
});

describe('buildAdaptationContext: no base (ad hoc)', () => {
  it('no planned workout: no today, no last sessions, no priority lifts; baseWorkout none; no baseRef', () => {
    const context = build({ planned: null });

    expect(context.sent.today).toBeUndefined();
    expect(context.sent.lastSessions).toBeUndefined();
    expect(context.sent.request.baseWorkout).toBe('none');
    expect(context.sent.plan?.priorityExerciseKeys).toEqual([]);
    expect(context.sent.plan).toMatchObject({ weekNumber: null, totalWeeks: null });
    expect(context.baseRef).toBeNull();
    expect(context.facts.base).toBeNull();
    expect(context.summary.sections.find((s) => s.key === 'request')!.items[0]).toMatch(/fresh session/i);
  });

  it('no plan at all: no plan section either, and the goal defaults to general', () => {
    const context = build({ planned: null, program: null });

    expect(context.sent.plan).toBeUndefined();
    expect(context.facts.goal).toBe('general');
    expect(context.facts.experience).toBe('beginner');
    expect(context.facts.base).toBeNull();
  });

  it('candidates then include exercises the plan would have kept (nothing is excluded as "planned")', () => {
    const withBase = build();
    const adHoc = build({ planned: null });

    expect(withBase.sent.candidates.map((c) => c.key)).not.toContain('barbell_bench_press');
    expect(adHoc.sent.candidates.map((c) => c.key)).toContain('barbell_bench_press');
  });
});

describe('buildAdaptationContext: minimisation', () => {
  it('sends exercises by key and never by internal id, and no id of any kind', () => {
    const context = build({ checkIn: CHECK_IN });
    const sent = JSON.stringify(context.sent);

    for (const lib of LIBRARY) expect(sent).not.toContain(lib.id);
    expect(sent).not.toContain(ADAPT_GYM_ID);
    expect(sent).not.toContain(ADAPT_PROGRAM_ID);
    expect(sent).not.toContain(adaptationSourceFixture().planned!.programWorkoutId);
    for (const typeId of Object.values(ET)) expect(sent).not.toContain(typeId);
  });

  it('never carries the fields the "not sent" column names', () => {
    const sent = JSON.stringify(build({ checkIn: CHECK_IN }).sent).toLowerCase();

    for (const word of ['email', 'timezone', 'latitude', 'longitude', 'coordinates', 'storagekey', 'photo', 'medication', 'lab', 'notes', 'gymname', 'displayname']) {
      expect(sent).not.toContain(`"${word}`);
    }
  });

  it('a gym is reduced to its type, equipment names, quantities and capability slugs', () => {
    const gym = {
      ...ADAPT_FULL_GYM,
      // Extra fields the loader must never have selected: if the builder copied a row wholesale they would leak.
      name: 'CANARY-GYM-NAME',
      notes: 'CANARY-GYM-NOTES',
      latitude: 9.93,
      longitude: -84.08,
    } as typeof ADAPT_FULL_GYM;
    const context = build({ gym });
    const sent = JSON.stringify(context.sent);

    expect(sent).not.toContain('CANARY-GYM');
    expect(sent).not.toContain('9.93');
    expect(sent).not.toContain('-84.08');
    expect(Object.keys(context.sent.gym).sort()).toEqual(['bodyweightOnly', 'equipment', 'type']);
    expect(context.sent.gym.equipment.find((e) => e.name === 'dumbbells')).toEqual({ name: 'dumbbells', quantity: 1, capabilities: ['goblet_squat'] });
  });

  it('the intake snapshot contributes only experience, goal, avoid keys and limitation AREAS (never their descriptions)', () => {
    const context = build({
      program: {
        id: ADAPT_PROGRAM_ID,
        goal: 'strength',
        gymId: ADAPT_GYM_ID,
        intake: {
          experience: 'advanced',
          avoidExerciseKeys: ['barbell_back_squat'],
          limitations: [{ area: 'knee', description: 'CANARY-LIMITATION-DESCRIPTION torn meniscus in 2019' }],
          contactEmail: 'canary@example.test',
        },
      },
    });

    expect(JSON.stringify(context.sent)).not.toContain('CANARY');
    expect(JSON.stringify(context.sent)).not.toContain('meniscus');
    expect(context.sent.constraints).toMatchObject({
      experience: 'advanced',
      avoidExerciseKeys: ['barbell_back_squat'],
      limitationAreas: ['knee'],
    });
    expect(context.sent.plan?.goal).toBe('strength');
  });

  it('a declared limitation makes the run conservative with a rule code, not the user\'s words', () => {
    const context = build({
      program: { id: ADAPT_PROGRAM_ID, goal: 'strength', gymId: ADAPT_GYM_ID, intake: { experience: 'beginner', limitations: [{ area: 'knee', description: 'x' }] } },
    });

    expect(context.safety).toEqual({ level: 'conservative', reasons: ['limitation_declared'] });
    expect(context.sent.constraints.conservative).toBe(true);
  });

  it('the check-in note cannot be sent: only the four numbers exist on the source', () => {
    const checkIn = { ...CHECK_IN, note: 'CANARY-CHECKIN-NOTE' } as typeof CHECK_IN;
    const context = build({ checkIn });

    expect(JSON.stringify(context)).not.toContain('CANARY-CHECKIN-NOTE');
    expect(Object.keys(context.sent.readiness!).sort()).toEqual(['energy', 'sleepQuality', 'soreness', 'stress']);
  });

  it('server-only facts (ids, loads) live in facts, never in sent', () => {
    const context = build();

    expect(context.facts.base?.exercises[0]).toMatchObject({ exerciseId: LIB.barbell_bench_press.id, targetLoadKg: 80 });
    expect(JSON.stringify(context.sent)).not.toContain('targetLoadKg');
    expect(JSON.stringify(context.sent)).not.toContain('loadGuidance');
  });
});

describe('buildAdaptationContext: candidates', () => {
  it('only exercises the chosen equipment supports, minus the avoid list and pain flags, never the planned ones', () => {
    const context = build({
      request: onlyDumbbellsRequest({ minutes: 30 }),
      painFlagExerciseIds: [LIB.dumbbell_curl.id],
      program: { id: ADAPT_PROGRAM_ID, goal: 'hypertrophy', gymId: ADAPT_GYM_ID, intake: { experience: 'intermediate', avoidExerciseKeys: ['dumbbell_lunge'] } },
    });
    const keys = context.sent.candidates.map((c) => c.key);

    expect(keys).toContain('dumbbell_bench_press');
    expect(keys).toContain('dumbbell_row');
    expect(keys).not.toContain('barbell_back_squat');
    expect(keys).not.toContain('cable_curl');
    expect(keys).not.toContain('dumbbell_curl'); // pain-flagged
    expect(keys).not.toContain('dumbbell_lunge'); // avoid list
    expect(keys).not.toContain('dumbbell_shoulder_press'); // planned
    expect(context.facts.painFlagKeys).toEqual(['dumbbell_curl']);
    expect(context.sent.constraints.avoidExerciseKeys).toEqual(['dumbbell_curl', 'dumbbell_lunge']);
  });

  it('is capped and the facts library is the base plus the candidates only', () => {
    const many = Array.from({ length: 90 }, (_, i) => ({ ...LIB.bodyweight_squat, id: randomUUID(), key: `extra_${String(i).padStart(2, '0')}`, name: `Extra ${i}` }));
    const context = build({ library: [...LIBRARY, ...many] });

    expect(context.sent.candidates).toHaveLength(ADAPTATION_CONTEXT_LIMITS.maxCandidates);
    expect(context.facts.library.length).toBe(UPPER_A.length + ADAPTATION_CONTEXT_LIMITS.maxCandidates);
  });

  it('bodyweight mode: no gym equipment is sent and only bodyweight exercises are candidates', () => {
    const context = build({ request: adaptationRequestFixture({ minutes: 20, equipment: { mode: 'bodyweight' } }) });

    expect(context.sent.gym).toEqual({ type: 'commercial', bodyweightOnly: true, equipment: [] });
    expect(context.facts.inventory).toBeNull();
    expect(context.sent.candidates.length).toBeGreaterThan(0);
    for (const candidate of context.sent.candidates) expect(LIB[candidate.key].requirements).toEqual([]);
    expect(context.sent.today?.exercises.find((e) => e.key === 'barbell_bench_press')?.availableHere).toBe(false);
  });

  it('only mode: today\'s exercises are flagged by whether that subset supports them', () => {
    const context = build({ request: onlyDumbbellsRequest({ minutes: 30 }) });
    const available = Object.fromEntries(context.sent.today!.exercises.map((e) => [e.key, e.availableHere]));

    expect(available).toEqual({
      barbell_bench_press: false,
      barbell_row: false,
      dumbbell_shoulder_press: true,
      cable_fly: false,
      triceps_pushdown: false,
      dumbbell_curl: true,
    });
    expect(context.sent.gym.equipment.map((e) => e.name).sort()).toEqual(['dumbbells', 'flat bench']);
    expect(context.sent.request.equipment).toEqual({ mode: 'only', names: ['dumbbells', 'flat bench'] });
  });
});

describe('effectiveInventory', () => {
  it('an only type the gym does not have is ADAPTATION_EQUIPMENT_NOT_IN_GYM, naming the type ids', () => {
    const request = adaptationRequestFixture({ equipment: { mode: 'only', equipmentTypeIds: [ET.dumbbells, ET.treadmill] } });

    let caught: unknown;
    try {
      effectiveInventory(request, ADAPT_FULL_GYM);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdaptationContextError);
    expect(caught).toMatchObject({ code: 'ADAPTATION_EQUIPMENT_NOT_IN_GYM', details: { equipmentTypeIds: [ET.treadmill] } });
  });

  it('only with no gym at all is refused the same way', () => {
    expect(() => effectiveInventory(onlyDumbbellsRequest(), null)).toThrow(AdaptationContextError);
  });

  it('no gym means bodyweight only; the gym mode keeps every type', () => {
    expect(effectiveInventory(adaptationRequestFixture({ minutes: 30 }), null)).toEqual({ inventory: null, names: [] });
    const all = effectiveInventory(adaptationRequestFixture({ minutes: 30 }), ADAPT_FULL_GYM);
    expect(all.inventory!.equipmentTypeIds).toHaveLength(ADAPT_FULL_GYM.equipment.length);
    expect(all.names).toEqual([]);
  });
});

describe('safety mapping (adaptationSafetyOf)', () => {
  it.each([
    ['chest pain', 'I get chest pain when I press'],
    ['fainting', 'I nearly fainted on the stairs'],
    ['numb arm', 'my left arm is numb and my face feels odd'],
  ])('urgent free text (%s) is blocked with urgent:* codes and never the user\'s words', (_label, freeText) => {
    const safety = adaptationSafetyOf({ freeText }, null, 0);

    expect(safety.level).toBe('blocked');
    expect(safety.reasons.length).toBeGreaterThan(0);
    for (const reason of safety.reasons) expect(reason).toMatch(/^urgent:/);
    expect(JSON.stringify(safety)).not.toContain(freeText);
  });

  it('a conservative stem ("my elbow hurts") is conservative, not blocked', () => {
    expect(adaptationSafetyOf({ freeText: 'my elbow hurts a bit' }, null, 0)).toEqual({ level: 'conservative', reasons: ['stem:pain'] });
  });

  it('low readiness makes it conservative with readiness:* codes; healthy readiness stays ok', () => {
    expect(adaptationSafetyOf({ freeText: undefined }, { energy: 1, sleepQuality: 2, soreness: 5, stress: 4 }, 0)).toEqual({
      level: 'conservative',
      reasons: ['readiness:high_soreness', 'readiness:high_stress', 'readiness:low_energy', 'readiness:poor_sleep'],
    });
    expect(adaptationSafetyOf({ freeText: undefined }, CHECK_IN, 0)).toEqual({ level: 'ok', reasons: [] });
    expect(adaptationSafetyOf({ freeText: undefined }, null, 0)).toEqual({ level: 'ok', reasons: [] });
  });

  it('readiness that the request turned off cannot make the run conservative', () => {
    const context = build({
      request: adaptationRequestFixture({ minutes: 30, useReadiness: false }),
      checkIn: { energy: 1, sleepQuality: 1, soreness: 5, stress: 5 },
    });

    expect(context.safety).toEqual({ level: 'ok', reasons: [] });
    expect(context.facts.lowEnergy).toBe(false);
  });

  it('the blocked level survives into the context (the graph stops on it)', () => {
    const context = build({ request: adaptationRequestFixture({ freeText: 'I have chest pain' }) });
    expect(context.safety.level).toBe('blocked');
  });

  it('a conservative context sets facts.conservative and constraints.conservative together', () => {
    const context = build({ checkIn: { energy: 1, sleepQuality: 3, soreness: 2, stress: 1 } });
    expect(context.facts.conservative).toBe(true);
    expect(context.sent.constraints.conservative).toBe(true);
  });
});

describe('isLowEnergy', () => {
  it('is true for the request flag or a check-in energy of 2 or less', () => {
    expect(isLowEnergy({ lowEnergy: true }, null)).toBe(true);
    expect(isLowEnergy({}, { ...CHECK_IN, energy: 2 })).toBe(true);
    expect(isLowEnergy({}, { ...CHECK_IN, energy: 1 })).toBe(true);
  });

  it('is false for energy 3+, a missing score or no check-in', () => {
    expect(isLowEnergy({}, { ...CHECK_IN, energy: 3 })).toBe(false);
    expect(isLowEnergy({}, { ...CHECK_IN, energy: null })).toBe(false);
    expect(isLowEnergy({ lowEnergy: false }, null)).toBe(false);
  });

  it('a low check-in energy flips constraints.lowEnergy without the request asking', () => {
    const context = build({ checkIn: { ...CHECK_IN, energy: 2 } });
    expect(context.sent.request.lowEnergy).toBe(false);
    expect(context.sent.constraints.lowEnergy).toBe(true);
    expect(context.facts.lowEnergy).toBe(true);
  });
});

describe('intakeFacts (read loosely)', () => {
  it('defaults an unreadable snapshot to beginner and general', () => {
    expect(intakeFacts(null, 'nonsense')).toEqual({ experience: 'beginner', goal: 'general', avoidKeys: [], limitationAreas: [] });
    expect(intakeFacts('garbage', 'strength')).toMatchObject({ experience: 'beginner', goal: 'strength' });
    expect(intakeFacts({ experience: 'wizard', avoidExerciseKeys: [1, 'a', 'a'], limitations: [null, { area: 'knee' }, { area: 3 }] }, 'strength')).toEqual({
      experience: 'beginner',
      goal: 'strength',
      avoidKeys: ['a'],
      limitationAreas: ['knee'],
    });
  });
});
