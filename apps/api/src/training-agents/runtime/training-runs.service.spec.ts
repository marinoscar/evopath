import { randomUUID } from 'node:crypto';

import { ConflictException, NotFoundException, NotImplementedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { TRAINING_AGENT_ROLES } from '../../common/schemas/settings.schema';
import type { RoleResolution } from '../models/dto/role-resolution.dto';
import { TRAINING_GRAPH_READY } from '../graph/training-graphs';
import { InMemoryRunEventLog } from '../testing/in-memory-run-event-log';
import { createInMemoryTrainingPrisma } from '../testing/in-memory-training-prisma';
import { TrainingRunsService, toTrainingRunView } from './training-runs.service';
import { ACTIVE_RUN_INDEX_NAME, isActiveRunConflict } from './training-runs.constants';

const USER = randomUUID();

const ready = (role: string): RoleResolution =>
  ({
    role,
    state: 'ready',
    model: { provider: 'openai', modelId: 'fake-model', displayName: 'Fake', keySource: 'user' },
    needs: [],
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

  it('answers 501 TRAINING_NOT_IMPLEMENTED while the kind\'s graph is stubbed, before resolving roles', async () => {
    const t = setup();

    const error = await t.service.create(USER, { kind: 'create', input: {} }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotImplementedException);
    expect((error as NotImplementedException).getResponse()).toMatchObject({
      details: { reason: 'TRAINING_NOT_IMPLEMENTED', graph: 'create' },
    });
    expect(t.resolver.resolveForRun).not.toHaveBeenCalled();
    expect(t.jobs.enqueueWithin).not.toHaveBeenCalled();
  });

  it('freezes the kind\'s role models, the cap and the critic rounds, and creates the run and its job in one transaction', async () => {
    TRAINING_GRAPH_READY.create = true;
    const t = setup();

    const started = await t.service.create(USER, { kind: 'revise', input: { instruction: 'USER-TEXT' } });

    expect(started).toMatchObject({ status: 'queued' });
    const run = t.db.get(started.runId)!;
    expect(run).toMatchObject({
      userId: USER,
      kind: 'revise',
      trigger: 'user',
      status: 'queued',
      tokenCap: 50_000,
      input: { request: { instruction: 'USER-TEXT' }, maxCriticRounds: 3 },
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

    const error = await t.service.create(USER, { kind: 'create', input: {} }).catch((e: unknown) => e);

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

    await expect(t.service.create(USER, { kind: 'create', input: {} })).rejects.toBe(other);
  });

  it('a safety stop records blocked_safety with no job, no provider path and no stored input', async () => {
    const t = setup({ stop: true });

    const started = await t.service.create(USER, { kind: 'create', input: { note: 'chest pain' } });

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
