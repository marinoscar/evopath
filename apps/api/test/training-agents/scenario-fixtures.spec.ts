import { EXERCISE_CATALOG } from '../../prisma/seed-data';
import { TRAINING_AGENT_ROLES } from '../../src/common/schemas/settings.schema';
import { adaptationVerdictSchema } from '../../src/training-agents/agents/critic/critic-adaptation.prompt';
import { evaluationResultSchema } from '../../src/training-agents/agents/evaluator/evaluation-result.contract';
import { criticVerdictSchema } from '../../src/training-agents/agents/critic/critic-verdict.contract';
import { planDraftSchema } from '../../src/training-agents/agents/planner/plan-draft.contract';
import { evidenceBriefSchema } from '../../src/training-agents/agents/researcher/evidence-brief.contract';
import { loadScenario, readOutputJson, scenarioNames, scriptFromScenario, type ScenarioCallSpec } from './support/scenario-script';

// The tripwire for the scenario fixtures shared by the Jest scenario suites and
// the fake Responses server: every output file parses with the real contract
// of its role, and every exercise a planner output names is a seeded slug, so a
// contract or seed change fails here in CI, not in the browser.

const SEEDED = new Set(EXERCISE_CATALOG.map((e) => e.slug));
const HOSTILE_ALLOWED_UNKNOWN = new Set(['planner/hostile-8w.json', 'evaluator/hostile.json']);

function exerciseKeys(draft: { blocks: Array<{ weekTypes: Array<{ workouts: Array<{ exercises: Array<{ exerciseKey: string }> }> }> }> }): string[] {
  return draft.blocks.flatMap((b) => b.weekTypes.flatMap((t) => t.workouts.flatMap((w) => w.exercises.map((e) => e.exerciseKey))));
}

describe('training scenario fixtures', () => {
  const names = scenarioNames();

  it('ships the create-flow scenarios', () => {
    expect(names).toEqual(
      expect.arrayContaining([
        'happy',
        'critic-reject-once',
        'critic-exhausted',
        'planner-hostile',
        'research-fabricated-url',
        'research-insufficient',
        'research-page-injection',
        'urgent-symptom',
        'budget-tight',
        'rate-limit-once',
        'slow',
      ]),
    );
  });

  it('ships the evaluate-flow scenarios', () => {
    expect(names).toEqual(
      expect.arrayContaining([
        'evaluator-no-change',
        'evaluator-autonomous',
        'evaluator-structural',
        'evaluator-hostile',
        'evaluator-pain-response',
        'evaluator-regenerate',
      ]),
    );
  });

  it.each(names)('%s: name matches the file and every role is declared', (name) => {
    const scenario = loadScenario(name);
    expect(scenario.name).toBe(name);
    expect(scenario.description.length).toBeGreaterThan(10);
    for (const role of TRAINING_AGENT_ROLES) expect(Array.isArray(scenario.calls[role])).toBe(true);
    expect(scenario.http.rateLimitOnCall === null || typeof scenario.http.rateLimitOnCall === 'number').toBe(true);
    expect(typeof scenario.http.retryAfterSeconds).toBe('number');
    expect(typeof scenario.http.delayMs).toBe('number');
  });

  const specs: Array<[string, string, ScenarioCallSpec]> = names.flatMap((name) =>
    TRAINING_AGENT_ROLES.flatMap((role) => loadScenario(name).calls[role].map((spec) => [name, role, spec] as [string, string, ScenarioCallSpec])),
  );
  const unique = [...new Map(specs.map(([, role, spec]) => [`${role}:${spec.outputJson}`, [role, spec] as const])).values()];

  it.each(unique.map(([role, spec]) => [role, spec.outputJson, spec] as const))('%s output %s parses with its real contract', (role, file, spec) => {
    const json = readOutputJson(spec) as Record<string, unknown>;
    if (role === 'planner') {
      const draft = planDraftSchema.parse(json);
      if (!HOSTILE_ALLOWED_UNKNOWN.has(file)) expect(exerciseKeys(draft).filter((key) => !SEEDED.has(key))).toEqual([]);
    } else if (role === 'critic') {
      // The evaluate graph's light critic answers with the adaptation verdict.
      if (file.startsWith('critic/adapt-')) adaptationVerdictSchema.parse(json);
      else criticVerdictSchema.parse(json);
    } else if (role === 'evaluator') {
      const result = evaluationResultSchema.parse(json);
      const named = result.changes.flatMap((op) =>
        op.op === 'swap_exercise' ? [op.withExerciseKey] : op.op === 'add_exercise' ? [op.exerciseKey] : [],
      );
      if (!HOSTILE_ALLOWED_UNKNOWN.has(file)) expect(named.filter((key) => !SEEDED.has(key))).toEqual([]);
    } else if (role === 'researcher') {
      evidenceBriefSchema.parse(json.brief ?? json);
    } else {
      throw new Error(`No contract for role ${role}`);
    }
  });

  it('the hostile planner output really names unseeded exercises (the fixture stays hostile)', () => {
    const spec = loadScenario('planner-hostile').calls.planner[0];
    expect(exerciseKeys(planDraftSchema.parse(readOutputJson(spec))).some((key) => !SEEDED.has(key))).toBe(true);
  });

  it('the hostile evaluator output really names an unseeded exercise and an unknown ref (the fixture stays hostile)', () => {
    const spec = loadScenario('evaluator-hostile').calls.evaluator[0];
    const result = evaluationResultSchema.parse(readOutputJson(spec));
    expect(result.changes.some((op) => op.op === 'swap_exercise' && !SEEDED.has(op.withExerciseKey))).toBe(true);
    expect(result.changes.some((op) => op.op === 'set_prescription' && op.target.exerciseRef === 'W52-9-9')).toBe(true);
  });

  it('every evaluator change targets the refs of the scenario plan (weeks 5 to 7 are open non-deload weeks of planner/valid-8w.json)', () => {
    for (const name of names.filter((n) => n.startsWith('evaluator-'))) {
      for (const call of loadScenario(name).calls.evaluator) {
        const result = evaluationResultSchema.parse(readOutputJson(call));
        for (const op of result.changes) {
          if (op.op === 'regenerate_remaining') continue;
          const ref = 'target' in op ? op.target.exerciseRef : 'workoutRef' in op ? op.workoutRef : '';
          if (name === 'evaluator-hostile') continue;
          expect(ref).toMatch(/^W[567]-[1-3](-[1-5])?$/);
        }
      }
    }
  });

  describe('scriptFromScenario', () => {
    const request = (agent: string, extra: Record<string, unknown> = {}) => ({ metadata: { agent }, ...extra }) as never;
    const ctx = {} as never;

    it('routes by role and call index, repeating the last entry', async () => {
      const script = scriptFromScenario('critic-reject-once');
      const first = await script(request('planner'), ctx);
      const second = await script(request('planner'), ctx);
      const third = await script(request('planner'), ctx);
      expect(JSON.parse(first.outputText ?? '{}').title).toBe('Eight-week dumbbell base');
      expect(JSON.parse(second.outputText ?? '{}').title).toBe('Eight-week dumbbell base (revised)');
      expect(third.outputText).toBe(second.outputText);
    });

    it('answers a critic investigation call without consuming a verdict', async () => {
      const script = scriptFromScenario('critic-reject-once');
      const note = await script(request('critic'), ctx);
      expect(note.outputText).toContain('see the verdict');
      const verdict = await script(request('critic', { structuredOutput: { name: 'critic_verdict' } }), ctx);
      expect(JSON.parse(verdict.outputText ?? '{}').verdict).toBe('revise');
    });

    it('builds a web_search call and a cited message for the researcher', async () => {
      const answer = await scriptFromScenario('happy')(request('researcher'), ctx);
      expect(answer.output?.map((item) => item.type)).toEqual(['hosted_tool_call', 'message']);
      expect(answer.usage).toMatchObject({ inputTokens: 9000, outputTokens: 4200, reasoningTokens: 1500 });
    });

    it('rate-limits exactly the configured request, then answers it on the retry', async () => {
      const script = scriptFromScenario('rate-limit-once');
      await script(request('researcher'), ctx);
      await expect(Promise.resolve().then(() => script(request('planner'), ctx))).rejects.toMatchObject({ code: 'AI_RATE_LIMITED', retryAfterMs: 2000 });
      const retry = await script(request('planner'), ctx);
      expect(JSON.parse(retry.outputText ?? '{}').title).toBe('Eight-week dumbbell base');
    });

    it('answers the evaluator by call index and a light critic with the adaptation verdict', async () => {
      const script = scriptFromScenario('evaluator-structural');
      const evaluation = await script(request('evaluator', { structuredOutput: { name: 'evaluation_result' } }), ctx);
      expect(JSON.parse(evaluation.outputText ?? '{}').changes[0].op).toBe('swap_exercise');
      const verdict = await script(request('critic', { structuredOutput: { name: 'adaptation_verdict' } }), ctx);
      expect(JSON.parse(verdict.outputText ?? '{}')).toMatchObject({ verdict: 'approve', blockers: [] });
    });

    it('refuses a role the scenario does not script', () => {
      expect(() => scriptFromScenario('urgent-symptom')(request('planner'), ctx)).toThrow(/no scripted call for planner/);
    });
  });
});
