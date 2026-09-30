import { AiError } from '../../../ai/core/ai-error';
import { toJsonSchema } from '../../../ai/core/structured-output';
import type { AiResponseRequest } from '../../../ai/core/types/responses.types';
import { runGuardrails, type GuardrailNodeOutput } from '../../nodes/guardrails.node';
import { runCritique } from '../../nodes/critique.node';
import { RunBudgetExceededError } from '../../runtime/run-budget';
import { TrainingRunFailedError } from '../../runtime/training-run-errors';
import { criticScript } from '../../testing/agent-scripts';
import { runContextFixture } from '../../testing/context-fixtures';
import { draftExercise, draftFixture } from '../../testing/draft-fixtures';
import { createNodeContextHarness } from '../../testing/node-context-harness';
import { STUB_VERIFIED_BRIEF, stubVerdict } from '../../testing/stub-agent-nodes';
import type { RunState } from '../../graph/run-state';
import type { PlanDraft } from '../planner/plan-draft.contract';
import { SAFETY_BLOCK, UNTRUSTED_DATA_BLOCK } from '../shared/prompt-blocks';
import {
  CRITIC_DIMENSIONS,
  criticRoundOf,
  criticVerdictSchema,
  lowScores,
  verdictPasses,
  type CriticVerdict,
} from './critic-verdict.contract';
import { CRITIC_INSTRUCTIONS } from './critic.prompt';
import { criticTools, durationTable, patternTable, weeklyVolumeTable } from './critic-tools';
import { guardrailContextOf } from '../../guardrails/types';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type JsonNode = Record<string, unknown>;
function objectNodes(node: unknown, out: JsonNode[] = []): JsonNode[] {
  if (Array.isArray(node)) node.forEach((child) => objectNodes(child, out));
  else if (node && typeof node === 'object') {
    const obj = node as JsonNode;
    if (obj.type === 'object') out.push(obj);
    Object.values(obj).forEach((child) => objectNodes(child, out));
  }
  return out;
}

/** A state with the context, the brief and the guardrails' output for `draft`. */
async function checkedState(draft: PlanDraft = draftFixture()): Promise<Partial<RunState>> {
  const h = createNodeContextHarness();
  const base = { context: runContextFixture(), brief: STUB_VERIFIED_BRIEF, draft: { round: 1, draft, droppedContext: [] } };
  const update = await h.runNode(runGuardrails, base);
  return { ...base, guardrailReport: update.guardrailReport };
}

const events = (h: ReturnType<typeof createNodeContextHarness>, type: string) =>
  (h.events.events.get(h.runId) ?? []).filter((e) => e.type === type).map((e) => e.data);

describe('CriticVerdict contract and prompt', () => {
  it('converts to strict-mode compatible JSON Schema: every property required, every object closed', () => {
    const objects = objectNodes(toJsonSchema(criticVerdictSchema));
    expect(objects.length).toBeGreaterThanOrEqual(4);
    for (const obj of objects) {
      expect([...((obj.required as string[]) ?? [])].sort()).toEqual(Object.keys((obj.properties as JsonNode) ?? {}).sort());
      expect(obj.additionalProperties).toBe(false);
    }
  });

  it('the instructions carry the rubric and end with the pinned safety and untrusted-data blocks', () => {
    expect(CRITIC_INSTRUCTIONS.endsWith(`${SAFETY_BLOCK}\n\n${UNTRUSTED_DATA_BLOCK}`)).toBe(true);
    for (const dimension of CRITIC_DIMENSIONS) expect(CRITIC_INSTRUCTIONS).toContain(`- ${dimension}:`);
    expect(CRITIC_INSTRUCTIONS).toContain('Approve only if every score is 4 or higher and there are no blockers.');
    expect(CRITIC_INSTRUCTIONS).toContain('Do not invent evidence');
  });

  it('verdictPasses needs approve, every score >= 4 and no blocker; lowScores lists the failing ones lowest first', () => {
    expect(verdictPasses(stubVerdict('approve'))).toBe(true);
    expect(verdictPasses(stubVerdict('revise'))).toBe(false);
    const three: CriticVerdict = { ...stubVerdict('approve'), scores: { ...stubVerdict('approve').scores, recovery: 3, progression: 2 } };
    expect(verdictPasses(three)).toBe(false);
    expect(lowScores(three)).toEqual([{ dimension: 'progression', score: 2 }, { dimension: 'recovery', score: 3 }]);
    expect(verdictPasses({ ...stubVerdict('approve'), blockers: stubVerdict('revise').blockers })).toBe(false);
  });

  it('criticRoundOf narrows verdict entries and skip markers, and rejects anything else', () => {
    expect(criticRoundOf({ ...stubVerdict('approve'), round: 2 })).toMatchObject({ round: 2, verdict: 'approve' });
    expect(criticRoundOf({ round: 1, skipped: 'budget' })).toEqual({ round: 1, skipped: 'budget' });
    expect(criticRoundOf({ approve: true })).toBeNull();
    expect(criticRoundOf(null)).toBeNull();
  });
});

describe('critic tools (read-only, bound to the run)', () => {
  it('answer from the repaired tree by key and week, with no ids', async () => {
    const state = await checkedState();
    const output = state.guardrailReport as GuardrailNodeOutput;
    const ctx = guardrailContextOf(runContextFixture(), STUB_VERIFIED_BRIEF);
    const tools = Object.fromEntries(criticTools({ tree: output.tree, ctx }).map((t) => [t.tool.name, t]));

    expect(Object.keys(tools).sort()).toEqual(
      ['check_equipment', 'estimate_duration', 'find_substitutes', 'get_evidence', 'get_exercise_history', 'get_weekly_volume'].sort(),
    );
    const run = (name: string, args: unknown) => tools[name].execute(args as never, { userId: 'u' });

    const volume = (await run('get_weekly_volume', { weekNumber: 1 })) as { setsByMuscle: Record<string, number>; isDeload: boolean };
    expect(volume.isDeload).toBe(false);
    expect(Object.values(volume.setsByMuscle).every((n) => n > 0)).toBe(true);
    expect(await run('get_weekly_volume', { weekNumber: 40 })).toMatchObject({ error: expect.any(String) });

    const duration = (await run('estimate_duration', { workoutName: 'Lower' })) as { estimates: Array<{ estimatedMinutes: number; weeks: number[] }> };
    expect(duration.estimates[0].estimatedMinutes).toBeGreaterThan(5);
    expect(duration.estimates.flatMap((e) => e.weeks)).toHaveLength(8);

    expect(await run('check_equipment', { exerciseKeys: ['barbell_back_squat', 'made_up'] })).toEqual({
      hasGym: true,
      results: [
        { key: 'barbell_back_squat', known: true, supported: true },
        { key: 'made_up', known: false, supported: false },
      ],
    });
    const subs = (await run('find_substitutes', { exerciseKey: 'barbell_back_squat' })) as { substitutes: Array<{ key: string }> };
    expect(subs.substitutes.length).toBeGreaterThan(0);
    expect(await run('get_exercise_history', { exerciseKey: 'barbell_back_squat' })).toEqual({ exerciseKey: 'barbell_back_squat', hasHistory: false });
    expect(await run('get_evidence', { claimId: 'E2' })).toMatchObject({ claimId: 'E2', sourceIds: ['S1', 'S2'] });
    expect(await run('get_evidence', { claimId: 'E9' })).toMatchObject({ error: expect.any(String) });

    const all = JSON.stringify([volume, duration, subs, weeklyVolumeTable({ tree: output.tree, ctx }), durationTable({ tree: output.tree, ctx }), patternTable({ tree: output.tree, ctx })]);
    expect(all).not.toMatch(UUID);
  });

  it('the weekly volume table folds identical weeks and marks the deload', async () => {
    const state = await checkedState();
    const output = state.guardrailReport as GuardrailNodeOutput;
    const ctx = guardrailContextOf(runContextFixture(), STUB_VERIFIED_BRIEF);
    const table = weeklyVolumeTable({ tree: output.tree, ctx });
    expect(table.map((row) => [row.weeks, row.isDeload])).toEqual([
      [[1, 2, 3, 4, 5], false],
      [[6], true],
      [[7, 8], false],
    ]);
  });
});

describe('critique node (critic agent over the scripted fake)', () => {
  it('investigates with tools, then returns a sanitised verdict with its round; emits critic.round', async () => {
    const seen: AiResponseRequest[] = [];
    const toolOutputs: string[] = [];
    const verdict: CriticVerdict = {
      ...stubVerdict('revise'),
      summary: 'Solid plan, see https://evil.example/x and <b>fix</b> recovery.',
    };
    const h = createNodeContextHarness({
      scripts: {
        critic: criticScript(
          () => verdict,
          { toolCalls: [{ name: 'get_weekly_volume', args: { weekNumber: 1 } }, { name: 'find_substitutes', args: { exerciseKey: 'barbell_back_squat' } }] },
          seen,
          toolOutputs,
        ),
      },
    });
    const state = await checkedState();

    const update = await h.runNode(runCritique, state);

    // Investigate (tool call round-trip + notes), then the structured verdict.
    expect(seen).toHaveLength(3);
    expect(seen.every((r) => r.instructions === CRITIC_INSTRUCTIONS)).toBe(true);
    expect(seen[0].metadata).toMatchObject({ agent: 'critic', node: 'critique', round: '1' });
    expect(seen[0].tools?.map((t) => (t as { name: string }).name)).toContain('find_substitutes');
    expect(seen[2].structuredOutput).toBeDefined();
    expect(toolOutputs).toHaveLength(2);
    expect(toolOutputs.join('')).not.toMatch(UUID);
    expect(String(JSON.stringify(seen[2].input))).toContain('investigationNotes');

    // The critic sees the REPAIRED tree by key, the server tables and report; no ids.
    const first = JSON.stringify(seen[0].input);
    expect(first).toContain('weeklyHardSetsPerMuscle');
    expect(first).toContain('barbell_back_squat');
    expect(first).not.toMatch(UUID);

    expect(update.roundCounters).toEqual({ critique: 1 });
    const stored = update.verdicts![0] as CriticVerdict & { round: number };
    expect(stored.round).toBe(1);
    expect(stored.summary).not.toContain('https://');
    expect(stored.summary).not.toContain('<b>');
    expect(events(h, 'critic.round')).toEqual([
      {
        round: 1,
        verdict: 'revise',
        scores: verdict.scores,
        blockers: [{ dimension: 'goal_fit', issue: 'Off goal.' }],
        summary: stored.summary,
      },
    ]);
  });

  it('a verdict that fails the schema is retried once, then the node records critic_unavailable when the draft is not blocked', async () => {
    let verdictCalls = 0;
    const h = createNodeContextHarness({
      scripts: { critic: criticScript(() => stubVerdict(), { verdictAnswer: () => ((verdictCalls += 1), { outputText: '{"verdict":"maybe"}' }) }) },
    });

    const update = await h.runNode(runCritique, await checkedState());

    expect(verdictCalls).toBe(2);
    expect(update.verdicts).toEqual([{ round: 1, skipped: 'unavailable' }]);
    expect(update.warnings).toEqual(['critic_unavailable']);
    expect(events(h, 'critic.round')[0]).toMatchObject({ verdict: 'skipped', scores: null });
  });

  it('with a blocked draft an unavailable critic fails the run with the AI code', async () => {
    const h = createNodeContextHarness({
      scripts: { critic: criticScript(() => stubVerdict(), { verdictAnswer: () => ({ outputText: 'not json' }) }) },
    });
    // Every exercise unknown: G1 blocks.
    const draft = draftFixture();
    for (const block of draft.blocks) for (const t of block.weekTypes) for (const w of t.workouts) w.exercises = [draftExercise('made_up_move')];
    const state = await checkedState(draft);
    expect((state.guardrailReport as GuardrailNodeOutput).report.status).toBe('blocked');

    await expect(h.runNode(runCritique, state)).rejects.toBeInstanceOf(AiError);
  });

  it('a spent budget skips the review (critic_skipped_budget) when the draft is not blocked, with no provider call', async () => {
    const h = createNodeContextHarness({ tokenCap: 1_000, scripts: { critic: criticScript(() => stubVerdict()) } });
    h.budget.charge({ inputTokens: 1_000, outputTokens: 0 }, { role: 'planner', node: 'plan' });

    const update = await h.runNode(runCritique, await checkedState());

    expect(update.verdicts).toEqual([{ round: 1, skipped: 'budget' }]);
    expect(update.warnings).toEqual(['critic_skipped_budget']);
    expect(h.runtime.fake.calls).toHaveLength(0);
  });

  it('a spent budget on a blocked draft fails with the budget error', async () => {
    const h = createNodeContextHarness({ tokenCap: 1_000, scripts: { critic: criticScript(() => stubVerdict()) } });
    h.budget.charge({ inputTokens: 1_000, outputTokens: 0 }, { role: 'planner', node: 'plan' });
    const draft = draftFixture();
    for (const block of draft.blocks) for (const t of block.weekTypes) for (const w of t.workouts) w.exercises = [draftExercise('made_up_move')];

    await expect(h.runNode(runCritique, await checkedState(draft))).rejects.toBeInstanceOf(RunBudgetExceededError);
  });

  it('fails cleanly without a checked plan or a critic model', async () => {
    const h = createNodeContextHarness({ scripts: {} });
    await expect(h.runNode(runCritique, { context: runContextFixture() })).rejects.toBeInstanceOf(TrainingRunFailedError);

    const noCritic = createNodeContextHarness({ roleModels: {} });
    await expect(noCritic.runNode(runCritique, await checkedState())).rejects.toMatchObject({ code: 'TRAINING_ROLE_UNAVAILABLE' });
  });
});
