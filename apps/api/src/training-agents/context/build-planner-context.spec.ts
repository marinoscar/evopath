import {
  ageInYears,
  buildTrainingRunContext,
  candidateExercises,
  compactPlan,
  equipmentClassOf,
  weightTrend,
} from './build-planner-context';
import { PLANNER_CONTEXT_KEYS } from './planner-context.contract';
import { summarizePlannerContext, summarizeResearcherContext, NONE_USED } from './summarize-context';
import { NEVER_SEND_LABELS } from './never-send';
import {
  DUMBBELL_GYM,
  FIXTURE_NOW,
  FULL_GYM,
  LIB,
  LIBRARY,
  contextSourceFixture,
  inventoryOf,
  runContextFixture,
} from '../testing/context-fixtures';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const daysAgo = (n: number) => new Date(FIXTURE_NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe('buildTrainingRunContext', () => {
  it('without profile, metrics, history or check-ins: those sections are omitted (never null) and nothing is a uuid', () => {
    const context = runContextFixture();

    expect(Object.keys(context.planner).sort()).toEqual(
      [
        'request',
        'goal',
        'experience',
        'daysPerWeek',
        'preferredWeekdays',
        'minutesPerSession',
        'durationWeeks',
        'limitations',
        'avoidExerciseKeys',
        'preferences',
        'conservative',
        'equipment',
        'candidateExercises',
      ].sort(),
    );
    expect(JSON.stringify(context.planner)).not.toMatch(UUID);
    expect(JSON.stringify(context.researcher)).not.toMatch(UUID);
    expect(context.mode).toEqual({ conservative: false, reasons: [] });
  });

  it('every key the builder can produce is in PLANNER_CONTEXT_KEYS, and the summary renders each exactly once', () => {
    const full = buildTrainingRunContext(
      contextSourceFixture({
        kind: 'revise',
        intake: { includeBio: true },
        revise: {
          programId: 'p',
          basedOnVersion: 1,
          instruction: 'More rows',
          currentPlan: {
            blocks: [
              {
                position: 0,
                name: 'B',
                focus: null,
                rationale: null,
                weeks: [{ weekNumber: 1, isDeload: false, workouts: [] }],
              },
            ],
          },
        },
        profile: { dateOfBirth: '1990-01-01', sexAtBirth: 'female', heightMm: 1700, unitSystem: 'metric', bio: 'I like rowing' },
        weights: [{ measuredAt: daysAgo(3), valueKg: 70 }],
        workouts: [
          {
            date: '2026-09-28',
            startedAt: daysAgo(2),
            completed: true,
            exercises: [{ exerciseId: LIB.goblet_squat.id, sets: [{ weightKg: 20, reps: 10, completed: true, isWarmup: false, painFlag: false }] }],
          },
        ],
        checkIns: [{ date: '2026-09-29', energy: 4, sleepQuality: 4, soreness: 2, stress: 2 }],
      }),
    );

    expect(Object.keys(full.planner).sort()).toEqual([...PLANNER_CONTEXT_KEYS].sort());

    const summary = summarizePlannerContext(full.planner);
    expect(summary.sections.map((s) => s.key)).toEqual([...PLANNER_CONTEXT_KEYS]);
    expect(summary.excluded).toEqual([...NEVER_SEND_LABELS]);

    const empty = summarizePlannerContext(runContextFixture().planner);
    for (const key of ['profile', 'bodyMetrics', 'history', 'readiness', 'bio', 'currentPlan']) {
      expect(empty.sections.find((s) => s.key === key)?.items).toEqual([NONE_USED]);
    }
  });

  it('the summary names what the context budget dropped', () => {
    const summary = summarizePlannerContext(runContextFixture().planner, ['history', 'bio']);
    expect(summary.dropped).toEqual(['Training history (last 6 weeks)', 'Bio']);
  });

  it('the researcher summary covers every researcher key', () => {
    const context = runContextFixture({ intake: { tailorResearch: true } });
    expect(summarizeResearcherContext(context.researcher).sections.map((s) => s.key).sort()).toEqual(Object.keys(context.researcher).sort());
  });

  it('profile: an integer age (never the birth date), sex female/male only, height in cm, unit preference; bio only with includeBio', () => {
    const profile = { dateOfBirth: '1990-10-01', sexAtBirth: 'prefer_not_to_say', heightMm: 1805, unitSystem: 'imperial', bio: 'BIO-TEXT' };
    const without = runContextFixture({ profile });
    const withBio = runContextFixture({ profile, intake: { includeBio: true } });

    expect(without.planner.profile).toEqual({ ageYears: 35, sexAtBirth: null, heightCm: 180.5, unitPreference: 'imperial' });
    expect(JSON.stringify(without.planner)).not.toContain('1990');
    expect(JSON.stringify(without)).not.toContain('BIO-TEXT');
    expect(withBio.planner.bio).toBe('BIO-TEXT');
    expect(JSON.stringify(withBio.researcher)).not.toContain('BIO-TEXT');
  });

  it('bio is cut to 500 characters', () => {
    const context = runContextFixture({
      intake: { includeBio: true },
      profile: { dateOfBirth: null, sexAtBirth: null, heightMm: null, unitSystem: 'metric', bio: 'x'.repeat(900) },
    });
    expect(context.planner.bio).toHaveLength(500);
  });

  it.each([
    ['2000-09-30', 26],
    ['2000-10-01', 25],
    [null, null],
    ['garbage', null],
  ])('ageInYears(%s) on 2026-09-30 = %s', (dob, age) => {
    expect(ageInYears(dob, FIXTURE_NOW)).toBe(age);
  });

  it('body metrics: the latest weight, body fat, and an 8-week kg/week trend', () => {
    const context = runContextFixture({
      weights: [
        { measuredAt: daysAgo(70), valueKg: 90 },
        { measuredAt: daysAgo(14), valueKg: 81 },
        { measuredAt: daysAgo(7), valueKg: 80.5 },
        { measuredAt: daysAgo(0), valueKg: 80 },
      ],
      latestBodyFatPercent: 21.44,
    });

    expect(context.planner.bodyMetrics).toEqual({ weightKg: 80, bodyFatPercent: 21.4, weightTrend: { kgPerWeek: -0.5, points: 3 } });
    expect(weightTrend([{ measuredAt: daysAgo(1), valueKg: 80 }])).toBeNull();
  });

  it('readiness: 7-day averages of the four scores and the day count; low scores switch conservative mode on', () => {
    const context = runContextFixture({
      checkIns: [
        { date: '2026-09-28', energy: 2, sleepQuality: 3, soreness: 2, stress: 3 },
        { date: '2026-09-29', energy: 1, sleepQuality: null, soreness: 3, stress: 3 },
      ],
    });

    expect(context.planner.readiness).toEqual({ energy: 1.5, sleepQuality: 3, soreness: 2.5, stress: 3, days: 2 });
    expect(context.mode).toEqual({ conservative: true, reasons: ['readiness:low_energy'] });
    expect(context.planner.conservative).toBe(true);
  });

  it('a limitation or "knee pain" switches conservative mode on', () => {
    expect(runContextFixture({ intake: { limitations: [{ area: 'knee', description: '' }] } }).mode.conservative).toBe(true);
    expect(runContextFixture({ intake: { preferences: 'I have knee pain' } }).mode).toEqual({ conservative: true, reasons: ['stem:pain'] });
  });

  it('history: sessions per week, per exercise the last top set, sessions ago and best load; pain flags in 28 days', () => {
    const set = (weightKg: number, reps: number, extra: Partial<{ isWarmup: boolean; painFlag: boolean; completed: boolean }> = {}) => ({
      weightKg,
      reps,
      completed: true,
      isWarmup: false,
      painFlag: false,
      ...extra,
    });
    const context = runContextFixture({
      workouts: [
        {
          date: '2026-09-29',
          startedAt: daysAgo(1),
          completed: true,
          exercises: [{ exerciseId: LIB.barbell_bench_press.id, sets: [set(40, 10, { isWarmup: true }), set(60, 8), set(62.5, 5)] }],
        },
        {
          date: '2026-09-20',
          startedAt: daysAgo(10),
          completed: true,
          exercises: [
            { exerciseId: LIB.barbell_bench_press.id, sets: [set(65, 3)] },
            { exerciseId: LIB.romanian_deadlift.id, sets: [set(80, 8, { painFlag: true })] },
          ],
        },
        {
          date: '2026-07-01',
          startedAt: daysAgo(91),
          completed: true,
          exercises: [{ exerciseId: LIB.barbell_row.id, sets: [set(50, 8)] }],
        },
      ],
    });

    expect(context.planner.history).toEqual({
      sessionsPerWeek: [0, 0, 0, 0, 1, 1],
      exercises: [
        { key: 'barbell_bench_press', lastTopSet: { weightKg: 62.5, reps: 5 }, sessionsAgo: 1, bestRecentWorkingLoadKg: 65 },
        { key: 'romanian_deadlift', lastTopSet: { weightKg: 80, reps: 8 }, sessionsAgo: 2, bestRecentWorkingLoadKg: 80 },
      ],
      painFlagExerciseKeys: ['romanian_deadlift'],
    });
    expect(context.history.find((h) => h.key === 'barbell_bench_press')).toMatchObject({
      lastLoadKg: 62.5,
      lastDate: '2026-09-29',
      lastMinReps: 5,
      bestRecentLoadKg: 65,
      painFlagged: false,
    });
    // A pain-flagged exercise is never offered as a candidate.
    expect(context.planner.candidateExercises.map((c) => c.key)).not.toContain('romanian_deadlift');
  });

  it('candidates: only what the gym supports (requirement groups), minus the avoid list, by goal relevance then name', () => {
    const dumbbells = candidateExercises({ library: LIBRARY, gym: inventoryOf(DUMBBELL_GYM), goal: 'strength', exclude: new Set(['dumbbell_row']) });
    const keys = dumbbells.map((c) => c.key);

    expect(keys).toContain('dumbbell_bench_press');
    expect(keys).toContain('goblet_squat');
    expect(keys).not.toContain('barbell_back_squat');
    expect(keys).not.toContain('dumbbell_row');
    expect(keys).not.toContain('inverted_row'); // needs a rack or a bar
    // Compound patterns first for strength, isolation and core after.
    expect(keys.indexOf('dumbbell_bench_press')).toBeLessThan(keys.indexOf('dumbbell_curl'));
    expect(keys.indexOf('dumbbell_lunge')).toBeLessThan(keys.indexOf('plank'));

    const none = candidateExercises({ library: LIBRARY, gym: null, goal: 'general', exclude: new Set() });
    expect(none.every((c) => LIB[c.key].requirements.length === 0)).toBe(true);
    expect(none.map((c) => c.key)).toContain('push_up');
  });

  it('candidates are capped at 150', () => {
    const big = Array.from({ length: 200 }, (_v, i) => ({ ...LIB.push_up, id: `id-${i}`, key: `push_${String(i).padStart(3, '0')}`, name: `Push ${i}` }));
    expect(candidateExercises({ library: big, gym: null, goal: 'general', exclude: new Set() })).toHaveLength(150);
  });

  it('equipment class and capability keys (never the gym name)', () => {
    expect(equipmentClassOf(null)).toBe('bodyweight');
    expect(equipmentClassOf(DUMBBELL_GYM)).toBe('home_basic');
    expect(equipmentClassOf(FULL_GYM)).toBe('full_gym');
    expect(runContextFixture({ gym: null }).planner.equipment).toEqual({ hasGym: false, equipmentClass: 'bodyweight', capabilityKeys: [] });
    expect(runContextFixture({ gym: DUMBBELL_GYM }).planner.equipment.capabilityKeys).toEqual(['goblet_squat']);
  });

  it('compactPlan: identical weeks once, then the sequence, exercises by key', () => {
    const workout = (weekday: number) => ({
      position: 0,
      weekday,
      name: 'Full body',
      estimatedMinutes: 45,
      rationale: null,
      exercises: [
        {
          exerciseId: LIB.goblet_squat.id,
          position: 0,
          isPriority: true,
          targetSets: 3,
          repMin: 8,
          repMax: 12,
          targetLoadKg: null,
          targetRpe: 7,
          restSeconds: 90,
          loadGuidance: 'choose_start' as const,
          rationale: null,
          evidenceRefs: [],
          notes: null,
          equipmentTypeId: null,
        },
      ],
    });
    const compact = compactPlan(
      {
        blocks: [
          {
            position: 0,
            name: 'Base',
            focus: null,
            rationale: null,
            weeks: [
              { weekNumber: 1, isDeload: false, workouts: [workout(1)] },
              { weekNumber: 2, isDeload: false, workouts: [workout(1)] },
              { weekNumber: 3, isDeload: true, workouts: [workout(2)] },
            ],
          },
        ],
      },
      new Map(LIBRARY.map((e) => [e.id, e])),
    );

    expect(compact.weekTypes.map((t) => t.key)).toEqual(['W1', 'W2']);
    expect(compact.weeks.map((w) => w.weekType)).toEqual(['W1', 'W1', 'W2']);
    expect(compact.weekTypes[0].workouts[0].exercises[0].key).toBe('goblet_squat');
    expect(JSON.stringify(compact)).not.toMatch(UUID);
  });
});
