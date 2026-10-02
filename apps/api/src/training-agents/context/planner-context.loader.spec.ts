import { HARNESS_USER } from '../../ai/testing/ai-runtime-harness';
import { buildTrainingRunContext } from './build-planner-context';
import { PlannerContextLoader } from './planner-context.loader';
import { runPrepareContext } from '../nodes/prepare-context.node';
import { CANARY, CANARY_GYM, CANARY_TOKENS, CANARY_USER, createCanaryPrisma } from '../testing/canary-prisma';
import { FIXTURE_NOW } from '../testing/context-fixtures';
import { intakeFixture } from '../testing/intake-fixtures';
import { createNodeContextHarness } from '../testing/node-context-harness';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function request(over: Parameters<typeof intakeFixture>[0] = {}) {
  return {
    kind: 'create',
    intake: intakeFixture({
      gymId: CANARY_GYM,
      goal: { type: 'strength', description: 'Squat more' },
      limitations: [{ area: 'knee', description: 'Old ache' }],
      ...over,
    }),
  };
}

describe('PlannerContextLoader + builder: data minimisation canary', () => {
  it('scopes every read by the caller and never lets a canary token into what is sent', async () => {
    const prisma = createCanaryPrisma();
    const loader = new PlannerContextLoader(prisma as never);

    const context = buildTrainingRunContext(await loader.load(CANARY_USER, request(), FIXTURE_NOW));
    const sent = JSON.stringify({ planner: context.planner, researcher: context.researcher });

    for (const token of [...CANARY_TOKENS, CANARY.bio]) expect(sent).not.toContain(token);
    expect(sent).not.toMatch(UUID);
    // The user's own words for this intake are sent.
    expect(sent).toContain('Squat more');
    expect(sent).toContain('Old ache');
    // Real data made it through: age, readiness, history, pain flags, the gym's capabilities.
    expect(context.planner.profile?.ageYears).toBe(39);
    expect(context.planner.readiness?.days).toBe(1);
    expect(context.planner.history?.exercises.map((e) => e.key)).toEqual(['barbell_bench_press', 'barbell_row']);
    expect(context.planner.history?.painFlagExerciseKeys).toEqual(['barbell_row']);
    expect(context.planner.equipment.capabilityKeys.length).toBeGreaterThan(0);

    for (const call of prisma.gym.findFirst.mock.calls) expect(call[0].where).toMatchObject({ userId: CANARY_USER });
    for (const call of prisma.measurement.findMany.mock.calls) expect(call[0].where).toMatchObject({ userId: CANARY_USER, supersededAt: null, deletedAt: null });
    for (const call of prisma.workout.findMany.mock.calls) expect(call[0].where).toMatchObject({ userId: CANARY_USER });
    expect(prisma.gymEquipment.findMany.mock.calls.every((c) => c[0].where.gymId === CANARY_GYM)).toBe(true);
    // The loader never reads the user row (name, email).
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('user memory (#325): only the training-audience block is sent, and no other canary rides along', async () => {
    const memoryText = 'CANARY-MEMORY-FACT User trains before work.';
    const buildBlock = jest.fn(async (_userId: string, _opts: { audience: string }) =>
      `<user_memories>\nUser-provided notes.\n- (schedule) ${memoryText}\n</user_memories>`,
    );
    const loader = new PlannerContextLoader(createCanaryPrisma() as never, undefined, { buildBlock } as never);

    const context = buildTrainingRunContext(await loader.load(CANARY_USER, request(), FIXTURE_NOW));
    const sent = JSON.stringify({ planner: context.planner, researcher: context.researcher });

    expect(buildBlock).toHaveBeenCalledWith(CANARY_USER, { audience: 'training' });
    expect(context.planner.userMemories).toContain(memoryText);
    // The researcher (web search queries) never sees a memory.
    expect(JSON.stringify(context.researcher)).not.toContain('CANARY-MEMORY');
    for (const token of [...CANARY_TOKENS, CANARY.bio]) expect(sent).not.toContain(token);
    expect(sent).not.toMatch(UUID);
  });

  it('the bio is sent only with includeBio', async () => {
    const loader = new PlannerContextLoader(createCanaryPrisma() as never);
    const context = buildTrainingRunContext(await loader.load(CANARY_USER, request({ includeBio: true }), FIXTURE_NOW));

    expect(context.planner.bio).toBe(CANARY.bio);
    expect(JSON.stringify(context.researcher)).not.toContain(CANARY.bio);
  });

  it('a gym that is not the caller\'s fails the run TRAINING_GYM_NOT_FOUND', async () => {
    const loader = new PlannerContextLoader(createCanaryPrisma({ userId: 'someone-else' }) as never);

    await expect(loader.load(CANARY_USER, request(), FIXTURE_NOW)).rejects.toMatchObject({ code: 'TRAINING_GYM_NOT_FOUND' });
  });

  it('prepare_context reads through the port and returns the run context; without a port it fails', async () => {
    const loader = new PlannerContextLoader(createCanaryPrisma({ userId: HARNESS_USER }) as never);
    const h = createNodeContextHarness({ ports: { plannerContext: loader }, now: () => FIXTURE_NOW });

    const update = await h.runNode(runPrepareContext, { input: request() });
    expect(update.context).toMatchObject({ version: 1, kind: 'create', mode: { conservative: true } });

    const bare = createNodeContextHarness();
    await expect(bare.runNode(runPrepareContext, { input: request() })).rejects.toMatchObject({ code: 'TRAINING_CONTEXT_UNAVAILABLE' });
  });
});
