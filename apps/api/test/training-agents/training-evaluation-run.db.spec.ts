// =============================================================================
// An evaluate run end to end on real Postgres
// =============================================================================
//
// The real `ai.training.plan.run` handler with every real evaluate node
// (load_signals .. notify) over the scripted fake provider, reading through
// the real `EvaluationContextLoader` (signals, planner context, locks) and
// writing through the real `ProgramsService`:
//
//   - autonomous: an in-bounds change lands as version 2 (`ai_adapt`, the run
//     id), one `adapted` entry with operations, rationale and citations,
//     `training.plan_adapted` after the write; one-tap revert restores the
//     tree as version 3 and the entry's operations become suppression
//     fingerprints for the next evaluation;
//   - ask first: the run pauses `awaiting_approval` with a `proposed` row and
//     a checkpoint in Postgres; a NEW handler (a restart) resumes it: approve
//     moves that row to `applied` (version 2), reject records `rejected`;
//   - thin data: no completed session, no provider call, a `reviewed` entry;
//   - the kill switch: with AI off the run fails before any provider call.
//
// THIS IS A `*.db.spec.ts` FILE: skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { Job, PrismaClient } from '@prisma/client';

import { CheckInsService } from '../../src/check-ins/check-ins.service';
import { addDays, fromDbDate, toDbDate } from '../../src/check-ins/local-date';
import { createAiRuntimeHarness, HARNESS_MODEL } from '../../src/ai/testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES } from '../../src/ai/testing/fake-ai-provider';
import { HealthProfileService } from '../../src/health-profile/health-profile.service';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { PlanChangeOperation } from '../../src/programs/contracts/plan-change.contract';
import { occurrenceDate } from '../../src/programs/today/resolve-today';
import { ProgramsService } from '../../src/programs/programs.service';
import { SignalsLoader } from '../../src/programs/signals/signals.loader';
import { TrainingSignalsService } from '../../src/programs/signals/signals.service';
import { PlannerContextLoader } from '../../src/training-agents/context/planner-context.loader';
import { buildEvaluatorContext } from '../../src/training-agents/evaluation/build-evaluator-context';
import { EvaluationContextLoader } from '../../src/training-agents/evaluation/evaluation-context.loader';
import type { NotificationsPort } from '../../src/training-agents/graph/node-context';
import { RunEventsService } from '../../src/training-agents/runtime/run-events.service';
import { TrainingPlanRunHandler } from '../../src/training-agents/runtime/training-plan-run.handler';
import { TrainingProgramsPort } from '../../src/training-agents/runtime/training-programs.port';
import { TRAINING_RUN_JOB_TYPE } from '../../src/training-agents/runtime/training-runs.constants';
import type { TrainingRunsService } from '../../src/training-agents/runtime/training-runs.service';
import { evaluationResult, evaluatorScript } from '../../src/training-agents/testing/evaluation-harness';
import { HARNESS_FROZEN_MODEL } from '../../src/training-agents/testing/node-context-harness';
import { WorkoutHistoryService } from '../../src/workouts/workout-history.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('training-evaluation-run.db.spec');

type Keys = Record<'squat' | 'push' | 'row' | 'lunge', string>;

describeWithDb('evaluate run end to end on real Postgres', () => {
  let client: PrismaClient;
  let prisma: PrismaService;
  let events: RunEventsService;
  let programs: ProgramsService;
  let loader: EvaluationContextLoader;
  const tag = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const threads: string[] = [];
  const today = fromDbDate(new Date());
  // Week 1 is entirely past; week 2 starts today; weeks 3 and 4 are open.
  const start = addDays(today, -7);

  beforeAll(() => {
    client = createDbClient();
    prisma = client as unknown as PrismaService;
    events = new RunEventsService(prisma);
    programs = new ProgramsService(prisma);
    const checkIns = new CheckInsService(prisma, new HealthProfileService(prisma));
    loader = new EvaluationContextLoader(
      prisma,
      new TrainingSignalsService(prisma, checkIns, new SignalsLoader(prisma, new WorkoutHistoryService(prisma, checkIns))),
      programs,
      new PlannerContextLoader(prisma),
    );
  });

  afterAll(async () => {
    await client.trainingRunCheckpointWrite.deleteMany({ where: { threadId: { in: threads } } });
    await client.trainingRunCheckpoint.deleteMany({ where: { threadId: { in: threads } } });
    await client.workout.deleteMany({ where: { userId: { in: userIds } } });
    await client.program.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  /** A user with four bodyweight exercises of their own, and an active 4-week plan with one completed session. */
  async function planWithHistory(opts: { autonomy?: 'autonomous' | 'ask_first'; completed?: boolean } = {}) {
    const user = await client.user.create({ data: { email: `evrun-${randomUUID().slice(0, 8)}-${tag}@example.com` } });
    userIds.push(user.id);
    const suffix = randomUUID().slice(0, 8);
    const keys: Keys = { squat: `ev_squat_${suffix}`, push: `ev_push_${suffix}`, row: `ev_row_${suffix}`, lunge: `ev_lunge_${suffix}` };
    const ids = {} as Record<keyof Keys, string>;
    const rows: Array<[keyof Keys, string, string[]]> = [
      ['squat', 'squat', ['quads', 'glutes']],
      ['push', 'horizontal_push', ['chest', 'triceps']],
      ['row', 'horizontal_pull', ['upper_back', 'lats']],
      ['lunge', 'lunge', ['quads', 'glutes']],
    ];
    for (const [name, movementPattern, primaryMuscles] of rows) {
      const row = await client.exercise.create({
        data: { slug: keys[name], name: keys[name], ownerUserId: user.id, movementPattern, primaryMuscles, isBodyweight: true, trackingMode: 'bodyweight_reps' },
      });
      ids[name] = row.id;
    }

    const exercise = (name: keyof Keys, position: number, priority = false) => ({
      exerciseId: ids[name],
      position,
      isPriority: priority,
      targetSets: 3,
      repMin: 8,
      repMax: 12,
      restSeconds: 90,
      targetRpe: 7,
    });
    const week = (weekNumber: number) => ({
      weekNumber,
      workouts: [
        { position: 0, weekday: 1, name: 'Full A', exercises: [exercise('squat', 0, true), exercise('push', 1), exercise('row', 2)] },
        { position: 1, weekday: 3, name: 'Full B', exercises: [exercise('lunge', 0, true), exercise('push', 1), exercise('row', 2)] },
        { position: 2, weekday: 5, name: 'Full C', exercises: [exercise('squat', 0, true), exercise('row', 1), exercise('push', 2)] },
      ],
    });
    const created = await programs.createWithTree({
      userId: user.id,
      header: { name: 'Plan', goal: 'general', source: 'ai', autonomy: opts.autonomy ?? 'autonomous' },
      tree: { blocks: [{ position: 0, name: 'Base', weeks: [week(1), week(2), week(3), week(4)] }] },
      origin: 'ai_create',
      actor: 'ai',
      summary: 'Created by the planner',
    });
    await client.program.update({ where: { id: created.programId }, data: { status: 'active', startDate: toDbDate(start) } });

    if (opts.completed !== false) {
      const first = await client.programWorkout.findFirstOrThrow({
        where: { weekday: 1, archivedAt: null, week: { programId: created.programId, weekNumber: 1 } },
        select: { id: true },
      });
      const date = occurrenceDate(start, 1, 1);
      const workout = await client.workout.create({
        data: {
          userId: user.id,
          name: 'Session',
          date: toDbDate(date),
          status: 'completed',
          startedAt: new Date(`${date}T10:00:00.000Z`),
          endedAt: new Date(`${date}T11:00:00.000Z`),
          programWorkoutId: first.id,
        },
      });
      const we = await client.workoutExercise.create({ data: { workoutId: workout.id, exerciseId: ids.push, position: 0 } });
      for (const setNumber of [1, 2, 3]) {
        await client.setLog.create({ data: { workoutExerciseId: we.id, setNumber, reps: 12, completed: true, rpe: 7 } as never });
      }
    }

    return { userId: user.id, programId: created.programId, keys, ids };
  }

  function harness(userId: string, evaluator: ReturnType<typeof evaluatorScript>, opts: { enabled?: boolean } = {}) {
    const h = createAiRuntimeHarness({
      models: [{ modelId: HARNESS_MODEL, capabilities: FAKE_TEXT_MODEL_CAPABILITIES }],
      ...(opts.enabled === false ? { policy: { enabled: false } } : {}),
      fake: {
        responses: (req, ctx) => {
          if (req.metadata?.agent !== 'evaluator') throw new Error(`No script for ${String(req.metadata?.agent)}`);
          return evaluator(req, ctx);
        },
      },
    });
    h.addUserKey(userId, `sk-evaluate-db-${tag}`, [HARNESS_MODEL]);
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
      loader,
    );
  }

  async function runRow(userId: string, programId: string) {
    const row = await client.trainingPlanRun.create({
      data: {
        userId,
        kind: 'evaluate',
        trigger: 'manual',
        programId,
        input: { request: { kind: 'evaluate', programId, trigger: 'manual' }, maxCriticRounds: 2 },
        roleModels: { evaluator: HARNESS_FROZEN_MODEL },
        tokenCap: 100_000,
      } as never,
    });
    threads.push(row.id);
    return row;
  }

  const jobFor = (runId: string): Job =>
    ({ id: randomUUID(), type: TRAINING_RUN_JOB_TYPE, payload: { runId }, subjectType: 'training_run', subjectId: runId }) as unknown as Job;

  /** More reps for the push-up in weeks 3 and 4 (open weeks), citing the stored claim if any. */
  const MORE_REPS: PlanChangeOperation = {
    op: 'set_prescription',
    target: { exerciseRef: 'W3-1-2', weeks: { from: 3, to: 4 } },
    sets: null,
    repMin: 10,
    repMax: 15,
    targetRpe: null,
    restSeconds: null,
    targetLoadKg: null,
    loadGuidance: null,
    reason: 'Every set reached the top of the range at RPE 7.',
  };
  const adjust = evaluationResult({
    assessment: { status: 'ahead', summary: 'Push-ups reached the top of the range at RPE 7.', observations: [] },
    decision: 'adjust',
    changes: [MORE_REPS],
    userMessage: 'Push-ups move to 10-15 reps in the coming weeks.',
  });

  async function pushRepsByWeek(programId: string, pushId: string): Promise<Array<[number, number]>> {
    const rows = await client.programExercise.findMany({
      where: { exerciseId: pushId, programWorkout: { position: 0, archivedAt: null, week: { programId, archivedAt: null } } },
      select: { repMax: true, programWorkout: { select: { week: { select: { weekNumber: true } } } } },
    });
    return rows.map((r) => [r.programWorkout.week.weekNumber, r.repMax] as [number, number]).sort((a, b) => a[0] - b[0]);
  }

  it('autonomous: the change lands as a new version with its entry and notification; one-tap revert restores it and feeds suppression', async () => {
    const { userId, programId, ids } = await planWithHistory();
    const notified: string[] = [];
    const h = harness(userId, evaluatorScript([adjust]));
    const run = await runRow(userId, programId);

    await handler(h, notified).process(jobFor(run.id));

    const after = await client.trainingPlanRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after).toMatchObject({ status: 'succeeded', errorCode: null });
    const result = after.result as { versionNumber: number; changeLogId: string; verdict: string };
    expect(result).toMatchObject({ versionNumber: 2, verdict: 'applied' });

    expect((await client.program.findUniqueOrThrow({ where: { id: programId } })).currentVersion).toBe(2);
    expect(await client.programVersion.findUniqueOrThrow({ where: { programId_versionNumber: { programId, versionNumber: 2 } } })).toMatchObject({
      origin: 'ai_adapt',
      runId: run.id,
    });
    const entry = await client.programChangeLog.findUniqueOrThrow({ where: { id: result.changeLogId } });
    expect(entry).toMatchObject({ kind: 'adapted', actor: 'ai', status: 'applied', fromVersion: 1, toVersion: 2, runId: run.id });
    expect(entry.summary).toContain('10-15');
    expect(entry.operations).toEqual([expect.objectContaining({ op: 'set_prescription', repMax: 15, fingerprint: expect.any(String), description: expect.any(String) })]);
    expect(await pushRepsByWeek(programId, ids.push)).toEqual([
      [1, 12],
      [2, 12],
      [3, 15],
      [4, 15],
    ]);
    expect(notified).toEqual(['training.plan_adapted']);
    expect(h.fake.calls).toHaveLength(1);
    const types = (await events.list(run.id, 0, 500)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['evaluation.signals', 'evaluation.assessed', 'adaptation.envelope', 'adaptation.applied']));

    // One tap: undo the latest AI change.
    const reverted = await programs.revert({ userId, programId, expectedVersion: 2, changeLogId: entry.id });
    expect(reverted.versionNumber).toBe(3);
    expect((await pushRepsByWeek(programId, ids.push)).map(([, max]) => max)).toEqual([12, 12, 12, 12]);
    expect(await client.programChangeLog.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({ status: 'reverted' });

    // The reverted operations are the evaluator's feedback and the envelope's suppression list.
    const sources = await loader.loadSources(userId, programId, new Date());
    const context = buildEvaluatorContext(sources!, { trigger: 'manual', deep: false, now: new Date() });
    expect(context.server.suppressedFingerprints).toEqual([(entry.operations as Array<{ fingerprint: string }>)[0].fingerprint]);
    expect(context.sent.history.find((row) => row.feedback === 'undone')).toBeDefined();
  });

  it('ask first: pauses awaiting approval; after a restart, approve applies the same proposal row', async () => {
    const { userId, programId } = await planWithHistory({ autonomy: 'ask_first' });
    const notified: string[] = [];
    const h = harness(userId, evaluatorScript([adjust]));
    const run = await runRow(userId, programId);

    await handler(h, notified).process(jobFor(run.id));

    const waiting = await client.trainingPlanRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(waiting).toMatchObject({ status: 'awaiting_approval', expiresAt: expect.any(Date) });
    const proposal = await client.programChangeLog.findFirstOrThrow({ where: { runId: run.id, kind: 'adapted' } });
    expect(proposal).toMatchObject({ status: 'proposed', actor: 'ai', fromVersion: 1, toVersion: null });
    expect((await client.program.findUniqueOrThrow({ where: { id: programId } })).currentVersion).toBe(1);
    expect(notified).toEqual(['training.plan_proposal']);
    expect(await client.trainingRunCheckpoint.count({ where: { threadId: run.id } })).toBeGreaterThan(0);

    // The decision route's effect (TrainingRunsService.decide): queued again with the decision.
    await client.trainingPlanRun.update({ where: { id: run.id }, data: { status: 'queued', pendingDecision: { decision: 'approve' } } });
    await handler(harness(userId, evaluatorScript([adjust])), notified).process(jobFor(run.id));

    expect(await client.trainingPlanRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'succeeded' });
    expect(await client.programChangeLog.findUniqueOrThrow({ where: { id: proposal.id } })).toMatchObject({
      status: 'applied',
      fromVersion: 1,
      toVersion: 2,
      decidedAt: expect.any(Date),
    });
    expect((await client.program.findUniqueOrThrow({ where: { id: programId } })).currentVersion).toBe(2);
    expect(await client.programChangeLog.count({ where: { programId, kind: 'adapted' } })).toBe(1);
    expect(notified).toEqual(['training.plan_proposal', 'training.plan_adapted']);
  });

  it('ask first: reject records rejected and leaves the plan untouched', async () => {
    const { userId, programId } = await planWithHistory({ autonomy: 'ask_first' });
    const run = await runRow(userId, programId);
    await handler(harness(userId, evaluatorScript([adjust])), []).process(jobFor(run.id));

    await client.trainingPlanRun.update({ where: { id: run.id }, data: { status: 'queued', pendingDecision: { decision: 'reject' } } });
    await handler(harness(userId, evaluatorScript([adjust])), []).process(jobFor(run.id));

    expect(await client.trainingPlanRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'succeeded' });
    expect(await client.programChangeLog.findFirstOrThrow({ where: { runId: run.id, kind: 'adapted' } })).toMatchObject({ status: 'rejected' });
    expect((await client.program.findUniqueOrThrow({ where: { id: programId } })).currentVersion).toBe(1);
  });

  it('thin data: no completed session means no provider call and a reviewed entry without a version bump', async () => {
    const { userId, programId } = await planWithHistory({ completed: false });
    const h = harness(userId, evaluatorScript([adjust]));
    const run = await runRow(userId, programId);

    await handler(h, []).process(jobFor(run.id));

    expect(h.fake.calls).toHaveLength(0);
    expect(await client.trainingPlanRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'succeeded' });
    expect(await client.programChangeLog.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({ kind: 'reviewed', actor: 'ai', fromVersion: 1, toVersion: 1 });
    expect((await client.program.findUniqueOrThrow({ where: { id: programId } })).currentVersion).toBe(1);
  });

  it('the kill switch: with AI off the run fails before any provider call and the plan is untouched', async () => {
    const { userId, programId } = await planWithHistory();
    const h = harness(userId, evaluatorScript([adjust]), { enabled: false });
    const run = await runRow(userId, programId);

    await handler(h, []).process(jobFor(run.id));

    expect(h.fake.calls).toHaveLength(0);
    expect(await client.trainingPlanRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'failed', errorCode: 'AI_DISABLED' });
    expect((await client.program.findUniqueOrThrow({ where: { id: programId } })).currentVersion).toBe(1);
    expect(await client.programChangeLog.count({ where: { programId } })).toBe(1);
  });
});
