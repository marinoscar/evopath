// =============================================================================
// BroadcastChunkHandler x JobTerminalService x ProviderThrottleService
// (issue #456) — an integration test with the REAL queue classes
// =============================================================================
//
// `broadcast-chunk.handler.spec.ts` proves the handler throws `RateLimitError`
// with the right `retryAfterMs` and commits the right prefix; that file mocks
// everything below `process()`. `job-terminal.service.spec.ts` proves
// `JobTerminalService` classifies a thrown `RateLimitError` correctly and that
// the REAL `ProviderThrottleService` backs off a sibling job type registered
// under the same provider key; that file uses synthetic job types
// (`vision.describe`/`vision.tag`), never `admin.broadcast.chunk`.
//
// Neither file proves the two halves actually agree end to end: that a
// `RateLimitError` thrown by THIS handler, fed to the REAL
// `JobTerminalService`, actually defers the chunk's own row (pending,
// `scheduledFor` set, the claim-time attempt un-charged, `rateLimitHits`
// incremented) and trips the REAL `ProviderThrottleService` for
// `BROADCAST_CHUNK_TYPE` specifically — the mapping `onModuleInit` registers
// under `BROADCAST_EMAIL_PROVIDER_KEY`. This file is that missing link.
//
// `PrismaService` is still a hand-built stub (a real Postgres round trip adds
// nothing this test needs — see `job-terminal.service.spec.ts`'s own header
// for the same argument), but `JobTerminalService` and `ProviderThrottleService`
// are constructed for real, exactly as `job-terminal.service.spec.ts`'s own
// "sibling back-off, with the real throttle gate" block does.
// =============================================================================

import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job, Prisma } from '@prisma/client';

import {
  BroadcastChunkHandler,
  BROADCAST_CHUNK_TYPE,
  BROADCAST_EMAIL_PROVIDER_KEY,
} from './broadcast-chunk.handler';
import { BROADCAST_SUBJECT_TYPE } from '../broadcast-audience';
import { JobClock } from '../../../jobs/job-clock';
import { JobHandlerRegistry } from '../../../jobs/job-handler.registry';
import type { JobsService } from '../../../jobs/jobs.service';
import { JobTerminalService } from '../../../jobs/job-terminal.service';
import { ProviderThrottleService } from '../../../jobs/provider-throttle.service';
import type { NotificationsService } from '../../notifications.service';
import type { PrismaService } from '../../../prisma/prisma.service';

const NOW = 1_700_000_000_000;
const BROADCAST_ID = 'bcast-integration-1';

const CONFIG_VALUES: Record<string, number> = {
  'jobs.maxAttempts': 3,
  'jobs.retryBaseMs': 2_000,
  'jobs.retryMaxMs': 60_000,
  'jobs.rateLimitMaxHits': 10,
  'jobs.rateLimitBaseMs': 30_000,
  'jobs.rateLimitMaxMs': 900_000,
};

const RAND_FLOOR = () => 0;

function fakeClock(start = NOW) {
  let current = start;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
  } satisfies JobClock;
}

function chunkJobRow(overrides: Partial<Job> = {}): Job {
  return {
    id: 'chunk-job-1',
    type: BROADCAST_CHUNK_TYPE,
    subjectType: BROADCAST_SUBJECT_TYPE,
    subjectId: BROADCAST_ID,
    dedupKey: null,
    status: 'running',
    reason: 'backfill',
    priority: 0,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 1,
    lastError: null,
    createdAt: new Date(NOW - 60_000),
    startedAt: new Date(NOW - 1_000),
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: new Date(NOW + 30_000),
    executor: 'server',
    ...overrides,
  } as Job;
}

/** A tiny stateful broadcast + user store, matching `broadcast-chunk.handler.spec.ts`'s shape. */
function makePrisma(users: string[]) {
  const state = {
    id: BROADCAST_ID,
    title: 'Scheduled maintenance',
    body: 'We will be offline on Sunday.',
    link: null,
    ctaLabel: null,
    eventKey: 'admin.broadcast',
    channels: ['email'],
    status: 'sending',
    audienceCutoff: new Date(NOW),
    cursorUserId: null as string | null,
    recipientsDispatched: 0,
  };

  const findUnique = jest.fn(async () => ({ ...state }));
  // The progress commit is a compare-and-swap on the cursor since #459.
  const updateMany = jest.fn(async ({ where, data }: any) => {
    if (where.cursorUserId !== state.cursorUserId) return { count: 0 };
    for (const [key, value] of Object.entries<any>(data)) {
      if (value && typeof value === 'object' && 'increment' in value) {
        (state as any)[key] = ((state as any)[key] ?? 0) + value.increment;
      } else {
        (state as any)[key] = value;
      }
    }
    return { count: 1 };
  });
  const findMany = jest.fn(async ({ where, take }: any) => {
    const after = where.id?.gt;
    return users
      .filter((id) => (after ? id > after : true))
      .slice(0, take)
      .map((id) => ({ id }));
  });

  return {
    notificationBroadcast: { findUnique, updateMany },
    user: { findMany },
  } as unknown as PrismaService;
}

describe('BroadcastChunkHandler rate-limit deferral, wired to the real queue classes (issue #456)', () => {
  it(
    'a chunk throttled by the email provider is deferred (pending, scheduledFor set, ' +
      'attempt un-charged, rateLimitHits incremented) and trips the REAL throttle gate ' +
      "for admin.broadcast.chunk's own provider key",
    async () => {
      const clock = fakeClock();
      // `updateManyAndReturn` since #477: the claim-guarded write resolves to
      // the one row it matched.
      const jobUpdate = jest.fn(({ where, data }: { where: { id: string }; data: unknown }) =>
        Promise.resolve([{ ...chunkJobRow({ id: where.id }), ...(data as object) }]),
      );

      const realThrottle = new ProviderThrottleService(
        { get: (key: string) => CONFIG_VALUES[key] } as unknown as ConfigService,
        clock,
      );
      const terminal = new JobTerminalService(
        {
          job: { updateManyAndReturn: jobUpdate, findUnique: jest.fn() },
        } as unknown as PrismaService,
        { get: (key: string) => CONFIG_VALUES[key] } as unknown as ConfigService,
        realThrottle,
        { emit: jest.fn() } as unknown as EventEmitter2,
        new JobHandlerRegistry(),
        clock,
        RAND_FLOOR,
      );

      const users = ['u-0000', 'u-0001', 'u-0002'];
      const prisma = makePrisma(users);

      // notifyNow: the SECOND recipient's provider throttles us.
      const notifyNow = jest
        .fn()
        .mockResolvedValueOnce({ rateLimited: false, retryAfterMs: null })
        .mockResolvedValueOnce({ rateLimited: true, retryAfterMs: 45_000 })
        .mockResolvedValueOnce({ rateLimited: false, retryAfterMs: null });
      const notifications = { notifyNow, notify: jest.fn() } as unknown as NotificationsService;

      const jobs = { enqueue: jest.fn() } as unknown as JobsService;
      const config = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
      const registry = { register: jest.fn() } as unknown as JobHandlerRegistry;

      const handler = new BroadcastChunkHandler(prisma, notifications, jobs, config, registry, realThrottle);

      // The exact wiring `onModuleInit` performs in production — this is the
      // one line that makes `RateLimitError` from THIS handler mean anything
      // to the throttle gate at all.
      handler.onModuleInit();

      expect(realThrottle.resolveKey(BROADCAST_CHUNK_TYPE)).toBe(BROADCAST_EMAIL_PROVIDER_KEY);

      const job = chunkJobRow();

      let thrown: unknown;
      try {
        await handler.process(job);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).name).toBe('RateLimitError');

      // Feed the SAME error the worker would, to the SAME chokepoint.
      const outcome = await terminal.completeFailed(job, thrown);

      expect(outcome).toBe('rate-limit-deferred');
      expect(jobUpdate).toHaveBeenCalledTimes(1);
      const written = (
        jobUpdate.mock.calls[0][0] as { data: Prisma.JobUncheckedUpdateManyInput }
      ).data;

      expect(written).toMatchObject({
        status: 'pending',
        // The claim-time attempt is UN-CHARGED (job.attempts - 1) — rate
        // limits bound a SEPARATE budget (`rateLimitHits`), never `attempts`.
        attempts: job.attempts - 1,
        rateLimitHits: 1,
        claimedByNodeId: null,
        leaseExpiresAt: null,
      });
      expect(written.scheduledFor).toBeInstanceOf(Date);
      // The provider named 45s; that is a FLOOR on the computed backoff, so
      // the actual deferral is at least that long.
      expect((written.scheduledFor as Date).getTime()).toBeGreaterThanOrEqual(NOW + 45_000);

      // The gate itself is now cooling down for THIS type specifically...
      expect(realThrottle.isCoolingDown(BROADCAST_CHUNK_TYPE)).toBe(true);
      // ...and a second broadcast's chunk (a different job row, same type)
      // would wait it out rather than rediscovering the throttle itself.
      const waited = await realThrottle.acquire(BROADCAST_CHUNK_TYPE);
      expect(waited).toBeGreaterThan(0);

      // An unrelated job type sharing no provider key is untouched.
      expect(realThrottle.isCoolingDown('some.other.job.type')).toBe(false);
    },
  );

  it('an unrelated job type, sharing no provider key, is unaffected by a broadcast chunk throttle', async () => {
    // Sanity check on the gate's own "no mapping, no effect" contract
    // (`provider-throttle.service.ts`), read from THIS suite's real instance
    // rather than assumed.
    const clock = fakeClock();
    const realThrottle = new ProviderThrottleService(
      { get: (key: string) => CONFIG_VALUES[key] } as unknown as ConfigService,
      clock,
    );

    realThrottle.registerProviderKey(BROADCAST_CHUNK_TYPE, BROADCAST_EMAIL_PROVIDER_KEY);
    realThrottle.trip(BROADCAST_CHUNK_TYPE, 60_000);

    expect(realThrottle.isCoolingDown(BROADCAST_CHUNK_TYPE)).toBe(true);
    // A type that never registered under `BROADCAST_EMAIL_PROVIDER_KEY` (or
    // any key at all) is untouched by the broadcast chunk's own throttle.
    expect(realThrottle.resolveKey('jobs.job-history-purge')).toBeNull();
    expect(realThrottle.isCoolingDown('jobs.job-history-purge')).toBe(false);
  });
});
