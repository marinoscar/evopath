// =============================================================================
// A training plan run end to end on real Postgres
// =============================================================================
//
// The real `ai.training.plan.run` handler with every real node (context
// loader, researcher, planner, guardrails, critic, finalize) over the
// scripted fake provider, writing through the real `ProgramsService`:
//
//   - a create run ends `succeeded` with a draft program, version 1
//     (`ai_create`, the run id, the verified evidence) and one `created`
//     change-log entry with citations, all written by `createWithTree`;
//     `training.plan_ready` is raised after the run's write returned;
//   - a revise run whose `basedOnVersion` went stale while it ran fails
//     `TRAINING_STALE_PLAN` and leaves the program untouched.
//
// THIS IS A `*.db.spec.ts` FILE: skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { Job, PrismaClient } from '@prisma/client';

import { createAiRuntimeHarness, HARNESS_MODEL } from '../../src/ai/testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES } from '../../src/ai/testing/fake-ai-provider';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { ProgramsService } from '../../src/programs/programs.service';
import type { PlanDraft } from '../../src/training-agents/agents/planner/plan-draft.contract';
import { PlannerContextLoader } from '../../src/training-agents/context/planner-context.loader';
import type { NotificationsPort } from '../../src/training-agents/graph/node-context';
import { RunEventsService } from '../../src/training-agents/runtime/run-events.service';
import { TrainingPlanRunHandler } from '../../src/training-agents/runtime/training-plan-run.handler';
import { TrainingProgramsPort } from '../../src/training-agents/runtime/training-programs.port';
import { TRAINING_RUN_JOB_TYPE } from '../../src/training-agents/runtime/training-runs.constants';
import type { TrainingRunsService } from '../../src/training-agents/runtime/training-runs.service';
import { criticScript, plannerScript, researcherScript } from '../../src/training-agents/testing/agent-scripts';
import { draftExercise, draftWorkout } from '../../src/training-agents/testing/draft-fixtures';
import { intakeFixture } from '../../src/training-agents/testing/intake-fixtures';
import type { AgentScript } from '../../src/training-agents/testing/node-context-harness';
import { HARNESS_FROZEN_MODEL } from '../../src/training-agents/testing/node-context-harness';
import { stubVerdict } from '../../src/training-agents/testing/stub-agent-nodes';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('training-plan-finalize.db.spec');

describeWithDb('training plan run, finalize on real Postgres', () => {
  let client: PrismaClient;
  let prisma: PrismaService;
  let events: RunEventsService;
  let programs: ProgramsService;
  const tag = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const threads: string[] = [];

  beforeAll(() => {
    client = createDbClient();
    prisma = client as unknown as PrismaService;
    events = new RunEventsService(prisma);
    programs = new ProgramsService(prisma);
  });

  afterAll(async () => {
    await client.trainingRunCheckpointWrite.deleteMany({ where: { threadId: { in: threads } } });
    await client.trainingRunCheckpoint.deleteMany({ where: { threadId: { in: threads } } });
    // Programs first: their exercises reference the users' own exercises.
    await client.program.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  /** A user with four bodyweight exercises of their own (no gym needed). */
  async function userWithExercises(): Promise<{ userId: string; keys: Record<'squat' | 'push' | 'row' | 'lunge', string> }> {
    const user = await client.user.create({ data: { email: `fin-${randomUUID().slice(0, 8)}-${tag}@example.com` } });
    userIds.push(user.id);
    const suffix = randomUUID().slice(0, 8);
    const keys = { squat: `fin_squat_${suffix}`, push: `fin_push_${suffix}`, row: `fin_row_${suffix}`, lunge: `fin_lunge_${suffix}` };
    const rows: Array<[string, string, string[]]> = [
      [keys.squat, 'squat', ['quads', 'glutes']],
      [keys.push, 'horizontal_push', ['chest', 'triceps']],
      [keys.row, 'horizontal_pull', ['upper_back', 'lats']],
      [keys.lunge, 'lunge', ['quads', 'glutes']],
    ];
    for (const [slug, movementPattern, primaryMuscles] of rows) {
      await client.exercise.create({
        data: { slug, name: slug, ownerUserId: user.id, movementPattern, primaryMuscles, isBodyweight: true, trackingMode: 'bodyweight_reps' },
      });
    }
    return { userId: user.id, keys };
  }

  function draftFor(keys: Record<'squat' | 'push' | 'row' | 'lunge', string>): PlanDraft {
    const type = {
      key: 'A',
      isDeload: false,
      workouts: [
        draftWorkout('Full A', 1, [draftExercise(keys.squat, { isPriority: true }), draftExercise(keys.push), draftExercise(keys.row)]),
        draftWorkout('Full B', 3, [draftExercise(keys.lunge, { isPriority: true }), draftExercise(keys.push), draftExercise(keys.row)]),
        draftWorkout('Full C', 5, [draftExercise(keys.squat, { isPriority: true }), draftExercise(keys.row), draftExercise(keys.push)]),
      ],
    };
    return {
      title: 'Bodyweight base',
      summary: 'Three full-body sessions a week.',
      rationale: 'Frequency twice a week per muscle (E1).',
      totalWeeks: 4,
      daysPerWeek: 3,
      blocks: [{ name: 'Base', focus: 'Consistency', rationale: 'Build the habit.', weekStart: 1, weekEnd: 4, weekSequence: ['A', 'A', 'A', 'A'], weekTypes: [type] }],
      assumptions: [],
      safetyNotes: [],
    };
  }

  function harness(userId: string, scripts: Record<string, AgentScript>) {
    const h = createAiRuntimeHarness({
      models: [
        {
          modelId: HARNESS_MODEL,
          capabilities: { ...FAKE_TEXT_MODEL_CAPABILITIES, capabilities: [...FAKE_TEXT_MODEL_CAPABILITIES.capabilities, 'hosted_tools'] },
        },
      ],
      policy: { hostedTools: { web_search: true } },
      fake: {
        hostedTools: ['web_search'],
        responses: (req, ctx) => {
          const script = scripts[String(req.metadata?.agent)];
          if (!script) throw new Error(`No script for ${String(req.metadata?.agent)}`);
          return script(req, ctx);
        },
      },
    });
    h.addUserKey(userId, `sk-finalize-db-${tag}`, [HARNESS_MODEL]);
    return h;
  }

  function handler(h: ReturnType<typeof createAiRuntimeHarness>, notified: string[]) {
    const notifications: NotificationsPort = { notify: (eventKey) => void notified.push(eventKey) };
    return new TrainingPlanRunHandler(
      new JobHandlerRegistry(),
      prisma,
      h.ai,
      h.aiConfig,
      events,
      { requeue: jest.fn(async () => true) } as unknown as TrainingRunsService,
      { cancelPollMs: 50 },
      new PlannerContextLoader(prisma),
      new TrainingProgramsPort(programs, prisma),
      notifications as never,
    );
  }

  async function runRow(userId: string, kind: 'create' | 'revise', request: Record<string, unknown>, programId: string | null = null) {
    const row = await client.trainingPlanRun.create({
      data: {
        userId,
        kind,
        programId,
        input: { request, maxCriticRounds: 2 },
        roleModels:
          kind === 'create'
            ? { researcher: HARNESS_FROZEN_MODEL, planner: HARNESS_FROZEN_MODEL, critic: HARNESS_FROZEN_MODEL }
            : { planner: HARNESS_FROZEN_MODEL, critic: HARNESS_FROZEN_MODEL },
        tokenCap: 400_000,
      } as never,
    });
    threads.push(row.id);
    return row;
  }

  const jobFor = (runId: string): Job =>
    ({ id: randomUUID(), type: TRAINING_RUN_JOB_TYPE, payload: { runId }, subjectType: 'training_run', subjectId: runId }) as unknown as Job;

  it('a create run writes a draft program, version 1 and its change log through createWithTree', async () => {
    const { userId, keys } = await userWithExercises();
    const notified: string[] = [];
    const h = harness(userId, {
      researcher: researcherScript(),
      planner: plannerScript([draftFor(keys)]),
      critic: criticScript((round) => stubVerdict(round === 1 ? 'revise' : 'approve')),
    });
    const intake = intakeFixture({ gymId: null, durationWeeks: 4, autonomy: 'ask_first' });
    const run = await runRow(userId, 'create', { kind: 'create', intake });

    await handler(h, notified).process(jobFor(run.id));

    const after = await client.trainingPlanRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after).toMatchObject({ status: 'succeeded', errorCode: null });
    const result = after.result as { programId: string; versionNumber: number; changeLogId: string; verdict: string };
    expect(result).toMatchObject({ versionNumber: 1, verdict: 'approved' });

    const program = await client.program.findUniqueOrThrow({ where: { id: result.programId } });
    expect(program).toMatchObject({ userId, status: 'draft', source: 'ai', autonomy: 'ask_first', gymId: null, currentVersion: 1, name: 'Bodyweight base' });
    expect(program.intake).toMatchObject({ durationWeeks: 4, autonomy: 'ask_first' });

    const versions = await client.programVersion.findMany({ where: { programId: program.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ versionNumber: 1, origin: 'ai_create', runId: run.id });
    const evidence = versions[0].evidence as Array<{ type: string }>;
    expect(evidence.filter((e) => e.type === 'claim').length).toBeGreaterThan(0);
    expect(evidence.filter((e) => e.type === 'source').length).toBeGreaterThan(0);
    expect(versions[0].meta).toMatchObject({ criticRounds: 2, verdict: 'approved' });

    const log = await client.programChangeLog.findMany({ where: { programId: program.id } });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ id: result.changeLogId, kind: 'created', actor: 'ai', runId: run.id, toVersion: 1 });
    expect((log[0].citations as unknown[]).length).toBeGreaterThan(0);

    expect(await client.programWeek.count({ where: { programId: program.id } })).toBe(4);
    expect(notified).toEqual(['training.plan_ready']);
    const types = (await events.list(run.id, 0, 500)).map((e) => e.type);
    expect(types).toContain('plan.finalized');
    expect(types.at(-1)).toBe('run.completed');
  });

  it('a revise run on a version that moved on fails TRAINING_STALE_PLAN and changes nothing', async () => {
    const { userId, keys } = await userWithExercises();
    const notified: string[] = [];
    const h = harness(userId, {
      researcher: researcherScript(),
      planner: plannerScript([draftFor(keys)]),
      critic: criticScript(() => stubVerdict('approve')),
    });
    const create = await runRow(userId, 'create', { kind: 'create', intake: intakeFixture({ gymId: null, durationWeeks: 4 }) });
    await handler(h, notified).process(jobFor(create.id));
    const programId = ((await client.trainingPlanRun.findUniqueOrThrow({ where: { id: create.id } })).result as { programId: string }).programId;

    const request = { kind: 'revise', programId, basedOnVersion: 1, instruction: 'Swap Friday for Saturday.' };
    const revise = await runRow(userId, 'revise', request, programId);
    // The owner edits the plan while the run waits in the queue.
    await programs.applyChange({
      userId,
      programId,
      expectedVersion: 1,
      origin: 'manual_edit',
      actor: 'user',
      kind: 'edited',
      mutate: (tree) => tree,
      summary: 'Manual edit',
    });

    await handler(h, notified).process(jobFor(revise.id));

    expect(await client.trainingPlanRun.findUniqueOrThrow({ where: { id: revise.id } })).toMatchObject({
      status: 'failed',
      errorCode: 'TRAINING_STALE_PLAN',
    });
    expect((await client.program.findUniqueOrThrow({ where: { id: programId } })).currentVersion).toBe(2);
    expect(await client.programVersion.count({ where: { programId } })).toBe(2);
    expect(await client.programVersion.count({ where: { programId, runId: revise.id } })).toBe(0);
    expect(notified).toEqual(['training.plan_ready']);
  });
});
