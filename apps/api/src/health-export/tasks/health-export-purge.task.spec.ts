import type { Job } from '@prisma/client';

import { HOUSEKEEPING_PRIORITY } from '../../jobs/housekeeping.enqueue';
import type { JobsService } from '../../jobs/jobs.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { HealthExportPurgeTask } from './health-export-purge.task';

describe('HealthExportPurgeTask', () => {
  function make(active: unknown = null) {
    const findFirst = jest.fn().mockResolvedValue(active);
    const enqueue = jest.fn().mockResolvedValue({ id: 'purge-1' } as unknown as Job);
    const task = new HealthExportPurgeTask(
      { job: { findFirst } } as unknown as PrismaService,
      { enqueue } as unknown as JobsService,
    );
    return { task, enqueue };
  }

  it('only enqueues health.export.purge at housekeeping priority', async () => {
    const { task, enqueue } = make();

    await task.handleCron();

    expect(enqueue).toHaveBeenCalledWith({ type: 'health.export.purge', reason: 'backfill', priority: HOUSEKEEPING_PRIORITY });
  });

  it('skips the tick while a purge is already in flight', async () => {
    const { task, enqueue } = make({ id: 'p', status: 'running' });

    await task.handleCron();

    expect(enqueue).not.toHaveBeenCalled();
  });
});
