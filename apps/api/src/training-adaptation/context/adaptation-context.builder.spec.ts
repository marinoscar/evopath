import { ET, fixtureId } from '../../training-agents/testing/context-fixtures';
import {
  CANARY,
  CANARY_DEFAULT_GYM as DEFAULT_GYM,
  CANARY_NOW as NOW,
  CANARY_OTHER_GYM as OTHER_GYM,
  CANARY_PLAN_GYM as PLAN_GYM,
  CANARY_PROGRAM as PROGRAM,
  CANARY_PROGRAM_WORKOUT as PROGRAM_WORKOUT,
  CANARY_THEIR_GYM as THEIR_GYM,
  CANARY_VERSION_ID as VERSION_ID,
  CANARY_TOKENS,
  createCanaryAdaptationSource,
} from '../testing/adaptation-canary';
import { adaptationRequestFixture } from '../testing/adaptation-fixtures';
import { AdaptationContextError } from './adaptation-context.contract';

// =============================================================================
// AdaptationContextBuilder: the READS behind the context
// =============================================================================
//
// The real builder over `createCanaryAdaptationSource` (`testing/adaptation-canary.ts`):
// a Prisma stand-in that returns every row WHOLE (it ignores `select`), with a
// unique canary token in each private column, and stand-ins for every table it
// must never read. A token can only stay out of the context if the builder
// never copies the field, and every query must be scoped by the caller's id.
// =============================================================================

type Row = Record<string, unknown>;
const ME = fixtureId(1, 'a');

function harness(over: { rows?: { programGymId?: string | null; hasProgram?: boolean; planned?: 'workout' | 'rest' } } = {}) {
  const source = createCanaryAdaptationSource({ userId: ME, ...over.rows });
  return { ...source, prisma: source.prisma, library: source.library };
}

const everything = (value: unknown) => JSON.stringify(value);

describe('AdaptationContextBuilder', () => {
  it('reads the plan gym, today\'s workout, the library and readiness, and builds the minimised context', async () => {
    const h = harness();
    const context = await h.builder.build(ME, adaptationRequestFixture({ minutes: 30 }), NOW);

    expect(context.facts.gymId).toBe(PLAN_GYM);
    expect(context.facts.base?.programWorkoutId).toBe(PROGRAM_WORKOUT);
    expect(context.facts.base?.gymId).toBe(PLAN_GYM);
    expect(context.baseRef).toEqual({ planId: PROGRAM, planVersionId: VERSION_ID, planVersion: 3, planWorkoutId: PROGRAM_WORKOUT, date: '2026-09-30' });
    expect(context.sent.readiness).toEqual({ energy: 3, sleepQuality: 4, soreness: 2, stress: 2 });
    expect(context.sent.gym).toEqual({
      type: 'home',
      bodyweightOnly: false,
      equipment: [
        { name: 'Dumbbells', quantity: 2, capabilities: ['goblet_squat'] },
        { name: 'Flat bench', quantity: 1, capabilities: [] },
      ],
    });
    expect(context.facts.painFlagKeys).toEqual(['dumbbell_curl']);
    expect(context.facts.today).toBe('2026-09-30');
  });

  it('the canary: no private column of any row it reads reaches the sent context, the summary or the facts', async () => {
    const h = harness();
    const context = await h.builder.build(ME, adaptationRequestFixture({ minutes: 30, equipment: { mode: 'only', equipmentTypeIds: [ET.dumbbells] } }), NOW);
    const all = everything(context);

    for (const token of CANARY_TOKENS) expect(all).not.toContain(token);
    expect(all).not.toContain(CANARY.email);
    // ... and it never even reads a table it has no business with (the user, labs, medications, weight history, documents).
    expect(h.forbiddenReads).toEqual([]);
  });

  it('every query is scoped to the caller: another user\'s gym is unreachable and never merged in', async () => {
    const h = harness();
    await h.builder.build(ME, adaptationRequestFixture({ minutes: 30 }), NOW);

    const scoped = (model: string, path: (args: Row) => unknown) =>
      h.queries.filter((q) => q.model === model).every((q) => path(q.args) === ME);
    expect(scoped('program', (a) => (a.where as Row).userId)).toBe(true);
    expect(scoped('gym', (a) => (a.where as Row).userId)).toBe(true);
    expect(scoped('gymEquipment', (a) => ((a.where as Row).gym as Row).userId)).toBe(true);
    const painWhere = h.queries.find((q) => q.model === 'setLog')!.args.where as { workoutExercise: { workout: { userId: string } } };
    expect(painWhere.workoutExercise.workout.userId).toBe(ME);
    expect(h.library.loadLibrary).toHaveBeenCalledWith(ME);
    expect(h.checkIns.today).toHaveBeenCalledWith(ME, NOW);
  });

  it('selects only what it uses from a gym (never its name, notes, photos or location)', async () => {
    const h = harness();
    await h.builder.build(ME, adaptationRequestFixture({ minutes: 30 }), NOW);

    for (const q of h.queries.filter((x) => x.model === 'gym')) {
      expect(Object.keys(q.args.select as Row).sort()).toEqual(['id', 'type']);
    }
    const equipmentSelect = h.queries.find((q) => q.model === 'gymEquipment')!.args.select as Row;
    expect(Object.keys(equipmentSelect).sort()).toEqual(['equipmentType', 'equipmentTypeId', 'quantity']);
    expect(everything(equipmentSelect)).not.toMatch(/notes|photo|latitude|longitude|name":true,"notes/);
  });

  it('a gym the caller names is used; someone else\'s is ADAPTATION_GYM_NOT_FOUND (indistinguishable from a missing one)', async () => {
    const h = harness();

    const own = await h.builder.build(ME, adaptationRequestFixture({ gymId: OTHER_GYM }), NOW);
    expect(own.facts.gymId).toBe(OTHER_GYM);
    expect(own.sent.gym.equipment.map((e) => e.name)).toEqual(['Treadmill']);

    for (const gymId of [THEIR_GYM, fixtureId(99, 'b')]) {
      await expect(h.builder.build(ME, adaptationRequestFixture({ gymId }), NOW)).rejects.toMatchObject({
        constructor: AdaptationContextError,
        code: 'ADAPTATION_GYM_NOT_FOUND',
      });
    }
  });

  it('with no gym named and no plan gym, the default gym is used', async () => {
    const h = harness({ rows: { programGymId: null } });
    const context = await h.builder.build(ME, adaptationRequestFixture({ minutes: 30 }), NOW);

    expect(context.facts.gymId).toBe(DEFAULT_GYM);
    expect(context.sent.gym.type).toBe('commercial');
  });

  it('a plan gym that no longer exists falls back to the default gym (a named one would be an error)', async () => {
    const h = harness({ rows: { programGymId: fixtureId(98, 'b') } });
    const context = await h.builder.build(ME, adaptationRequestFixture({ minutes: 30 }), NOW);

    expect(context.facts.gymId).toBe(DEFAULT_GYM);
  });

  it('an only-equipment type the chosen gym lacks surfaces as ADAPTATION_EQUIPMENT_NOT_IN_GYM', async () => {
    const h = harness();
    const request = adaptationRequestFixture({ equipment: { mode: 'only', equipmentTypeIds: [ET.barbell] } });

    await expect(h.builder.build(ME, request, NOW)).rejects.toMatchObject({ code: 'ADAPTATION_EQUIPMENT_NOT_IN_GYM' });
  });

  it('useReadiness: false never reads the check-in; a missing check-in just omits the section', async () => {
    const off = harness();
    const context = await off.builder.build(ME, adaptationRequestFixture({ minutes: 30, useReadiness: false }), NOW);
    expect(off.checkIns.getForDate).not.toHaveBeenCalled();
    expect(context.sent.readiness).toBeUndefined();

    const missing = harness();
    missing.checkIns.getForDate.mockResolvedValueOnce(null as never);
    const noCheckIn = await missing.builder.build(ME, adaptationRequestFixture({ minutes: 30 }), NOW);
    expect(noCheckIn.sent.readiness).toBeUndefined();
    expect(noCheckIn.safety.level).toBe('ok');
  });

  it('baseWorkout none never asks for today\'s workout: an ad-hoc context with a plan header but no base', async () => {
    const h = harness();
    const context = await h.builder.build(ME, adaptationRequestFixture({ minutes: 30, baseWorkout: 'none' }), NOW);

    expect(h.todayService.today).not.toHaveBeenCalled();
    expect(context.facts.base).toBeNull();
    expect(context.baseRef).toBeNull();
    expect(context.sent.today).toBeUndefined();
    expect(context.sent.plan).toBeDefined();
  });

  it('a rest day resolves to no base even though a plan is active', async () => {
    const h = harness({ rows: { planned: 'rest' } });
    const context = await h.builder.build(ME, adaptationRequestFixture({ minutes: 30 }), NOW);

    expect(h.todayService.today).toHaveBeenCalledWith(ME, '2026-09-30', NOW);
    expect(context.facts.base).toBeNull();
    expect(context.sent.request.baseWorkout).toBe('none');
  });

  it('no active plan: no base, no plan header, and today is never resolved', async () => {
    const h = harness({ rows: { hasProgram: false } });
    const context = await h.builder.build(ME, adaptationRequestFixture({ minutes: 30 }), NOW);

    expect(h.todayService.today).not.toHaveBeenCalled();
    expect(context.facts.base).toBeNull();
    expect(context.sent.plan).toBeUndefined();
    // No plan gym: the default gym is used.
    expect(context.facts.gymId).toBe(DEFAULT_GYM);
  });

  it('"today" is the server\'s day from the check-in service, never the client\'s', async () => {
    const h = harness();
    h.checkIns.today.mockResolvedValueOnce('2026-10-01');
    const context = await h.builder.build(ME, adaptationRequestFixture({ minutes: 30 }), NOW);

    expect(h.todayService.today).toHaveBeenCalledWith(ME, '2026-10-01', NOW);
    expect(context.facts.today).toBe('2026-10-01');
  });
});
