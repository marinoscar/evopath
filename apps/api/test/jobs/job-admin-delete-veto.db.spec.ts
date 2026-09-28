// =============================================================================
// Real-Postgres test: the admin delete veto for broadcast jobs (issue #480)
// =============================================================================
//
// `job-admin.service.spec.ts` proves what `JobAdminService.remove` DOES with
// whatever its (mocked) `JobHandlerRegistry` and `canDelete` answer.
// `broadcast-job-delete-guard.spec.ts` proves what the shared guard function
// answers, against a mocked Prisma. Neither proves the thing this suite
// exists for: that wiring the REAL `JobAdminService`, a REAL
// `JobHandlerRegistry` holding the REAL `BroadcastStartHandler` /
// `BroadcastChunkHandler`, and a REAL `notification_broadcasts` row together
// actually refuses the delete end to end — and that cancelling the broadcast
// (a real status flip in the real table) really does lift the refusal on the
// very same row, which is the one behaviour a mocked `findUnique` cannot
// demonstrate: it can only ever answer what a test told it to, never "did
// this write really change what the next read sees".
//
// Constructed the same way `broadcast-fanout.db.spec.ts` constructs its
// handlers: real classes over a real `PrismaClient` from `createDbClient()`,
// with `JobHandlerRegistry` real too (unlike that suite, which stubs it,
// because this suite's entire point is `JobAdminService.remove` calling
// `registry.get(job.type)` and finding the real handler there — the same
// `register(this)` self-registration every handler's `onModuleInit` performs
// in production, just driven by hand instead of by Nest's module lifecycle).
//
// NOT run by `npm test`/`test:unit`/`test:ci` — see
// `apps/api/package.json`'s `testPathIgnorePatterns` — only by
// `npm run test:db --runInBand`. See `db-test-support.ts`.
// =============================================================================

import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

import { JobAdminService } from '../../src/jobs/job-admin.service';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobsService } from '../../src/jobs/jobs.service';
import { BroadcastChunkHandler } from '../../src/notifications/broadcasts/handlers/broadcast-chunk.handler';
import { BroadcastStartHandler } from '../../src/notifications/broadcasts/handlers/broadcast-start.handler';
import { BROADCAST_SUBJECT_TYPE } from '../../src/notifications/broadcasts/broadcast-audience';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { ProviderThrottleService } from '../../src/jobs/provider-throttle.service';
import type { JobStuckService } from '../../src/jobs/job-stuck.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from './db-test-support';

const { describeWithDb } = resolveDbSuite('job-admin-delete-veto.db.spec');

const PREFIX = `test.job-admin-delete-veto.${process.pid}.`;
let eventKeyCounter = 0;
const nextEventKey = (): string => `${PREFIX}${(eventKeyCounter += 1)}`;

/** A `JobStuckService` stub — `JobAdminService.remove` never consults it. */
function stuckStub(): JobStuckService {
  return {} as unknown as JobStuckService;
}

/** A `NotificationsService` stub — no chunk job in this suite is ever `process()`-ed. */
function notificationsStub(): NotificationsService {
  return { notifyNow: jest.fn(), notify: jest.fn() } as unknown as NotificationsService;
}

function configStub(): ConfigService {
  return { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
}

describeWithDb('JobAdminService.remove — the broadcast owner veto (real Postgres)', () => {
  let client: PrismaClient;
  let prisma: PrismaService;
  let jobsService: JobsService;
  let jobAdmin: JobAdminService;
  let createdBroadcastIds: string[];

  beforeAll(async () => {
    client = createDbClient();
    await client.$connect();
    prisma = client as unknown as PrismaService;
    jobsService = new JobsService(prisma);

    // The REAL registry, populated the way production populates it: each
    // handler's own `onModuleInit` calling `registry.register(this)`. Both
    // broadcast handlers AND the innocuous `example.echo` type (registered
    // nowhere here, deliberately — its absence from the registry is exactly
    // the "no handler ⇒ allow" case one of the tests below relies on).
    const registry = new JobHandlerRegistry();
    const startHandler = new BroadcastStartHandler(prisma, jobsService, registry);
    const chunkHandler = new BroadcastChunkHandler(
      prisma,
      notificationsStub(),
      jobsService,
      configStub(),
      registry,
      { registerProviderKey: jest.fn() } as unknown as ProviderThrottleService
    );
    startHandler.onModuleInit();
    chunkHandler.onModuleInit();

    jobAdmin = new JobAdminService(prisma, stuckStub(), registry);
  });

  beforeEach(() => {
    createdBroadcastIds = [];
  });

  afterEach(async () => {
    if (createdBroadcastIds.length > 0) {
      await client.job.deleteMany({ where: { subjectId: { in: createdBroadcastIds } } });
      await client.notificationBroadcast.deleteMany({ where: { id: { in: createdBroadcastIds } } });
    }
  });

  afterAll(async () => {
    await client?.notificationBroadcast
      .deleteMany({ where: { eventKey: { startsWith: PREFIX } } })
      .catch(() => undefined);
    await client?.$disconnect();
  });

  /** Creates a `notification_broadcasts` row with the given status, tracked for cleanup. */
  async function createBroadcast(status: string) {
    const broadcast = await client.notificationBroadcast.create({
      data: {
        title: 'Scheduled maintenance',
        body: 'The application will be briefly unavailable.',
        eventKey: nextEventKey(),
        channels: ['browser'],
        status: status as never,
      },
    });
    createdBroadcastIds.push(broadcast.id);
    return broadcast;
  }

  describe('a pending admin.broadcast.start job', () => {
    it('is refused with ConflictException while its broadcast is scheduled, and the row survives', async () => {
      const broadcast = await createBroadcast('scheduled');
      const job = await jobsService.enqueue({
        type: 'admin.broadcast.start',
        reason: 'backfill',
        subjectType: BROADCAST_SUBJECT_TYPE,
        subjectId: broadcast.id,
      });

      await expect(jobAdmin.remove(job.id)).rejects.toThrow(ConflictException);

      const stillThere = await client.job.findUnique({ where: { id: job.id } });
      expect(stillThere).not.toBeNull();
      expect(stillThere?.status).toBe('pending');
    });

    it('carries the owner_refused reason and the broadcast id in the 409 body', async () => {
      const broadcast = await createBroadcast('scheduled');
      const job = await jobsService.enqueue({
        type: 'admin.broadcast.start',
        reason: 'backfill',
        subjectType: BROADCAST_SUBJECT_TYPE,
        subjectId: broadcast.id,
      });

      await expect(jobAdmin.remove(job.id)).rejects.toMatchObject({
        response: {
          details: { jobId: job.id, status: 'pending', reason: 'owner_refused' },
          message: expect.stringContaining(broadcast.id),
        },
      });
    });
  });

  describe('a pending admin.broadcast.chunk job', () => {
    it('is refused while its broadcast is sending', async () => {
      const broadcast = await createBroadcast('sending');
      const job = await jobsService.enqueue({
        type: 'admin.broadcast.chunk',
        reason: 'backfill',
        subjectType: BROADCAST_SUBJECT_TYPE,
        subjectId: broadcast.id,
        skipDedup: true,
      });

      await expect(jobAdmin.remove(job.id)).rejects.toThrow(ConflictException);

      const stillThere = await client.job.findUnique({ where: { id: job.id } });
      expect(stillThere).not.toBeNull();
    });

    it('becomes deletable once the broadcast is cancelled', async () => {
      const broadcast = await createBroadcast('sending');
      const job = await jobsService.enqueue({
        type: 'admin.broadcast.chunk',
        reason: 'backfill',
        subjectType: BROADCAST_SUBJECT_TYPE,
        subjectId: broadcast.id,
        skipDedup: true,
      });

      // Refused first, proving the fixture really is load-bearing before the
      // cancel — otherwise a bug that always allows the delete would make
      // the assertion below pass for the wrong reason.
      await expect(jobAdmin.remove(job.id)).rejects.toThrow(ConflictException);

      await client.notificationBroadcast.update({
        where: { id: broadcast.id },
        data: { status: 'canceled' as never },
      });

      await expect(jobAdmin.remove(job.id)).resolves.toBeUndefined();
      expect(await client.job.findUnique({ where: { id: job.id } })).toBeNull();
    });

    it('a terminal (succeeded) chunk job is deletable even while its broadcast is still sending', async () => {
      const broadcast = await createBroadcast('sending');
      const job = await jobsService.enqueue({
        type: 'admin.broadcast.chunk',
        reason: 'backfill',
        subjectType: BROADCAST_SUBJECT_TYPE,
        subjectId: broadcast.id,
        skipDedup: true,
      });
      await client.job.update({ where: { id: job.id }, data: { status: 'succeeded' } });

      await expect(jobAdmin.remove(job.id)).resolves.toBeUndefined();
      expect(await client.job.findUnique({ where: { id: job.id } })).toBeNull();

      // The broadcast itself is untouched — deleting job history is never a
      // mutation on the feature it belonged to.
      const broadcastAfter = await client.notificationBroadcast.findUnique({
        where: { id: broadcast.id },
      });
      expect(broadcastAfter?.status).toBe('sending');
    });
  });

  describe('an unrelated job type', () => {
    it('is deletable — no handler is registered for it, so the pre-#480 behaviour holds', async () => {
      const job = await jobsService.enqueue({
        type: 'example.echo',
        reason: 'backfill',
      });

      await expect(jobAdmin.remove(job.id)).resolves.toBeUndefined();
      expect(await client.job.findUnique({ where: { id: job.id } })).toBeNull();
    });
  });
});
