import { randomUUID } from 'node:crypto';

import { HARNESS_USER } from '../../ai/testing/ai-runtime-harness';
import { EVENT_BROWSER_TEMPLATES } from '../../notifications/channels/browser-notification.channel';
import { findEvent, isMandatory } from '../../notifications/notification-events';
import type { RunState } from '../graph/run-state';
import { briefFromEvidence } from '../finalize/plan-evidence';
import { PLANNER_INSTRUCTIONS } from '../agents/planner/planner.prompt';
import { runContextFixture } from '../testing/context-fixtures';
import { draftExercise, draftFixture } from '../testing/draft-fixtures';
import { createFakeProgramsPort } from '../testing/fake-programs-port';
import { createNodeContextHarness } from '../testing/node-context-harness';
import { STUB_VERIFIED_BRIEF, stubVerdict } from '../testing/stub-agent-nodes';
import { CREATE_SUMMARY, PLAN_READY_EVENT, REVISE_SUMMARY, runFinalize } from './finalize.node';
import { runGuardrails, type GuardrailNodeOutput } from './guardrails.node';

type Context = ReturnType<typeof runContextFixture>;

async function checked(context: Context, draft = draftFixture()): Promise<Partial<RunState>> {
  const h = createNodeContextHarness();
  const base = { context, brief: STUB_VERIFIED_BRIEF, draft: { round: 1, draft, droppedContext: [] } };
  const update = await h.runNode(runGuardrails, base);
  return { ...base, guardrailReport: update.guardrailReport };
}

function harness(kind: 'create' | 'revise' = 'create') {
  const fake = createFakeProgramsPort();
  const h = createNodeContextHarness({ kind, ports: { programs: fake.port, notifications: fake.notify } });
  return { h, fake };
}

const events = (h: ReturnType<typeof createNodeContextHarness>, type: string) =>
  (h.events.events.get(h.runId) ?? []).filter((e) => e.type === type).map((e) => e.data);

describe('finalize node: create', () => {
  it('writes the checked plan as a draft through createWithTree, then notifies and emits plan.finalized', async () => {
    const { h, fake } = harness();
    const context = runContextFixture({ intake: { autonomy: 'ask_first' } });
    const state = await checked(context);

    const update = await h.runNode(runFinalize, {
      ...state,
      verdicts: [{ ...stubVerdict('approve'), round: 1 }],
      roundCounters: { critique: 1 },
    });

    expect(fake.programs.size).toBe(1);
    const program = [...fake.programs.values()][0];
    expect(program).toMatchObject({
      userId: HARNESS_USER,
      name: 'Eight-week strength base',
      goal: 'hypertrophy',
      status: 'draft',
      source: 'ai',
      autonomy: 'ask_first',
      gymId: context.intake.gymId,
      currentVersion: 1,
    });
    expect(program.intake).toEqual(context.intake);
    const version = program.versions[0];
    expect(version).toMatchObject({ versionNumber: 1, origin: 'ai_create', runId: h.runId });
    expect(version.tree).toEqual((state.guardrailReport as GuardrailNodeOutput).tree);
    expect(briefFromEvidence(version.evidence)).toEqual(STUB_VERIFIED_BRIEF);
    expect(version.meta).toMatchObject({
      criticRounds: 1,
      verdict: 'approved',
      warnings: [],
      tokens: expect.objectContaining({ calls: 0 }),
      models: expect.objectContaining({ planner: expect.objectContaining({ provider: expect.any(String), modelId: expect.any(String) }) }),
    });
    expect(JSON.stringify(version.meta)).not.toContain(PLANNER_INSTRUCTIONS.slice(0, 40));
    expect(program.changeLog[0]).toMatchObject({ kind: 'created', actor: 'ai', summary: CREATE_SUMMARY, runId: h.runId });
    expect(program.changeLog[0].citations.length).toBeGreaterThan(0);

    // After the write returned, never before.
    expect(fake.log).toEqual([`create:${program.id}`, `notify:${PLAN_READY_EVENT}`]);
    expect(fake.notifications[0]).toEqual({ eventKey: PLAN_READY_EVENT, userId: HARNESS_USER, data: { programId: program.id, programName: program.name, weeks: 8 } });
    expect(events(h, 'plan.finalized')).toEqual([{ programId: program.id, versionNumber: 1, warnings: [] }]);
    expect(update.outcome).toEqual({
      status: 'completed',
      programId: program.id,
      versionNumber: 1,
      changeLogId: program.changeLog[0].id,
      verdict: 'approved',
    });
    expect(update.programId).toBe(program.id);
  });

  it('exhausted but clean: ships with critic_open_notes and the open blockers and low scores in meta', async () => {
    const { h, fake } = harness();
    const state = await checked(runContextFixture());

    const update = await h.runNode(runFinalize, {
      ...state,
      maxCriticRounds: 2,
      verdicts: [{ ...stubVerdict('revise'), round: 1 }, { ...stubVerdict('revise'), round: 2 }],
      roundCounters: { critique: 2 },
    });

    expect(update.warnings).toEqual(['critic_open_notes']);
    expect(update.outcome).toMatchObject({ status: 'completed', verdict: 'exhausted' });
    const meta = [...fake.programs.values()][0].versions[0].meta;
    expect(meta).toMatchObject({
      verdict: 'exhausted',
      warnings: ['critic_open_notes'],
      openBlockers: [{ dimension: 'goal_fit', path: 'week 1', issue: 'Off goal.' }],
    });
    expect((meta.lowestScores as unknown[]).length).toBe(8);
    expect(events(h, 'plan.finalized')[0]).toMatchObject({ warnings: ['critic_open_notes'] });
  });

  it('a blocked plan is rejected: TRAINING_PLAN_REJECTED, no program, no notification', async () => {
    const { h, fake } = harness();
    const draft = draftFixture();
    for (const block of draft.blocks) for (const t of block.weekTypes) for (const w of t.workouts) w.exercises = [draftExercise('made_up_move')];
    const state = await checked(runContextFixture(), draft);

    const update = await h.runNode(runFinalize, { ...state, verdicts: [{ ...stubVerdict('approve'), round: 2 }], roundCounters: { critique: 2 } });

    expect(update.outcome).toEqual({ status: 'rejected', code: 'TRAINING_PLAN_REJECTED', verdict: 'blocked' });
    expect(fake.programs.size).toBe(0);
    expect(fake.notifications).toHaveLength(0);
    expect(events(h, 'plan.finalized')).toHaveLength(0);
  });

  it('is idempotent across a resume: the version this run wrote is reused', async () => {
    const { h, fake } = harness();
    const state = { ...(await checked(runContextFixture())), verdicts: [{ ...stubVerdict('approve'), round: 1 }], roundCounters: { critique: 1 } };

    const first = await h.runNode(runFinalize, state);
    const again = await h.runNode(runFinalize, state);

    expect(fake.programs.size).toBe(1);
    expect(again.outcome).toEqual(first.outcome);
  });

  it('fails cleanly without the programs port', async () => {
    const h = createNodeContextHarness();
    const state = { ...(await checked(runContextFixture())), verdicts: [{ ...stubVerdict('approve'), round: 1 }], roundCounters: { critique: 1 } };
    await expect(h.runNode(runFinalize, state)).rejects.toMatchObject({ code: 'TRAINING_PROGRAMS_UNAVAILABLE' });
  });
});

describe('finalize node: revise', () => {
  async function reviseSetup(currentVersion: number, basedOnVersion: number) {
    const { h, fake } = harness('revise');
    const created = await checked(runContextFixture());
    const tree = (created.guardrailReport as GuardrailNodeOutput).tree;
    const program = fake.addProgram(HARNESS_USER, tree, { currentVersion });
    const context = runContextFixture({
      kind: 'revise',
      revise: { programId: program.id, basedOnVersion, instruction: 'Swap Friday for Saturday.', currentPlan: tree },
    });
    const state = { ...(await checked(context)), verdicts: [{ ...stubVerdict('approve'), round: 1 }], roundCounters: { critique: 1 } };
    return { h, fake, program, state };
  }

  it('applies the plan as a new version with expectedVersion = basedOnVersion', async () => {
    const { h, fake, program, state } = await reviseSetup(3, 3);

    const update = await h.runNode(runFinalize, state);

    expect(program.currentVersion).toBe(4);
    expect(program.versions.at(-1)).toMatchObject({ versionNumber: 4, origin: 'ai_adapt', runId: h.runId });
    expect(program.changeLog.at(-1)).toMatchObject({ kind: 'adapted', actor: 'ai', summary: REVISE_SUMMARY });
    expect(update.outcome).toMatchObject({ status: 'completed', programId: program.id, versionNumber: 4 });
    expect(fake.log).toEqual([`apply:${program.id}:4`, `notify:${PLAN_READY_EVENT}`]);
  });

  it('a stale basedOnVersion fails TRAINING_STALE_PLAN and changes nothing', async () => {
    const { h, fake, program, state } = await reviseSetup(4, 3);

    await expect(h.runNode(runFinalize, state)).rejects.toMatchObject({ code: 'TRAINING_STALE_PLAN' });
    expect(program.currentVersion).toBe(4);
    expect(program.versions).toHaveLength(1);
    expect(fake.notifications).toHaveLength(0);
  });

  it('another user\'s program is a clean failure', async () => {
    const { h, fake, state } = await reviseSetup(1, 1);
    const other = fake.addProgram(randomUUID(), (state.guardrailReport as GuardrailNodeOutput).tree);
    const context = { ...(state.context as Context), revise: { programId: other.id, basedOnVersion: 1 } };

    await expect(h.runNode(runFinalize, { ...state, context })).rejects.toMatchObject({ code: 'TRAINING_PROGRAM_NOT_FOUND' });
  });
});

describe('training.plan_ready notification', () => {
  it('is registered for browser and push, on by default, with a template linking to the plan', () => {
    expect(findEvent(PLAN_READY_EVENT)).toMatchObject({ channels: ['browser', 'push'], defaultEnabled: true });
    expect(isMandatory(PLAN_READY_EVENT)).toBe(false);
    const content = EVENT_BROWSER_TEMPLATES[PLAN_READY_EVENT]!({ programId: 'p-1', programName: 'Strength base', weeks: 8 } as never);
    expect(content).toEqual({
      title: 'Your training plan is ready',
      body: '"Strength base" (8 weeks) is ready to review.',
      link: '/train/plans/p-1',
    });
  });
});
