import { randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, NotFoundException, NotImplementedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { TRAINING_AGENT_ROLES } from '../../common/schemas/settings.schema';
import type { RoleResolution } from '../models/dto/role-resolution.dto';
import { TRAINING_GRAPH_READY } from '../graph/training-graphs';
import { InMemoryRunEventLog } from '../testing/in-memory-run-event-log';
import { createRunBody } from '../testing/intake-fixtures';
import { SAFETY_STOP_GUIDANCE } from '../guardrails/safety-keywords';
import { FreeTextSafetyScreen } from './safety-screen';
import { createInMemoryTrainingPrisma } from '../testing/in-memory-training-prisma';
import { TrainingRunsService, toTrainingRunView } from './training-runs.service';
import { ACTIVE_RUN_INDEX_NAME, isActiveRunConflict } from './training-runs.constants';

const USER = randomUUID();

const ready = (role: string): RoleResolution =>
  ({
    role,
    featureId: `training.${role}` as RoleResolution['featureId'],
    state: 'ready',
    source: 'admin_feature',
    model: { provider: 'openai', modelId: 'fake-model', displayName: 'Fake', keySource: 'user' },
    needs: [],
    inputModalities: [],
    requestedEffort: 'high',
    effectiveEffort: 'high',
    fix: null,
  }) as RoleResolution;

function setup(opts: { roles?: Partial<Record<string, RoleResolution>>; stop?: boolean } = {}) {
  const db = createInMemoryTrainingPrisma();
  const events = new InMemoryRunEventLog();
  const jobs = { enqueueWithin: jest.fn(async () => ({ id: randomUUID() })) };
  const resolver = {
    resolveForRun: jest.fn(async () => ({
      roles: { ...Object.fromEntries(TRAINING_AGENT_ROLES.map((r) => [r, ready(r)])), ...opts.roles },
      settings: { training: { maxRunTokens: 50_000, maxCriticRounds: 3 } },
      limits: () => ({ contextWindow: 128_000, maxOutputTokens: 16_384 }),
    })),
  };
  const safety = {
    screen: jest.fn(async () =>
      opts.stop ? { stop: true as const, guidance: 'Please contact a medical professional.' } : { stop: false as const },
    ),
  };
  const service = new TrainingRunsService(db.prisma as never, jobs as never, resolver as never, events as never, safety);

  return { db, events, jobs, resolver, safety, service };
}

describe('TrainingRunsService.create', () => {
  let restore: () => void;

  beforeEach(() => {
    const saved = { ...TRAINING_GRAPH_READY };
    restore = () => Object.assign(TRAINING_GRAPH_READY, saved);
  });
  afterEach(() => restore());

  it('answers 501 TRAINING_NOT_IMPLEMENTED while the kind\'s graph is not ready, before resolving roles', async () => {
    TRAINING_GRAPH_READY.evaluate = false;
    const t = setup();

    const error = await t.service.create(USER, { kind: 'evaluate', input: {} }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotImplementedException);
    expect((error as NotImplementedException).getResponse()).toMatchObject({
      details: { reason: 'TRAINING_NOT_IMPLEMENTED', graph: 'evaluate' },
    });
    expect(t.resolver.resolveForRun).not.toHaveBeenCalled();
    expect(t.jobs.enqueueWithin).not.toHaveBeenCalled();
  });

  it('freezes the kind\'s role models, the cap and the critic rounds, and creates the run and its job in one transaction', async () => {
    TRAINING_GRAPH_READY.create = true;
    const t = setup();
    const program = t.db.addProgram(USER, 4);

    const started = await t.service.create(USER, {
      kind: 'revise',
      programId: program.id,
      basedOnVersion: 4,
      instruction: 'USER-TEXT',
    });

    expect(started).toMatchObject({ status: 'queued' });
    const run = t.db.get(started.runId)!;
    expect(run).toMatchObject({
      userId: USER,
      kind: 'revise',
      trigger: 'user',
      status: 'queued',
      tokenCap: 50_000,
      programId: program.id,
      input: {
        request: { kind: 'revise', programId: program.id, basedOnVersion: 4, instruction: 'USER-TEXT' },
        maxCriticRounds: 3,
      },
      jobId: started.jobId,
      jobIds: [started.jobId],
    });
    expect(Object.keys(run.roleModels as object).sort()).toEqual(['critic', 'planner']);
    expect((run.roleModels as Record<string, unknown>).planner).toEqual({
      provider: 'openai',
      modelId: 'fake-model',
      effort: 'high',
      keySource: 'user',
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
    });
    expect(t.jobs.enqueueWithin).toHaveBeenCalledWith(t.db.prisma, {
      type: 'ai.training.plan.run',
      reason: 'upload',
      subjectType: 'training_run',
      subjectId: started.runId,
      payload: { runId: started.runId },
      skipDedup: true,
    });
    expect(t.events.types(started.runId)).toEqual(['run.queued']);
    expect(t.db.audits).toEqual([expect.objectContaining({ action: 'training_run:start', targetId: started.runId })]);
    // The published view never carries the request.
    expect(JSON.stringify(toTrainingRunView(run))).not.toContain('USER-TEXT');
  });

  it('409 TRAINING_ROLE_UNAVAILABLE names the role and its state', async () => {
    TRAINING_GRAPH_READY.evaluate = true;
    const t = setup({ roles: { evaluator: { ...ready('evaluator'), state: 'no_key', model: undefined } } });

    const error = await t.service.create(USER, { kind: 'evaluate', input: {} }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      details: { reason: 'TRAINING_ROLE_UNAVAILABLE', role: 'evaluator', state: 'no_key' },
    });
    expect(t.db.runs.size).toBe(0);
  });

  it('maps the active-run index violation to 409 TRAINING_RUN_ACTIVE with the existing run id', async () => {
    TRAINING_GRAPH_READY.create = true;
    const t = setup();
    const existing = t.db.add({ userId: USER, status: 'running' });
    t.db.prisma.$transaction.mockRejectedValueOnce(activeRunViolation());

    const error = await t.service.create(USER, createRunBody()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      details: { reason: 'TRAINING_RUN_ACTIVE', runId: existing.id },
    });
  });

  it('lets any other unique violation propagate', async () => {
    TRAINING_GRAPH_READY.create = true;
    const t = setup();
    const other = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'x',
      meta: { target: ['some_other_idx'] },
    });
    t.db.prisma.$transaction.mockRejectedValueOnce(other);

    await expect(t.service.create(USER, createRunBody())).rejects.toBe(other);
  });

  it('a safety stop records blocked_safety with no job, no provider path and no stored input', async () => {
    const t = setup({ stop: true });

    const started = await t.service.create(USER, createRunBody({ preferences: 'chest pain' }));

    expect(started).toEqual({
      runId: expect.any(String),
      jobId: null,
      status: 'blocked_safety',
      guidance: 'Please contact a medical professional.',
    });
    expect(t.db.get(started.runId)).toMatchObject({ status: 'blocked_safety', input: {}, errorCode: 'TRAINING_SAFETY_STOP' });
    expect(t.jobs.enqueueWithin).not.toHaveBeenCalled();
    expect(t.resolver.resolveForRun).not.toHaveBeenCalled();
  });
});

describe('TrainingRunsService.create: the request', () => {
  let restore: () => void;

  beforeEach(() => {
    const saved = { ...TRAINING_GRAPH_READY };
    restore = () => Object.assign(TRAINING_GRAPH_READY, saved);
    TRAINING_GRAPH_READY.create = true;
  });
  afterEach(() => restore());

  it('stores the validated create request (intake defaults applied) and no program', async () => {
    const t = setup();
    const gym = t.db.addGym(USER);

    const started = await t.service.create(USER, createRunBody({ gymId: gym.id }));

    const run = t.db.get(started.runId)!;
    expect(run.programId).toBeNull();
    expect((run.input as { request: { kind: string; intake: { gymId: string; autonomy: string } } }).request).toMatchObject({
      kind: 'create',
      intake: { gymId: gym.id, autonomy: 'autonomous' },
    });
  });

  it("404 when the intake's gym is not the caller's, and creates nothing", async () => {
    const t = setup();
    const other = t.db.addGym(randomUUID());

    const error = await t.service.create(USER, createRunBody({ gymId: other.id })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect(t.db.runs.size).toBe(0);
    expect(t.resolver.resolveForRun).not.toHaveBeenCalled();
  });

  it('revise: 404 for another user\'s program, 409 TRAINING_STALE_PLAN for a stale basedOnVersion; nothing is created', async () => {
    const t = setup();
    const theirs = t.db.addProgram(randomUUID(), 1);
    const mine = t.db.addProgram(USER, 3);
    const revise = (programId: string, basedOnVersion: number) =>
      t.service.create(USER, { kind: 'revise', programId, basedOnVersion, instruction: 'Fewer squats' }).catch((e: unknown) => e);

    expect(await revise(theirs.id, 1)).toBeInstanceOf(NotFoundException);

    const stale = await revise(mine.id, 2);
    expect(stale).toBeInstanceOf(ConflictException);
    expect((stale as ConflictException).getResponse()).toMatchObject({
      details: { reason: 'TRAINING_STALE_PLAN', currentVersion: 3 },
    });
    expect(t.db.runs.size).toBe(0);
    expect(t.jobs.enqueueWithin).not.toHaveBeenCalled();
  });

  it.each([
    ['create without an intake', { kind: 'create' }],
    ['create with a revise field', { ...createRunBody(), instruction: 'x' }],
    ['revise without basedOnVersion', { kind: 'revise', programId: randomUUID(), instruction: 'x' }],
    ['revise with an intake', { kind: 'revise', programId: randomUUID(), basedOnVersion: 1, instruction: 'x', intake: createRunBody().intake }],
    ['an instruction over 500 characters', { kind: 'revise', programId: randomUUID(), basedOnVersion: 1, instruction: 'x'.repeat(501) }],
    ['preferred weekdays fewer than days per week', { kind: 'create', intake: { ...createRunBody().intake, daysPerWeek: 4, preferredWeekdays: [1, 3] } }],
  ])('400 for %s', async (_label, body) => {
    const t = setup();
    const error = await t.service.create(USER, body as never).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(t.db.runs.size).toBe(0);
  });
});

describe('TrainingRunsService.create: the urgent-symptom screen (G0)', () => {
  it.each([
    ['the goal sentence', createRunBody({ goal: { type: 'general', description: 'Get fit despite chest pain and dizzy spells' } })],
    ['a limitation', createRunBody({ limitations: [{ area: 'other', description: 'chest pain and dizzy' }] })],
    ['the preferences', createRunBody({ preferences: 'I fainted last week' })],
    ['a revise instruction', { kind: 'revise' as const, programId: randomUUID(), basedOnVersion: 1, instruction: 'I cannot move my arm' }],
  ])('urgent text in %s: blocked_safety with the fixed guidance, no job, no resolver', async (_label, body) => {
    const db = createInMemoryTrainingPrisma();
    const jobs = { enqueueWithin: jest.fn() };
    const resolver = { resolveForRun: jest.fn() };
    const service = new TrainingRunsService(db.prisma as never, jobs as never, resolver as never, new InMemoryRunEventLog() as never, new FreeTextSafetyScreen());

    const started = await service.create(USER, body);

    expect(started).toEqual({ runId: expect.any(String), jobId: null, status: 'blocked_safety', guidance: SAFETY_STOP_GUIDANCE });
    expect(db.get(started.runId)).toMatchObject({ status: 'blocked_safety', input: {} });
    expect(jobs.enqueueWithin).not.toHaveBeenCalled();
    expect(resolver.resolveForRun).not.toHaveBeenCalled();
  });
});

describe('TrainingRunsService.create: G0 over the opt-in health summary (H8, #192)', () => {
  const summary = (narrative: string) => ({
    narrative,
    trainingConsiderations: [{ text: 'Keep it moderate.', severity: 'caution' as const, conservative: true }],
    dataAsOf: '2026-09-28',
  });

  function service(forTraining: jest.Mock) {
    const db = createInMemoryTrainingPrisma();
    const jobs = { enqueueWithin: jest.fn() };
    const resolver = { resolveForRun: jest.fn() };
    const screen = new FreeTextSafetyScreen({ forTraining } as never);
    return { db, jobs, resolver, service: new TrainingRunsService(db.prisma as never, jobs as never, resolver as never, new InMemoryRunEventLog() as never, screen) };
  }

  it.each([
    ['create', createRunBody()],
    ['revise', { kind: 'revise' as const, programId: randomUUID(), basedOnVersion: 1, instruction: 'Swap Friday for Saturday.' }],
  ])('%s: a summary naming an urgent symptom blocks the run with blocked_safety, no job and no provider call', async (_kind, body) => {
    const forTraining = jest.fn(async () => summary('Reports chest pain and fainting after hard sessions.'));
    const t = service(forTraining);

    const started = await t.service.create(USER, body);

    expect(forTraining).toHaveBeenCalledWith(USER);
    expect(started).toEqual({ runId: expect.any(String), jobId: null, status: 'blocked_safety', guidance: SAFETY_STOP_GUIDANCE });
    expect(t.db.get(started.runId)).toMatchObject({ status: 'blocked_safety', input: {} });
    expect(t.jobs.enqueueWithin).not.toHaveBeenCalled();
    expect(t.resolver.resolveForRun).not.toHaveBeenCalled();
  });

  it('an urgent symptom in a consideration blocks too, for an evaluate run as well', async () => {
    const forTraining = jest.fn(async () => ({ ...summary('Steady.'), trainingConsiderations: [{ text: 'Shortness of breath at rest was reported.', severity: 'caution' as const, conservative: true }] }));
    const screen = new FreeTextSafetyScreen({ forTraining } as never);

    expect(await screen.screen({ userId: USER, kind: 'evaluate', input: { trigger: 'weekly' } })).toEqual({
      stop: true,
      guidance: SAFETY_STOP_GUIDANCE,
    });
  });

  it('a calm summary, or none (consent off), lets the run through the screen', async () => {
    for (const value of [summary('Blood pressure above the usual range; clinician follow-up recommended.'), null]) {
      const screen = new FreeTextSafetyScreen({ forTraining: jest.fn(async () => value) } as never);
      expect(await screen.screen({ userId: USER, kind: 'create', input: { kind: 'create', intake: createRunBody().intake } })).toEqual({ stop: false });
    }
  });
});

describe('TrainingRunsService: cancel, resume, decide', () => {
  it('cancels a queued, paused or interrupted run at once; a running run only gets the request', async () => {
    const t = setup();

    for (const status of ['queued', 'awaiting_approval', 'interrupted'] as const) {
      const run = t.db.add({ userId: USER, status });
      const view = await t.service.cancel(USER, run.id);
      expect(view).toMatchObject({ status: 'cancelled', cancelRequested: true });
      expect(t.events.types(run.id)).toEqual(['run.cancelled']);
    }

    const running = t.db.add({ userId: USER, status: 'running' });
    expect(await t.service.cancel(USER, running.id)).toMatchObject({ status: 'running', cancelRequested: true });
    expect(t.events.types(running.id)).toEqual([]);
  });

  it('cancel is idempotent and owner-scoped', async () => {
    const t = setup();
    const done = t.db.add({ userId: USER, status: 'succeeded' });

    expect(await t.service.cancel(USER, done.id)).toMatchObject({ status: 'succeeded', cancelRequested: false });
    await expect(t.service.cancel(randomUUID(), done.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resumes only an interrupted run, at most three times', async () => {
    const t = setup();
    const run = t.db.add({ userId: USER, status: 'interrupted', resumeCount: 2 });

    expect(await t.service.resume(USER, run.id)).toMatchObject({ status: 'queued', resumeCount: 3 });
    expect(t.jobs.enqueueWithin).toHaveBeenCalledTimes(1);

    t.db.get(run.id)!.status = 'interrupted';
    const error = await t.service.resume(USER, run.id).catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({ details: { reason: 'TRAINING_RUN_NOT_RESUMABLE' } });

    const running = t.db.add({ userId: USER, status: 'running' });
    await expect(t.service.resume(USER, running.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('records a decision on a paused run and queues it; refuses one on any other status', async () => {
    const t = setup();
    const run = t.db.add({ userId: USER, status: 'awaiting_approval', expiresAt: new Date() });

    const view = await t.service.decide(USER, run.id, { decision: 'approve', note: 'NOTE' });

    expect(view).toMatchObject({ status: 'queued', pendingDecision: 'approve', expiresAt: null });
    expect(t.db.get(run.id)?.pendingDecision).toMatchObject({ decision: 'approve', note: 'NOTE' });
    expect(JSON.stringify(view)).not.toContain('NOTE');
    expect(t.db.audits.at(-1)).toMatchObject({ action: 'training_run:decision', meta: expect.objectContaining({ decision: 'approve' }) });
    expect(JSON.stringify(t.db.audits)).not.toContain('NOTE');

    const error = await t.service.decide(USER, run.id, { decision: 'reject' }).catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({
      details: { reason: 'TRAINING_RUN_NOT_AWAITING_DECISION', status: 'queued' },
    });
  });
});

describe('isActiveRunConflict', () => {
  it('matches the active-run index by name in either metadata shape, and nothing else', () => {
    expect(isActiveRunConflict(activeRunViolation())).toBe(true);
    expect(
      isActiveRunConflict(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x', meta: { target: ACTIVE_RUN_INDEX_NAME } }),
      ),
    ).toBe(true);
    expect(
      isActiveRunConflict(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x', meta: { target: ['user_id'] } }),
      ),
    ).toBe(false);
    expect(isActiveRunConflict(new Error(ACTIVE_RUN_INDEX_NAME))).toBe(false);
  });
});

function activeRunViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'x',
    meta: {
      driverAdapterError: {
        cause: {
          originalMessage: `duplicate key value violates unique constraint "${ACTIVE_RUN_INDEX_NAME}"`,
          constraint: { fields: ['user_id'] },
        },
      },
    },
  });
}
