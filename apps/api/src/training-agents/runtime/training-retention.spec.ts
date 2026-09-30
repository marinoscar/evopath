import { Logger } from '@nestjs/common';

import { TrainingRunsPurgeHandler } from './handlers/training-runs-purge.handler';
import { TrainingRunsPurgeTask } from './tasks/training-runs-purge.task';
import {
  TRAINING_RUN_CHECKPOINT_RETENTION_DAYS,
  TRAINING_RUN_EVENT_RETENTION_DAYS,
  TRAINING_RUN_RETENTION_DAYS,
  TRAINING_RUNS_PURGE_BATCH_SIZE,
  TRAINING_RUNS_PURGE_CRON,
  daysAgo,
} from './training-retention';

describe('training run retention', () => {
  it('keeps events and checkpoints 30 days and run rows a year, in batches of 5000', () => {
    expect(TRAINING_RUN_EVENT_RETENTION_DAYS).toBe(30);
    expect(TRAINING_RUN_CHECKPOINT_RETENTION_DAYS).toBe(30);
    expect(TRAINING_RUN_RETENTION_DAYS).toBe(365);
    expect(TRAINING_RUNS_PURGE_BATCH_SIZE).toBe(5000);
    expect(daysAgo(30, new Date('2026-03-31T00:00:00Z')).toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('runs daily at 05:30, a different minute from ai.usage.purge (05:00)', () => {
    expect(TRAINING_RUNS_PURGE_CRON).toBe('30 5 * * *');
  });

  it('the purge job is a 30 minute, three-attempt, server-only housekeeping type', () => {
    const handler = new TrainingRunsPurgeHandler({ register: jest.fn() } as never, {} as never);

    expect(handler.type).toBe('training.runs.purge');
    expect(handler.profile).toEqual({ maxRuntimeMs: 30 * 60_000, maxAttempts: 3 });
    expect('nodeResultSchema' in handler).toBe(false);
  });

  it('the task only enqueues a global housekeeping job', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const jobs = { enqueue: jest.fn(async () => ({ id: 'job-1' })) };
    const prisma = { job: { findFirst: jest.fn(async () => null) } };

    await new TrainingRunsPurgeTask(jobs as never, prisma as never).handleCron();

    expect(jobs.enqueue).toHaveBeenCalledWith({ type: 'training.runs.purge', reason: 'backfill', priority: 100 });
  });
});
