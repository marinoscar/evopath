// =============================================================================
// Unit tests for BroadcastFailureListener (issue #459, epic #319)
// =============================================================================
//
// Driven directly against `handleJobSettled`/`markFailed`, hand-built Prisma
// mock — the mocking style of `broadcasts.service.spec.ts` and
// `broadcast-chunk.handler.spec.ts`, not the real-`EventEmitter2` wiring
// `job-failure-notifier.spec.ts` uses. The claim under test here is what the
// LISTENER decides given an event ("which job types, which statuses, what does
// it write"), not whether `@OnEvent` is actually wired to `job.settled` — that
// end-to-end wiring, plus the real `JobTerminalService`/`BroadcastsService`
// interaction, is covered by the `describe('permanent failure and resume
// (#459)')` block added to `test/broadcasts/broadcast-fanout.db.spec.ts`.
// =============================================================================

import { Job } from '@prisma/client';

import { BroadcastFailureListener } from './broadcast-failure.listener';
import { JobSettledEvent } from '../../jobs/events/job-settled.event';
import { BROADCAST_SUBJECT_TYPE } from './broadcast-audience';
import { BROADCAST_CHUNK_TYPE } from './handlers/broadcast-chunk.handler';
import { BROADCAST_START_TYPE } from './handlers/broadcast-start.handler';
import type { PrismaService } from '../../prisma/prisma.service';

const BROADCAST_ID = 'bcast-1';

function failedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: BROADCAST_CHUNK_TYPE,
    subjectType: BROADCAST_SUBJECT_TYPE,
    subjectId: BROADCAST_ID,
    dedupKey: null,
    status: 'failed',
    reason: 'backfill',
    priority: 0,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 3,
    lastError: 'the provider refused the batch',
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    startedAt: new Date('2026-03-01T00:00:01.000Z'),
    finishedAt: new Date('2026-03-01T00:05:00.000Z'),
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    claimToken: null,
    executor: 'server',
    ...overrides,
  } as Job;
}

function makeListener(options: { updateManyCount?: number; updateManyImpl?: () => Promise<{ count: number }> } = {}) {
  const updateMany = jest.fn(async (_args: any) =>
    options.updateManyImpl ? options.updateManyImpl() : { count: options.updateManyCount ?? 1 },
  );

  const prisma = {
    notificationBroadcast: { updateMany },
  } as unknown as PrismaService;

  return { listener: new BroadcastFailureListener(prisma), updateMany };
}

/** Waits for any detached `.catch()` chain the listener scheduled to settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('BroadcastFailureListener', () => {
  // ---------------------------------------------------------------------------
  // The ignore cases — no write at all
  // ---------------------------------------------------------------------------

  describe('ignores', () => {
    it('a succeeded job', async () => {
      const { listener, updateMany } = makeListener();

      listener.handleJobSettled(new JobSettledEvent(failedJob({ status: 'succeeded' })));
      await flush();

      expect(updateMany).not.toHaveBeenCalled();
    });

    it('a failed job of an unrelated type', async () => {
      const { listener, updateMany } = makeListener();

      listener.handleJobSettled(
        new JobSettledEvent(failedJob({ type: 'example.checksum' })),
      );
      await flush();

      expect(updateMany).not.toHaveBeenCalled();
    });

    it('a failed job with no subjectId', async () => {
      const { listener, updateMany } = makeListener();

      listener.handleJobSettled(new JobSettledEvent(failedJob({ subjectId: null })));
      await flush();

      expect(updateMany).not.toHaveBeenCalled();
    });

    it('a failed job whose subjectType is not a broadcast', async () => {
      const { listener, updateMany } = makeListener();

      listener.handleJobSettled(
        new JobSettledEvent(failedJob({ subjectType: 'storage_object' })),
      );
      await flush();

      expect(updateMany).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Both fan-out types act
  // ---------------------------------------------------------------------------

  describe('acts on both fan-out job types', () => {
    it('a failed admin.broadcast.chunk job', async () => {
      const { listener, updateMany } = makeListener();

      listener.handleJobSettled(
        new JobSettledEvent(failedJob({ type: BROADCAST_CHUNK_TYPE })),
      );
      await flush();

      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(updateMany.mock.calls[0][0].data.lastError).toMatch(/^Chunk job job-1 failed/);
    });

    it('a failed admin.broadcast.start job', async () => {
      const { listener, updateMany } = makeListener();

      listener.handleJobSettled(
        new JobSettledEvent(failedJob({ type: BROADCAST_START_TYPE })),
      );
      await flush();

      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(updateMany.mock.calls[0][0].data.lastError).toMatch(/^Start job job-1 failed/);
    });
  });

  // ---------------------------------------------------------------------------
  // The write itself
  // ---------------------------------------------------------------------------

  describe('markFailed', () => {
    it('writes a compare-and-swap on sending, with the job id in the where', async () => {
      const { listener, updateMany } = makeListener();

      await listener.markFailed(BROADCAST_ID, failedJob());

      expect(updateMany).toHaveBeenCalledWith({
        where: { id: BROADCAST_ID, status: 'sending' },
        data: {
          status: 'failed',
          lastError: expect.stringContaining('job-1'),
          finishedAt: expect.any(Date),
        },
      });
    });

    it('quotes the job kind, id, attempts and error in lastError', async () => {
      const { listener, updateMany } = makeListener();

      await listener.markFailed(
        BROADCAST_ID,
        failedJob({ attempts: 3, lastError: 'the provider refused the batch' }),
      );

      expect(updateMany.mock.calls[0][0].data.lastError).toBe(
        'Chunk job job-1 failed permanently after 3 attempt(s): the provider refused the batch',
      );
    });

    it('substitutes "no error recorded" when the job carries no lastError', async () => {
      const { listener, updateMany } = makeListener();

      await listener.markFailed(BROADCAST_ID, failedJob({ lastError: null }));

      expect(updateMany.mock.calls[0][0].data.lastError).toContain('no error recorded');
    });

    it('truncates a job error past 500 characters', async () => {
      const { listener, updateMany } = makeListener();
      const longError = 'x'.repeat(600);

      await listener.markFailed(BROADCAST_ID, failedJob({ lastError: longError }));

      const written = updateMany.mock.calls[0][0].data.lastError as string;
      // The prefix plus the truncated, ellipsis-terminated cause.
      const cause = written.split(': ').slice(1).join(': ');
      expect(cause.length).toBe(500);
      expect(cause.endsWith('…')).toBe(true);
      expect(written).not.toContain(longError);
    });

    it('does not truncate an error at or under the 500-character cap', async () => {
      const { listener, updateMany } = makeListener();
      const exactError = 'y'.repeat(500);

      await listener.markFailed(BROADCAST_ID, failedJob({ lastError: exactError }));

      expect(updateMany.mock.calls[0][0].data.lastError).toContain(exactError);
    });

    it('uses the job’s own finishedAt when it has one', async () => {
      const { listener, updateMany } = makeListener();
      const finishedAt = new Date('2026-03-01T00:05:00.000Z');

      await listener.markFailed(BROADCAST_ID, failedJob({ finishedAt }));

      expect(updateMany.mock.calls[0][0].data.finishedAt).toBe(finishedAt);
    });

    it('falls back to "now" when the job carries no finishedAt', async () => {
      const { listener, updateMany } = makeListener();

      await listener.markFailed(BROADCAST_ID, failedJob({ finishedAt: null }));

      expect(updateMany.mock.calls[0][0].data.finishedAt).toBeInstanceOf(Date);
    });

    it('resolves true when the CAS matched a row', async () => {
      const { listener } = makeListener({ updateManyCount: 1 });

      await expect(listener.markFailed(BROADCAST_ID, failedJob())).resolves.toBe(true);
    });

    it('resolves false when the broadcast was not sending (already canceled/sent/failed, or gone)', async () => {
      const { listener } = makeListener({ updateManyCount: 0 });

      await expect(listener.markFailed(BROADCAST_ID, failedJob())).resolves.toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Containment — a throwing/rejecting write must not escape the handler
  // ---------------------------------------------------------------------------

  describe('containment', () => {
    it('handleJobSettled returns synchronously (undefined), never a promise', () => {
      const { listener } = makeListener();

      const result = listener.handleJobSettled(new JobSettledEvent(failedJob()));

      expect(result).toBeUndefined();
    });

    it('a rejecting updateMany is caught rather than becoming an unhandled rejection', async () => {
      const { listener, updateMany } = makeListener({
        updateManyImpl: async () => {
          throw new Error('database is down');
        },
      });

      expect(() =>
        listener.handleJobSettled(new JobSettledEvent(failedJob())),
      ).not.toThrow();

      await flush();

      expect(updateMany).toHaveBeenCalledTimes(1);
    });

    it('a synchronous throw while reading the event is caught, not propagated', () => {
      const { listener } = makeListener();
      // A malformed event whose `.job` getter throws — simulates a bug in an
      // accessor rather than in the listener's own logic.
      const brokenEvent = {
        get job(): never {
          throw new Error('accessor exploded');
        },
        get jobId() {
          return 'job-1';
        },
      } as unknown as JobSettledEvent;

      expect(() => listener.handleJobSettled(brokenEvent)).not.toThrow();
    });

    it('a failure marking one broadcast does not prevent the next call from succeeding', async () => {
      const { listener, updateMany } = makeListener();
      updateMany.mockRejectedValueOnce(new Error('database is down'));

      listener.handleJobSettled(new JobSettledEvent(failedJob({ id: 'job-1' })));
      await flush();

      listener.handleJobSettled(new JobSettledEvent(failedJob({ id: 'job-2' })));
      await flush();

      expect(updateMany).toHaveBeenCalledTimes(2);
    });
  });
});
