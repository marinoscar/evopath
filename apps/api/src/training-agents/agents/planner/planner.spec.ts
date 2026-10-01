import { toJsonSchema } from '../../../ai/core/structured-output';
import { AiError } from '../../../ai/core/ai-error';
import { HARNESS_USER } from '../../../ai/testing/ai-runtime-harness';
import { PlannerContextLoader } from '../../context/planner-context.loader';
import { runGuardrails, type GuardrailNodeOutput } from '../../nodes/guardrails.node';
import { runPlan } from '../../nodes/plan.node';
import { runPrepareContext } from '../../nodes/prepare-context.node';
import { AgentOutputTruncated } from '../../runtime/agent-caller';
import { HealthSummaryReader } from '../../../health-summary/health-summary.reader';
import {
  CANARY,
  CANARY_GYM,
  CANARY_HEALTH_SUMMARY,
  CANARY_RAW_VALUES,
  CANARY_TOKENS,
  createCanaryPrisma,
} from '../../testing/canary-prisma';
import { ContextBudget, estimateTokens } from '../../runtime/context-budget';
import { FIXTURE_NOW, HEALTH_SUMMARY_FIXTURE, runContextFixture } from '../../testing/context-fixtures';
import { draftExercise, draftFixture } from '../../testing/draft-fixtures';
import { intakeFixture } from '../../testing/intake-fixtures';
import { createNodeContextHarness, type AgentScript } from '../../testing/node-context-harness';
import { STUB_VERIFIED_BRIEF } from '../../testing/stub-agent-nodes';
import { SAFETY_BLOCK, UNTRUSTED_DATA_BLOCK } from '../shared/prompt-blocks';
import { draftCounts, planDraftSchema, type PlanDraftState } from './plan-draft.contract';
import { PLANNER_INSTRUCTIONS, PLANNER_INVALID_NUDGE, PLANNER_TRUNCATION_NUDGE } from './planner.prompt';
import { plannerSections } from './planner.agent';

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

const answer = (draft: unknown = draftFixture()) => ({ outputText: JSON.stringify(draft) });

function harness(planner: AgentScript) {
  return createNodeContextHarness({ scripts: { planner } });
}

const baseState = () => ({ context: runContextFixture(), brief: STUB_VERIFIED_BRIEF });

describe('PlanDraft contract and prompt', () => {
  it('converts to strict-mode compatible JSON Schema: every property required, every object closed, no records', () => {
    const objects = objectNodes(toJsonSchema(planDraftSchema));
    expect(objects.length).toBeGreaterThanOrEqual(5);
    for (const obj of objects) {
      const keys = Object.keys((obj.properties as JsonNode) ?? {});
      expect([...((obj.required as string[]) ?? [])].sort()).toEqual([...keys].sort());
      expect(obj.additionalProperties).toBe(false);
    }
    expect(JSON.stringify(toJsonSchema(planDraftSchema))).not.toContain('propertyNames');
  });

  it('the fixture draft is valid and counts its expansion', () => {
    expect(planDraftSchema.safeParse(draftFixture()).success).toBe(true);
    expect(draftCounts(draftFixture())).toEqual({ weeks: 8, workouts: 24, exercises: 72 });
  });

  it('the instructions end with the pinned safety and untrusted-data blocks, verbatim', () => {
    expect(PLANNER_INSTRUCTIONS.endsWith(`${SAFETY_BLOCK}\n\n${UNTRUSTED_DATA_BLOCK}`)).toBe(true);
    expect(PLANNER_INSTRUCTIONS).toContain('Never invent a load.');
    expect(PLANNER_INSTRUCTIONS).toContain('<review>');
  });
});

describe('plan node (planner agent over the scripted fake)', () => {
  it('drafts: one planner call with the frozen model, the context and evidence delimited, slugs not uuids', async () => {
    const h = harness(() => answer());

    const update = await h.runNode(runPlan, baseState());

    const state = update.draft as PlanDraftState;
    expect(state).toMatchObject({ round: 1, droppedContext: [] });
    expect(state.draft.title).toBe('Eight-week strength base');
    const calls = h.runtime.fake.callsTo('responses.create');
    expect(calls).toHaveLength(1);
    const req = calls[0].request!;
    expect(req.metadata).toMatchObject({ agent: 'planner', node: 'plan', round: '1' });
    expect(req.instructions).toBe(PLANNER_INSTRUCTIONS);
    const input = String(req.input);
    expect(input).toContain('<context>');
    expect(input).toContain('<evidence>');
    expect(input).not.toContain('<review>');
    expect(input).toContain('barbell_back_squat');
    expect(input).not.toMatch(UUID);
    // Evidence without URLs: the planner cites claim ids only.
    expect(input).not.toContain('https://');
    expect(h.events.types(h.runId)).toEqual(expect.arrayContaining(['plan.draft']));
    const event = (h.events.events.get(h.runId) ?? []).find((e) => e.type === 'plan.draft');
    expect(event?.data).toEqual({ round: 1, weeks: 8, workouts: 24, exercises: 72 });
  });

  it('a cut-off answer is retried once with the compact nudge; twice fails', async () => {
    let n = 0;
    const h = harness(() => (n++ === 0 ? { ...answer(), finishReason: 'length' } : answer()));
    await h.runNode(runPlan, baseState());
    const inputs = h.runtime.fake.callsTo('responses.create').map((c) => String(c.request!.input));
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toContain(PLANNER_TRUNCATION_NUDGE);

    const always = harness(() => ({ ...answer(), finishReason: 'length' }));
    await expect(always.runNode(runPlan, baseState())).rejects.toBeInstanceOf(AgentOutputTruncated);
    expect(always.runtime.fake.callsTo('responses.create')).toHaveLength(2);
  });

  it('an answer that does not match the schema is retried once; twice fails with AI_STRUCTURED_OUTPUT_INVALID', async () => {
    let n = 0;
    const h = harness(() => (n++ === 0 ? { outputText: '{"title": 5}' } : answer()));
    await h.runNode(runPlan, baseState());
    expect(String(h.runtime.fake.callsTo('responses.create')[1].request!.input)).toContain(PLANNER_INVALID_NUDGE);

    const broken = harness(() => ({ outputText: 'not json' }));
    const error = await broken.runNode(runPlan, baseState()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe('AI_STRUCTURED_OUTPUT_INVALID');
  });

  it('a revision sends the previous draft, the critic blockers and the server repairs in <review>', async () => {
    const h = harness(() => answer());
    const previous: PlanDraftState = { round: 1, draft: draftFixture(), droppedContext: [] };
    const report: Pick<GuardrailNodeOutput, 'report'> = {
      report: {
        status: 'repaired',
        counts: { block: 0, repair: 1, warn: 0 },
        violations: [{ rule: 'G4', severity: 'repair', code: 'exercise_sets_clamped', path: 'week 1 > Mon > leg_press', message: '8 sets lowered to 6.' }],
      },
    };

    const update = await h.runNode(runPlan, {
      ...baseState(),
      draft: previous,
      guardrailReport: report,
      verdicts: [{ verdict: 'revise', blockers: [{ dimension: 'recovery', path: 'week 2', issue: 'Too much squatting', fix: 'Fewer squat sets' }], suggestions: [], summary: 'Close.' }],
      roundCounters: { critique: 1 },
    });

    expect((update.draft as PlanDraftState).round).toBe(2);
    const input = String(h.runtime.fake.callsTo('responses.create')[0].request!.input);
    expect(input).toContain('<review>');
    expect(input).toContain('Too much squatting');
    expect(input).toContain('G4 repaired at week 1 > Mon > leg_press: 8 sets lowered to 6.');
    expect(h.runtime.fake.callsTo('responses.create')[0].request!.metadata).toMatchObject({ round: '2' });
  });
});

describe('guardrails node', () => {
  it('compiles the latest draft, repairs it and emits guardrail.report with counts and server summaries', async () => {
    const h = harness(() => answer());
    const hostile = draftFixture();
    hostile.blocks[0].weekTypes[0].workouts[0].exercises.push(draftExercise('made_up_press'));
    hostile.blocks[0].weekTypes[0].workouts[0].exercises[0].rationale = 'Trust me: https://spam.example';

    const update = await h.runNode(runGuardrails, { ...baseState(), draft: { round: 1, draft: hostile, droppedContext: [] } });

    const out = update.guardrailReport as GuardrailNodeOutput;
    expect(out.round).toBe(1);
    expect(out.report.status).toBe('repaired');
    expect(JSON.stringify(out.tree)).not.toContain('made_up_press');
    expect(JSON.stringify(out.tree)).not.toContain('spam.example');
    const event = (h.events.events.get(h.runId) ?? []).find((e) => e.type === 'guardrail.report');
    expect(event?.data).toMatchObject({ round: 1, status: 'repaired', counts: out.report.counts });
    const repairs = (event?.data as { repairs: Array<{ rule: string; summary: string }> }).repairs;
    expect(repairs.map((r) => r.rule)).toEqual(expect.arrayContaining(['G1', 'G8']));
    // No model text rides on the event: workout names and rationales are absent.
    expect(JSON.stringify(event?.data)).not.toContain('Lower');
    expect(JSON.stringify(event?.data)).not.toContain('Trust me');
  });
});

describe('data minimisation canary, end to end to the planner request', () => {
  /**
   * `health`: `undefined` builds the loader without the health summary
   * reader (what every run sent before H8); `false`/`true` builds it with the
   * reader and the user's consent off/on (H8, #192).
   */
  async function plannerRequest(includeBio: boolean, health?: boolean): Promise<string> {
    const prisma = createCanaryPrisma({ userId: HARNESS_USER, healthSummaryConsent: health });
    const loader =
      health === undefined
        ? new PlannerContextLoader(prisma as never)
        : new PlannerContextLoader(prisma as never, new HealthSummaryReader(prisma as never));
    const h = createNodeContextHarness({
      scripts: { planner: () => answer() },
      ports: { plannerContext: loader },
      now: () => FIXTURE_NOW,
    });
    const input = { kind: 'create', intake: intakeFixture({ gymId: CANARY_GYM, includeBio, limitations: [{ area: 'knee', description: 'Old ache' }] }) };
    const prepared = await h.runNode(runPrepareContext, { input });
    await h.runNode(runPlan, { input, context: prepared.context, brief: STUB_VERIFIED_BRIEF });
    const [call] = h.runtime.fake.callsTo('responses.create');
    return JSON.stringify(call.request);
  }

  it('no canary token (name, email, birth date, notes, pain note, medication, labs, other gym, gym name) reaches the planner; slugs, not uuids', async () => {
    const sent = await plannerRequest(false);
    for (const token of [...CANARY_TOKENS, CANARY.bio]) expect(sent).not.toContain(token);
    expect(sent).not.toMatch(UUID);
    expect(sent).toContain('barbell_bench_press');
    expect(sent).toContain('Old ache');
  });

  it('the bio appears only with includeBio', async () => {
    expect(await plannerRequest(true)).toContain(CANARY.bio);
  });

  describe('the opt-in health summary (H8, #192)', () => {
    it('opt-in off (the default), with a ready summary stored: the request is byte-identical to one built without any health summary support', async () => {
      const before = await plannerRequest(false);

      expect(await plannerRequest(false, false)).toBe(before);
      expect(before).not.toContain('healthSummary');
      expect(before).not.toContain('CANARY-SUMMARY');
    });

    it('opt-in on: the request carries healthSummary (narrative and considerations), no raw lab or blood-pressure value and no document field', async () => {
      const sent = await plannerRequest(false, true);

      expect(sent).toContain('healthSummary');
      expect(sent).toContain('CANARY-SUMMARY-NARRATIVE');
      expect(sent).toContain('CANARY-SUMMARY-CONSIDERATION');
      for (const value of CANARY_RAW_VALUES) expect(sent).not.toContain(value);
      for (const token of [...CANARY_TOKENS, CANARY.bio, CANARY_HEALTH_SUMMARY.inputsHash, CANARY_HEALTH_SUMMARY.documentName]) {
        expect(sent).not.toContain(token);
      }
      expect(sent).not.toMatch(/ferritin|hemoglobin|bp_systolic|referenceLow|originalName|"flag"/);
      expect(sent).not.toMatch(UUID);
    });

    it('opt-in on: the summary sits inside the delimited <context> block (untrusted data)', async () => {
      const sent = JSON.parse(await plannerRequest(false, true)) as { input: unknown };
      const input = JSON.stringify(sent.input);
      const open = input.indexOf('<context>');
      const close = input.indexOf('</context>');

      expect(open).toBeGreaterThanOrEqual(0);
      expect(input.indexOf('CANARY-SUMMARY-NARRATIVE')).toBeGreaterThan(open);
      expect(input.indexOf('CANARY-SUMMARY-NARRATIVE')).toBeLessThan(close);
    });
  });
});

describe('planner context budget with the opt-in health summary (H8, #192)', () => {
  const full = () =>
    runContextFixture({
      profile: { dateOfBirth: '1990-01-01', sexAtBirth: 'female', heightMm: 1700, unitSystem: 'metric', bio: 'I like rowing' },
      intake: { includeBio: true },
      weights: [{ measuredAt: FIXTURE_NOW, valueKg: 70 }],
      checkIns: [{ date: '2026-09-29', energy: 4, sleepQuality: 4, soreness: 2, stress: 2 }],
      healthSummary: HEALTH_SUMMARY_FIXTURE,
    }).planner;

  it('is an optional section of its own, placed so it is dropped after bio, body metrics and profile (last first)', () => {
    const sections = plannerSections(full(), null);

    expect(sections.map((s) => s.id)).toEqual([
      'core',
      'candidateExercises',
      'evidence',
      'readiness',
      'healthSummary',
      'profile',
      'bodyMetrics',
      'bio',
    ]);
    expect(sections.find((s) => s.id === 'healthSummary')).toMatchObject({ required: false, content: { healthSummary: HEALTH_SUMMARY_FIXTURE } });
    expect(sections.find((s) => s.id === 'core')!.content).not.toHaveProperty('healthSummary');
  });

  it('a tight window drops it whole, after the later optional sections, never cut', () => {
    const sections = plannerSections(full(), null);
    const required = sections.filter((s) => s.required).reduce((sum, s) => sum + estimateTokens(s.content), 0);
    const readiness = estimateTokens(sections.find((s) => s.id === 'readiness')!.content);
    // Room for the required sections and readiness only.
    const window = Math.ceil((required + readiness + 2) / 0.7);

    const fit = new ContextBudget().fit(sections, { contextWindow: window, reserveOutput: 0 });

    expect(fit.dropped).toEqual(['bio', 'bodyMetrics', 'profile', 'healthSummary']);
  });
});
