// =============================================================================
// Real-Postgres test: continuous evaluation scheduling (scheduler and sweep)
// =============================================================================
//
// What a mocked Prisma cannot prove:
//
//   - the `programs` evaluation-state CHECKs (pause reason value set, the
//     timestamp and reason set together) and the `missed_sessions` trigger;
//   - concurrent triggers create exactly ONE run (the active-run index decides
//     the race; the losers defer or are covered, never error);
//   - the coalescing flag and the follow-up rule end to end;
//   - the per-user limits counted from real rows (UTC day, spacing, manual
//     cooldown through `TrainingRunsService.create`);
//   - the sweep: expiry of unanswered proposals, due plans in the user's time
//     zone, paging and the per-pass user cap;
//   - `WorkoutsService.finish` emits `workout.finished` once, after commit.
//
// The sweep is given a Prisma whose program and run scans are scoped to this
// suite's users, so rows other suites left in the database cannot take its
// per-pass cap.
//
// THIS IS A `*.db.spec.ts` FILE: skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { ConflictException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { CheckInsService } from '../../src/check-ins/check-ins.service';
import { TRAINING_AGENT_ROLES } from '../../src/common/schemas/settings.schema';
import type { GymStorageService } from '../../src/gyms/gym-storage.service';
import { GymsService } from '../../src/gyms/gyms.service';
import { HealthProfileService } from '../../src/health-profile/health-profile.service';
import { JobsService } from '../../src/jobs/jobs.service';
import { ProgramsService } from '../../src/programs/programs.service';
import { SignalsLoader } from '../../src/programs/signals/signals.loader';
import { TrainingSignalsService } from '../../src/programs/signals/signals.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { EVALUATION_SWEEP } from '../../src/training-agents/evaluation/evaluation.constants';
import { PlannerContextLoader } from '../../src/training-agents/context/planner-context.loader';
import { EvaluationContextLoader } from '../../src/training-agents/evaluation/evaluation-context.loader';
import {
  APPROVAL_EXPIRED_CODE,
  TrainingEvaluationSweepHandler,
} from '../../src/training-agents/evaluation/handlers/training-evaluation-sweep.handler';
import { TrainingEvaluationScheduler } from '../../src/training-agents/evaluation/training-evaluation.scheduler';
import { TRAINING_GRAPH_READY } from '../../src/training-agents/graph/training-graphs';
import { RunEventsService } from '../../src/training-agents/runtime/run-events.service';
import { TrainingRunsService } from '../../src/training-agents/runtime/training-runs.service';
import { WORKOUT_FINISHED_EVENT } from '../../src/workouts/workout-events';
import { WorkoutHistoryService } from '../../src/workouts/workout-history.service';
import { WorkoutsService } from '../../src/workouts/workouts.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('training-evaluation.db.spec');

const READY = {
  state: 'ready',
  model: { provider: 'openai', modelId: 'fake-model', displayName: 'Fake', keySource: 'user' },
  effectiveEffort: 'high',
};

describeWithDb('continuous evaluation scheduling (real Postgres)', () => {
  let client: PrismaClient;
  let prisma: PrismaService;
  let runs: TrainingRunsService;
  let scheduler: TrainingEvaluationScheduler;
  let aiEnabled = true;
  const tag = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const savedReady = { ...TRAINING_GRAPH_READY };
  const savedSweep = { ...EVALUATION_SWEEP };

  async function makeUser(label: string, timeZone?: string): Promise<string> {
    const user = await client.user.create({ data: { email: `teval-${label}-${tag}@example.com` }, select: { id: true } });
    userIds.push(user.id);
    if (timeZone) await client.healthProfile.create({ data: { userId: user.id, timeZone } });
    return user.id;
  }

  async function makeProgram(userId: string, data: Record<string, unknown> = {}) {
    return client.program.create({
      data: {
        userId,
        name: 'Plan',
        goal: 'strength',
        status: 'active',
        startDate: new Date('2026-09-07T00:00:00.000Z'),
        ...data,
      } as never,
    });
  }

  const makeRun = (userId: string, data: Record<string, unknown> = {}) =>
    client.trainingPlanRun.create({
      data: { userId, kind: 'evaluate', trigger: 'workout_finished', status: 'succeeded', input: {}, tokenCap: 100_000, ...data } as never,
    });

  const evaluateRuns = (userId: string) =>
    client.trainingPlanRun.findMany({ where: { userId, kind: 'evaluate' }, orderBy: { createdAt: 'asc' } });

  /** A Prisma whose sweep scans (programs, awaiting runs) only see this suite's users. */
  function scopedPrisma(): PrismaService {
    const scope = (args: { where?: Record<string, unknown> } = {}) => ({
      ...args,
      where: { ...(args.where ?? {}), userId: { in: userIds } },
    });
    return new Proxy(client, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'program' || prop === 'trainingPlanRun') {
          return new Proxy(value as object, {
            get(model, method, r) {
              const fn = Reflect.get(model, method, r);
              if (method !== 'findMany' || typeof fn !== 'function') return fn;
              return (args: { where?: Record<string, unknown> }) => fn.call(model, scope(args));
            },
          });
        }
        return value;
      },
    }) as unknown as PrismaService;
  }

  beforeAll(() => {
    client = createDbClient();
    prisma = client as unknown as PrismaService;
    TRAINING_GRAPH_READY.evaluate = true;

    const resolver = {
      resolveForRun: async () => ({
        roles: Object.fromEntries(TRAINING_AGENT_ROLES.map((role) => [role, READY])),
        settings: { training: { maxRunTokens: 50_000, maxCriticRounds: 2 } },
        limits: () => ({}),
      }),
    };
    runs = new TrainingRunsService(prisma, new JobsService(prisma), resolver as never, new RunEventsService(prisma), {
      screen: async () => ({ stop: false as const }),
    });
    scheduler = new TrainingEvaluationScheduler(prisma, { isEnabled: async () => aiEnabled } as never, resolver as never, runs);
  });

  afterEach(() => {
    aiEnabled = true;
    Object.assign(EVALUATION_SWEEP, savedSweep);
  });

  afterAll(async () => {
    Object.assign(TRAINING_GRAPH_READY, savedReady);
    const jobIds = (await client.trainingPlanRun.findMany({ where: { userId: { in: userIds } }, select: { jobIds: true } }))
      .flatMap((r) => (Array.isArray(r.jobIds) ? r.jobIds : []))
      .filter((id): id is string => typeof id === 'string');
    await client.job.deleteMany({ where: { id: { in: jobIds } } });
    await client.workout.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  describe('schema', () => {
    it('accepts the three pause reasons, each with its timestamp', async () => {
      const u = await makeUser('pause-ok');
      for (const reason of ['safety_text', 'pain_pattern', 'user_paused']) {
        await expect(
          makeProgram(u, { status: 'paused', autonomyPausedAt: new Date(), autonomyPausedReason: reason }),
        ).resolves.toBeDefined();
      }
    });

    it('refuses an unknown pause reason, and a reason without its timestamp (or the reverse)', async () => {
      const u = await makeUser('pause-bad');
      await expect(
        makeProgram(u, { status: 'draft', autonomyPausedAt: new Date(), autonomyPausedReason: 'bored' }),
      ).rejects.toThrow(/programs_autonomy_paused_reason_chk|check constraint/i);
      await expect(makeProgram(u, { status: 'draft', autonomyPausedReason: 'user_paused' })).rejects.toThrow(
        /programs_autonomy_paused_pair_chk|check constraint/i,
      );
      await expect(makeProgram(u, { status: 'draft', autonomyPausedAt: new Date() })).rejects.toThrow(
        /programs_autonomy_paused_pair_chk|check constraint/i,
      );
    });

    it('accepts the missed_sessions run trigger', async () => {
      const u = await makeUser('trigger');
      await expect(makeRun(u, { trigger: 'missed_sessions' })).resolves.toBeDefined();
    });
  });

  describe('the scheduler', () => {
    it('two triggers racing create exactly one run; the loser defers (flag set), never errors', async () => {
      const u = await makeUser('race');
      const program = await makeProgram(u);

      const outcomes = await Promise.all([
        scheduler.requestEvaluation(u, 'workout_finished'),
        scheduler.requestEvaluation(u, 'workout_finished'),
        scheduler.requestEvaluation(u, 'workout_finished'),
      ]);

      expect(outcomes.filter((o) => o.status === 'created')).toHaveLength(1);
      expect(outcomes.every((o) => o.status === 'created' || o.status === 'deferred' || o.status === 'skipped')).toBe(true);
      const rows = await evaluateRuns(u);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'evaluate', trigger: 'workout_finished', status: 'queued', programId: program.id });
      expect(rows[0].jobId).not.toBeNull();
      expect(await client.program.findUniqueOrThrow({ where: { id: program.id } })).toMatchObject({
        lastEvaluatedAt: expect.any(Date),
      });
    });

    it('coalesces a burst and follows up exactly once when the run settles', async () => {
      const u = await makeUser('burst');
      const program = await makeProgram(u);

      const first = await scheduler.requestEvaluation(u, 'workout_finished');
      expect(first.status).toBe('created');
      const runId = (first as { runId: string }).runId;
      await client.trainingPlanRun.update({ where: { id: runId }, data: { status: 'running' } });

      for (let i = 0; i < 3; i += 1) {
        expect(await scheduler.requestEvaluation(u, 'workout_finished')).toEqual({ status: 'deferred', reason: 'active_run' });
      }
      const flagged = await client.program.findUniqueOrThrow({ where: { id: program.id } });
      expect(flagged.evaluationRequestedAt).not.toBeNull();

      await client.trainingPlanRun.update({ where: { id: runId }, data: { status: 'succeeded', completedAt: new Date() } });
      // Two settle notifications (e.g. a retry) still yield one follow-up.
      const followUps = await Promise.all([scheduler.onRunSettled(runId), scheduler.onRunSettled(runId)]);

      expect(followUps.filter((o) => o?.status === 'created')).toHaveLength(1);
      expect(await evaluateRuns(u)).toHaveLength(2);
      expect((await client.program.findUniqueOrThrow({ where: { id: program.id } })).evaluationRequestedAt).toBeNull();
    });

    it('counts the per-user limits from real rows: 3 automatic runs this UTC day defer the next', async () => {
      const u = await makeUser('cap');
      const program = await makeProgram(u);
      const now = new Date();
      for (const minutes of [180, 120, 60]) {
        await makeRun(u, { createdAt: new Date(now.getTime() - minutes * 60_000), programId: program.id });
      }
      const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const today = (await evaluateRuns(u)).filter((r) => r.createdAt >= utcMidnight).length;

      const outcome = await scheduler.requestEvaluation(u, 'workout_finished', { now });

      expect(outcome).toEqual(today >= 3 ? { status: 'deferred', reason: 'daily_cap' } : { status: 'created', runId: expect.any(String), programId: program.id });
    });

    it('schedules nothing with AI off or a paused plan', async () => {
      const u = await makeUser('off');
      await makeProgram(u);
      aiEnabled = false;
      expect(await scheduler.requestEvaluation(u, 'workout_finished')).toEqual({ status: 'skipped', reason: 'ai_disabled' });
      aiEnabled = true;

      const v = await makeUser('paused');
      await makeProgram(v, { autonomyPausedAt: new Date(), autonomyPausedReason: 'pain_pattern' });
      expect(await scheduler.requestEvaluation(v, 'workout_finished')).toEqual({ status: 'skipped', reason: 'automation_paused' });

      expect(await client.trainingPlanRun.count({ where: { userId: { in: [u, v] } } })).toBe(0);
    });

    it('"Re-evaluate now" answers 409 TRAINING_EVALUATION_COOLDOWN within 30 minutes, and defers automatic runs too', async () => {
      const u = await makeUser('manual');
      const program = await makeProgram(u);

      const started = await runs.create(u, { kind: 'evaluate', programId: program.id }, 'manual');
      await client.trainingPlanRun.update({ where: { id: started.runId }, data: { status: 'succeeded' } });

      const refused = await runs.create(u, { kind: 'evaluate' }, 'manual').catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ConflictException);
      expect((refused as ConflictException).getResponse()).toMatchObject({
        details: { reason: 'TRAINING_EVALUATION_COOLDOWN', retryAfterSeconds: expect.any(Number) },
      });
      expect(await scheduler.requestEvaluation(u, 'workout_finished')).toEqual({ status: 'deferred', reason: 'manual_cooldown' });
    });
  });

  describe('the sweep', () => {
    function sweepHandler(missedStreak = 0) {
      return new TrainingEvaluationSweepHandler(
        { register: () => undefined } as never,
        scopedPrisma(),
        { isEnabled: async () => aiEnabled } as never,
        scheduler,
        { forEvaluator: async () => ({ adherence: { missedStreak } }) } as never,
        new RunEventsService(prisma),
      );
    }

    it('expires an unanswered proposal: run cancelled, entry expired, the user free for a new run', async () => {
      const u = await makeUser('expire');
      const program = await makeProgram(u);
      const run = await makeRun(u, { status: 'awaiting_approval', expiresAt: new Date(Date.now() - 60_000), programId: program.id });
      const entry = await client.programChangeLog.create({
        data: { programId: program.id, userId: u, kind: 'adapted', actor: 'ai', status: 'proposed', fromVersion: 1, runId: run.id, summary: 'Proposal' },
      });

      const summary = await sweepHandler().sweep('job', new Date());

      expect(summary.expiredProposals).toBeGreaterThanOrEqual(1);
      expect(await client.trainingPlanRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: 'cancelled',
        errorCode: APPROVAL_EXPIRED_CODE,
      });
      expect(await client.programChangeLog.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({
        status: 'expired',
        decidedAt: expect.any(Date),
      });
      expect(await client.trainingRunEvent.findFirst({ where: { runId: run.id, type: 'run.cancelled' } })).not.toBeNull();
    });

    it('starts the due evaluations in the user\'s time zone, and nothing for plans with nothing due', async () => {
      // Sunday 2026-10-04 09:30 UTC: 18:30 in Tokyo (due), 09:30 in UTC (not yet).
      const now = new Date('2026-10-04T09:30:00.000Z');
      const tokyo = await makeUser('tokyo', 'Asia/Tokyo');
      const tokyoPlan = await makeProgram(tokyo, { lastEvaluatedAt: new Date('2026-10-01T00:00:00.000Z') });
      const utc = await makeUser('utc', 'UTC');
      await makeProgram(utc, {
        lastEvaluatedAt: new Date('2026-10-02T00:00:00.000Z'),
        lastWeeklyEvaluationAt: new Date('2026-09-27T18:05:00.000Z'),
      });
      const flagged = await makeUser('flagged');
      await makeProgram(flagged, {
        lastEvaluatedAt: new Date('2026-10-03T00:00:00.000Z'),
        lastWeeklyEvaluationAt: new Date('2026-09-27T18:05:00.000Z'),
        evaluationRequestedAt: new Date('2026-10-04T08:00:00.000Z'),
      });

      await sweepHandler().sweep('job', now);

      expect((await evaluateRuns(tokyo)).map((r) => r.trigger)).toEqual(['weekly']);
      expect(await client.program.findUniqueOrThrow({ where: { id: tokyoPlan.id } })).toMatchObject({
        lastWeeklyEvaluationAt: now,
        lastEvaluatedAt: now,
      });
      expect(await evaluateRuns(utc)).toHaveLength(0);
      expect((await evaluateRuns(flagged)).map((r) => r.trigger)).toEqual(['workout_finished']);
    });

    it('with AI off does nothing at all', async () => {
      const u = await makeUser('sweep-off');
      await makeProgram(u, { evaluationRequestedAt: new Date() });
      aiEnabled = false;

      const summary = await sweepHandler().sweep('job', new Date());

      expect(summary).toMatchObject({ aiEnabled: false, created: 0, scanned: 0 });
      expect(await evaluateRuns(u)).toHaveLength(0);
    });

    it('pages through every plan and serves at most the per-pass user cap, oldest-evaluated first', async () => {
      // Clear what earlier cases left due, so only this case's plans compete.
      await client.program.updateMany({ where: { userId: { in: userIds } }, data: { status: 'archived' } });
      Object.assign(EVALUATION_SWEEP, { pageSize: 2, maxUsers: 3 });
      const now = new Date();
      const users: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const u = await makeUser(`page-${i}`);
        users.push(u);
        await makeProgram(u, {
          evaluationRequestedAt: new Date(now.getTime() - 60_000),
          lastEvaluatedAt: new Date(now.getTime() - (10 - i) * 86_400_000),
          lastWeeklyEvaluationAt: now,
        });
      }

      const summary = await sweepHandler().sweep('job', now);

      expect(summary).toMatchObject({ due: 5, considered: 3, created: 3 });
      expect(summary.scanned).toBeGreaterThanOrEqual(5);
      const served = await Promise.all(users.map(async (u) => (await evaluateRuns(u)).length));
      // The three evaluated longest ago (users 0..2) are served; 3 and 4 wait for the next pass.
      expect(served).toEqual([1, 1, 1, 0, 0]);
    });
  });

  describe('the evaluation port and reviewed entries', () => {
    it('loads the sources, screens-only pain notes of the window, and writes one reviewed entry per run with the pause', async () => {
      const u = await makeUser('port', 'UTC');
      const exercise = await client.exercise.create({
        data: { slug: `teval-${tag}-squat`, name: 'Squat', primaryMuscles: ['quads'], movementPattern: 'squat' },
        select: { id: true },
      });
      const programs = new ProgramsService(prisma);
      const created = await programs.createWithTree({
        userId: u,
        header: { name: 'Plan', goal: 'strength', source: 'ai' },
        tree: {
          blocks: [
            {
              position: 0,
              name: 'Block',
              weeks: [
                {
                  weekNumber: 1,
                  workouts: [
                    {
                      position: 0,
                      weekday: 1,
                      name: 'Day',
                      exercises: [
                        { exerciseId: exercise.id, position: 0, targetSets: 3, repMin: 5, repMax: 8, restSeconds: 120 },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        origin: 'ai_create',
        actor: 'ai',
        summary: 'Created',
      });
      await client.program.update({ where: { id: created.programId }, data: { status: 'active', startDate: new Date('2026-09-07T00:00:00.000Z') } });
      const workout = await client.workout.create({
        data: { userId: u, name: 'Session', date: new Date('2026-09-20T00:00:00.000Z'), startedAt: new Date('2026-09-20T10:00:00.000Z') },
      });
      const we = await client.workoutExercise.create({ data: { workoutId: workout.id, exerciseId: exercise.id, position: 0 } });
      await client.setLog.create({ data: { workoutExerciseId: we.id, setNumber: 1, reps: 5, painFlag: true, painNote: 'sharp knee' } });
      await client.setLog.create({ data: { workoutExerciseId: we.id, setNumber: 2, reps: 5 } });

      const checkIns = new CheckInsService(prisma, new HealthProfileService(prisma));
      const loader = new EvaluationContextLoader(
        prisma,
        new TrainingSignalsService(prisma, checkIns, new SignalsLoader(prisma, new WorkoutHistoryService(prisma, checkIns))),
        programs,
        new PlannerContextLoader(prisma),
      );

      const sources = await loader.loadSources(u, created.programId, new Date('2026-09-24T12:00:00.000Z'));
      expect(sources).toMatchObject({
        program: { id: created.programId, startDate: '2026-09-07', currentVersion: 1, autonomyPausedReason: null },
        exercises: [{ id: exercise.id, key: `teval-${tag}-squat` }],
      });
      expect(sources!.changeLog.map((row) => row.kind)).toEqual(['created']);
      expect(await loader.loadSources(await makeUser('stranger'), created.programId, new Date())).toBeNull();

      expect(await loader.recentPainNotes(u, '2026-09-11', '2026-09-24')).toEqual(['sharp knee']);
      expect(await loader.recentPainNotes(u, '2026-09-21', '2026-09-24')).toEqual([]);

      const runId = randomUUID();
      const first = await loader.recordReview({
        userId: u,
        programId: created.programId,
        actor: 'system',
        summary: 'Paused',
        runId,
        pause: 'pain_pattern',
      });
      const second = await loader.recordReview({ userId: u, programId: created.programId, actor: 'system', summary: 'Again', pause: 'safety_text' });

      expect(first).toMatchObject({ versionNumber: 1, paused: true });
      expect(second.paused).toBe(false);
      expect(await client.program.findUniqueOrThrow({ where: { id: created.programId } })).toMatchObject({
        currentVersion: 1,
        autonomyPausedReason: 'pain_pattern',
        autonomyPausedAt: expect.any(Date),
      });
      expect(await client.programChangeLog.findUniqueOrThrow({ where: { id: first.changeLogId } })).toMatchObject({
        kind: 'reviewed',
        actor: 'system',
        status: 'applied',
        fromVersion: 1,
        toVersion: 1,
        runId,
      });
      expect(await loader.findRunReview(u, runId, 'system')).toEqual({ changeLogId: first.changeLogId });
      expect(await loader.findRunReview(u, runId, 'ai')).toBeNull();

      // A review is not a change: it cannot be undone and is not a version's entry.
      const refused = await programs
        .revert({ userId: u, programId: created.programId, expectedVersion: 1, changeLogId: first.changeLogId })
        .catch((e: unknown) => e);
      expect((refused as ConflictException).getResponse()).toMatchObject({ details: { reason: 'NOT_REVERTIBLE' } });
      expect((await programs.getVersion(u, created.programId, 1)).changeLogId).toBe(created.changeLogId);

      await client.workout.deleteMany({ where: { userId: u } });
      await client.program.deleteMany({ where: { userId: u } });
      await client.exercise.delete({ where: { id: exercise.id } });
    });
  });

  describe('workout.finished', () => {
    it('is emitted once, after the finish committed, and not for a repeated finish', async () => {
      const u = await makeUser('finish');
      const checkIns = new CheckInsService(prisma, new HealthProfileService(prisma));
      const emitted: Array<{ event: string; payload: unknown; status: string | undefined }> = [];
      const events = {
        emit: (event: string, payload: { workoutId: string }) => {
          // Record what a listener would read at dispatch time: the committed row.
          void client.workout
            .findUnique({ where: { id: payload.workoutId }, select: { status: true } })
            .then((row) => emitted.push({ event, payload, status: row?.status }));
          return true;
        },
      };
      const workouts = new WorkoutsService(
        prisma,
        new GymsService(prisma, {} as GymStorageService),
        checkIns,
        new WorkoutHistoryService(prisma, checkIns),
        undefined,
        events as never,
      );
      const workout = await client.workout.create({
        data: { userId: u, name: 'Session', date: new Date('2026-09-30T00:00:00.000Z'), startedAt: new Date(Date.now() - 3_600_000) },
      });

      await workouts.finish(u, workout.id, {});
      await workouts.finish(u, workout.id, {});
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(emitted).toEqual([
        { event: WORKOUT_FINISHED_EVENT, payload: { userId: u, workoutId: workout.id }, status: 'completed' },
      ]);
    });
  });
});
