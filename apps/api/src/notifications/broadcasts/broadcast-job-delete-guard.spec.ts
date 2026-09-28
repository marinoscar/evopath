// =============================================================================
// Unit tests for `broadcastJobDeleteRefusal` (issue #480, epic #319)
// =============================================================================
//
// This is the ONE function both broadcast job handlers' `canDelete` delegate
// to (`broadcast-start.handler.ts`, `broadcast-chunk.handler.ts`) — see
// `broadcast-job-delete-guard.ts`'s own header for why it is a single shared
// function rather than two hand-written copies. Every branch here is a short-
// circuit BEFORE the database read, or the database read itself, so the "no
// DB read" assertions are as load-bearing as the reason strings: a terminal
// job or a non-broadcast subject must never cost a query on the admin
// delete's hot path.
// =============================================================================

import { broadcastJobDeleteRefusal } from './broadcast-job-delete-guard';
import { BROADCAST_SUBJECT_TYPE } from './broadcast-audience';
import type { PrismaService } from '../../prisma/prisma.service';

/** A `PrismaService` stand-in whose only method this guard ever calls is spied on. */
function prismaStub(broadcast: { id: string; status: string } | null = null) {
  const findUnique = jest.fn().mockResolvedValue(broadcast);
  return {
    prisma: { notificationBroadcast: { findUnique } } as unknown as PrismaService,
    findUnique,
  };
}

const BROADCAST_ID = 'bcast-1';

/** Builds the `Pick<Job, ...>` this guard takes, from plain test strings. */
function jobLike(status: string, subjectType: string | null, subjectId: string | null) {
  return { status, subjectType, subjectId } as unknown as Parameters<
    typeof broadcastJobDeleteRefusal
  >[1];
}

describe('broadcastJobDeleteRefusal', () => {
  // ===========================================================================
  // Terminal job status — no DB read at all
  // ===========================================================================

  describe('a terminal job (succeeded/failed)', () => {
    it.each(['succeeded', 'failed'])(
      'answers null for a %s job with NO database read, even a scheduled broadcast',
      async (status) => {
        const { prisma, findUnique } = prismaStub({ id: BROADCAST_ID, status: 'scheduled' });

        const result = await broadcastJobDeleteRefusal(prisma, jobLike(status, BROADCAST_SUBJECT_TYPE, BROADCAST_ID));

        expect(result).toBeNull();
        expect(findUnique).not.toHaveBeenCalled();
      }
    );
  });

  // ===========================================================================
  // Non-broadcast subject — no DB read at all
  // ===========================================================================

  describe('a job whose subject is not a broadcast', () => {
    it.each(['pending', 'running'])(
      'answers null for a %s job with a different subjectType, with NO database read',
      async (status) => {
        const { prisma, findUnique } = prismaStub();

        const result = await broadcastJobDeleteRefusal(prisma, jobLike(status, 'storage_object', 'obj-1'));

        expect(result).toBeNull();
        expect(findUnique).not.toHaveBeenCalled();
      }
    );

    it('answers null when subjectId is null, with NO database read', async () => {
      const { prisma, findUnique } = prismaStub();

      const result = await broadcastJobDeleteRefusal(prisma, jobLike('pending', BROADCAST_SUBJECT_TYPE, null));

      expect(result).toBeNull();
      expect(findUnique).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Broadcast subject, non-terminal job — the DB read happens
  // ===========================================================================

  describe('a non-terminal job naming a broadcast', () => {
    it('reads the broadcast by id via findUnique', async () => {
      const { prisma, findUnique } = prismaStub({ id: BROADCAST_ID, status: 'scheduled' });

      await broadcastJobDeleteRefusal(prisma, jobLike('pending', BROADCAST_SUBJECT_TYPE, BROADCAST_ID));

      expect(findUnique).toHaveBeenCalledWith({
        where: { id: BROADCAST_ID },
        select: { id: true, status: true },
      });
    });

    it('answers null when the broadcast no longer exists', async () => {
      const { prisma } = prismaStub(null);

      const result = await broadcastJobDeleteRefusal(prisma, jobLike('pending', BROADCAST_SUBJECT_TYPE, BROADCAST_ID));

      expect(result).toBeNull();
    });

    it.each(['scheduled', 'sending'])(
      'refuses with a reason naming the id and status when the broadcast is %s',
      async (status) => {
        const { prisma } = prismaStub({ id: BROADCAST_ID, status });

        const result = await broadcastJobDeleteRefusal(prisma, jobLike('pending', BROADCAST_SUBJECT_TYPE, BROADCAST_ID));

        expect(result).not.toBeNull();
        expect(result).toEqual(expect.stringContaining(BROADCAST_ID));
        expect(result).toEqual(expect.stringContaining(status));
      }
    );

    it.each(['draft', 'sent', 'canceled', 'failed'])(
      'answers null when the broadcast is %s (not scheduled/sending)',
      async (status) => {
        const { prisma } = prismaStub({ id: BROADCAST_ID, status });

        const result = await broadcastJobDeleteRefusal(prisma, jobLike('pending', BROADCAST_SUBJECT_TYPE, BROADCAST_ID));

        expect(result).toBeNull();
      }
    );

    it('the refusal reason instructs cancelling the broadcast rather than deleting the job', async () => {
      const { prisma } = prismaStub({ id: BROADCAST_ID, status: 'sending' });

      const result = await broadcastJobDeleteRefusal(prisma, jobLike('pending', BROADCAST_SUBJECT_TYPE, BROADCAST_ID));

      expect(result).toEqual(expect.stringContaining('Cancel the broadcast'));
    });

    it('a `running` job is still non-terminal, so an active broadcast is still refused', async () => {
      const { prisma } = prismaStub({ id: BROADCAST_ID, status: 'scheduled' });

      const result = await broadcastJobDeleteRefusal(prisma, jobLike('running', BROADCAST_SUBJECT_TYPE, BROADCAST_ID));

      expect(result).not.toBeNull();
    });

    it('propagates a database error rather than swallowing it', async () => {
      const findUnique = jest.fn().mockRejectedValue(new Error('connection terminated'));
      const prisma = {
        notificationBroadcast: { findUnique },
      } as unknown as PrismaService;

      await expect(
        broadcastJobDeleteRefusal(prisma, jobLike('pending', BROADCAST_SUBJECT_TYPE, BROADCAST_ID))
      ).rejects.toThrow('connection terminated');
    });
  });
});
