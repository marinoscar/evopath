// =============================================================================
// Unit tests for `emitJobSettled` (issue #468)
// =============================================================================
//
// The one place the listener-containment rule lives, shared by
// `JobTerminalService` and `JobStuckService`'s phase-1 give-up. Both callers
// are exercised in their own spec files (`job-terminal.service.spec.ts`,
// `job-stuck.service.spec.ts`); this file proves the shared helper itself,
// in isolation, against a bare `EventEmitter2`-shaped mock and a bare
// `Logger`-shaped mock — nothing here depends on Nest's DI or a real logger
// transport.
// =============================================================================

import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from '@prisma/client';

import { JOB_SETTLED_EVENT, JobSettledEvent } from './events/job-settled.event';
import { emitJobSettled } from './job-settled.emit';

/** A settled job row, complete enough to satisfy the `Job` type. */
function fakeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: 'example.echo',
    subjectType: null,
    subjectId: null,
    dedupKey: null,
    status: 'failed',
    reason: 'backfill',
    priority: 0,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 3,
    lastError: 'gave up',
    createdAt: new Date('2026-01-01T12:00:00.000Z'),
    startedAt: new Date('2026-01-01T12:00:00.000Z'),
    finishedAt: new Date('2026-01-01T12:05:00.000Z'),
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    claimToken: null,
    leaseExpiresAt: null,
    executor: 'server',
    ...overrides,
  } as Job;
}

/** A `Logger`-shaped stub — only `error` is ever called by `emitJobSettled`. */
function fakeLogger(): jest.Mocked<Pick<Logger, 'error'>> {
  return { error: jest.fn() };
}

describe('emitJobSettled', () => {
  it('emits JOB_SETTLED_EVENT with a JobSettledEvent wrapping exactly this job', () => {
    const emit = jest.fn();
    const logger = fakeLogger();
    const job = fakeJob();

    emitJobSettled({ emit } as unknown as EventEmitter2, job, logger as unknown as Logger);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toBe(JOB_SETTLED_EVENT);

    const event = emit.mock.calls[0][1] as JobSettledEvent;
    expect(event).toBeInstanceOf(JobSettledEvent);
    expect(event.job).toBe(job);

    expect(logger.error).not.toHaveBeenCalled();
  });

  it('works identically for a succeeded job — the event does not filter by status', () => {
    const emit = jest.fn();
    const logger = fakeLogger();
    const job = fakeJob({ status: 'succeeded', lastError: null });

    emitJobSettled({ emit } as unknown as EventEmitter2, job, logger as unknown as Logger);

    expect(emit).toHaveBeenCalledWith(JOB_SETTLED_EVENT, expect.any(JobSettledEvent));
    expect((emit.mock.calls[0][1] as JobSettledEvent).status).toBe('succeeded');
  });

  it('catches a throwing listener, logs it naming the job and its status, and never rethrows', () => {
    const emit = jest.fn(() => {
      throw new Error('listener blew up');
    });
    const logger = fakeLogger();
    const job = fakeJob({ id: 'job-2', status: 'failed' });

    expect(() =>
      emitJobSettled({ emit } as unknown as EventEmitter2, job, logger as unknown as Logger)
    ).not.toThrow();

    expect(logger.error).toHaveBeenCalledTimes(1);
    const message = logger.error.mock.calls[0][0] as string;
    expect(message).toContain('job-2');
    expect(message).toContain('failed');
    expect(message).toContain('listener blew up');
  });

  it('renders a non-Error throw with String(), not "[object Object]"', () => {
    const emit = jest.fn(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'a bare string';
    });
    const logger = fakeLogger();

    emitJobSettled({ emit } as unknown as EventEmitter2, fakeJob(), logger as unknown as Logger);

    expect(logger.error.mock.calls[0][0]).toContain('a bare string');
  });
});
