// =============================================================================
// Unit tests for the broadcast start handler (issue #323, epic #319)
// =============================================================================
//
// The thing under test is a RACE, so most of what follows is about the shape
// of one statement rather than about arithmetic. The compare-and-swap is what
// makes a fan-out happen exactly once, and its correctness lives entirely in
// the status being in the `WHERE` clause — a fact a mock CAN prove, because
// the assertion is on the query the handler builds, not on what Postgres does
// with it. What a mock cannot prove (that two concurrent swaps really do
// resolve to one winner) is a property of the database's row locking, not of
// this file.
//
// Mocking style follows `jobs/handlers/job-history-purge.handler.spec.ts`:
// hand-built jest mocks cast through `unknown`, no Nest testing module. The
// handler takes three collaborators and touches four query methods; standing
// up DI to reach them would test Nest.
// =============================================================================

import { Job } from '@prisma/client';

import { BroadcastStartHandler, BROADCAST_START_TYPE } from './broadcast-start.handler';
import type { JobHandler } from '../../../jobs/job-handler.interface';
import type { JobsService } from '../../../jobs/jobs.service';
import type { JobHandlerRegistry } from '../../../jobs/job-handler.registry';
import type { PrismaService } from '../../../prisma/prisma.service';
import { BROADCAST_SUBJECT_TYPE } from '../broadcast-audience';
import { BROADCAST_CHUNK_TYPE } from './broadcast-chunk.handler';

const BROADCAST_ID = 'bcast-1';

const startJob = {
  id: 'job-1',
  type: BROADCAST_START_TYPE,
  subjectType: BROADCAST_SUBJECT_TYPE,
  subjectId: BROADCAST_ID,
} as Job;

function makeHandler(options: {
  broadcast?: {
    id: string;
    status: string;
    audienceCutoff?: Date | null;
    cursorUserId?: string | null;
    recipientsDispatched?: number;
  } | null;
  claimedCount?: number;
  userCount?: number;
  existingChunk?: { id: string } | null;
} = {}) {
  const findUnique = jest.fn().mockResolvedValue(
    options.broadcast === undefined
      ? { id: BROADCAST_ID, status: 'scheduled' }
      : options.broadcast
  );
  // Serves both the claim CAS and the conditional `recipientsTargeted` write.
  const updateMany = jest.fn().mockResolvedValue({ count: options.claimedCount ?? 1 });
  const update = jest.fn().mockResolvedValue({});
  const count = jest.fn().mockResolvedValue(options.userCount ?? 42);
  const findFirst = jest.fn().mockResolvedValue(options.existingChunk ?? null);

  const prisma = {
    notificationBroadcast: { findUnique, updateMany, update },
    user: { count },
    job: { findFirst },
  } as unknown as PrismaService;

  const enqueue = jest.fn().mockResolvedValue({ id: 'job-2' });
  const jobs = { enqueue } as unknown as JobsService;

  const register = jest.fn();
  const registry = { register } as unknown as JobHandlerRegistry;

  return {
    handler: new BroadcastStartHandler(prisma, jobs, registry),
    findUnique,
    updateMany,
    update,
    count,
    findFirst,
    enqueue,
    register,
  };
}

describe('BroadcastStartHandler', () => {
  it('self-registers under a permanent, dotted type', () => {
    const { handler, register } = makeHandler();

    handler.onModuleInit();

    expect(register).toHaveBeenCalledWith(handler);
    expect(handler.type).toBe('admin.broadcast.start');
  });

  it('is server-only — it declares neither node-eligibility member', () => {
    // Both members or neither; exactly one collapses to server-only anyway.
    // A worker node has no database access and no mail credentials, so there
    // is nothing here for one to compute. Typed as the interface because the
    // members are optional on it — their absence is what
    // `JobHandlerRegistry.serverOnlyTypes()` reads.
    const handler: JobHandler = makeHandler().handler;

    expect(handler.nodeResultSchema).toBeUndefined();
    expect(handler.persistNodeResult).toBeUndefined();
  });

  // ===========================================================================
  // canDelete (#480) — delegates to broadcastJobDeleteRefusal
  // ===========================================================================

  describe('canDelete', () => {
    it('returns the shared guard\'s refusal reason for a scheduled broadcast', async () => {
      const { handler, findUnique } = makeHandler({
        broadcast: { id: BROADCAST_ID, status: 'scheduled' },
      });

      const result = await handler.canDelete(startJob);

      expect(findUnique).toHaveBeenCalledWith({
        where: { id: BROADCAST_ID },
        select: { id: true, status: true },
      });
      expect(result).toEqual(expect.stringContaining(BROADCAST_ID));
      expect(result).toEqual(expect.stringContaining('scheduled'));
    });

    it('returns the shared guard\'s refusal reason for a sending broadcast', async () => {
      const { handler } = makeHandler({
        broadcast: { id: BROADCAST_ID, status: 'sending' },
      });

      const result = await handler.canDelete(startJob);

      expect(result).toEqual(expect.stringContaining('sending'));
    });

    it('returns null for a terminal job even when the broadcast is still scheduled', async () => {
      const { handler } = makeHandler({
        broadcast: { id: BROADCAST_ID, status: 'scheduled' },
      });

      const result = await handler.canDelete({ ...startJob, status: 'succeeded' } as Job);

      expect(result).toBeNull();
    });

    it('returns null once the broadcast has been cancelled', async () => {
      const { handler } = makeHandler({
        broadcast: { id: BROADCAST_ID, status: 'canceled' },
      });

      const result = await handler.canDelete(startJob);

      expect(result).toBeNull();
    });
  });

  it('is a no-op when the job carries no subject', async () => {
    const { handler, findUnique } = makeHandler();

    await handler.process({ ...startJob, subjectId: null } as Job);

    expect(findUnique).not.toHaveBeenCalled();
  });

  it('is a no-op when the broadcast has been deleted', async () => {
    // Deleting a broadcast does NOT delete its scheduled `jobs` row — that
    // races with a claim. The row runs and finds nothing, which must return
    // normally rather than failing an attempt budget on a state the system
    // deliberately allows.
    const { handler, updateMany, count, enqueue } = makeHandler({ broadcast: null });

    await expect(handler.process(startJob)).resolves.toBeUndefined();

    expect(updateMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('claims with a compare-and-swap that puts the status in the WHERE', async () => {
    // THE CENTRAL ASSERTION OF THIS FILE. `status: 'scheduled'` in the `where`
    // is what makes the claim atomic against a concurrent cancel; a
    // read-then-write would leave a window in which a cancelled announcement
    // goes out to everybody.
    const { handler, updateMany } = makeHandler();

    await handler.process(startJob);

    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: BROADCAST_ID, status: 'scheduled' },
      data: {
        status: 'sending',
        startedAt: expect.any(Date),
        audienceCutoff: expect.any(Date),
      },
    });
  });

  it('stamps startedAt and audienceCutoff from a single instant', async () => {
    const { handler, updateMany } = makeHandler();

    await handler.process(startJob);

    const { data } = updateMany.mock.calls[0][0];

    expect(data.startedAt.getTime()).toBe(data.audienceCutoff.getTime());
  });

  it('counts the audience against the cutoff it just stamped', async () => {
    // The count and the chunk paging MUST use the same predicate — see
    // `broadcast-audience.ts`. Counting against a different one is what makes
    // a progress bar lie.
    const { handler, updateMany, count } = makeHandler({ userCount: 137 });

    await handler.process(startJob);

    const cutoff = updateMany.mock.calls[0][0].data.audienceCutoff;

    expect(count).toHaveBeenCalledWith({
      where: { isActive: true, createdAt: { lte: cutoff } },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: BROADCAST_ID, status: 'sending' },
      data: { recipientsTargeted: 137 },
    });
  });

  it('enqueues the first chunk with skipDedup, the broadcast subject and backfill', async () => {
    const { handler, enqueue } = makeHandler();

    await handler.process(startJob);

    expect(enqueue).toHaveBeenCalledWith({
      type: BROADCAST_CHUNK_TYPE,
      reason: 'backfill',
      subjectType: BROADCAST_SUBJECT_TYPE,
      subjectId: BROADCAST_ID,
      skipDedup: true,
    });
  });

  describe('when the compare-and-swap claims nothing', () => {
    // Every status other than `scheduled` lands here: a cancel that won the
    // race, a fan-out already in progress, a broadcast that has finished, and
    // — the case an operator can actually cause — a manual rerun of a
    // succeeded start job from the admin Jobs dashboard.
    it('re-stamps nothing, counts nothing and enqueues nothing', async () => {
      const { handler, count, update, enqueue } = makeHandler({
        // A fan-out already under way (#469: a `sending` broadcast with no
        // cursor, no dispatches and no chunk job would be resumed instead).
        broadcast: { id: BROADCAST_ID, status: 'sending', cursorUserId: 'user-9' },
        claimedCount: 0,
      });

      await expect(handler.process(startJob)).resolves.toBeUndefined();

      // The point of the CAS: a replay cannot move `audienceCutoff`, which is
      // the definition of who the broadcast was for, and cannot start a second
      // chunk chain over a population the first chain is already walking.
      expect(count).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('sends nothing for a broadcast an admin cancelled before it fired', async () => {
      const { handler, enqueue } = makeHandler({
        broadcast: { id: BROADCAST_ID, status: 'canceled' },
        claimedCount: 0,
      });

      await handler.process(startJob);

      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  it('throws to fail rather than swallowing a database error', async () => {
    // The queue turns a rejection into `Job.lastError` plus a retry. A
    // `try/catch` here would report `succeeded` for a broadcast that never
    // started, which is the failure mode that leaves no evidence anywhere.
    const { handler, updateMany } = makeHandler();

    updateMany.mockRejectedValue(new Error('connection terminated'));

    await expect(handler.process(startJob)).rejects.toThrow('connection terminated');
  });

  it('throws when the first chunk cannot be queued', async () => {
    // A claimed broadcast with no chunk chain is a broadcast stuck in
    // `sending` forever. It must be a visible, retryable failure.
    const { handler, enqueue } = makeHandler();

    enqueue.mockRejectedValue(new Error('queue unavailable'));

    await expect(handler.process(startJob)).rejects.toThrow('queue unavailable');
  });

  describe('resuming a hand-off an earlier attempt claimed (#469)', () => {
    it('routes a sending broadcast to the resume path instead of the CAS', async () => {
      const { handler, updateMany, findFirst } = makeHandler({
        broadcast: {
          id: BROADCAST_ID,
          status: 'sending',
          audienceCutoff: new Date('2026-01-01T00:00:00.000Z'),
          cursorUserId: null,
          recipientsDispatched: 0,
        },
      });

      await handler.process(startJob);

      // The CAS is the claim statement; a `sending` row never reaches it —
      // resumeHandOff's own guards decide everything from here.
      expect(updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: BROADCAST_ID, status: 'scheduled' } })
      );
      expect(findFirst).toHaveBeenCalled();
    });

    it(
      'resumes with the STORED cutoff, writes recipientsTargeted conditionally, and enqueues ' +
        'exactly one chunk identically to the fresh path',
      async () => {
        const storedCutoff = new Date('2026-01-01T00:00:00.000Z');
        const { handler, updateMany, count, findFirst, enqueue } = makeHandler({
          broadcast: {
            id: BROADCAST_ID,
            status: 'sending',
            audienceCutoff: storedCutoff,
            cursorUserId: null,
            recipientsDispatched: 0,
          },
          userCount: 99,
        });

        await handler.process(startJob);

        // Counted against the STORED cutoff, not a freshly-minted `now`.
        expect(count).toHaveBeenCalledWith({
          where: { isActive: true, createdAt: { lte: storedCutoff } },
        });

        // The conditional write, same shape the fresh path uses.
        expect(updateMany).toHaveBeenCalledWith({
          where: { id: BROADCAST_ID, status: 'sending' },
          data: { recipientsTargeted: 99 },
        });
        // Only ONE `updateMany` call total — the resume path never runs the
        // claim CAS at all.
        expect(updateMany).toHaveBeenCalledTimes(1);

        // Exactly one chunk enqueued, identical args to the fresh path.
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue).toHaveBeenCalledWith({
          type: BROADCAST_CHUNK_TYPE,
          reason: 'backfill',
          subjectType: BROADCAST_SUBJECT_TYPE,
          subjectId: BROADCAST_ID,
          skipDedup: true,
        });

        // Never touches startedAt/audienceCutoff/status via `update` (only
        // the conditional `updateMany` above), and the chunk lookup ran.
        expect(findFirst).toHaveBeenCalledWith({
          where: {
            type: BROADCAST_CHUNK_TYPE,
            subjectType: BROADCAST_SUBJECT_TYPE,
            subjectId: BROADCAST_ID,
          },
          select: { id: true },
        });
      }
    );

    it('is a no-op with no count, write or enqueue when audienceCutoff is null', async () => {
      const { handler, count, updateMany, findFirst, enqueue } = makeHandler({
        broadcast: {
          id: BROADCAST_ID,
          status: 'sending',
          audienceCutoff: null,
          cursorUserId: null,
          recipientsDispatched: 0,
        },
      });

      await handler.process(startJob);

      expect(count).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
      expect(findFirst).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('is a no-op when cursorUserId is already non-null (fan-out in progress)', async () => {
      const { handler, count, updateMany, findFirst, enqueue } = makeHandler({
        broadcast: {
          id: BROADCAST_ID,
          status: 'sending',
          audienceCutoff: new Date(),
          cursorUserId: 'user-9',
          recipientsDispatched: 0,
        },
      });

      await handler.process(startJob);

      expect(count).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
      expect(findFirst).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('is a no-op when recipientsDispatched is already > 0', async () => {
      const { handler, count, updateMany, findFirst, enqueue } = makeHandler({
        broadcast: {
          id: BROADCAST_ID,
          status: 'sending',
          audienceCutoff: new Date(),
          cursorUserId: null,
          recipientsDispatched: 5,
        },
      });

      await handler.process(startJob);

      expect(count).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
      expect(findFirst).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it(
      'is a no-op with no count or write, but still performs the exact lookup with no status ' +
        'filter, when a chunk job already exists',
      async () => {
        const { handler, count, updateMany, findFirst, enqueue } = makeHandler({
          broadcast: {
            id: BROADCAST_ID,
            status: 'sending',
            audienceCutoff: new Date(),
            cursorUserId: null,
            recipientsDispatched: 0,
          },
          existingChunk: { id: 'chunk-job-7' },
        });

        await handler.process(startJob);

        expect(findFirst).toHaveBeenCalledWith({
          where: {
            type: BROADCAST_CHUNK_TYPE,
            subjectType: BROADCAST_SUBJECT_TYPE,
            subjectId: BROADCAST_ID,
          },
          select: { id: true },
        });
        // No status filter anywhere in that where clause — "any status" per
        // the handler's own contract.
        const where = findFirst.mock.calls[0][0].where;
        expect(where).not.toHaveProperty('status');

        expect(count).not.toHaveBeenCalled();
        expect(updateMany).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
      }
    );

    it('resolves without enqueuing when the conditional write matches nothing (a cancel won)', async () => {
      const { handler, updateMany, enqueue } = makeHandler({
        broadcast: {
          id: BROADCAST_ID,
          status: 'sending',
          audienceCutoff: new Date(),
          cursorUserId: null,
          recipientsDispatched: 0,
        },
        claimedCount: 0,
      });

      await expect(handler.process(startJob)).resolves.toBeUndefined();

      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('resolves without enqueuing on the FRESH path too, when the conditional write matches nothing', async () => {
      // A cancel landing between the claim CAS (count 1) and the
      // recipientsTargeted write (count 0) — the fresh path's own version of
      // the same race the resume path guards against above.
      const { handler, updateMany, enqueue } = makeHandler();

      // First updateMany (the claim) succeeds with count 1; the second
      // (recipientsTargeted) must report count 0.
      updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      await expect(handler.process(startJob)).resolves.toBeUndefined();

      expect(updateMany).toHaveBeenCalledTimes(2);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('rejects when findFirst (the chunk lookup) fails in the resume path', async () => {
      const { handler, findFirst } = makeHandler({
        broadcast: {
          id: BROADCAST_ID,
          status: 'sending',
          audienceCutoff: new Date(),
          cursorUserId: null,
          recipientsDispatched: 0,
        },
      });
      findFirst.mockRejectedValue(new Error('connection terminated'));

      await expect(handler.process(startJob)).rejects.toThrow('connection terminated');
    });

    it('rejects when the audience count fails in the resume path', async () => {
      const { handler, count } = makeHandler({
        broadcast: {
          id: BROADCAST_ID,
          status: 'sending',
          audienceCutoff: new Date(),
          cursorUserId: null,
          recipientsDispatched: 0,
        },
      });
      count.mockRejectedValue(new Error('connection terminated'));

      await expect(handler.process(startJob)).rejects.toThrow('connection terminated');
    });

    it('rejects when the conditional updateMany fails in the resume path', async () => {
      const { handler, updateMany } = makeHandler({
        broadcast: {
          id: BROADCAST_ID,
          status: 'sending',
          audienceCutoff: new Date(),
          cursorUserId: null,
          recipientsDispatched: 0,
        },
      });
      updateMany.mockRejectedValue(new Error('connection terminated'));

      await expect(handler.process(startJob)).rejects.toThrow('connection terminated');
    });

    it('rejects when enqueue fails in the resume path', async () => {
      const { handler, enqueue } = makeHandler({
        broadcast: {
          id: BROADCAST_ID,
          status: 'sending',
          audienceCutoff: new Date(),
          cursorUserId: null,
          recipientsDispatched: 0,
        },
      });
      enqueue.mockRejectedValue(new Error('queue unavailable'));

      await expect(handler.process(startJob)).rejects.toThrow('queue unavailable');
    });
  });
});
