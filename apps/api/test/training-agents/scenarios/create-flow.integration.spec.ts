import { EXERCISE_CATALOG } from '../../../prisma/seed-data';
import type { PlanTree } from '../../../src/programs/contracts/plan-tree.contract';
import { FreeTextSafetyScreen } from '../../../src/training-agents/runtime/safety-screen';
import { RunDeferredError } from '../../../src/training-agents/runtime/agent-caller';
import { RunBudgetExceededError } from '../../../src/training-agents/runtime/run-budget';
import { HARNESS_USER } from '../../../src/ai/testing/ai-runtime-harness';
import { createFakeProgramsPort } from '../../../src/training-agents/testing/fake-programs-port';
import { createNodeContextHarness } from '../../../src/training-agents/testing/node-context-harness';
import { contextSourceOf, loadPersonas } from '../../evals/training/personas';
import { SEED_LIBRARY } from '../../evals/support/seed-library';
import { scenarioCardioContextSource, scenarioContextSource } from '../support/scenario-context';
import { scenarioScripts } from '../support/scenario-script';
import type { AgentScript } from '../../../src/training-agents/testing/node-context-harness';
import type { TrainingAgentRole } from '../../../src/common/schemas/settings.schema';

// =============================================================================
// The create flow, one JSON scenario at a time (the same files the fake
// Responses server replays in the browser e2e), over the real graph nodes,
// guardrails, AgentCaller and AiService with the scripted fake provider.
// =============================================================================

const SEEDED = new Set(EXERCISE_CATALOG.map((e) => e.slug));

function scenario(
  name: string,
  opts: { tokenCap?: number; wrap?: (script: AgentScript, role: TrainingAgentRole) => AgentScript; source?: ReturnType<typeof scenarioContextSource> } = {},
) {
  const source = opts.source ?? scenarioContextSource();
  const fake = createFakeProgramsPort();
  const scripts = scenarioScripts(name);
  const wrapped = opts.wrap
    ? (Object.fromEntries(Object.entries(scripts).map(([role, script]) => [role, opts.wrap!(script, role as TrainingAgentRole)])) as typeof scripts)
    : scripts;
  const h = createNodeContextHarness({
    kind: 'create',
    ...(opts.tokenCap ? { tokenCap: opts.tokenCap } : {}),
    scripts: wrapped,
    ports: { plannerContext: { load: async () => source }, programs: fake.port, notifications: fake.notify },
  });
  const input = { input: { kind: 'create' as const, intake: source.intake }, maxCriticRounds: 2 };
  const run = () => h.runGraph({ input });
  const resume = () => h.runGraph({});
  const log = () => h.events.events.get(h.runId) ?? [];
  const events = (type: string) => log().filter((e) => e.type === type).map((e) => e.data);
  const types = () => log().map((e) => e.type);
  const calls = (agent?: string) =>
    h.runtime.fake.callsTo('responses.create').filter((c) => !agent || c.request?.metadata?.agent === agent);
  const program = () => {
    expect(fake.programs.size).toBe(1);
    return [...fake.programs.values()][0];
  };
  return { h, fake, run, resume, events, types, calls, program };
}

function exerciseKeys(tree: PlanTree): string[] {
  return tree.blocks.flatMap((b) => b.weeks.flatMap((w) => w.workouts.flatMap((wo) => wo.exercises.map((e) => (e as unknown as { exerciseKey?: string }).exerciseKey ?? e.exerciseId))));
}

describe('create-flow scenarios', () => {
  it('happy: research, one draft, one critique; the plan is a draft version 1 and every role is called the scripted number of times', async () => {
    const s = scenario('happy');

    const result = await s.run();

    expect(result.interrupt).toBeNull();
    expect(result.state.outcome).toMatchObject({ status: 'completed', versionNumber: 1, verdict: 'approved' });
    expect(s.program()).toMatchObject({ status: 'draft', source: 'ai', currentVersion: 1, name: 'Eight-week dumbbell base' });
    expect(s.calls().map((c) => c.request?.metadata?.agent)).toEqual(['researcher', 'planner', 'critic', 'critic']);
    expect(s.calls('researcher')[0].request?.tools).toEqual([expect.objectContaining({ type: 'web_search' })]);
    expect(s.calls('planner')[0].request?.structuredOutput).toBeDefined();
    expect(s.types().filter((t) => /^(research\.brief|plan\.|guardrail\.|critic\.)/.test(t))).toEqual([
      'research.brief',
      'plan.draft',
      'guardrail.report',
      'critic.round',
      'plan.finalized',
    ]);
    expect(s.events('guardrail.report')[0]).toMatchObject({ status: 'clean' });
    expect(s.fake.notifications.map((n) => n.eventKey)).toEqual(['training.plan_ready']);
    // Usage is what the scenario reports: researcher 9000 in, 4200 out, 1500 reasoning.
    expect(s.h.usage.find((u) => u.role === 'researcher')?.usage).toMatchObject({ inputTokens: 9000, outputTokens: 4200, reasoningTokens: 1500 });
    expect(s.h.usage).toHaveLength(4);
  });

  it('cardio-walks (#265): 3 strength days plus 4 requested walks compile to 4 outdoor_walk sessions of 30 minutes on the non-strength days', async () => {
    const s = scenario('cardio-walks', { source: scenarioCardioContextSource() });

    const result = await s.run();

    expect(result.state.outcome).toMatchObject({ status: 'completed', versionNumber: 1, verdict: 'approved' });
    // The planner saw the request, the walking exercises and the weekly cap.
    const input = String(s.calls('planner')[0].request?.input);
    expect(input).toContain('"cardio"');
    expect(input).toContain('"exerciseKeys":["hike","outdoor_walk"]');
    expect(input).toContain('"weeklyMinutesCap":150');

    const report = s.events('guardrail.report')[0] as { status: string; repairs?: Array<{ code?: string }> };
    expect(report.status).not.toBe('blocked');
    expect(JSON.stringify(report)).not.toMatch(/cardio_|surplus_workout_removed|weekday_moved|no_rest_day/);

    const keyOf = new Map(SEED_LIBRARY.map((e) => [e.id, e.key]));
    const program = s.program();
    expect(program.name).toBe('Eight-week dumbbell base with walks');
    const tree = program.versions[0].tree as PlanTree;
    const weeks = tree.blocks.flatMap((b) => b.weeks);
    expect(weeks).toHaveLength(8);
    for (const week of weeks) {
      const walks = week.workouts.filter((w) => w.exercises.some((e) => keyOf.get(e.exerciseId) === 'outdoor_walk'));
      const strength = week.workouts.filter((w) => !walks.includes(w));
      expect(walks.map((w) => w.weekday)).toEqual([2, 4, 6, 7]);
      expect(strength.map((w) => w.weekday)).toEqual([1, 3, 5]);
      for (const workout of walks) {
        expect(workout.exercises).toHaveLength(1);
        expect(workout.exercises[0]).toMatchObject({ targetDurationSeconds: 1800, targetDistanceMeters: null, repMin: null, repMax: null });
      }
      for (const workout of strength) expect(workout.exercises.every((e) => e.targetDurationSeconds === null)).toBe(true);
    }
  });

  it('critic-reject-once: two critique rounds, the planner revises with the review, the second draft ships', async () => {
    const s = scenario('critic-reject-once');

    const result = await s.run();

    expect(result.state.outcome).toMatchObject({ status: 'completed', verdict: 'approved' });
    expect(s.events('critic.round').map((e) => e.verdict)).toEqual(['revise', 'approve']);
    expect(s.calls('planner')).toHaveLength(2);
    expect(String(s.calls('planner')[1].request?.input)).toContain('<review>');
    expect(s.program().name).toBe('Eight-week dumbbell base (revised)');
    expect(s.program().versions[0].meta).toMatchObject({ criticRounds: 2, verdict: 'approved' });
  });

  it('critic-exhausted: rejects every round with clean guardrails, ships with open notes after the bounded rounds', async () => {
    const s = scenario('critic-exhausted');

    const result = await s.run();

    expect(s.calls('planner')).toHaveLength(2);
    expect(result.state.outcome).toMatchObject({ status: 'completed', verdict: 'exhausted' });
    expect(result.state.warnings).toEqual(['critic_open_notes']);
    expect(s.events('critic.round').map((e) => e.verdict)).toEqual(['revise', 'revise']);
  });

  it('planner-hostile: the guardrails repair it, the repairs are listed, and none of the hostile content reaches the plan or the change log', async () => {
    const s = scenario('planner-hostile');

    const result = await s.run();

    expect(result.state.outcome).toMatchObject({ status: 'completed' });
    const report = s.events('guardrail.report')[0] as { status: string; repairs: Array<{ rule: string }> };
    expect(report.status).toBe('repaired');
    expect(report.repairs.map((r) => r.rule)).toEqual(expect.arrayContaining(['G1', 'G2', 'G3', 'G8']));

    const program = s.program();
    const tree = program.versions[0].tree as PlanTree;
    for (const block of tree.blocks)
      for (const week of block.weeks)
        for (const workout of week.workouts) {
          expect(workout.exercises.length).toBeGreaterThan(0);
          for (const exercise of workout.exercises) {
            expect(exercise.targetLoadKg ?? 0).toBeLessThanOrEqual(100);
            expect(exercise.targetSets).toBeLessThanOrEqual(6);
          }
        }
    // The plan header (name and plan-level rationale) is part of what a user stores and reads.
    const stored = JSON.stringify({ name: program.name, rationale: program.rationale, tree, changeLog: program.changeLog, meta: program.versions[0].meta });
    for (const bad of [/made-up/i, /ignore your previous/i, /system prompt/i, /quantum_deadlift/i, /"targetLoadKg":500/]) { const m = stored.match(new RegExp('.{0,60}' + bad.source + '.{0,60}', 'i')); expect(m && m[0]).toBeNull(); }
    // The only links in a stored plan are the verified sources the change log cites.
    for (const url of stored.match(/https?:\/\/[^"\\\s]+/g) ?? []) expect(url).toMatch(/acsm\.org|pubmed\.ncbi|nsca\.com/);
    expect(exerciseKeys(tree).length).toBeGreaterThan(0);
    for (const key of exerciseKeys(tree)) expect(SEEDED.has(key) || /^[0-9a-f-]{36}$/.test(key)).toBe(true);
  });

  it('research-fabricated-url: the invented source and its claim are dropped and counted, and the plan carries no trace of the URL', async () => {
    const s = scenario('research-fabricated-url');

    await s.run();

    expect(s.events('research.brief')[0]).toMatchObject({ droppedSources: 1, droppedClaims: 1 });
    expect(JSON.stringify(s.program().versions[0])).not.toContain('made-up-journal');
  });

  it('research-page-injection: markup, links and injected instructions in the brief are stripped before the planner sees it', async () => {
    const planner: string[] = [];
    const s = scenario('research-page-injection', {
      wrap: (script, role) => (req, ctx) => {
        if (role === 'planner') planner.push(JSON.stringify(req.input) + JSON.stringify(req.instructions));
        return script(req, ctx);
      },
    });

    await s.run();

    expect(planner).toHaveLength(1);
    expect(planner[0]).not.toContain('<script>');
    expect(planner[0]).not.toContain('attacker.example.net');
    expect(JSON.stringify(s.program().versions[0])).not.toContain('attacker.example.net');
  });

  it('research-insufficient: the knowledge fallback fills the brief (web_partial), the planner is told, and the run completes with a plan', async () => {
    const planner: string[] = [];
    const s = scenario('research-insufficient', {
      wrap: (script, role) => (req, ctx) => {
        if (role === 'planner') planner.push(String(req.input));
        return script(req, ctx);
      },
    });

    const result = await s.run();

    expect(result.state.outcome).toMatchObject({ status: 'completed', versionNumber: 1 });
    // Two web attempts, then one tool-less knowledge call.
    const researcher = s.calls('researcher');
    expect(researcher).toHaveLength(3);
    expect(researcher[2].request?.tools).toBeUndefined();
    expect(researcher[2].request?.structuredOutput?.name).toBe('knowledge_brief');
    expect(s.events('research.brief')).toEqual([expect.objectContaining({ basis: 'web_partial', sourceCount: 1, claimCount: 5 })]);
    expect(planner[0]).toContain('web_partial');

    const evidence = s.program().versions[0].evidence as Array<Record<string, unknown>>;
    expect(evidence.find((item) => item.type === 'brief')).toMatchObject({ basis: 'web_partial' });
    expect(evidence.filter((item) => item.type === 'source')).toHaveLength(1);
    expect(evidence.filter((item) => item.type === 'claim')).toHaveLength(5);
    expect(s.fake.notifications.map((n) => n.eventKey)).toEqual(['training.plan_ready']);
  });

  it('urgent-symptom: the safety screen stops the request with guidance before any provider call', async () => {
    const persona = loadPersonas().find((p) => p.id === 'urgent-symptom-text');
    if (!persona) throw new Error('urgent-symptom-text persona fixture is missing');
    const source = contextSourceOf(persona);
    const h = createNodeContextHarness({ scripts: scenarioScripts('urgent-symptom') });

    const stop = await new FreeTextSafetyScreen().screen({ userId: 'scenario', kind: 'create', input: { kind: 'create', intake: source.intake } });

    expect(stop.stop).toBe(true);
    expect(h.runtime.fake.callsTo('responses.create')).toHaveLength(0);
  });

  it('budget-tight: the researcher spends the whole budget, the next call is refused TRAINING_RUN_BUDGET_EXCEEDED and nothing is created', async () => {
    const s = scenario('budget-tight');

    const error = await s.run().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RunBudgetExceededError);
    expect(error).toMatchObject({ code: 'TRAINING_RUN_BUDGET_EXCEEDED', cap: 400_000 });
    expect(s.calls().map((c) => c.request?.metadata?.agent)).toEqual(['researcher']);
    expect(s.fake.programs.size).toBe(0);
  });

  it('rate-limit-once: the planner call is deferred, and the resume continues from the checkpoint without repeating the research', async () => {
    const s = scenario('rate-limit-once');

    const error = await s.run().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RunDeferredError);
    expect(s.calls('researcher')).toHaveLength(1);
    expect(s.fake.programs.size).toBe(0);

    const result = await s.resume();

    expect(result.state.outcome).toMatchObject({ status: 'completed', verdict: 'approved' });
    expect(s.calls('researcher')).toHaveLength(1);
    expect(s.events('research.brief')).toHaveLength(1);
    expect(s.program().currentVersion).toBe(1);
  });

  it('cancel: aborting during the planner call rejects the run, creates nothing and never reaches the critic', async () => {
    let s!: ReturnType<typeof scenario>;
    s = scenario('slow', {
      wrap: (script, role) => async (req, ctx) => {
        if (role === 'planner') s.h.abort();
        return script(req, ctx);
      },
    });

    const error = await s.run().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(s.fake.programs.size).toBe(0);
    expect(s.fake.notifications).toHaveLength(0);
    expect(s.types()).not.toContain('plan.finalized');
    expect(s.calls('critic')).toHaveLength(0);
  });
});

describe('revise flow on the happy scenario', () => {
  async function revise(currentVersion: number, basedOnVersion: number) {
    const created = scenario('happy');
    await created.run();
    const firstTree = created.program().versions[0].tree as PlanTree;

    const fake = createFakeProgramsPort();
    const program = fake.addProgram(HARNESS_USER, firstTree, { currentVersion });
    const instruction = 'Swap Friday for Saturday.';
    const source = {
      ...scenarioContextSource(),
      kind: 'revise' as const,
      revise: { programId: program.id, basedOnVersion, instruction, currentPlan: firstTree },
    };
    const h = createNodeContextHarness({
      kind: 'revise',
      scripts: scenarioScripts('happy'),
      ports: { plannerContext: { load: async () => source }, programs: fake.port, notifications: fake.notify },
    });
    const request = { kind: 'revise', programId: program.id, basedOnVersion, instruction };
    return { h, fake, program, run: () => h.runGraph({ input: { input: request, maxCriticRounds: 2 } }) };
  }

  it('skips research, calls planner and critic from the scenario, and writes version 2 on the based-on version', async () => {
    const r = await revise(1, 1);

    const result = await r.run();

    expect(result.state.outcome).toMatchObject({ status: 'completed', programId: r.program.id, versionNumber: 2 });
    expect(r.program.versions.at(-1)).toMatchObject({ origin: 'ai_adapt', runId: r.h.runId });
    const agents = r.h.runtime.fake.callsTo('responses.create').map((c) => c.request?.metadata?.agent);
    expect(agents).not.toContain('researcher');
    expect(agents).toContain('planner');
  });

  it('a stale basedOnVersion fails TRAINING_STALE_PLAN and changes nothing', async () => {
    const r = await revise(2, 1);

    const error = await r.run().catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'TRAINING_STALE_PLAN' });
    expect(r.program.versions).toHaveLength(1);
    expect(r.fake.notifications).toHaveLength(0);
  });
});
