import { CAP, ET, LIB, LIBRARY } from '../../training-agents/testing/context-fixtures';
import { ADAPTATION_REASONS, ADAPTATION_RULES as R } from '../adaptation.constants';
import type { AdaptationFacts } from '../context/adaptation-context.contract';
import type { AdaptationProposalModel, AdaptedWorkout } from '../contracts/adapted-workout.contract';
import type { AdaptationRequestInput } from '../dto/adaptation-request.dto';
import {
  ADAPT_GYM_ID,
  ADAPT_PROGRAM_ID,
  UPPER_A,
  adaptationContextFixture,
  adaptationRequestFixture,
  modelExercise,
  onlyDumbbellsRequest,
  proposalAnswer,
} from '../testing/adaptation-fixtures';
import {
  type AdaptationRuleOutcome,
  type AdaptationRuleRequest,
  applyAdaptationRules,
  cannotFitMessage,
  estimateAdaptedMinutes,
  staleFindings,
} from './adaptation-rules';

// =============================================================================
// The adaptation rules and the deterministic repair, table-driven
// =============================================================================
//
// Every rule of the spec's table, on "Upper A" (bench 4x, row 4x priority;
// shoulder press, cable fly, pushdown, curl 3x each: 20 sets, 46 minutes) and
// the small fixture library. The pure function takes no clock and no I/O, so
// every case is exact.
// =============================================================================

type Over = {
  request?: Partial<AdaptationRequestInput>;
  source?: Parameters<typeof adaptationContextFixture>[0];
};

const factsOf = ({ request = { minutes: 60 }, source = {} }: Over = {}): AdaptationFacts =>
  adaptationContextFixture({ request: adaptationRequestFixture(request), ...source }).facts;

/** The whole planned workout, as a planner that changed nothing would answer. */
const upperAll = (): AdaptationProposalModel['exercises'] =>
  UPPER_A.map((e) =>
    modelExercise(e.key, { isPriority: e.isPriority, sets: e.sets, repMin: e.repMin, repMax: e.repMax, targetRpe: e.targetRpe, restSeconds: e.restSeconds }),
  );

const rule = (over: Partial<AdaptationRuleRequest> = {}): AdaptationRuleRequest => ({ minutes: null, soreness: null, ...over });

function ok(outcome: AdaptationRuleOutcome) {
  if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
  return outcome;
}

const byKey = (proposal: AdaptedWorkout, key: string) => proposal.exercises.find((e) => e.exerciseKey === key);
const totalSets = (proposal: AdaptedWorkout) => proposal.exercises.reduce((sum, e) => sum + e.sets, 0);
const codes = (findings: Array<{ code: string }>) => findings.map((f) => f.code);

const PLANNED_TOTAL = UPPER_A.reduce((sum, e) => sum + e.sets, 0);

describe('the fixture is what the tables below assume', () => {
  it('Upper A is 20 sets and 46 estimated minutes', () => {
    expect(PLANNED_TOTAL).toBe(20);
    expect(estimateAdaptedMinutes(upperAll().map((e) => ({ sets: e.sets, repMax: e.repMax, restSeconds: e.restSeconds, isPriority: e.isPriority })))).toBe(46);
  });
});

describe('time fit and time repair', () => {
  // T1 drops non-priority exercises from the END (never the last one left); T2 one
  // set at a time off non-priority (floor 2); T3 one set at a time off priority
  // (floor 2), last exercise first. Sets are bench/row.
  it.each([
    { minutes: 90, dropped: [], benchSets: 4, rowSets: 4, estimated: 46, repairs: [] },
    { minutes: 46, dropped: [], benchSets: 4, rowSets: 4, estimated: 46, repairs: [] },
    { minutes: 45, dropped: ['dumbbell_curl'], benchSets: 4, rowSets: 4, estimated: 41, repairs: ['time_exercise_dropped'] },
    { minutes: 40, dropped: ['dumbbell_curl', 'triceps_pushdown'], benchSets: 4, rowSets: 4, estimated: 36, repairs: ['time_exercise_dropped', 'time_exercise_dropped'] },
    { minutes: 30, dropped: ['dumbbell_curl', 'triceps_pushdown', 'cable_fly'], benchSets: 4, rowSets: 4, estimated: 30, repairs: ['time_exercise_dropped', 'time_exercise_dropped', 'time_exercise_dropped'] },
    { minutes: 25, dropped: ['dumbbell_curl', 'triceps_pushdown', 'cable_fly', 'dumbbell_shoulder_press'], benchSets: 4, rowSets: 4, estimated: 25, repairs: ['time_exercise_dropped', 'time_exercise_dropped', 'time_exercise_dropped', 'time_exercise_dropped'] },
    {
      minutes: 20,
      dropped: ['dumbbell_curl', 'triceps_pushdown', 'cable_fly', 'dumbbell_shoulder_press'],
      benchSets: 3,
      rowSets: 3,
      estimated: 19,
      repairs: ['time_exercise_dropped', 'time_exercise_dropped', 'time_exercise_dropped', 'time_exercise_dropped', 'time_priority_set_removed', 'time_priority_set_removed'],
    },
    {
      minutes: 15,
      dropped: ['dumbbell_curl', 'triceps_pushdown', 'cable_fly', 'dumbbell_shoulder_press'],
      benchSets: 2,
      rowSets: 2,
      estimated: 14,
      repairs: [
        'time_exercise_dropped', 'time_exercise_dropped', 'time_exercise_dropped', 'time_exercise_dropped',
        'time_priority_set_removed', 'time_priority_set_removed', 'time_priority_set_removed', 'time_priority_set_removed',
      ],
    },
  ])('$minutes minutes: drops $dropped, bench $benchSets and row $rowSets sets, $estimated min', ({ minutes, dropped, benchSets, rowSets, estimated, repairs }) => {
    const { proposal, report } = ok(applyAdaptationRules(proposalAnswer(upperAll()), factsOf({ request: { minutes } }), rule({ minutes })));

    expect(proposal.estimatedMinutes).toBe(estimated);
    expect(report.estimatedMinutes).toBe(estimated);
    expect(report.fitsRequest).toBe(true);
    expect(estimated).toBeLessThanOrEqual(minutes);
    expect(proposal.dropped.map((d) => d.exerciseKey).sort()).toEqual([...dropped].sort());
    expect(proposal.dropped.every((d) => d.reason === 'time')).toBe(true);
    expect(byKey(proposal, 'barbell_bench_press')?.sets).toBe(benchSets);
    expect(byKey(proposal, 'barbell_row')?.sets).toBe(rowSets);
    expect(codes(report.repairs).filter((c) => c.startsWith('time_'))).toEqual(repairs);
    // Priority lifts are never dropped and never below the floor.
    expect(byKey(proposal, 'barbell_bench_press')).toBeDefined();
    expect(byKey(proposal, 'barbell_row')).toBeDefined();
    for (const e of proposal.exercises) expect(e.sets).toBeGreaterThanOrEqual(R.setFloor);
  });

  it.each([
    { minutes: 12, tryAt: 22 },
    { minutes: 10, tryAt: 20 },
  ])('$minutes minutes cannot fit two priority lifts at the 2-set floor: ADAPTATION_CANNOT_FIT, "try $tryAt"', ({ minutes, tryAt }) => {
    const outcome = applyAdaptationRules(proposalAnswer(upperAll()), factsOf({ request: { minutes } }), rule({ minutes }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe(ADAPTATION_REASONS.CANNOT_FIT);
    expect(outcome.message).toBe(`Can't fit these lifts in ${minutes} minutes; try ${tryAt}`);
    expect(outcome.report.fitsRequest).toBe(false);
    expect(outcome.report.estimatedMinutes).toBe(14);
  });

  it('cannotFitMessage suggests the request plus the configured step', () => {
    expect(R.cannotFitSuggestionStep).toBe(10);
    expect(cannotFitMessage(30)).toBe("Can't fit these lifts in 30 minutes; try 40");
  });

  it('never drops the last exercise: a single priority lift that is too long fails instead', () => {
    // Even at the 2-set floor with the longest allowed rest this is 12 minutes.
    const answer = proposalAnswer([modelExercise('barbell_bench_press', { isPriority: true, sets: 4, repMin: 5, repMax: 8, restSeconds: 300 })]);
    const outcome = applyAdaptationRules(answer, factsOf({ request: { minutes: 10 } }), rule({ minutes: 10 }));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe(ADAPTATION_REASONS.CANNOT_FIT);
  });

  it('T1 (drop the trailing accessory) comes before any set is removed', () => {
    const answer = proposalAnswer([
      modelExercise('barbell_bench_press', { isPriority: true, sets: 2, repMin: 5, repMax: 8, restSeconds: 60 }),
      modelExercise('dumbbell_shoulder_press', { sets: 3, repMax: 12, restSeconds: 90 }),
    ]);
    const before = estimateAdaptedMinutes([
      { sets: 2, repMax: 8, restSeconds: 60, isPriority: true },
      { sets: 3, repMax: 12, restSeconds: 90, isPriority: false },
    ]);
    const { proposal, report } = ok(applyAdaptationRules(answer, factsOf({ request: { minutes: before - 1 } }), rule({ minutes: before - 1 })));

    // Dropping the trailing accessory alone fits, so no set is touched.
    expect(codes(report.repairs)).toContain('time_exercise_dropped');
    expect(proposal.exercises.map((e) => e.exerciseKey)).toEqual(['barbell_bench_press']);
    expect(codes(report.repairs).filter((c) => c.startsWith('time_'))).toEqual(['time_exercise_dropped']);
    expect(byKey(proposal, 'barbell_bench_press')?.sets).toBe(2);
  });

  it('T2 (sets off an accessory) applies when the accessory is the only exercise left', () => {
    const answer = proposalAnswer([modelExercise('dumbbell_curl', { sets: 3, repMax: 15, restSeconds: 150 })], {});
    const before = estimateAdaptedMinutes([{ sets: 3, repMax: 15, restSeconds: 150, isPriority: false }]);
    expect(before).toBe(14);
    const { proposal, report } = ok(
      applyAdaptationRules(answer, factsOf({ request: { minutes: before - 1 }, source: { planned: null } }), rule({ minutes: before - 1 })),
    );

    expect(codes(report.repairs)).toContain('time_set_removed');
    expect(codes(report.repairs)).not.toContain('time_exercise_dropped');
    expect(proposal.exercises[0].sets).toBe(2);
    expect(proposal.estimatedMinutes).toBeLessThanOrEqual(before - 1);
  });

  it('no minutes in the request: no time repair at all', () => {
    const { report } = ok(applyAdaptationRules(proposalAnswer(upperAll()), factsOf({ request: { lowEnergy: false, freeText: 'just testing' } }), rule()));

    expect(codes(report.repairs).filter((c) => c.startsWith('time_'))).toEqual([]);
    expect(report.fitsRequest).toBe(true);
  });

  it('the model\'s own estimatedMinutes is ignored: the server recomputes it', () => {
    const { proposal } = ok(applyAdaptationRules(proposalAnswer(upperAll(), { estimatedMinutes: 5 }), factsOf(), rule()));
    expect(proposal.estimatedMinutes).toBe(46);
  });
});

describe('never escalate (with a base)', () => {
  it('no exercise above its counterpart\'s sets or RPE, total within the plan (8-set, RPE 10 everywhere)', () => {
    const greedy = upperAll().map((e) => ({ ...e, sets: 8, targetRpe: 10 }));
    const { proposal, report } = ok(applyAdaptationRules(proposalAnswer(greedy), factsOf(), rule()));

    for (const e of proposal.exercises) {
      const base = UPPER_A.find((b) => b.key === e.exerciseKey)!;
      expect(e.sets).toBeLessThanOrEqual(base.sets);
      expect(e.targetRpe!).toBeLessThanOrEqual(base.targetRpe!);
    }
    expect(totalSets(proposal)).toBeLessThanOrEqual(PLANNED_TOTAL);
    expect(codes(report.repairs)).toEqual(expect.arrayContaining(['escalation_sets', 'escalation_rpe']));
  });

  it('a swap inherits the replaced exercise\'s ceiling', () => {
    const answer = proposalAnswer([
      modelExercise('dumbbell_bench_press', { source: 'swapped', replacesExerciseKey: 'barbell_bench_press', sets: 6, targetRpe: 9.5 }),
    ]);
    const { proposal } = ok(applyAdaptationRules(answer, factsOf(), rule()));

    expect(proposal.exercises[0]).toMatchObject({ exerciseKey: 'dumbbell_bench_press', source: 'swapped', replacesExerciseKey: 'barbell_bench_press', sets: 4, targetRpe: 8 });
    expect(proposal.exercises[0].replacesExerciseId).toBe(LIB.barbell_bench_press.id);
  });

  it('an added exercise is capped at the largest planned set count and RPE', () => {
    const answer = proposalAnswer([
      modelExercise('barbell_bench_press', { isPriority: true, sets: 4, targetRpe: 8 }),
      modelExercise('dumbbell_lateral_raise', { source: 'added', sets: 8, targetRpe: 10 }),
    ]);
    const { proposal } = ok(applyAdaptationRules(answer, factsOf(), rule()));

    expect(byKey(proposal, 'dumbbell_lateral_raise')).toMatchObject({ source: 'added', sets: 4, targetRpe: 8 });
  });

  it('a missing RPE becomes the counterpart\'s (never left open-ended)', () => {
    const answer = proposalAnswer([modelExercise('barbell_bench_press', { isPriority: true, sets: 3, targetRpe: null })]);
    const { proposal } = ok(applyAdaptationRules(answer, factsOf(), rule()));

    expect(proposal.exercises[0].targetRpe).toBe(8);
  });

  it('extra exercises that push the total past the plan\'s are trimmed (sets, then exercises, from the end; priority last)', () => {
    const answer = proposalAnswer([
      ...upperAll(),
      modelExercise('dumbbell_lateral_raise', { source: 'added', sets: 4 }),
      modelExercise('plank', { source: 'added', sets: 4 }),
    ]);
    const { proposal, report } = ok(applyAdaptationRules(answer, factsOf(), rule()));

    expect(totalSets(proposal)).toBeLessThanOrEqual(PLANNED_TOTAL);
    expect(codes(report.repairs)).toContain('escalation_total_sets');
    expect(byKey(proposal, 'barbell_bench_press')).toBeDefined();
    expect(byKey(proposal, 'barbell_row')).toBeDefined();
  });
});

describe('never escalate (ad hoc, no base): the level bounds are the ceiling', () => {
  const adHoc = (request: Partial<AdaptationRequestInput> = { minutes: 60 }, extra: Parameters<typeof adaptationContextFixture>[0] = {}) =>
    factsOf({ request, source: { planned: null, ...extra } });

  it('a beginner\'s 12-set, RPE 10 exercise is brought inside the level\'s per-exercise and RPE caps, and the session inside its cap', () => {
    const facts = adHoc({ minutes: 240 }, { program: { id: ADAPT_PROGRAM_ID, goal: 'general', gymId: ADAPT_GYM_ID, intake: { experience: 'beginner' } } });
    const answer = proposalAnswer(
      ['barbell_back_squat', 'barbell_bench_press', 'barbell_row', 'barbell_overhead_press', 'romanian_deadlift', 'dumbbell_curl'].map((key) =>
        modelExercise(key, { source: 'added', sets: 12, targetRpe: 10, isPriority: false }),
      ),
    );
    const { proposal, report } = ok(applyAdaptationRules(answer, facts, rule({ minutes: 240 })));

    expect(codes(report.repairs)).toEqual(expect.arrayContaining(['sets_clamped', 'level_rpe']));
    for (const e of proposal.exercises) {
      expect(e.sets).toBeLessThanOrEqual(8);
      expect(e.targetRpe!).toBeLessThanOrEqual(10);
      expect(e.source).toBe('added');
    }
    expect(totalSets(proposal)).toBeLessThanOrEqual(30);
    expect(proposal.dropped).toEqual([]);
  });

  it('with no base every exercise is "added" and priority comes from the model', () => {
    const answer = proposalAnswer([
      modelExercise('barbell_back_squat', { source: 'kept', isPriority: true, sets: 3 }),
      modelExercise('dumbbell_curl', { source: 'swapped', replacesExerciseKey: 'barbell_back_squat', sets: 2 }),
    ]);
    const { proposal } = ok(applyAdaptationRules(answer, adHoc(), rule()));

    expect(proposal.exercises.map((e) => e.source)).toEqual(['added', 'added']);
    expect(proposal.exercises.map((e) => e.isPriority)).toEqual([true, false]);
    expect(proposal.dropped).toEqual([]);
  });

  it('a session may hold at most 12 exercises: the rest are removed and reported', () => {
    const keys = LIBRARY.filter((e) => e.implement !== 'machine' && e.movementPattern !== 'cardio').slice(0, 14).map((e) => e.key);
    expect(keys).toHaveLength(14);
    const facts: AdaptationFacts = {
      ...adHoc({ minutes: 240 }),
      library: LIBRARY,
      inventory: { equipmentTypeIds: Object.values(ET), capabilityIds: Object.values(CAP) },
    };
    const answer = proposalAnswer(keys.map((key) => modelExercise(key, { source: 'added', sets: 1, targetRpe: 7 })));
    const { proposal, report } = ok(applyAdaptationRules(answer, facts, rule({ minutes: 240 })));

    expect(proposal.exercises).toHaveLength(12);
    expect(proposal.exercises.map((e) => e.exerciseKey)).toEqual(keys.slice(0, 12));
    expect(codes(report.rejected)).toEqual(['too_many_exercises', 'too_many_exercises']);
  });
});

describe('soreness', () => {
  const sore = (level: 'mild' | 'moderate', muscles: string[]) => rule({ soreness: { level, muscles } });

  it.each([
    { planned: 4, expected: 3, why: '75% of 4' },
    { planned: 3, expected: 2, why: '75% of 3 floors at 2' },
    { planned: 2, expected: 2, why: 'the floor is 2' },
  ])('mild: a prime mover planned at $planned sets gets $expected ($why), RPE at most 8', ({ planned, expected }) => {
    const facts = factsOf({ request: { soreness: { muscles: ['chest'], level: 'mild' } } });
    facts.base!.exercises = facts.base!.exercises.map((e) => (e.key === 'barbell_bench_press' ? { ...e, sets: planned } : e));
    const answer = proposalAnswer([modelExercise('barbell_bench_press', { isPriority: true, sets: planned, targetRpe: 8 })]);
    const { proposal } = ok(applyAdaptationRules(answer, facts, sore('mild', ['chest'])));

    expect(proposal.exercises[0].sets).toBe(expected);
    expect(proposal.exercises[0].targetRpe!).toBeLessThanOrEqual(R.soreness.mild.rpeCap);
  });

  it('mild: exercises whose prime mover is not sore are untouched', () => {
    const { proposal } = ok(applyAdaptationRules(proposalAnswer(upperAll()), factsOf(), sore('mild', ['chest'])));

    expect(byKey(proposal, 'barbell_bench_press')?.sets).toBe(3);
    expect(byKey(proposal, 'cable_fly')?.sets).toBe(3 - 1); // chest too: floor(3 * .75) = 2
    expect(byKey(proposal, 'barbell_row')?.sets).toBe(4);
    expect(byKey(proposal, 'dumbbell_curl')?.sets).toBe(3);
    expect(byKey(proposal, 'dumbbell_shoulder_press')?.sets).toBe(3);
  });

  it('mild: the RPE cap of 8 applies even where the base RPE is higher (ad hoc, model asks for 9)', () => {
    const facts = factsOf({ request: { soreness: { muscles: ['chest'], level: 'mild' } }, source: { planned: null } });
    const answer = proposalAnswer([modelExercise('barbell_bench_press', { source: 'added', sets: 3, targetRpe: 9 })]);
    const { proposal, report } = ok(applyAdaptationRules(answer, facts, sore('mild', ['chest'])));

    expect(proposal.exercises[0].targetRpe).toBe(8);
    expect(codes(report.repairs)).toContain('sore_mild_rpe');
  });

  it('moderate: a kept prime mover has at most 2 sets at RPE 6 and a note explaining why; priority lifts are not spared', () => {
    const { proposal } = ok(applyAdaptationRules(proposalAnswer(upperAll()), factsOf(), sore('moderate', ['chest'])));

    for (const key of ['barbell_bench_press', 'cable_fly']) {
      const e = byKey(proposal, key)!;
      expect(e.sets).toBeLessThanOrEqual(R.soreness.moderate.maxSets);
      expect(e.targetRpe!).toBeLessThanOrEqual(R.soreness.moderate.rpeCap);
      expect(e.note).toMatch(/sore/i);
      expect(e.note).toContain('chest');
    }
    expect(byKey(proposal, 'barbell_row')?.sets).toBe(4);
    expect(byKey(proposal, 'barbell_row')?.note).toBeNull();
  });

  it('moderate: swapping the sore muscle out entirely leaves nothing to reduce and adds no note', () => {
    const answer = proposalAnswer([
      modelExercise('barbell_row', { isPriority: true, sets: 4 }),
      modelExercise('dumbbell_curl', { sets: 3 }),
    ], { dropped: [{ exerciseKey: 'barbell_bench_press', reason: 'sore' }] });
    const { proposal } = ok(applyAdaptationRules(answer, factsOf(), sore('moderate', ['chest'])));

    expect(proposal.exercises.every((e) => e.note === null)).toBe(true);
    expect(proposal.dropped.find((d) => d.exerciseKey === 'barbell_bench_press')?.reason).toBe('sore');
  });

  it('moderate with several sore muscles says "are"; sore secondary muscles do not count (triceps hits presses only where it is primary)', () => {
    const { proposal } = ok(applyAdaptationRules(proposalAnswer(upperAll()), factsOf(), sore('moderate', ['chest', 'triceps'])));

    expect(byKey(proposal, 'barbell_bench_press')?.note).toContain('are sore');
    expect(byKey(proposal, 'triceps_pushdown')?.sets).toBe(2);
    expect(byKey(proposal, 'barbell_bench_press')?.note).toContain('chest, triceps');
  });

  it('a note from the model is kept after the explanation, within 160 characters', () => {
    const answer = proposalAnswer([modelExercise('barbell_bench_press', { isPriority: true, sets: 4, note: 'y'.repeat(300) })]);
    const { proposal } = ok(applyAdaptationRules(answer, factsOf(), sore('moderate', ['chest'])));

    expect(proposal.exercises[0].note!.startsWith('Kept light: your chest is sore.')).toBe(true);
    expect([...proposal.exercises[0].note!].length).toBeLessThanOrEqual(160);
  });
});

describe('low energy', () => {
  const lowFacts = (over: Over = {}) => factsOf({ request: { minutes: 90, lowEnergy: true }, ...over });

  it('RPE at most 7 everywhere; non-priority sets at most base minus one (floor 2); priority sets are kept', () => {
    const { proposal, report } = ok(applyAdaptationRules(proposalAnswer(upperAll()), lowFacts(), rule({ minutes: 90 })));

    for (const e of proposal.exercises) expect(e.targetRpe!).toBeLessThanOrEqual(R.lowEnergy.rpeCap);
    expect(byKey(proposal, 'barbell_bench_press')?.sets).toBe(4);
    expect(byKey(proposal, 'barbell_row')?.sets).toBe(4);
    for (const key of ['dumbbell_shoulder_press', 'cable_fly', 'triceps_pushdown', 'dumbbell_curl']) {
      expect(byKey(proposal, key)?.sets).toBe(2);
    }
    expect(codes(report.repairs)).toEqual(expect.arrayContaining(['energy_rpe', 'energy_sets']));
  });

  it('a check-in energy of 2 or less counts as low energy without the request asking', () => {
    const source = { checkIn: { energy: 2, sleepQuality: 4, soreness: 2, stress: 2 } };
    const { proposal } = ok(applyAdaptationRules(proposalAnswer(upperAll()), factsOf({ request: { minutes: 90 }, source }), rule({ minutes: 90 })));

    expect(byKey(proposal, 'dumbbell_curl')?.sets).toBe(2);
    expect(proposal.exercises.every((e) => e.targetRpe! <= 7)).toBe(true);
  });

  it('energy 3 is normal; readiness turned off ignores a low check-in', () => {
    const normal = ok(applyAdaptationRules(proposalAnswer(upperAll()), factsOf({ request: { minutes: 90 }, source: { checkIn: { energy: 3, sleepQuality: 4, soreness: 2, stress: 2 } } }), rule({ minutes: 90 })));
    expect(byKey(normal.proposal, 'dumbbell_curl')?.sets).toBe(3);

    const off = ok(
      applyAdaptationRules(
        proposalAnswer(upperAll()),
        factsOf({ request: { minutes: 90, useReadiness: false }, source: { checkIn: { energy: 1, sleepQuality: 1, soreness: 5, stress: 5 } } }),
        rule({ minutes: 90 }),
      ),
    );
    expect(byKey(off.proposal, 'dumbbell_curl')?.sets).toBe(3);
  });

  it('a non-priority exercise planned at 2 sets stays at 2 (the floor)', () => {
    const facts = lowFacts();
    facts.base!.exercises = facts.base!.exercises.map((e) => (e.key === 'dumbbell_curl' ? { ...e, sets: 2 } : e));
    const { proposal } = ok(applyAdaptationRules(proposalAnswer([modelExercise('dumbbell_curl', { sets: 2 })]), facts, rule({ minutes: 90 })));

    expect(proposal.exercises[0].sets).toBe(2);
  });
});

describe('conservative mode (pain wording, limitations or poor readiness)', () => {
  it('RPE at most 7 and sets at most 4 per exercise', () => {
    const source = { checkIn: { energy: 3, sleepQuality: 1, soreness: 2, stress: 2 } };
    const facts = factsOf({ request: { minutes: 90 }, source });
    expect(facts.conservative).toBe(true);
    const { proposal, report } = ok(applyAdaptationRules(proposalAnswer(upperAll()), facts, rule({ minutes: 90 })));

    for (const e of proposal.exercises) {
      expect(e.targetRpe!).toBeLessThanOrEqual(7);
      expect(e.sets).toBeLessThanOrEqual(4);
    }
    expect(codes(report.repairs)).toContain('conservative_rpe');
  });
});

describe('pain: exclude, never "push through"', () => {
  it('an avoid-list exercise is replaced by the best substitute in its pattern, keeping the prescription and marking a swap', () => {
    const facts = factsOf({
      request: { minutes: 90 },
      source: { program: { id: ADAPT_PROGRAM_ID, goal: 'hypertrophy', gymId: ADAPT_GYM_ID, intake: { experience: 'intermediate', avoidExerciseKeys: ['barbell_bench_press'] } } },
    });
    const { proposal, report } = ok(applyAdaptationRules(proposalAnswer(upperAll()), facts, rule({ minutes: 90 })));

    expect(byKey(proposal, 'barbell_bench_press')).toBeUndefined();
    const replacement = proposal.exercises[0];
    expect(replacement).toMatchObject({ exerciseKey: 'dumbbell_bench_press', source: 'swapped', replacesExerciseKey: 'barbell_bench_press' });
    expect(codes(report.repairs)).toContain('pain_substituted');
  });

  it('a pain-flagged exercise with no substitute is removed and reported as dropped for "other"', () => {
    const facts = factsOf({ request: { minutes: 90 }, source: { painFlagExerciseIds: [LIB.cable_fly.id] } });
    const { proposal, report } = ok(applyAdaptationRules(proposalAnswer(upperAll()), facts, rule({ minutes: 90 })));

    expect(byKey(proposal, 'cable_fly')).toBeUndefined();
    expect(codes(report.rejected)).toContain('pain_removed');
    expect(proposal.dropped.find((d) => d.exerciseKey === 'cable_fly')?.reason).toBe('other');
  });

  it('nothing is left after removals: ADAPTATION_INVALID', () => {
    const facts = factsOf({ request: { minutes: 90 }, source: { painFlagExerciseIds: [LIB.cable_fly.id] } });
    const outcome = applyAdaptationRules(proposalAnswer([modelExercise('cable_fly', { sets: 3 })]), facts, rule({ minutes: 90 }));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe(ADAPTATION_REASONS.INVALID);
      expect(codes(outcome.report.rejected)).toContain('pain_removed');
    }
  });
});

describe('only these equipment / bodyweight', () => {
  const onlyDb = () => factsOf({ request: onlyDumbbellsRequest({ minutes: 90 }) as unknown as Partial<AdaptationRequestInput> });

  it('every exercise in the proposal is doable with the chosen subset, whatever the model asked for', () => {
    const facts = onlyDb();
    const { proposal, report } = ok(applyAdaptationRules(proposalAnswer(upperAll()), facts, rule({ minutes: 90 })));

    for (const e of proposal.exercises) {
      const lib = LIB[e.exerciseKey];
      const needed = lib.requirements.map((r) => r.equipmentTypeId).filter(Boolean);
      for (const typeId of needed) expect([ET.dumbbells, ET.flat_bench]).toContain(typeId);
    }
    expect(proposal.exercises.map((e) => e.exerciseKey)).toEqual(expect.arrayContaining(['dumbbell_bench_press', 'dumbbell_shoulder_press', 'dumbbell_curl']));
    expect(codes(report.repairs)).toContain('equipment_substituted');
  });

  it('an exercise with no substitute is removed, and the dropped list says "equipment"', () => {
    const { proposal, report } = ok(applyAdaptationRules(proposalAnswer(upperAll()), onlyDb(), rule({ minutes: 90 })));

    expect(byKey(proposal, 'triceps_pushdown')).toBeUndefined();
    expect(codes(report.rejected)).toContain('equipment_removed');
    expect(proposal.dropped.find((d) => d.exerciseKey === 'triceps_pushdown')?.reason).toBe('equipment');
  });

  it('a substitution that lands on an exercise already in the answer is not duplicated', () => {
    const answer = proposalAnswer([
      modelExercise('barbell_bench_press', { isPriority: true, sets: 3 }),
      modelExercise('dumbbell_bench_press', { source: 'added', sets: 3 }),
    ]);
    const { proposal } = ok(applyAdaptationRules(answer, onlyDb(), rule({ minutes: 90 })));

    expect(proposal.exercises.filter((e) => e.exerciseKey === 'dumbbell_bench_press')).toHaveLength(1);
  });

  it('bodyweight mode: only exercises that need nothing survive', () => {
    const facts = factsOf({ request: { minutes: 90, equipment: { mode: 'bodyweight' } } });
    const { proposal } = ok(applyAdaptationRules(proposalAnswer(upperAll()), facts, rule({ minutes: 90 })));

    expect(proposal.exercises.length).toBeGreaterThan(0);
    for (const e of proposal.exercises) expect(LIB[e.exerciseKey].requirements).toEqual([]);
  });
});

describe('shape: the model\'s answer is checked, never trusted', () => {
  it('unknown keys and duplicates are removed and reported', () => {
    const answer = proposalAnswer([
      modelExercise('barbell_bench_press', { isPriority: true, sets: 3 }),
      modelExercise('not_a_real_exercise', { source: 'added' }),
      modelExercise('barbell_bench_press', { isPriority: true, sets: 3 }),
      modelExercise('treadmill_run_9000', { source: 'added' }),
    ]);
    const { proposal, report } = ok(applyAdaptationRules(answer, factsOf(), rule()));

    expect(proposal.exercises.map((e) => e.exerciseKey)).toEqual(['barbell_bench_press']);
    expect(codes(report.rejected)).toEqual(['unknown_exercise_removed', 'duplicate_removed', 'unknown_exercise_removed']);
  });

  it('an exercise not offered for today (in the library but not among the candidates) is unknown too', () => {
    const facts = factsOf({ request: onlyDumbbellsRequest({ minutes: 60 }) as never });
    const offered = new Set(facts.library.map((e) => e.key));
    const outsider = LIBRARY.find((e) => !offered.has(e.key))!;
    const { report } = ok(applyAdaptationRules(proposalAnswer([modelExercise('dumbbell_curl', { sets: 3 }), modelExercise(outsider.key, { source: 'added' })]), facts, rule({ minutes: 60 })));

    expect(codes(report.rejected)).toContain('unknown_exercise_removed');
  });

  it.each([
    { label: 'kept -> a planned exercise labelled "added"', exercise: { source: 'added' as const }, key: 'barbell_row', source: 'kept', code: 'source_corrected' },
    { label: 'kept -> a non-planned exercise labelled "kept"', exercise: { source: 'kept' as const }, key: 'dumbbell_lateral_raise', source: 'added', code: 'source_corrected' },
    { label: 'swapped -> a swap naming an unknown replacement is "added"', exercise: { source: 'swapped' as const, replacesExerciseKey: 'nope' }, key: 'dumbbell_lateral_raise', source: 'added', code: 'source_corrected' },
    { label: 'swapped -> a valid swap stays swapped', exercise: { source: 'swapped' as const, replacesExerciseKey: 'barbell_row' }, key: 'dumbbell_row', source: 'swapped', code: null },
  ])('source: $label', ({ exercise, key, source, code }) => {
    const answer = proposalAnswer([modelExercise(key, { sets: 3, ...exercise })]);
    const { proposal, report } = ok(applyAdaptationRules(answer, factsOf(), rule()));

    expect(proposal.exercises[0].source).toBe(source);
    if (code) expect(codes(report.repairs)).toContain(code);
    else expect(codes(report.repairs)).not.toContain('source_corrected');
  });

  it('one planned exercise can be replaced only once', () => {
    const answer = proposalAnswer([
      modelExercise('dumbbell_row', { source: 'swapped', replacesExerciseKey: 'barbell_row', sets: 3 }),
      modelExercise('seated_cable_row', { source: 'swapped', replacesExerciseKey: 'barbell_row', sets: 3 }),
    ]);
    const { proposal } = ok(applyAdaptationRules(answer, factsOf(), rule()));

    expect(proposal.exercises.map((e) => e.source)).toEqual(['swapped', 'added']);
  });

  it('the model cannot promote an exercise to priority, and the plan\'s priority is not something it can drop', () => {
    const answer = proposalAnswer([
      modelExercise('dumbbell_curl', { isPriority: true, sets: 3 }),
      modelExercise('barbell_bench_press', { isPriority: false, sets: 4 }),
    ]);
    const { proposal, report } = ok(applyAdaptationRules(answer, factsOf(), rule()));

    expect(byKey(proposal, 'dumbbell_curl')?.isPriority).toBe(false);
    expect(byKey(proposal, 'barbell_bench_press')?.isPriority).toBe(true);
    expect(codes(report.repairs)).toContain('priority_corrected');
  });

  it.each([
    { label: 'sets 0 -> 1 (then the plan ceiling)', over: { sets: 0 }, expected: { sets: 1 }, code: 'sets_clamped' },
    { label: 'sets 3.6 -> 4', over: { sets: 3.6 }, expected: { sets: 4 }, code: 'sets_clamped' },
    { label: 'repMin 0 -> 1', over: { repMin: 0, repMax: 10 }, expected: { repMin: 1 }, code: 'reps_clamped' },
    { label: 'repMax 99 -> 30', over: { repMin: 8, repMax: 99 }, expected: { repMax: 30 }, code: 'reps_clamped' },
    { label: 'repMax below repMin -> repMin', over: { repMin: 12, repMax: 8 }, expected: { repMin: 12, repMax: 12 }, code: 'reps_clamped' },
    { label: 'rest 5 s -> 30 s', over: { restSeconds: 5 }, expected: { restSeconds: 30 }, code: 'rest_clamped' },
    { label: 'rest 900 s -> 300 s', over: { restSeconds: 900 }, expected: { restSeconds: 300 }, code: 'rest_clamped' },
    { label: 'RPE 7.3 -> 7.5', over: { targetRpe: 7.3 }, expected: { targetRpe: 7.5 }, code: 'rpe_clamped' },
    { label: 'RPE 3 -> 5', over: { targetRpe: 3 }, expected: { targetRpe: 5 }, code: 'rpe_clamped' },
  ])('bounds: $label', ({ over, expected, code }) => {
    const answer = proposalAnswer([modelExercise('barbell_bench_press', { isPriority: true, sets: 4, targetRpe: 8, ...over })]);
    const { proposal, report } = ok(applyAdaptationRules(answer, factsOf(), rule()));

    expect(proposal.exercises[0]).toMatchObject(expected);
    expect(codes(report.repairs)).toContain(code);
  });

  it('text is clipped to the contract: title 80, summary 400, rationale 6 x 200, uncertainty 6 x 200, note 160', () => {
    const long = 'z'.repeat(1000);
    const answer = proposalAnswer([modelExercise('barbell_bench_press', { isPriority: true, sets: 3, note: long })], {
      title: long,
      summary: long,
      rationale: Array.from({ length: 9 }, () => long),
      uncertainty: Array.from({ length: 9 }, () => long),
    });
    const { proposal } = ok(applyAdaptationRules(answer, factsOf(), rule()));

    expect([...proposal.title].length).toBeLessThanOrEqual(80);
    expect([...proposal.summary].length).toBeLessThanOrEqual(400);
    expect(proposal.rationale).toHaveLength(6);
    for (const line of [...proposal.rationale, ...proposal.uncertainty]) expect([...line].length).toBeLessThanOrEqual(200);
    expect(proposal.uncertainty).toHaveLength(6);
    expect([...proposal.exercises[0].note!].length).toBeLessThanOrEqual(160);
  });

  it('empty text falls back: the planned workout\'s name as the title, a default rationale line', () => {
    const answer = proposalAnswer([modelExercise('barbell_bench_press', { isPriority: true, sets: 3 })], { title: '   ', rationale: ['  '] });
    const withBase = ok(applyAdaptationRules(answer, factsOf(), rule()));
    const adHoc = ok(applyAdaptationRules(answer, factsOf({ source: { planned: null } }), rule()));

    expect(withBase.proposal.title).toBe('Upper A');
    expect(adHoc.proposal.title).toBe('Adapted workout');
    expect(withBase.proposal.rationale).toEqual(['Adjusted to what you told us about today.']);
  });

  it('positions are sequential from 0 and exercises carry their muscles and tracking mode from the library', () => {
    const { proposal } = ok(applyAdaptationRules(proposalAnswer(upperAll()), factsOf(), rule()));

    expect(proposal.exercises.map((e) => e.position)).toEqual(proposal.exercises.map((_e, i) => i));
    expect(byKey(proposal, 'barbell_bench_press')).toMatchObject({ primaryMuscles: ['chest', 'triceps'], trackingMode: 'weight_reps', exerciseId: LIB.barbell_bench_press.id });
  });

  it('planned exercises the answer leaves out are listed as dropped: the model\'s reason when given, else "other"', () => {
    const answer = proposalAnswer(
      [modelExercise('barbell_bench_press', { isPriority: true, sets: 4 }), modelExercise('barbell_row', { isPriority: true, sets: 4 })],
      { dropped: [{ exerciseKey: 'cable_fly', reason: 'sore' }] },
    );
    const { proposal } = ok(applyAdaptationRules(answer, factsOf(), rule()));

    const reasons = Object.fromEntries(proposal.dropped.map((d) => [d.exerciseKey, d.reason]));
    expect(reasons).toEqual({ dumbbell_shoulder_press: 'other', cable_fly: 'sore', triceps_pushdown: 'other', dumbbell_curl: 'other' });
    expect(proposal.dropped.find((d) => d.exerciseKey === 'cable_fly')).toMatchObject({ exerciseId: LIB.cable_fly.id, name: LIB.cable_fly.name });
  });
});

describe('purity', () => {
  it('is deterministic and never mutates its input', () => {
    const answer = proposalAnswer([...upperAll(), modelExercise('not_real', { source: 'added' })]);
    const facts = factsOf({ request: { minutes: 30, soreness: { muscles: ['chest'], level: 'mild' } } });
    const request = rule({ minutes: 30, soreness: { muscles: ['chest'], level: 'mild' } });
    const before = JSON.stringify({ answer, facts, request });

    const first = applyAdaptationRules(answer, facts, request);
    const second = applyAdaptationRules(answer, facts, request);

    expect(JSON.stringify({ answer, facts, request })).toBe(before);
    expect(second).toEqual(first);
  });
});

describe('staleFindings (the apply-time re-check; never repairs)', () => {
  const proposalFor = (over: Over = {}) => {
    const facts = factsOf({ request: onlyDumbbellsRequest({ minutes: 60 }) as never, ...over });
    return { facts, proposal: ok(applyAdaptationRules(proposalAnswer([modelExercise('dumbbell_bench_press', { source: 'swapped', replacesExerciseKey: 'barbell_bench_press', isPriority: true, sets: 3 }), modelExercise('dumbbell_curl', { sets: 3 })]), facts, rule({ minutes: 60 }))).proposal };
  };
  const current = (facts: AdaptationFacts) => ({
    library: new Map(LIBRARY.map((e) => [e.id, e])),
    inventory: facts.inventory,
    painFlagKeys: facts.painFlagKeys,
    avoidKeys: facts.avoidKeys,
  });

  it('is empty while everything still holds', () => {
    const { facts, proposal } = proposalFor();
    expect(staleFindings(proposal, current(facts))).toEqual([]);
  });

  it('an exercise deleted from the library is exercise_unavailable', () => {
    const { facts, proposal } = proposalFor();
    const library = new Map(LIBRARY.filter((e) => e.key !== 'dumbbell_curl').map((e) => [e.id, e]));

    expect(codes(staleFindings(proposal, { ...current(facts), library }))).toEqual(['exercise_unavailable']);
  });

  it('a gym that lost its dumbbells is equipment_changed for each exercise that needed them', () => {
    const { facts, proposal } = proposalFor();
    const inventory = { equipmentTypeIds: [ET.flat_bench], capabilityIds: [] };
    const findings = staleFindings(proposal, { ...current(facts), inventory });

    expect(findings.map((f) => f.code)).toEqual(['equipment_changed', 'equipment_changed']);
    expect(findings.map((f) => f.exerciseKey)).toEqual(['dumbbell_bench_press', 'dumbbell_curl']);
  });

  it('no gym at all (bodyweight only) makes equipment exercises stale', () => {
    const { facts, proposal } = proposalFor();
    expect(staleFindings(proposal, { ...current(facts), inventory: null }).length).toBe(2);
  });

  it.each([
    ['a new pain flag', { painFlagKeys: ['dumbbell_curl'], avoidKeys: [] }],
    ['a new avoid-list entry', { painFlagKeys: [], avoidKeys: ['dumbbell_curl'] }],
  ])('%s is pain_flagged', (_label, extra) => {
    const { facts, proposal } = proposalFor();
    const findings = staleFindings(proposal, { ...current(facts), ...extra });

    expect(findings).toEqual([{ code: 'pain_flagged', exerciseKey: 'dumbbell_curl', message: expect.stringContaining('avoid list or pain-flagged') }]);
  });
});
