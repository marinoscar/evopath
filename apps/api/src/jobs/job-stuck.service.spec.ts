// =============================================================================
// Unit tests for JobStuckService (issue #263, epic #254)
// =============================================================================
//
// THE SPLIT WITH `test/jobs/job-stuck-reset.db.spec.ts` IS DELIBERATE. That
// suite asks Postgres which rows the four recovery signals actually MATCH —
// a question a mock cannot answer, because a mocked `updateMany` returns
// whatever the test told it to regardless of the `where` it was handed. This
// suite covers what a real database makes awkward instead: the exact shape of
// that `where` (so a signal cannot be silently dropped in a refactor), the
// two-phase give-up/requeue split, the per-row failure message, and the
// settings fallbacks that only happen when a read throws.
// =============================================================================

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EventEmitter2 } from '@nestjs/event-emitter';

import { JOB_SETTLED_EVENT, JobSettledEvent } from './events/job-settled.event';
import { JobExecutionProfile, resetJobProfileWarnings } from './job-execution-profile';
import { JobHandler } from './job-handler.interface';
import { JobHandlerRegistry } from './job-handler.registry';
import { JobStuckService, stuckRunningWhere } from './job-stuck.service';
import { DEFAULT_SYSTEM_SETTINGS } from '../common/types/settings.types';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemSettingsService } from '../settings/system-settings/system-settings.service';

const THRESHOLD = new Date('2026-01-01T12:00:00.000Z');
const NOW = new Date('2026-01-01T12:30:00.000Z');

/** The fourth instant (#347): "no lease could legitimately point past here". */
const HORIZON = new Date('2026-01-01T12:45:00.000Z');

function makeService(overrides: {
  findMany?: jest.Mock;
  updateMany?: jest.Mock;
  /** Phase 1's per-row give-up write (#468). Defaults to "changed nothing". */
  updateManyAndReturn?: jest.Mock;
  config?: Record<string, unknown>;
  jobsPolicy?: jest.Mock;
  /**
   * Handlers to register before the sweep. EMPTY BY DEFAULT, which is the
   * shape every pre-#346 case assumes: nothing registered means no profile
   * anywhere, means one budget group, means the exact two queries this
   * service has always issued.
   */
  handlers?: JobHandler[];
}) {
  const findMany = overrides.findMany ?? jest.fn().mockResolvedValue([]);
  const updateMany = overrides.updateMany ?? jest.fn().mockResolvedValue({ count: 0 });

  const updateManyAndReturn = overrides.updateManyAndReturn ?? jest.fn().mockResolvedValue([]);

  const prisma = {
    job: { findMany, updateMany, updateManyAndReturn },
  } as unknown as PrismaService;

  const events = { emit: jest.fn() };

  const config = {
    get: jest.fn((key: string) => (overrides.config ?? { 'jobs.maxAttempts': 3 })[key]),
  } as unknown as ConfigService;

  const systemSettings = {
    getJobsPolicy:
      overrides.jobsPolicy ??
      jest.fn().mockResolvedValue({
        history: { retentionDays: 30, purgeEnabled: true },
        stuckThresholdMinutes: 30,
      }),
  } as unknown as SystemSettingsService;

  const registry = new JobHandlerRegistry();

  for (const handler of overrides.handlers ?? []) {
    registry.register(handler);
  }

  return {
    service: new JobStuckService(
      prisma,
      config,
      systemSettings,
      registry,
      events as unknown as EventEmitter2
    ),
    findMany,
    updateMany,
    updateManyAndReturn,
    events,
    systemSettings,
    registry,
  };
}

/**
 * A `updateManyAndReturn` mock whose every call "changed" the one row it was
 * aimed at, echoing that row back (#468).
 */
function givesUpEachRow(rows: Array<{ id: string; type: string; attempts: number }>): jest.Mock {
  return jest.fn(async ({ where }: { where: { id: string } }) =>
    rows.filter((row) => row.id === where.id).map((row) => ({ ...row, status: 'failed' }))
  );
}

/** A handler that exists only to carry (or not carry) a profile. */
function handler(type: string, profile?: JobExecutionProfile): JobHandler {
  return { type, profile, process: async () => undefined };
}

describe('stuckRunningWhere', () => {
  it('carries all four recovery signals, OR-ed, under status running', () => {
    const where = stuckRunningWhere(THRESHOLD, NOW, HORIZON);

    expect(where.status).toBe('running');
    expect(where.OR).toEqual([
      { leaseExpiresAt: null, startedAt: { lt: THRESHOLD } },
      { leaseExpiresAt: null, startedAt: null, createdAt: { lt: THRESHOLD } },
      { leaseExpiresAt: { lt: NOW } },
      { leaseExpiresAt: { gt: HORIZON } },
    ]);
  });

  it('ages the zombie signal by createdAt, since startedAt is null there', () => {
    // The signal that is easiest to lose in a refactor and impossible to
    // notice afterwards: `NULL < threshold` is NULL, never true, so a row
    // that is `running` with no `startedAt` is invisible to signal 1 and
    // (when the lease was never written either) to signal 3. Without this
    // arm it is stuck forever, holding its dedup key with it.
    const zombie = stuckRunningWhere(THRESHOLD, NOW, HORIZON).OR?.[1];

    expect(zombie).toEqual({
      leaseExpiresAt: null,
      startedAt: null,
      createdAt: { lt: THRESHOLD },
    });
  });

  it('never judges a LEASED row by its age (#347)', () => {
    // THE DEFECT #347 FIXED, asserted as a property of the shape rather than
    // as a literal: every age-based clause must also require the lease to be
    // absent. Without that, a job renewing its lease flawlessly was still
    // requeued the moment it passed the stuck threshold, a second executor
    // claimed it, and the same work ran twice — concurrently.
    const where = stuckRunningWhere(THRESHOLD, NOW, HORIZON);
    const ageClauses = (where.OR ?? []).filter(
      (clause) => 'startedAt' in clause || 'createdAt' in clause
    );

    expect(ageClauses).toHaveLength(2);

    for (const clause of ageClauses) {
      expect(clause).toMatchObject({ leaseExpiresAt: null });
    }
  });

  it('catches an implausibly distant lease, which no other signal can', () => {
    // Clause 4, and the reason narrowing clauses 1 and 2 did not open a gap.
    // A lease in the year 2400 is not expired (so signal 3 misses it) and is
    // not absent (so signals 1 and 2 miss it); without this arm such a row is
    // `running` forever and holds its dedup key with it.
    const where = stuckRunningWhere(THRESHOLD, NOW, HORIZON);

    expect(where.OR?.[3]).toEqual({ leaseExpiresAt: { gt: HORIZON } });
  });

  it('compares each signal against its own instant', () => {
    // Three different instants, deliberately: an expired lease is stuck NOW,
    // an aged unleased claim is stuck relative to the threshold, and an
    // implausible lease is stuck relative to the horizon. Collapsing any two
    // either reaps live jobs or delays a dead lease by a whole threshold.
    const where = stuckRunningWhere(THRESHOLD, NOW, HORIZON);

    expect(where.OR?.[0]).toEqual({ leaseExpiresAt: null, startedAt: { lt: THRESHOLD } });
    expect(where.OR?.[2]).toEqual({ leaseExpiresAt: { lt: NOW } });
    expect(where.OR?.[3]).toEqual({ leaseExpiresAt: { gt: HORIZON } });
  });
});

describe('JobStuckService.leaseHorizon', () => {
  it('is the deployment-wide lease plus a grace when nothing is registered', () => {
    // THE EMPTY-REGISTRY CASE IS THE DANGEROUS ONE: a `JOBS_WORKER_MODE=off`
    // control plane registers no handlers and must still reap for its fleet.
    // A horizon taken as the max over registered handlers alone would be one
    // grace period wide and reap every live row on the next sweep.
    const { service } = makeService({
      config: { 'jobs.maxAttempts': 3, 'jobs.jobTimeoutMs': 600_000 },
    });

    // lease = 600_000 + 60_000 grace; horizon = lease + 60_000 grace.
    expect(service.leaseHorizon(NOW).getTime()).toBe(NOW.getTime() + 720_000);
  });

  it('stretches to the LONGEST lease any registered handler could ask for', () => {
    const { service } = makeService({
      config: { 'jobs.maxAttempts': 3, 'jobs.jobTimeoutMs': 600_000 },
      handlers: [
        handler('fast.one', { maxRuntimeMs: 5_000, maxAttempts: 3 }),
        handler('slow.dump', { maxRuntimeMs: 6 * 3_600_000, maxAttempts: 1 }),
      ],
    });

    // The six-hour type decides it: 21_600_000 + 60_000 lease grace, then the
    // horizon's own 60_000. A shorter horizon would reap that type mid-run,
    // which is the exact failure #346 and #347 exist to remove.
    expect(service.leaseHorizon(NOW).getTime()).toBe(NOW.getTime() + 21_720_000);
  });

  it('never shrinks below the unprofiled lease, however short the profiles', () => {
    // A row may name a type this process does not register (a removed
    // handler, a fork's type, another deployment's), and such a row was
    // claimed on the deployment-wide lease. The floor keeps it plausible.
    const { service } = makeService({
      config: { 'jobs.maxAttempts': 3, 'jobs.jobTimeoutMs': 600_000 },
      handlers: [handler('fast.one', { maxRuntimeMs: 1_000, maxAttempts: 3 })],
    });

    expect(service.leaseHorizon(NOW).getTime()).toBe(NOW.getTime() + 720_000);
  });
});

describe('JobStuckService.getStuckThresholdMinutes', () => {
  it('reads the value through the narrow system-settings accessor', async () => {
    const jobsPolicy = jest.fn().mockResolvedValue({
      history: { retentionDays: 30, purgeEnabled: true },
      stuckThresholdMinutes: 45,
    });
    const { service } = makeService({ jobsPolicy });

    await expect(service.getStuckThresholdMinutes()).resolves.toBe(45);
    expect(jobsPolicy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the shipped default when the settings read throws', async () => {
    // A cron tick has no caller to report to, and a settings blip is not a
    // reason to stop reaping.
    const jobsPolicy = jest.fn().mockRejectedValue(new Error('database is having a moment'));
    const { service } = makeService({ jobsPolicy });

    await expect(service.getStuckThresholdMinutes()).resolves.toBe(
      DEFAULT_SYSTEM_SETTINGS.jobs.stuckThresholdMinutes
    );
  });

  it('falls back when the stored value is not a usable number', async () => {
    const jobsPolicy = jest.fn().mockResolvedValue({
      history: { retentionDays: 30, purgeEnabled: true },
      stuckThresholdMinutes: Number.NaN,
    });
    const { service } = makeService({ jobsPolicy });

    await expect(service.getStuckThresholdMinutes()).resolves.toBe(
      DEFAULT_SYSTEM_SETTINGS.jobs.stuckThresholdMinutes
    );
  });
});

describe('JobStuckService.resetStuck', () => {
  it('fails the rows at or over the attempt cap, one at a time, naming their own count', async () => {
    const stuck = [
      { id: 'job-a', type: 'example.echo', attempts: 3 },
      { id: 'job-b', type: 'example.echo', attempts: 7 },
    ];
    const findMany = jest.fn().mockResolvedValue(stuck);
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const updateManyAndReturn = givesUpEachRow(stuck);
    const { service } = makeService({ findMany, updateMany, updateManyAndReturn });

    const result = await service.resetStuck();

    // Two give-up updates plus the single requeue sweep.
    expect(updateManyAndReturn).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(2);

    const [first] = updateManyAndReturn.mock.calls[0] as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ];
    const [second] = updateManyAndReturn.mock.calls[1] as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ];

    expect(first.where).toMatchObject({ id: 'job-a', status: 'running' });
    expect(first.data).toMatchObject({
      status: 'failed',
      scheduledFor: null,
      claimedByNodeId: null,
      leaseExpiresAt: null,
    });

    // THE REASON THE PHASE IS ONE ROW AT A TIME: each message carries that
    // job's own attempt count, which a bulk update could not do.
    expect(String(first.data.lastError)).toContain('after 3 attempt(s)');
    expect(String(second.data.lastError)).toContain('after 7 attempt(s)');

    // `executor` is NOT cleared on the terminal row — which side the job died
    // on is exactly what you want to still know later.
    expect(first.data).not.toHaveProperty('executor');
  });

  it('requeues the rows still under budget with claim, lease and executor released', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 4 });
    const { service } = makeService({ updateMany });

    const result = await service.resetStuck();

    expect(result).toEqual({ reset: 4, failed: 0 });

    const [requeue] = updateMany.mock.calls[0] as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ];

    expect(requeue.where).toMatchObject({ status: 'running', attempts: { lt: 3 } });
    expect(requeue.data).toEqual({
      status: 'pending',
      claimedByNodeId: null,
      claimToken: null,
      leaseExpiresAt: null,
      executor: null,
      scheduledFor: null,
      finishedAt: null,
      lastError: expect.any(String),
    });
  });

  it('never touches attempts, in either phase', async () => {
    // The claim-time charge is the ONLY evidence a poison pill leaves behind
    // — the executor died before anything could count the failure — so the
    // reaper must not spend it, refund it, or reset it.
    const stuck = [{ id: 'job-a', type: 'example.echo', attempts: 3 }];
    const findMany = jest.fn().mockResolvedValue(stuck);
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const updateManyAndReturn = givesUpEachRow(stuck);
    const { service } = makeService({ findMany, updateMany, updateManyAndReturn });

    await service.resetStuck();

    expect(updateManyAndReturn).toHaveBeenCalledTimes(1);

    for (const call of [...updateManyAndReturn.mock.calls, ...updateMany.mock.calls]) {
      const [{ data }] = call as [{ data: Record<string, unknown> }];
      expect(data).not.toHaveProperty('attempts');
    }
  });

  it('splits the two phases on the configured attempt cap', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const { service } = makeService({
      findMany,
      updateMany,
      config: { 'jobs.maxAttempts': 5 },
    });

    await service.resetStuck();

    expect(findMany.mock.calls[0][0].where).toMatchObject({ attempts: { gte: 5 } });
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ attempts: { lt: 5 } });
  });

  it('degrades to the shipped attempt cap when the config key is missing', async () => {
    // A stub `ConfigService` returning `undefined` must not produce `NaN`,
    // which would make every comparison false and silently disable the
    // give-up phase.
    const findMany = jest.fn().mockResolvedValue([]);
    const { service } = makeService({ findMany, config: {} });

    await service.resetStuck();

    expect(findMany.mock.calls[0][0].where).toMatchObject({ attempts: { gte: 3 } });
  });

  it('honours an explicit olderThanMinutes instead of reading settings', async () => {
    const jobsPolicy = jest.fn();
    const findMany = jest.fn().mockResolvedValue([]);
    const { service } = makeService({ findMany, jobsPolicy });

    const before = Date.now();
    await service.resetStuck(10);
    const after = Date.now();

    expect(jobsPolicy).not.toHaveBeenCalled();

    const where = findMany.mock.calls[0][0].where as {
      OR: [{ startedAt: { lt: Date } }, unknown, unknown];
    };
    const threshold = where.OR[0].startedAt.lt.getTime();

    expect(threshold).toBeGreaterThanOrEqual(before - 10 * 60_000);
    expect(threshold).toBeLessThanOrEqual(after - 10 * 60_000);
  });

  it('judges every row in a sweep against the same pair of instants', async () => {
    const stuck = [{ id: 'job-a', type: 'example.echo', attempts: 9 }];
    const findMany = jest.fn().mockResolvedValue(stuck);
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const updateManyAndReturn = givesUpEachRow(stuck);
    const { service } = makeService({ findMany, updateMany, updateManyAndReturn });

    await service.resetStuck();

    const readWhere = findMany.mock.calls[0][0].where as { OR: unknown[] };
    const failWhere = (updateManyAndReturn.mock.calls[0][0] as { where: { OR: unknown[] } })
      .where;
    const requeueWhere = (updateMany.mock.calls[0][0] as { where: { OR: unknown[] } }).where;

    expect(failWhere.OR).toEqual(readWhere.OR);
    expect(requeueWhere.OR).toEqual(readWhere.OR);
  });

  // ===========================================================================
  // Per-type attempt budgets (#346)
  // ===========================================================================

  describe('per-type attempt budgets', () => {
    beforeEach(() => {
      resetJobProfileWarnings();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('issues exactly ONE requeue sweep, with no type filter, when nothing is profiled', async () => {
      // THE REGRESSION GUARD FOR EVERY DEPLOYMENT THAT DID NOT ASK FOR THIS.
      // The reaper's query shape is unchanged: one `updateMany`, the same
      // `attempts: { lt: 3 }`, and — crucially — no `type` clause at all, so
      // rows of a type this process does not register are still reaped.
      const updateMany = jest.fn().mockResolvedValue({ count: 2 });
      const { service } = makeService({ updateMany, handlers: [handler('plain.type')] });

      await expect(service.resetStuck()).resolves.toEqual({ reset: 2, failed: 0 });

      expect(updateMany).toHaveBeenCalledTimes(1);

      const [requeue] = updateMany.mock.calls[0] as [{ where: Record<string, unknown> }];

      expect(requeue.where).toMatchObject({ status: 'running', attempts: { lt: 3 } });
      expect(requeue.where).not.toHaveProperty('type');
    });

    it('NEVER REQUEUES a maxAttempts:1 job — the retry the profile forbids', async () => {
      // The bug this exists to prevent, stated as a test. `attempts` is
      // charged at claim time, so a one-attempt job whose executor died sits
      // at `attempts: 1`. Judged against the deployment-wide 3 the reaper
      // would decide it still had budget and requeue it — resurrecting the
      // automatic retry the profile forbids, on the one path nobody watches.
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      const { service } = makeService({
        updateMany,
        handlers: [handler('never.retry', { maxRuntimeMs: 30_000, maxAttempts: 1 })],
      });

      await service.resetStuck();

      // Nothing was over budget, so every `updateMany` here is a requeue
      // sweep: the fallback group first, then one per override.
      const sweeps = updateMany.mock.calls.map(
        ([call]) => (call as { where: Record<string, unknown> }).where
      );

      expect(sweeps).toHaveLength(2);

      // The profiled type is compared against ITS OWN budget...
      expect(sweeps[1]).toMatchObject({
        type: { in: ['never.retry'] },
        attempts: { lt: 1 },
      });

      // ...and the fallback sweep EXCLUDES it, so the deployment-wide 3
      // cannot pick it up through the other query instead. Without this
      // exclusion the whole thing is decorative: the row would be requeued
      // anyway, just by a different statement.
      expect(sweeps[0]).toMatchObject({
        type: { notIn: ['never.retry'] },
        attempts: { lt: 3 },
      });
    });

    it('FAILS a maxAttempts:1 job the reaper finds, naming its own budget', async () => {
      const stuck = [{ id: 'job-a', type: 'never.retry', attempts: 1 }];
      const findMany = jest.fn().mockResolvedValue(stuck);
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      const updateManyAndReturn = givesUpEachRow(stuck);
      const { service } = makeService({
        findMany,
        updateMany,
        updateManyAndReturn,
        handlers: [handler('never.retry', { maxRuntimeMs: 30_000, maxAttempts: 1 })],
      });

      const result = await service.resetStuck();

      expect(result.failed).toBe(1);

      const [failCall] = updateManyAndReturn.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];

      expect(failCall.data).toMatchObject({ status: 'failed' });
      // The quoted cap is THIS type's, not the deployment's 3.
      expect(String(failCall.data.lastError)).toContain('after 1 attempt(s)');
      expect(String(failCall.data.lastError)).toContain('(1)');
    });

    it('reads the give-up set as the union of every budget in play', async () => {
      // One query, not one per group: the read is where the two phases agree
      // about which rows are over budget, and it has to see all of them.
      const findMany = jest.fn().mockResolvedValue([]);
      const { service } = makeService({
        findMany,
        handlers: [
          handler('plain.type'),
          handler('never.retry', { maxRuntimeMs: 30_000, maxAttempts: 1 }),
          handler('stubborn.type', { maxRuntimeMs: 30_000, maxAttempts: 9 }),
        ],
      });

      await service.resetStuck();

      const where = findMany.mock.calls[0][0].where as {
        AND: [{ OR: Array<Record<string, unknown>> }];
      };

      // `AND`, not a second top-level `OR`: the three recovery signals and
      // the budget union must BOTH hold, not either.
      expect(where.AND[0].OR).toEqual(
        expect.arrayContaining([
          { type: { notIn: expect.arrayContaining(['never.retry', 'stubborn.type']) }, attempts: { gte: 3 } },
          { type: { in: ['never.retry'] }, attempts: { gte: 1 } },
          { type: { in: ['stubborn.type'] }, attempts: { gte: 9 } },
        ])
      );
    });

    it('groups types that share a budget into ONE sweep', async () => {
      // Bounded by the number of DISTINCT budgets, not by the number of types
      // and certainly not by the size of the stuck set.
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      const { service } = makeService({
        updateMany,
        handlers: [
          handler('a.once', { maxRuntimeMs: 1_000, maxAttempts: 1 }),
          handler('b.once', { maxRuntimeMs: 2_000, maxAttempts: 1 }),
          handler('c.plain'),
        ],
      });

      await service.resetStuck();

      // One fallback sweep plus one for the shared budget of 1.
      expect(updateMany).toHaveBeenCalledTimes(2);
    });

    it('treats a profile that restates the deployment default as no override', async () => {
      // Otherwise a handler could accidentally cost the whole process the
      // single-query fast path while changing nothing.
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      const { service } = makeService({
        updateMany,
        handlers: [handler('same.as.default', { maxRuntimeMs: 30_000, maxAttempts: 3 })],
      });

      await service.resetStuck();

      expect(updateMany).toHaveBeenCalledTimes(1);
      expect((updateMany.mock.calls[0][0] as { where: object }).where).not.toHaveProperty('type');
    });

    it('ignores an unusable profile and keeps the single-sweep shape', async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      const { service } = makeService({
        updateMany,
        handlers: [handler('bad.type', { maxRuntimeMs: 1_000, maxAttempts: 0 })],
      });

      await service.resetStuck();

      expect(updateMany).toHaveBeenCalledTimes(1);
      expect((updateMany.mock.calls[0][0] as { where: object }).where).not.toHaveProperty('type');
    });

    it('sums the requeue counts across every sweep', async () => {
      const updateMany = jest
        .fn()
        .mockResolvedValueOnce({ count: 5 })
        .mockResolvedValueOnce({ count: 2 });
      const { service } = makeService({
        updateMany,
        handlers: [handler('never.retry', { maxRuntimeMs: 1_000, maxAttempts: 1 })],
      });

      await expect(service.resetStuck()).resolves.toEqual({ reset: 7, failed: 0 });
    });
  });

  it('counts only the give-up updates that actually matched a row', async () => {
    // A job settled by an executor that turned out to be alive after all
    // fails the re-asserted `where`, so nothing is stamped over its terminal
    // row and nothing is counted.
    const findMany = jest
      .fn()
      .mockResolvedValue([{ id: 'job-a', type: 'example.echo', attempts: 3 }]);
    const updateMany = jest.fn().mockResolvedValueOnce({ count: 0 });
    // `UPDATE … RETURNING` changed nothing: the re-asserted `where` no longer
    // matched, so no row comes back (#468).
    const updateManyAndReturn = jest.fn().mockResolvedValueOnce([]);
    const { service } = makeService({ findMany, updateMany, updateManyAndReturn });

    await expect(service.resetStuck()).resolves.toEqual({ reset: 0, failed: 0 });
  });

  // ===========================================================================
  // The give-up is a settlement, so it is announced (#468)
  // ===========================================================================

  describe('JOB_SETTLED_EVENT on the phase-1 give-up', () => {
    beforeEach(() => {
      // `emitJobSettled` logs through the service's own `Logger` when a
      // listener throws; silence it here the same way the per-type budget
      // block above silences `warn`/`log`, so a deliberately-thrown listener
      // does not spam the test run.
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('emits once per row phase 1 actually changed, each carrying that exact row', async () => {
      const stuck = [
        { id: 'job-a', type: 'example.echo', attempts: 3 },
        { id: 'job-b', type: 'example.echo', attempts: 7 },
      ];
      const findMany = jest.fn().mockResolvedValue(stuck);
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      // Distinct object identities per row, so `event.job === row` is a
      // meaningful assertion rather than one two `{...spread}` copies would
      // pass by coincidence.
      const settledRows = stuck.map((row) => ({ ...row, status: 'failed' }));
      const updateManyAndReturn = jest.fn(async ({ where }: { where: { id: string } }) =>
        settledRows.filter((row) => row.id === where.id)
      );
      const { service, events } = makeService({ findMany, updateMany, updateManyAndReturn });

      const result = await service.resetStuck();

      expect(result.failed).toBe(2);
      expect(events.emit).toHaveBeenCalledTimes(2);

      expect(events.emit.mock.calls[0][0]).toBe(JOB_SETTLED_EVENT);
      expect(events.emit.mock.calls[1][0]).toBe(JOB_SETTLED_EVENT);

      const firstEvent = events.emit.mock.calls[0][1] as JobSettledEvent;
      const secondEvent = events.emit.mock.calls[1][1] as JobSettledEvent;

      expect(firstEvent).toBeInstanceOf(JobSettledEvent);
      // The exact row object `updateManyAndReturn` handed back — not a copy,
      // not a re-read — is what the event carries.
      expect(firstEvent.job).toBe(settledRows[0]);
      expect(secondEvent.job).toBe(settledRows[1]);
    });

    it('emits nothing when updateManyAndReturn returns no rows (lost the race)', async () => {
      const findMany = jest
        .fn()
        .mockResolvedValue([{ id: 'job-a', type: 'example.echo', attempts: 3 }]);
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      // A late executor (or a faster replica) settled the row first: the
      // re-asserted `where` no longer matches, so `UPDATE ... RETURNING`
      // changes and returns nothing.
      const updateManyAndReturn = jest.fn().mockResolvedValue([]);
      const { service, events } = makeService({ findMany, updateMany, updateManyAndReturn });

      const result = await service.resetStuck();

      expect(result).toEqual({ reset: 0, failed: 0 });
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('never emits on the phase-2 requeue — a requeue is not a settlement', async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 4 });
      const { service, events } = makeService({ updateMany });

      const result = await service.resetStuck();

      expect(result).toEqual({ reset: 4, failed: 0 });
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('contains a throwing listener: the rest of phase 1 and phase 2 still run', async () => {
      const stuck = [
        { id: 'job-a', type: 'example.echo', attempts: 3 },
        { id: 'job-b', type: 'example.echo', attempts: 7 },
      ];
      const findMany = jest.fn().mockResolvedValue(stuck);
      const updateMany = jest.fn().mockResolvedValue({ count: 4 });
      const updateManyAndReturn = givesUpEachRow(stuck);
      const { service, events } = makeService({ findMany, updateMany, updateManyAndReturn });

      events.emit.mockImplementation(() => {
        throw new Error('listener blew up');
      });

      // Neither row's give-up, nor the requeue sweep that follows, is
      // aborted by the throwing listener.
      await expect(service.resetStuck()).resolves.toEqual({ reset: 4, failed: 2 });

      expect(updateManyAndReturn).toHaveBeenCalledTimes(2);
      expect(updateMany).toHaveBeenCalledTimes(1);
      // The emit was still attempted for both rows, even though both threw.
      expect(events.emit).toHaveBeenCalledTimes(2);
    });
  });
});
