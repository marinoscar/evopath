import { MEMORY_PURGE_JOB_TYPE } from '../memory-job-types';
import { MemoryExtractionScheduler } from '../extraction/memory-extraction.scheduler';
import { MemoryPurgeHandler } from './memory-purge.handler';
import { MemoryPurgeTask } from './memory-purge.task';

// =============================================================================
// memory.purge (#325) and the daily enqueue; the extraction enqueue
// =============================================================================

const NOW = new Date('2026-10-02T04:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('MemoryPurgeHandler', () => {
  function make(batches: Array<Array<{ id: string }>>) {
    const queue = [...batches];
    const prisma = {
      userMemory: {
        findMany: jest.fn(async () => queue.shift() ?? []),
        deleteMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => ({ count: where.id.in.length })),
      },
    };
    const systemSettings = { getMemoryPolicy: jest.fn(async () => ({ purgeAfterDays: 30 })) };
    const handler = new MemoryPurgeHandler({ register: jest.fn() } as never, prisma as never, systemSettings as never);
    return { handler, prisma };
  }

  it('is server-only (writes as it goes) with a declared profile', () => {
    const { handler } = make([]);
    expect(handler.type).toBe(MEMORY_PURGE_JOB_TYPE);
    expect((handler as any).nodeResultSchema).toBeUndefined();
    expect(handler.profile).toEqual({ maxRuntimeMs: 300_000, maxAttempts: 3 });
  });

  it('hard-deletes deleted (by deletedAt) and superseded (by updatedAt) rows past purgeAfterDays, in batches', async () => {
    const big = Array.from({ length: 1000 }, (_, i) => ({ id: `a${i}` }));
    const { handler, prisma } = make([big, [{ id: 'b1' }]]);

    expect(await handler.purge(NOW)).toBe(1001);
    const cutoff = new Date(NOW.getTime() - 30 * DAY);
    expect(prisma.userMemory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { status: 'deleted', deletedAt: { lt: cutoff } },
            { status: 'superseded', updatedAt: { lt: cutoff } },
          ],
        },
      }),
    );
    // The delete re-checks the status: an active row is never purged.
    for (const call of prisma.userMemory.deleteMany.mock.calls) {
      expect((call[0] as any).where.status).toEqual({ in: ['deleted', 'superseded'] });
    }
  });

  it('does nothing when nothing expired', async () => {
    const { handler, prisma } = make([]);
    expect(await handler.purge(NOW)).toBe(0);
    expect(prisma.userMemory.deleteMany).not.toHaveBeenCalled();
  });
});

describe('MemoryPurgeTask', () => {
  it('only enqueues the global housekeeping job', async () => {
    const jobs = { enqueue: jest.fn(async () => ({ id: 'job-1' })) };
    const prisma = { job: { findFirst: jest.fn(async () => null) } };
    await new MemoryPurgeTask(jobs as never, prisma as never).handleCron();

    expect(jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: MEMORY_PURGE_JOB_TYPE, priority: 100 }));
  });
});

describe('MemoryExtractionScheduler', () => {
  const USER = '11111111-1111-4111-8111-111111111111';

  it('queues one ai.memory.extract per user, five minutes out, deduplicated on the user subject', async () => {
    const jobs = { enqueue: jest.fn(async () => ({ id: 'job-1' })) };
    const memories = { gate: jest.fn(async () => ({ autoExtract: true })) };
    const queued = await new MemoryExtractionScheduler(jobs as never, memories as never).afterChatTurn(USER, NOW);

    expect(queued).toBe(true);
    expect(jobs.enqueue).toHaveBeenCalledWith({
      type: 'ai.memory.extract',
      reason: 'backfill',
      subjectType: 'user',
      subjectId: USER,
      payload: { userId: USER },
      scheduledFor: new Date(NOW.getTime() + 5 * 60_000),
    });
  });

  it('queues nothing while extraction is off, and never throws', async () => {
    const jobs = { enqueue: jest.fn(async () => ({ id: 'job-1' })) };
    const off = new MemoryExtractionScheduler(jobs as never, { gate: jest.fn(async () => ({ autoExtract: false })) } as never);
    expect(await off.afterChatTurn(USER, NOW)).toBe(false);
    expect(jobs.enqueue).not.toHaveBeenCalled();

    const failing = new MemoryExtractionScheduler(
      { enqueue: jest.fn(async () => Promise.reject(new Error('db'))) } as never,
      { gate: jest.fn(async () => ({ autoExtract: true })) } as never,
    );
    await expect(failing.afterChatTurn(USER, NOW)).resolves.toBe(false);
  });
});
