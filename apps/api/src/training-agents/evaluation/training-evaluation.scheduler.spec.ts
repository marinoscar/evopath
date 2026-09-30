import { randomUUID } from 'node:crypto';

import { ConflictException, NotImplementedException } from '@nestjs/common';

import { TRAINING_GRAPH_READY } from '../graph/training-graphs';
import { TrainingEvaluationScheduler } from './training-evaluation.scheduler';

// =============================================================================
// The scheduler over an in-memory store: gates, per-user limits, the
// coalescing flag and the follow-up rule. The real-Postgres suite
// (`test/training-agents/training-evaluation.db.spec.ts`) covers the
// active-run index deciding a race.
// =============================================================================

type Row = Record<string, unknown>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
      const op = expected as { in?: unknown[]; gte?: Date; gt?: Date; not?: unknown };
      if (op.in && !op.in.includes(actual)) return false;
      if (op.gte && !((actual as Date) >= op.gte)) return false;
      if (op.gt && !((actual as Date) > op.gt)) return false;
      if ('not' in op && actual === op.not) return false;
      return true;
    }
    return actual === expected;
  });
}

const NOW = new Date('2026-09-30T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const USER = randomUUID();

function setup(opts: { aiEnabled?: boolean; evaluatorUsable?: boolean; paused?: boolean; noProgram?: boolean } = {}) {
  const programs: Row[] = opts.noProgram
    ? []
    : [
        {
          id: randomUUID(),
          userId: USER,
          status: 'active',
          autonomyPausedAt: opts.paused ? minutesAgo(60) : null,
          evaluationRequestedAt: null,
          lastEvaluatedAt: null,
          lastWeeklyEvaluationAt: null,
        },
      ];
  const runs: Row[] = [];
  const proposals: Row[] = [];

  const prisma = {
    program: {
      findFirst: jest.fn(async ({ where }: { where: Row }) => programs.find((p) => matches(p, where)) ?? null),
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hit = programs.filter((p) => matches(p, where));
        for (const p of hit) Object.assign(p, data);
        return { count: hit.length };
      }),
    },
    trainingPlanRun: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => runs.find((r) => r.id === where.id) ?? null),
      findFirst: jest.fn(async ({ where }: { where: Row }) => {
        const hit = runs.filter((r) => matches(r, where));
        hit.sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime());
        return hit[0] ?? null;
      }),
      count: jest.fn(async ({ where }: { where: Row }) => runs.filter((r) => matches(r, where)).length),
    },
    programChangeLog: {
      count: jest.fn(async ({ where }: { where: Row }) => proposals.filter((r) => matches(r, where)).length),
    },
  };
  const aiConfig = { isEnabled: jest.fn(async () => opts.aiEnabled ?? true) };
  const resolver = {
    resolveForRun: jest.fn(async () => ({
      roles: {
        evaluator:
          opts.evaluatorUsable === false
            ? { role: 'evaluator', state: 'no_key' }
            : { role: 'evaluator', state: 'ready', model: { provider: 'openai', modelId: 'm', keySource: 'user' } },
      },
    })),
  };
  const create = jest.fn(async (userId: string, body: { programId: string }, trigger: string) => {
    if (runs.some((r) => r.userId === userId && ['queued', 'running', 'awaiting_approval'].includes(r.status as string))) {
      throw new ConflictException({ message: 'active', details: { reason: 'TRAINING_RUN_ACTIVE' } });
    }
    const run = { id: randomUUID(), userId, kind: 'evaluate', trigger, status: 'queued', programId: body.programId, createdAt: NOW };
    runs.push(run);
    return { runId: run.id, jobId: randomUUID(), status: 'queued' as const };
  });

  const scheduler = new TrainingEvaluationScheduler(
    prisma as never,
    aiConfig as never,
    resolver as never,
    { create } as never,
  );

  return {
    scheduler,
    prisma,
    programs,
    runs,
    proposals,
    create,
    resolver,
    program: programs[0],
    addRun: (row: Row) => {
      const run = { id: randomUUID(), userId: USER, kind: 'evaluate', status: 'succeeded', createdAt: NOW, ...row };
      runs.push(run);
      return run;
    },
  };
}

describe('TrainingEvaluationScheduler.requestEvaluation', () => {
  const saved = { ...TRAINING_GRAPH_READY };
  beforeEach(() => {
    TRAINING_GRAPH_READY.evaluate = true;
  });
  afterEach(() => Object.assign(TRAINING_GRAPH_READY, saved));

  it('creates one evaluate run with the trigger, and stamps lastEvaluatedAt', async () => {
    const t = setup();

    const outcome = await t.scheduler.requestEvaluation(USER, 'workout_finished', { now: NOW });

    expect(outcome).toMatchObject({ status: 'created', programId: t.program.id });
    expect(t.create).toHaveBeenCalledWith(
      USER,
      { kind: 'evaluate', programId: t.program.id, input: { trigger: 'workout_finished' } },
      'workout_finished',
    );
    expect(t.program).toMatchObject({ lastEvaluatedAt: NOW, evaluationRequestedAt: null, lastWeeklyEvaluationAt: null });
  });

  it('a weekly run stamps lastWeeklyEvaluationAt and carries deep', async () => {
    const t = setup();

    await t.scheduler.requestEvaluation(USER, 'weekly', { deep: true, now: NOW });

    expect(t.create.mock.calls[0][1]).toMatchObject({ input: { trigger: 'weekly', deep: true } });
    expect(t.program).toMatchObject({ lastEvaluatedAt: NOW, lastWeeklyEvaluationAt: NOW });
  });

  describe('schedules nothing, and forgets the request, when', () => {
    it.each<[string, Parameters<typeof setup>[0], string]>([
      ['AI is off', { aiEnabled: false }, 'ai_disabled'],
      ['the plan is paused', { paused: true }, 'automation_paused'],
      ['there is no active plan', { noProgram: true }, 'no_active_program'],
      ['the evaluator is blocked', { evaluatorUsable: false }, 'evaluator_unavailable'],
    ])('%s', async (_label, opts, reason) => {
      const t = setup(opts);

      const outcome = await t.scheduler.requestEvaluation(USER, 'workout_finished', { now: NOW });

      expect(outcome).toEqual({ status: 'skipped', reason });
      expect(t.create).not.toHaveBeenCalled();
      expect(t.programs.every((p) => p.evaluationRequestedAt === null)).toBe(true);
    });

    it('the evaluate graph is not shipped yet', async () => {
      TRAINING_GRAPH_READY.evaluate = false;
      const t = setup();

      expect(await t.scheduler.requestEvaluation(USER, 'workout_finished', { now: NOW })).toEqual({
        status: 'skipped',
        reason: 'graph_not_ready',
      });
      expect(t.create).not.toHaveBeenCalled();
    });

    it('a proposal waits for the user', async () => {
      const t = setup();
      t.proposals.push({ programId: t.program.id, status: 'proposed' });

      expect(await t.scheduler.requestEvaluation(USER, 'workout_finished', { now: NOW })).toEqual({
        status: 'skipped',
        reason: 'proposal_pending',
      });
    });

    it('a queued evaluate run already covers it', async () => {
      const t = setup();
      t.addRun({ status: 'queued', trigger: 'weekly' });

      expect(await t.scheduler.requestEvaluation(USER, 'workout_finished', { now: NOW })).toEqual({
        status: 'skipped',
        reason: 'covered_by_queued_run',
      });
      expect(t.program.evaluationRequestedAt).toBeNull();
    });
  });

  it('does not ask the evaluator resolution when a cheaper gate already fails', async () => {
    const t = setup({ paused: true });

    await t.scheduler.requestEvaluation(USER, 'workout_finished', { now: NOW });

    expect(t.resolver.resolveForRun).not.toHaveBeenCalled();
  });

  describe('per-user limits defer a finished workout (coalescing flag set)', () => {
    it.each<[string, (t: ReturnType<typeof setup>) => void, string]>([
      ['another run is active', (t) => t.addRun({ kind: 'create', status: 'running', trigger: 'user' }), 'active_run'],
      [
        '3 automatic runs this UTC day',
        (t) => {
          for (const m of [300, 200, 100]) t.addRun({ trigger: 'workout_finished', createdAt: minutesAgo(m) });
        },
        'daily_cap',
      ],
      ['an automatic run 10 minutes ago', (t) => t.addRun({ trigger: 'weekly', createdAt: minutesAgo(10) }), 'min_spacing'],
      ['a manual run 10 minutes ago', (t) => t.addRun({ trigger: 'manual', createdAt: minutesAgo(10) }), 'manual_cooldown'],
    ])('%s', async (_label, arrange, reason) => {
      const t = setup();
      arrange(t);

      const outcome = await t.scheduler.requestEvaluation(USER, 'workout_finished', { now: NOW });

      expect(outcome).toEqual({ status: 'deferred', reason });
      expect(t.create).not.toHaveBeenCalled();
      expect(t.program.evaluationRequestedAt).toEqual(NOW);
    });

    it('keeps the oldest pending request', async () => {
      const t = setup();
      t.addRun({ kind: 'create', status: 'running', trigger: 'user' });
      t.program.evaluationRequestedAt = minutesAgo(20);

      await t.scheduler.requestEvaluation(USER, 'workout_finished', { now: NOW });

      expect(t.program.evaluationRequestedAt).toEqual(minutesAgo(20));
    });

    it('does not flag a weekly or missed-sessions request (the sweep retries those)', async () => {
      const t = setup();
      t.addRun({ trigger: 'weekly', createdAt: minutesAgo(10) });

      expect(await t.scheduler.requestEvaluation(USER, 'weekly', { now: NOW })).toEqual({
        status: 'skipped',
        reason: 'min_spacing',
      });
      expect(t.program.evaluationRequestedAt).toBeNull();
    });

    it('counts yesterday\'s runs against yesterday, not today', async () => {
      const t = setup();
      for (const h of [13, 14, 15]) t.addRun({ trigger: 'workout_finished', createdAt: new Date(NOW.getTime() - h * 3_600_000) });

      expect((await t.scheduler.requestEvaluation(USER, 'workout_finished', { now: NOW })).status).toBe('created');
    });

    it('counts only automatic evaluate runs toward the cap', async () => {
      const t = setup();
      for (const m of [300, 200]) t.addRun({ trigger: 'workout_finished', createdAt: minutesAgo(m) });
      t.addRun({ trigger: 'manual', createdAt: minutesAgo(120) });
      t.addRun({ kind: 'create', trigger: 'user', createdAt: minutesAgo(90) });

      expect((await t.scheduler.requestEvaluation(USER, 'workout_finished', { now: NOW })).status).toBe('created');
    });
  });

  it('reads a lost race (409 TRAINING_RUN_ACTIVE) as "already running": deferred, never an error', async () => {
    const t = setup();
    t.create.mockRejectedValueOnce(new ConflictException({ details: { reason: 'TRAINING_RUN_ACTIVE' } }));

    expect(await t.scheduler.requestEvaluation(USER, 'workout_finished', { now: NOW })).toEqual({
      status: 'deferred',
      reason: 'active_run',
    });
    expect(t.program.evaluationRequestedAt).toEqual(NOW);
  });

  it('maps the create refusals it can meet to a skip, and rethrows anything else', async () => {
    const t = setup();
    t.create.mockRejectedValueOnce(new ConflictException({ details: { reason: 'TRAINING_ROLE_UNAVAILABLE' } }));
    expect(await t.scheduler.requestEvaluation(USER, 'workout_finished', { now: NOW })).toEqual({
      status: 'skipped',
      reason: 'evaluator_unavailable',
    });

    t.create.mockRejectedValueOnce(new NotImplementedException({ details: { reason: 'TRAINING_NOT_IMPLEMENTED' } }));
    expect(await t.scheduler.requestEvaluation(USER, 'workout_finished', { now: NOW })).toEqual({
      status: 'skipped',
      reason: 'graph_not_ready',
    });

    t.create.mockRejectedValueOnce(new Error('database down'));
    await expect(t.scheduler.requestEvaluation(USER, 'workout_finished', { now: NOW })).rejects.toThrow('database down');
  });
});

describe('the follow-up rule (onRunSettled)', () => {
  const saved = { ...TRAINING_GRAPH_READY };
  beforeEach(() => {
    TRAINING_GRAPH_READY.evaluate = true;
  });
  afterEach(() => Object.assign(TRAINING_GRAPH_READY, saved));

  it('does nothing when the plan carries no deferred request', async () => {
    const t = setup();
    const settled = t.addRun({ status: 'succeeded', createdAt: minutesAgo(5), trigger: 'workout_finished' });

    expect(await t.scheduler.onRunSettled(settled.id as string, NOW)).toBeNull();
    expect(t.create).not.toHaveBeenCalled();
  });

  it('coalesces a burst: three finished workouts during a run cost exactly one follow-up run', async () => {
    const t = setup();
    const running = t.addRun({ status: 'running', createdAt: minutesAgo(5), trigger: 'workout_finished' });

    for (let i = 0; i < 3; i += 1) {
      expect(await t.scheduler.requestEvaluation(USER, 'workout_finished', { now: NOW })).toMatchObject({ status: 'deferred' });
    }
    expect(t.program.evaluationRequestedAt).toEqual(NOW);

    running.status = 'succeeded';
    // The follow-up is exempt from the 30-minute spacing (the settled run is 5 minutes old).
    expect(await t.scheduler.onRunSettled(running.id as string, NOW)).toMatchObject({ status: 'created' });
    expect(t.program.evaluationRequestedAt).toBeNull();

    // The follow-up run settles in turn: nothing more is pending, so nothing more runs.
    const followUp = t.runs.at(-1)!;
    followUp.status = 'succeeded';
    expect(await t.scheduler.onRunSettled(followUp.id as string, NOW)).toBeNull();
    expect(t.create).toHaveBeenCalledTimes(1);
  });

  it('a follow-up that loses a race does not re-arm the flag (no chain of runs)', async () => {
    const t = setup();
    const settled = t.addRun({ status: 'succeeded', createdAt: minutesAgo(5) });
    t.program.evaluationRequestedAt = minutesAgo(3);
    t.create.mockImplementationOnce(async () => {
      // Another settle's follow-up won: it cleared the flag and holds the active run.
      t.program.evaluationRequestedAt = null;
      throw new ConflictException({ details: { reason: 'TRAINING_RUN_ACTIVE' } });
    });

    expect(await t.scheduler.onRunSettled(settled.id as string, NOW)).toEqual({ status: 'skipped', reason: 'active_run' });
    expect(t.program.evaluationRequestedAt).toBeNull();
  });

  it('keeps the flag when the follow-up is still blocked (another run active); the next settle or the sweep serves it', async () => {
    const t = setup();
    const settled = t.addRun({ status: 'succeeded', createdAt: minutesAgo(5) });
    t.addRun({ kind: 'create', status: 'queued', trigger: 'user', createdAt: minutesAgo(1) });
    t.program.evaluationRequestedAt = minutesAgo(3);

    expect(await t.scheduler.onRunSettled(settled.id as string, NOW)).toEqual({ status: 'deferred', reason: 'active_run' });
    expect(t.program.evaluationRequestedAt).toEqual(minutesAgo(3));
  });

  it('ignores a run that no longer exists', async () => {
    const t = setup();
    expect(await t.scheduler.onRunSettled(randomUUID(), NOW)).toBeNull();
  });
});
