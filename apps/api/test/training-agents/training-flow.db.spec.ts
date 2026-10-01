// =============================================================================
// The agentic training flow across stories, on real Postgres
// =============================================================================
//
// One user's whole journey through the real services, with the scripted fake
// provider standing in for the model (the researcher and critic answer from the
// `happy` scenario, the evaluator from `evaluator-autonomous`, the same JSON
// files the browser e2e replays through the fake Responses server):
//
//   create run (`TrainingRunsService.create`, the real handler and graph)
//     -> draft program, version 1, activated with a start a week ago
//     -> Today resolves the planned session, `start` prefills the logger
//     -> `WorkoutsService.finish` emits `workout.finished` after commit
//     -> the real listener and scheduler queue ONE evaluate run
//     -> the handler runs the evaluate graph: autonomous applies, ask-first
//        pauses and a NEW handler (a restart) resumes after the owner's decision
//     -> the change log carries the entry, the banner counts it, one tap
//        reverts it, and the revert becomes the next evaluation's suppression
//
// and, with AI switched off mid-flow, nothing is scheduled.
//
// THIS IS A `*.db.spec.ts` FILE: skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { Job, PrismaClient } from '@prisma/client';

import { createAiRuntimeHarness, HARNESS_MODEL } from '../../src/ai/testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES } from '../../src/ai/testing/fake-ai-provider';
import { addDays, fromDbDate, toDbDate } from '../../src/check-ins/local-date';
import { CheckInsService } from '../../src/check-ins/check-ins.service';
import { TRAINING_AGENT_ROLES } from '../../src/common/schemas/settings.schema';
import { ExerciseAvailabilityService } from '../../src/exercises/exercise-availability.service';
import type { GymStorageService } from '../../src/gyms/gym-storage.service';
import { GymsService } from '../../src/gyms/gyms.service';
import { HealthProfileService } from '../../src/health-profile/health-profile.service';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobsService } from '../../src/jobs/jobs.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { TrainingTodayService } from '../../src/programs/today/training-today.service';
import { ProgramsService } from '../../src/programs/programs.service';
import { SignalsLoader } from '../../src/programs/signals/signals.loader';
import { TrainingSignalsService } from '../../src/programs/signals/signals.service';
import type { PlanDraft } from '../../src/training-agents/agents/planner/plan-draft.contract';
import { PlannerContextLoader } from '../../src/training-agents/context/planner-context.loader';
import { buildEvaluatorContext } from '../../src/training-agents/evaluation/build-evaluator-context';
import { EvaluationContextLoader } from '../../src/training-agents/evaluation/evaluation-context.loader';
import { TrainingEvaluationListener } from '../../src/training-agents/evaluation/workout-finished.listener';
import { TrainingEvaluationScheduler } from '../../src/training-agents/evaluation/training-evaluation.scheduler';
import type { NotificationsPort } from '../../src/training-agents/graph/node-context';
import { TRAINING_GRAPH_READY } from '../../src/training-agents/graph/training-graphs';
import { RunEventsService } from '../../src/training-agents/runtime/run-events.service';
import { TrainingPlanRunHandler } from '../../src/training-agents/runtime/training-plan-run.handler';
import { TrainingProgramsPort } from '../../src/training-agents/runtime/training-programs.port';
import { TRAINING_RUN_JOB_TYPE } from '../../src/training-agents/runtime/training-runs.constants';
import { TrainingRunsService } from '../../src/training-agents/runtime/training-runs.service';
import { plannerScript } from '../../src/training-agents/testing/agent-scripts';
import { draftExercise, draftWorkout } from '../../src/training-agents/testing/draft-fixtures';
import { createRunBody } from '../../src/training-agents/testing/intake-fixtures';
import { HARNESS_FROZEN_MODEL } from '../../src/training-agents/testing/node-context-harness';
import { WORKOUT_FINISHED_EVENT } from '../../src/workouts/workout-events';
import { WorkoutHistoryService } from '../../src/workouts/workout-history.service';
import { WorkoutsService } from '../../src/workouts/workouts.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';
import { scenarioScripts } from './support/scenario-script';

const { describeWithDb } = resolveDbSuite('training-flow.db.spec');

const READY = {
  state: 'ready',
  model: { provider: HARNESS_FROZEN_MODEL.provider, modelId: HARNESS_FROZEN_MODEL.modelId, displayName: 'Fake', keySource: 'user' },
  effectiveEffort: 'medium',
};

type Keys = Record<'squat' | 'push' | 'row' | 'lunge', string>;

describeWithDb('the agentic training flow (real Postgres)', () => {
  let client: PrismaClient;
  let prisma: PrismaService;
  let events: RunEventsService;
  let programs: ProgramsService;
  let runs: TrainingRunsService;
  let scheduler: TrainingEvaluationScheduler;
  let listener: TrainingEvaluationListener;
  let loader: EvaluationContextLoader;
  let today: TrainingTodayService;
  let workouts: WorkoutsService;
  let aiEnabled = true;
  const pendingListeners: Array<Promise<void>> = [];
  const finishedEvents: Array<{ event: string; payload: { userId: string; workoutId: string } }> = [];
  const tag = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const threads: string[] = [];
  const savedReady = { ...TRAINING_GRAPH_READY };
  const todayStr = fromDbDate(new Date());
  // Week 1 is entirely past; week 2 starts today, so today's session is week 2's.
  const start = addDays(todayStr, -7);

  beforeAll(() => {
    client = createDbClient();
    prisma = client as unknown as PrismaService;
    TRAINING_GRAPH_READY.create = true;
    TRAINING_GRAPH_READY.evaluate = true;
    events = new RunEventsService(prisma);
    programs = new ProgramsService(prisma);

    const resolver = {
      resolveForRun: async () => ({
        roles: Object.fromEntries(TRAINING_AGENT_ROLES.map((role) => [role, READY])),
        settings: { training: { maxRunTokens: 400_000, maxCriticRounds: 2 } },
        limits: () => ({ contextWindow: HARNESS_FROZEN_MODEL.contextWindow, maxOutputTokens: HARNESS_FROZEN_MODEL.maxOutputTokens }),
      }),
    };
    runs = new TrainingRunsService(prisma, new JobsService(prisma), resolver as never, events, { screen: async () => ({ stop: false as const }) });
    scheduler = new TrainingEvaluationScheduler(prisma, { isEnabled: async () => aiEnabled } as never, resolver as never, runs);
    listener = new TrainingEvaluationListener(scheduler);

    const checkIns = new CheckInsService(prisma, new HealthProfileService(prisma));
    const gyms = new GymsService(prisma, {} as GymStorageService);
    const emitter = {
      emit: (event: string, payload: { userId: string; workoutId: string }) => {
        finishedEvents.push({ event, payload });
        pendingListeners.push(listener.onWorkoutFinished(payload));
        return true;
      },
    };
    workouts = new WorkoutsService(prisma, gyms, checkIns, new WorkoutHistoryService(prisma, checkIns), undefined, emitter as never);
    today = new TrainingTodayService(prisma, checkIns, new ExerciseAvailabilityService(prisma, gyms), workouts);
    loader = new EvaluationContextLoader(
      prisma,
      new TrainingSignalsService(prisma, checkIns, new SignalsLoader(prisma, new WorkoutHistoryService(prisma, checkIns))),
      programs,
      new PlannerContextLoader(prisma),
    );
  });

  afterAll(async () => {
    Object.assign(TRAINING_GRAPH_READY, savedReady);
    // Every job this suite caused, claimed or not (a follow-up evaluation can
    // be enqueued and never run): leftovers would look stuck to the reaper in
    // other real-Postgres suites.
    const runs = await client.trainingPlanRun.findMany({ where: { userId: { in: userIds } }, select: { id: true, jobIds: true } });
    const jobIds = runs
      .flatMap((r) => (Array.isArray(r.jobIds) ? r.jobIds : []))
      .filter((id): id is string => typeof id === 'string');
    await client.job.deleteMany({ where: { OR: [{ id: { in: jobIds } }, { subjectId: { in: runs.map((r) => r.id) } }] } });
    await client.trainingRunCheckpointWrite.deleteMany({ where: { threadId: { in: threads } } });
    await client.trainingRunCheckpoint.deleteMany({ where: { threadId: { in: threads } } });
    await client.workout.deleteMany({ where: { userId: { in: userIds } } });
    await client.program.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  afterEach(() => {
    aiEnabled = true;
  });

  // ---------------------------------------------------------------------------
  // Setup helpers
  // ---------------------------------------------------------------------------

  /** A user with four bodyweight exercises of their own (no gym needed). */
  async function userWithExercises(): Promise<{ userId: string; keys: Keys }> {
    const user = await client.user.create({ data: { email: `flow-${randomUUID().slice(0, 8)}-${tag}@example.com` } });
    userIds.push(user.id);
    const suffix = randomUUID().slice(0, 8);
    const keys: Keys = { squat: `flow_squat_${suffix}`, push: `flow_push_${suffix}`, row: `flow_row_${suffix}`, lunge: `flow_lunge_${suffix}` };
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

  /**
   * Eight weeks, three sessions a week, weeks 4 and 8 deloads. The first session
   * falls on today's weekday so today's planned session exists; the refs the
   * evaluator fixtures name (`W5-1-2` the push, `W5-1-3` the row) exist and are open.
   */
  function draftFor(keys: Keys): PlanDraft {
    const isoToday = new Date(`${todayStr}T00:00:00Z`).getUTCDay() || 7;
    const day = (offset: number) => ((isoToday - 1 + offset) % 7) + 1;
    const type = (key: string, isDeload: boolean): PlanDraft['blocks'][number]['weekTypes'][number] => {
      const sets = isDeload ? 2 : 3;
      return {
        key,
        isDeload,
        workouts: [
          draftWorkout('Full A', day(0), [draftExercise(keys.squat, { isPriority: true, sets }), draftExercise(keys.push, { sets }), draftExercise(keys.row, { sets })]),
          draftWorkout('Full B', day(2), [draftExercise(keys.lunge, { isPriority: true, sets }), draftExercise(keys.push, { sets }), draftExercise(keys.row, { sets })]),
          // Same push-then-row order as the other workouts: guardrails sort the week by
          // weekday, so whichever workout sorts first must carry the refs the evaluator
          // fixtures name (W5-1-2 the push, W5-1-3 the row).
          draftWorkout('Full C', day(4), [draftExercise(keys.squat, { isPriority: true, sets }), draftExercise(keys.push, { sets }), draftExercise(keys.row, { sets })]),
        ],
      };
    };
    return {
      title: 'Bodyweight base',
      summary: 'Three full-body sessions a week for eight weeks.',
      rationale: 'Frequency twice a week per muscle (E1) with a planned deload (E3).',
      totalWeeks: 8,
      daysPerWeek: 3,
      blocks: [
        {
          name: 'Base',
          focus: 'Consistency',
          rationale: 'Build the habit.',
          weekStart: 1,
          weekEnd: 8,
          weekSequence: ['A', 'A', 'A', 'D', 'A', 'A', 'A', 'D'],
          weekTypes: [type('A', false), type('D', true)],
        },
      ],
      assumptions: [],
      safetyNotes: [],
    };
  }

  /** One harness per "process": the scenario scripts over a fresh AI runtime, with the planner drafting `draft`. */
  function harness(userId: string, draft: PlanDraft | null, evaluatorScenario = 'evaluator-autonomous') {
    const scripts = scenarioScripts('happy');
    const evaluator = scenarioScripts(evaluatorScenario).evaluator;
    const planner = draft ? plannerScript([draft]) : scripts.planner;
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
          const role = String(req.metadata?.agent);
          const script = role === 'evaluator' ? evaluator : role === 'planner' ? planner : (scripts as Record<string, typeof evaluator>)[role];
          if (!script) throw new Error(`No script for ${role}`);
          return script(req, ctx);
        },
      },
    });
    h.addUserKey(userId, `sk-flow-db-${tag}`, [HARNESS_MODEL]);
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
      runs,
      { cancelPollMs: 50 },
      new PlannerContextLoader(prisma),
      new TrainingProgramsPort(programs, prisma),
      notifications as never,
      loader,
    );
  }

  const jobFor = (runId: string): Job =>
    ({ id: randomUUID(), type: TRAINING_RUN_JOB_TYPE, payload: { runId }, subjectType: 'training_run', subjectId: runId }) as unknown as Job;

  const runOf = (runId: string) => client.trainingPlanRun.findUniqueOrThrow({ where: { id: runId } });

  /** Create run -> draft -> activated a week ago, autonomy as given. */
  async function activePlan(autonomy: 'autonomous' | 'ask_first') {
    const { userId, keys } = await userWithExercises();
    const notified: string[] = [];
    const h = harness(userId, draftFor(keys));
    const started = await runs.create(userId, createRunBody({ gymId: null, durationWeeks: 8, autonomy }), 'user');
    threads.push(started.runId);
    await handler(h, notified).process(jobFor(started.runId));

    const created = await runOf(started.runId);
    expect(created).toMatchObject({ status: 'succeeded', errorCode: null });
    const result = created.result as { programId: string; versionNumber: number; changeLogId: string };
    expect(result.versionNumber).toBe(1);
    expect(await client.program.findUniqueOrThrow({ where: { id: result.programId } })).toMatchObject({ status: 'draft', autonomy, currentVersion: 1 });

    await programs.activate(userId, result.programId, start);
    return { userId, keys, programId: result.programId, notified };
  }

  /** Today's planned session started, one set logged, finished: emits `workout.finished` once. */
  async function finishTodaysWorkout(userId: string) {
    const view = await today.today(userId, todayStr);
    expect(view.kind).toBe('workout');
    const programWorkoutId = (view as { programWorkout: { id: string } }).programWorkout.id;
    const started = await today.start(userId, programWorkoutId, { date: todayStr });
    await client.setLog.updateMany({ where: { workoutExercise: { workoutId: started.workoutId } }, data: { completed: true, reps: 12, rpe: 7 } as never });
    await workouts.finish(userId, started.workoutId, {});
    await Promise.all(pendingListeners.splice(0));
    return started.workoutId;
  }

  const evaluateRuns = (userId: string) => client.trainingPlanRun.findMany({ where: { userId, kind: 'evaluate' }, orderBy: { createdAt: 'asc' } });

  /** The sets of the first exercise of the first workout's position-3 exercise (the row) per week. */
  async function rowSets(programId: string, key: string): Promise<Array<[number, number]>> {
    const rows = await client.programExercise.findMany({
      where: { exercise: { slug: key }, programWorkout: { position: 0, archivedAt: null, week: { programId, archivedAt: null } } },
      select: { targetSets: true, programWorkout: { select: { week: { select: { weekNumber: true } } } } },
    });
    return rows.map((r) => [r.programWorkout.week.weekNumber, r.targetSets] as [number, number]).sort((a, b) => a[0] - b[0]);
  }

  // ---------------------------------------------------------------------------
  // The flow
  // ---------------------------------------------------------------------------

  it('autonomous: create, activate, finish a workout, the evaluation runs, the change is banner-visible and one tap reverts it', async () => {
    const { userId, keys, programId, notified } = await activePlan('autonomous');
    expect(notified).toEqual(['training.plan_ready']);
    const unseenBefore = (await programs.list(userId)).find((p) => p.id === programId)!.unseenChangeCount;

    const workoutId = await finishTodaysWorkout(userId);

    // workout.finished was emitted exactly once, the listener queued ONE evaluate run.
    expect(finishedEvents.filter((e) => e.payload.workoutId === workoutId)).toEqual([{ event: WORKOUT_FINISHED_EVENT, payload: { userId, workoutId } }]);
    const queued = await evaluateRuns(userId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: 'evaluate', trigger: 'workout_finished', status: 'queued', programId });
    threads.push(queued[0].id);

    // The evaluate run applies the scenario's change: the row gains a set in weeks 5 and 6.
    const evaluator = harness(userId, null);
    const evalNotified: string[] = [];
    await handler(evaluator, evalNotified).process(jobFor(queued[0].id));

    const done = await runOf(queued[0].id);
    expect(done).toMatchObject({ status: 'succeeded', errorCode: null });
    const result = done.result as { versionNumber: number; changeLogId: string; verdict: string };
    expect(result).toMatchObject({ versionNumber: 2, verdict: 'applied' });
    expect(evaluator.fake.calls.map((c) => c.request?.metadata?.agent)).toEqual(['evaluator']);
    expect(evalNotified).toEqual(['training.plan_adapted']);
    expect(await client.programVersion.findUniqueOrThrow({ where: { programId_versionNumber: { programId, versionNumber: 2 } } })).toMatchObject({
      origin: 'ai_adapt',
      runId: queued[0].id,
    });
    const entry = await client.programChangeLog.findUniqueOrThrow({ where: { id: result.changeLogId } });
    expect(entry).toMatchObject({ kind: 'adapted', actor: 'ai', status: 'applied', fromVersion: 1, toVersion: 2, runId: queued[0].id });
    expect(entry.operations).toEqual(expect.arrayContaining([expect.objectContaining({ op: 'set_prescription', fingerprint: expect.any(String) })]));
    const week = (n: number) => (sets: Array<[number, number]>) => sets.find(([w]) => w === n)![1];
    const after = await rowSets(programId, keys.row);
    expect([5, 6, 7].map((n) => week(n)(after))).toEqual([4, 4, 3]);
    // Past weeks and the finished session are untouched.
    expect([1, 2, 3].map((n) => week(n)(after))).toEqual([3, 3, 3]);

    // Banner state: one more unseen AI change, cleared by marking it seen.
    const list = await programs.list(userId);
    expect(list.find((p) => p.id === programId)!.unseenChangeCount).toBe(unseenBefore + 1);
    await programs.markSeen(userId, programId, entry.id);
    expect((await programs.list(userId)).find((p) => p.id === programId)!.unseenChangeCount).toBe(0);

    // One tap: Undo restores the plan as version 3 and marks the entry reverted.
    const reverted = await programs.revert({ userId, programId, expectedVersion: 2, changeLogId: entry.id });
    expect(reverted.versionNumber).toBe(3);
    expect((await rowSets(programId, keys.row)).map(([, sets]) => sets.toString())).toEqual(['3', '3', '3', '2', '3', '3', '3', '2']);
    expect(await client.programChangeLog.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({ status: 'reverted' });

    // The undo is the next evaluation's memory: its operations suppress the same change.
    const sources = await loader.loadSources(userId, programId, new Date());
    const context = buildEvaluatorContext(sources!, { trigger: 'manual', deep: false, now: new Date() });
    expect(context.server.suppressedFingerprints).toEqual(expect.arrayContaining((entry.operations as Array<{ fingerprint: string }>).map((op) => op.fingerprint)));
    expect(context.sent.history.some((row) => row.feedback === 'undone')).toBe(true);
  });

  it('ask first: the run pauses with a proposal; after a restart the owner\'s approval applies the same proposal row', async () => {
    const { userId, keys, programId } = await activePlan('ask_first');
    await finishTodaysWorkout(userId);
    const [queued] = await evaluateRuns(userId);
    threads.push(queued.id);

    const notified: string[] = [];
    await handler(harness(userId, null), notified).process(jobFor(queued.id));

    expect(await runOf(queued.id)).toMatchObject({ status: 'awaiting_approval', expiresAt: expect.any(Date) });
    const proposal = await client.programChangeLog.findFirstOrThrow({ where: { runId: queued.id, kind: 'adapted' } });
    expect(proposal).toMatchObject({ status: 'proposed', fromVersion: 1, toVersion: null });
    expect((await client.program.findUniqueOrThrow({ where: { id: programId } })).currentVersion).toBe(1);
    expect(notified).toEqual(['training.plan_proposal']);
    expect(await client.trainingRunCheckpoint.count({ where: { threadId: queued.id } })).toBeGreaterThan(0);
    // A second automatic request while a proposal is pending schedules nothing.
    expect(await scheduler.requestEvaluation(userId, 'workout_finished')).toMatchObject({ status: expect.stringMatching(/deferred|skipped/) });
    expect(await evaluateRuns(userId)).toHaveLength(1);

    // The decision route's effect, then a NEW handler on a NEW runtime: nothing in memory survived.
    await runs.decide(userId, queued.id, { decision: 'approve' });
    const restarted = harness(userId, null);
    await handler(restarted, notified).process(jobFor(queued.id));

    expect(await runOf(queued.id)).toMatchObject({ status: 'succeeded' });
    expect(restarted.fake.calls).toHaveLength(0);
    expect(await client.programChangeLog.findUniqueOrThrow({ where: { id: proposal.id } })).toMatchObject({ status: 'applied', fromVersion: 1, toVersion: 2 });
    expect(await client.programChangeLog.count({ where: { programId, kind: 'adapted' } })).toBe(1);
    expect((await rowSets(programId, keys.row)).filter(([, sets]) => sets === 4).map(([w]) => w)).toEqual([5, 6]);
    expect(notified).toEqual(['training.plan_proposal', 'training.plan_adapted']);
  });

  it('ask first: rejecting after a restart records rejected and leaves the plan untouched', async () => {
    const { userId, programId } = await activePlan('ask_first');
    await finishTodaysWorkout(userId);
    const [queued] = await evaluateRuns(userId);
    threads.push(queued.id);
    await handler(harness(userId, null), []).process(jobFor(queued.id));

    await runs.decide(userId, queued.id, { decision: 'reject' });
    await handler(harness(userId, null), []).process(jobFor(queued.id));

    expect(await runOf(queued.id)).toMatchObject({ status: 'succeeded' });
    expect(await client.programChangeLog.findFirstOrThrow({ where: { runId: queued.id, kind: 'adapted' } })).toMatchObject({ status: 'rejected' });
    expect((await client.program.findUniqueOrThrow({ where: { id: programId } })).currentVersion).toBe(1);
  });

  it('AI off mid-flow: finishing a workout schedules nothing and the plan stays as it was', async () => {
    const { userId, programId } = await activePlan('autonomous');
    aiEnabled = false;

    await finishTodaysWorkout(userId);

    expect(await evaluateRuns(userId)).toHaveLength(0);
    expect(await client.job.count({ where: { type: TRAINING_RUN_JOB_TYPE, subjectId: { in: (await client.trainingPlanRun.findMany({ where: { userId, kind: 'evaluate' }, select: { id: true } })).map((r) => r.id) } } })).toBe(0);
    expect((await client.program.findUniqueOrThrow({ where: { id: programId } })).currentVersion).toBe(1);
  });

  it('the plan the flow builds is the one the fixtures name their refs against', async () => {
    const { keys, programId } = await activePlan('autonomous');

    expect(await rowSets(programId, keys.row)).toEqual([[1, 3], [2, 3], [3, 3], [4, 2], [5, 3], [6, 3], [7, 3], [8, 2]]);
    expect(toDbDate(start).getTime()).toBeLessThan(toDbDate(todayStr).getTime());
  });
});
