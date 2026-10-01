import type { AiResponseRequest } from '../../ai/core/types/responses.types';
import { HARNESS_USER } from '../../ai/testing/ai-runtime-harness';
import { planTreeSchema, type PlanTree } from '../../programs/contracts/plan-tree.contract';
import type { PlanDraft } from '../agents/planner/plan-draft.contract';
import { supportedBy, type PlannerContextSource } from '../context/build-planner-context';
import { PlannerContextLoader } from '../context/planner-context.loader';
import { briefFromEvidence } from '../finalize/plan-evidence';
import { effectiveLimits } from '../guardrails/limits';
import { sessionSets } from '../guardrails/tree';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import { criticScript, plannerScript, researcherScript } from '../testing/agent-scripts';
import { HealthSummaryReader } from '../../health-summary/health-summary.reader';
import {
  CANARY,
  CANARY_GYM,
  CANARY_HEALTH_SUMMARY,
  CANARY_RAW_VALUES,
  CANARY_TOKENS,
  createCanaryPrisma,
} from '../testing/canary-prisma';
import { DUMBBELL_GYM, LIB, contextSourceFixture } from '../testing/context-fixtures';
import { draftExercise, draftFixture, draftWorkout, singleTypeDraft, weekTypeA } from '../testing/draft-fixtures';
import { createFakeProgramsPort } from '../testing/fake-programs-port';
import { intakeFixture } from '../testing/intake-fixtures';
import { createNodeContextHarness, type AgentScript } from '../testing/node-context-harness';
import { stubVerdict } from '../testing/stub-agent-nodes';
import type { NodePorts } from './node-context';

// =============================================================================
// The create graph end to end: real nodes (context, research, plan,
// guardrails, critique, finalize) over the real AgentCaller and AiService,
// the scripted fake provider, and in-memory programs and notifications ports.
// =============================================================================

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface ScenarioOptions {
  planner: AgentScript;
  critic: AgentScript;
  researcher?: AgentScript;
  source?: Parameters<typeof contextSourceFixture>[0];
  plannerContext?: NodePorts['plannerContext'];
  request?: Record<string, unknown>;
  maxCriticRounds?: number;
  tokenCap?: number;
}

function scenario(opts: ScenarioOptions) {
  const fake = createFakeProgramsPort();
  const source: PlannerContextSource = contextSourceFixture(opts.source);
  const h = createNodeContextHarness({
    kind: 'create',
    ...(opts.tokenCap ? { tokenCap: opts.tokenCap } : {}),
    scripts: { researcher: opts.researcher ?? researcherScript(), planner: opts.planner, critic: opts.critic },
    ports: {
      plannerContext: opts.plannerContext ?? { load: async () => source },
      programs: fake.port,
      notifications: fake.notify,
    },
  });
  const run = () =>
    h.runGraph({ input: { input: opts.request ?? { kind: 'create', intake: source.intake }, maxCriticRounds: opts.maxCriticRounds ?? 2 } });
  const calls = (agent: string) => h.runtime.fake.callsTo('responses.create').filter((c) => c.request?.metadata?.agent === agent);
  const events = (type: string) => (h.events.events.get(h.runId) ?? []).filter((e) => e.type === type).map((e) => e.data);
  const types = () => (h.events.events.get(h.runId) ?? []).map((e) => e.type);
  return { h, fake, run, calls, events, types };
}

/** A critic that asks for a revision in the first `rejections` rounds, then approves. */
const rejectThenApprove = (rejections = 1) => criticScript((round) => stubVerdict(round <= rejections ? 'revise' : 'approve'));
const alwaysRevise = () => criticScript(() => stubVerdict('revise'));

/** Every draft exercise replaced by an unknown key: G1 blocks it. */
function unfixableDraft(): PlanDraft {
  const draft = draftFixture();
  for (const block of draft.blocks) for (const t of block.weekTypes) for (const w of t.workouts) w.exercises = [draftExercise('made_up_move')];
  return draft;
}

function onlyProgram(fake: ReturnType<typeof createFakeProgramsPort>) {
  expect(fake.programs.size).toBe(1);
  return [...fake.programs.values()][0];
}

describe('create graph, end to end over the scripted fake', () => {
  it('critic rejects once then approves: the program is created as a draft, version 1, with verified citations', async () => {
    const plannerSeen: AiResponseRequest[] = [];
    const s = scenario({ planner: plannerScript([draftFixture()], plannerSeen), critic: rejectThenApprove(1) });

    const result = await s.run();

    expect(result.interrupt).toBeNull();
    const program = onlyProgram(s.fake);
    expect(program).toMatchObject({ status: 'draft', source: 'ai', currentVersion: 1, name: 'Eight-week strength base' });
    expect(program.versions[0]).toMatchObject({ versionNumber: 1, origin: 'ai_create', runId: s.h.runId });
    expect(planTreeSchema.safeParse(program.versions[0].tree).success).toBe(true);
    const brief = briefFromEvidence(program.versions[0].evidence);
    expect(brief?.sources.every((source) => source.verified)).toBe(true);
    expect(program.changeLog[0].citations.length).toBeGreaterThan(0);
    expect(program.versions[0].meta).toMatchObject({ criticRounds: 2, verdict: 'approved', warnings: [] });

    expect(result.state.outcome).toMatchObject({ status: 'completed', programId: program.id, versionNumber: 1, verdict: 'approved' });
    expect(s.fake.notifications.map((n) => n.eventKey)).toEqual(['training.plan_ready']);

    // One researcher call; two planner drafts (the second with the review); two critic rounds of investigate + verdict.
    expect(s.calls('researcher')).toHaveLength(1);
    expect(s.calls('planner')).toHaveLength(2);
    expect(s.calls('critic')).toHaveLength(4);
    expect(String(plannerSeen[1].input)).toContain('<review>');

    // The agent events, in order, and the stage sequence.
    const agentEvents = s.types().filter((type) => /^(research\.brief|plan\.|guardrail\.|critic\.)/.test(type));
    expect(agentEvents).toEqual([
      'research.brief',
      'plan.draft',
      'guardrail.report',
      'critic.round',
      'plan.draft',
      'guardrail.report',
      'critic.round',
      'plan.finalized',
    ]);
    expect(s.events('stage.started').map((e) => e.node)).toEqual([
      'prepare_context',
      'research',
      'plan',
      'guardrails',
      'critique',
      'plan',
      'guardrails',
      'critique',
      'finalize',
    ]);
    expect(s.events('critic.round').map((e) => e.verdict)).toEqual(['revise', 'approve']);
  });

  it.each([1, 2, 3])('critic loop bounds: maxCriticRounds %i gives exactly that many planner drafts and critic rounds', async (max) => {
    const s = scenario({ planner: plannerScript([draftFixture()]), critic: alwaysRevise(), maxCriticRounds: max });

    const result = await s.run();

    expect(s.calls('planner')).toHaveLength(max);
    expect(s.calls('critic')).toHaveLength(2 * max);
    expect(s.calls('critic').filter((c) => c.request?.structuredOutput)).toHaveLength(max);
    // Rejected every time with clean guardrails: ships with open notes.
    expect(result.state.outcome).toMatchObject({ status: 'completed', verdict: 'exhausted' });
    expect(result.state.warnings).toEqual(['critic_open_notes']);
    expect(onlyProgram(s.fake).versions[0].meta).toMatchObject({ verdict: 'exhausted', warnings: ['critic_open_notes'] });
  });

  it('a critic that approves while a block remains does not ship; the block after the last round rejects the run and creates nothing', async () => {
    const s = scenario({ planner: plannerScript([unfixableDraft()]), critic: criticScript(() => stubVerdict('approve')) });

    const result = await s.run();

    expect(result.state.outcome).toEqual({ status: 'rejected', code: 'TRAINING_PLAN_REJECTED', verdict: 'blocked' });
    expect(s.calls('planner')).toHaveLength(2);
    expect(s.events('guardrail.report').map((e) => e.status)).toEqual(['blocked', 'blocked']);
    expect(s.fake.programs.size).toBe(0);
    expect(s.fake.notifications).toHaveLength(0);
    expect(s.types()).not.toContain('plan.finalized');
  });

  it('a hostile planner (40 sets, unsupported and unknown exercises, an invented load, a fabricated citation, a URL) ships none of it, and the repairs are listed', async () => {
    const type = weekTypeA();
    type.workouts[0] = draftWorkout('Lower', 1, [
      draftExercise('barbell_back_squat', { isPriority: true, sets: 8 }),
      draftExercise('romanian_deadlift', { sets: 8, evidenceRefs: ['E99'], rationale: 'Proven by https://made-up.example/study to add 73% strength.' }),
      draftExercise('quantum_deadlift', { sets: 8 }),
      draftExercise('dumbbell_lunge', { sets: 8 }),
      draftExercise('goblet_squat', { sets: 8, targetLoadKg: 500, loadGuidance: 'fixed' }),
    ]);
    const hostile = singleTypeDraft(type, 4);
    const s = scenario({ planner: plannerScript([hostile]), critic: criticScript(() => stubVerdict('approve')), source: { gym: DUMBBELL_GYM } });

    const result = await s.run();

    expect(result.state.outcome).toMatchObject({ status: 'completed', verdict: 'approved' });
    const tree: PlanTree = onlyProgram(s.fake).versions[0].tree;
    const limits = effectiveLimits('intermediate', false);
    const byId = new Map(Object.values(LIB).map((e) => [e.id, e]));
    const gym = { equipmentTypeIds: DUMBBELL_GYM.equipment.map((e) => e.equipmentTypeId), capabilityIds: DUMBBELL_GYM.capabilities.map((c) => c.id) };
    for (const block of tree.blocks)
      for (const week of block.weeks)
        for (const workout of week.workouts) {
          expect(sessionSets(workout)).toBeLessThanOrEqual(limits.sessionSetsRepairAbove);
          for (const exercise of workout.exercises) {
            const lib = byId.get(exercise.exerciseId);
            expect(lib).toBeDefined();
            expect(supportedBy(lib!, gym)).toBe(true);
            expect(exercise.targetSets).toBeLessThanOrEqual(limits.setsPerExercise);
            expect(exercise.targetLoadKg).toBeNull();
            expect(exercise.evidenceRefs).not.toContain('E99');
            expect(exercise.rationale ?? '').not.toMatch(/https?:\/\//);
          }
        }

    const report = s.events('guardrail.report')[0] as { status: string; repairs: Array<{ rule: string }> };
    expect(report.status).toBe('repaired');
    expect(report.repairs.map((r) => r.rule)).toEqual(expect.arrayContaining(['G1', 'G2', 'G4', 'G8', 'G9']));
  });

  it('a budget that runs out before the revision ships the checked first draft with critic_skipped_budget', async () => {
    // Every call reports 150 tokens: research, plan, investigate, verdict = 600.
    const s = scenario({ planner: plannerScript([draftFixture()]), critic: alwaysRevise(), tokenCap: 600 });

    const result = await s.run();

    expect(s.calls('planner')).toHaveLength(1);
    expect(result.state.warnings).toEqual(['critic_skipped_budget']);
    expect(result.state.outcome).toMatchObject({ status: 'completed', verdict: 'critic_skipped_budget' });
    expect(onlyProgram(s.fake).versions[0].meta).toMatchObject({ warnings: ['critic_skipped_budget'] });
    expect(s.events('stage.started').map((e) => e.node).slice(-2)).toEqual(['plan', 'finalize']);
  });

  it('a critic that never produces a valid verdict: the checked draft ships as critic_unavailable', async () => {
    const s = scenario({
      planner: plannerScript([draftFixture()]),
      critic: criticScript(() => stubVerdict(), { verdictAnswer: () => ({ outputText: '{"verdict":"perhaps"}' }) }),
    });

    const result = await s.run();

    expect(result.state.outcome).toMatchObject({ status: 'completed', verdict: 'critic_unavailable' });
    expect(result.state.warnings).toEqual(['critic_unavailable']);
    expect(s.fake.programs.size).toBe(1);
  });

  it('a conservative run (knee pain) delivers a plan inside the conservative caps', async () => {
    const type = weekTypeA();
    for (const w of type.workouts) for (const e of w.exercises) Object.assign(e, { sets: 6, targetRpe: 9 });
    const s = scenario({
      planner: plannerScript([singleTypeDraft(type, 4)]),
      critic: criticScript(() => stubVerdict('approve')),
      source: { intake: { limitations: [{ area: 'knee', description: 'knee pain on stairs' }] } },
    });

    const result = await s.run();

    expect(result.state.outcome?.status).toBe('completed');
    const tree = onlyProgram(s.fake).versions[0].tree;
    const caps = effectiveLimits('intermediate', true);
    for (const block of tree.blocks)
      for (const week of block.weeks)
        for (const workout of week.workouts) {
          expect(sessionSets(workout)).toBeLessThanOrEqual(22);
          for (const exercise of workout.exercises) {
            expect(exercise.targetSets).toBeLessThanOrEqual(caps.setsPerExercise);
            expect(exercise.targetRpe ?? 0).toBeLessThanOrEqual(7);
          }
        }
  });
});

describe('data minimisation canary across every provider call of a full run', () => {
  it.each([false, true])('includeBio %s: no canary token in any request; planner and critic see slugs, not uuids', async (includeBio) => {
    const seen: AiResponseRequest[] = [];
    const record = (script: AgentScript): AgentScript => (req, ctx) => (seen.push(req), script(req, ctx));
    const intake = intakeFixture({ gymId: CANARY_GYM, includeBio, limitations: [{ area: 'knee', description: 'Old ache' }] });
    const s = scenario({
      researcher: record(researcherScript()),
      planner: record(plannerScript([draftFixture()])),
      critic: record(
        criticScript((round) => stubVerdict(round === 1 ? 'revise' : 'approve'), {
          toolCalls: [
            { name: 'get_exercise_history', args: { exerciseKey: 'barbell_back_squat' } },
            { name: 'find_substitutes', args: { exerciseKey: 'barbell_back_squat' } },
          ],
        }),
      ),
      plannerContext: new PlannerContextLoader(createCanaryPrisma({ userId: HARNESS_USER }) as never),
      request: { kind: 'create', intake },
    });

    const result = await s.run();

    expect(result.state.outcome?.status).toBe('completed');
    expect(seen.map((r) => r.metadata?.agent)).toEqual(expect.arrayContaining(['researcher', 'planner', 'critic']));
    expect(seen.length).toBe(s.h.runtime.fake.callsTo('responses.create').length);
    for (const req of seen) {
      const sent = JSON.stringify({ instructions: req.instructions, input: req.input, tools: req.tools });
      for (const token of CANARY_TOKENS) expect(sent).not.toContain(token);
      if (!includeBio) expect(sent).not.toContain(CANARY.bio);
      if (req.metadata?.agent !== 'researcher') expect(JSON.stringify(req.input)).not.toMatch(UUID);
    }
    const planner = seen.filter((r) => r.metadata?.agent === 'planner').map((r) => String(r.input));
    expect(planner[0]).toContain('barbell_back_squat');
    expect(planner[0].includes(CANARY.bio)).toBe(includeBio);
  });
});

describe('data minimisation canary with the opt-in health summary on (H8, #192)', () => {
  it('no raw lab or blood-pressure value and no document field in any provider call; only the planner gets the summary text', async () => {
    const seen: AiResponseRequest[] = [];
    const record = (script: AgentScript): AgentScript => (req, ctx) => (seen.push(req), script(req, ctx));
    const prisma = createCanaryPrisma({ userId: HARNESS_USER, healthSummaryConsent: true });
    const intake = intakeFixture({ gymId: CANARY_GYM, includeBio: false });
    const s = scenario({
      researcher: record(researcherScript()),
      planner: record(plannerScript([draftFixture()])),
      critic: record(criticScript(() => stubVerdict('approve'))),
      plannerContext: new PlannerContextLoader(prisma as never, new HealthSummaryReader(prisma as never)),
      request: { kind: 'create', intake },
    });

    const result = await s.run();

    expect(result.state.outcome?.status).toBe('completed');
    expect(seen.map((r) => r.metadata?.agent)).toEqual(expect.arrayContaining(['researcher', 'planner', 'critic']));
    for (const req of seen) {
      const sent = JSON.stringify({ instructions: req.instructions, input: req.input, tools: req.tools });
      for (const value of CANARY_RAW_VALUES) expect(sent).not.toContain(value);
      for (const token of [...CANARY_TOKENS, CANARY.bio, CANARY_HEALTH_SUMMARY.inputsHash, CANARY_HEALTH_SUMMARY.documentName]) {
        expect(sent).not.toContain(token);
      }
      expect(sent.includes('CANARY-SUMMARY-NARRATIVE')).toBe(req.metadata?.agent === 'planner');
    }
    // The flagged consideration switched the run to conservative mode.
    expect((result.state.context as { mode: { reasons: string[] } }).mode.reasons).toContain('health_summary');
  });
});

describe('revise graph', () => {
  async function revise(currentVersion: number, basedOnVersion: number) {
    const fake = createFakeProgramsPort();
    const firstTree = (await (async () => {
      const s = scenario({ planner: plannerScript([draftFixture()]), critic: criticScript(() => stubVerdict('approve')) });
      await s.run();
      return onlyProgram(s.fake).versions[0].tree;
    })()) as PlanTree;
    const program = fake.addProgram(HARNESS_USER, firstTree, { currentVersion });
    const request = { kind: 'revise', programId: program.id, basedOnVersion, instruction: 'Swap Friday for Saturday.' };
    const source = contextSourceFixture({ kind: 'revise', revise: { programId: program.id, basedOnVersion, instruction: request.instruction, currentPlan: firstTree } });
    const h = createNodeContextHarness({
      kind: 'revise',
      scripts: { planner: plannerScript([draftFixture()]), critic: criticScript(() => stubVerdict('approve')) },
      ports: { plannerContext: { load: async () => source }, programs: fake.port, notifications: fake.notify },
    });
    return { h, fake, program, run: () => h.runGraph({ input: { input: request, maxCriticRounds: 2 } }) };
  }

  it('skips research and writes a new version on the based-on version', async () => {
    const r = await revise(2, 2);

    const result = await r.run();

    expect(result.state.outcome).toMatchObject({ status: 'completed', programId: r.program.id, versionNumber: 3 });
    expect(r.program.versions.at(-1)).toMatchObject({ origin: 'ai_adapt', runId: r.h.runId });
    expect(r.h.runtime.fake.callsTo('responses.create').some((c) => c.request?.metadata?.agent === 'researcher')).toBe(false);
  });

  it('a stale basedOnVersion fails TRAINING_STALE_PLAN and changes nothing', async () => {
    const r = await revise(3, 2);

    const error = await r.run().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TrainingRunFailedError);
    expect(error).toMatchObject({ code: 'TRAINING_STALE_PLAN' });
    expect(r.program.currentVersion).toBe(3);
    expect(r.program.versions).toHaveLength(1);
    expect(r.fake.notifications).toHaveLength(0);
  });
});
