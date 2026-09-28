import { AI_USAGE_PURGE_TYPE } from './ai-usage-purge.handler';
import { AiUsagePurgeTask } from './ai-usage-purge.task';

describe('AiUsagePurgeTask', () => {
  let findFirst: jest.Mock;
  let enqueue: jest.Mock;
  let task: AiUsagePurgeTask;

  beforeEach(() => {
    findFirst = jest.fn().mockResolvedValue(null);
    enqueue = jest.fn().mockResolvedValue({ id: 'job-1' });
    task = new AiUsagePurgeTask({ enqueue } as never, { job: { findFirst } } as never);
  });

  it('enqueues one global, low-priority ai.usage.purge job', async () => {
    await task.handleCron();

    expect(enqueue).toHaveBeenCalledWith({
      type: AI_USAGE_PURGE_TYPE,
      reason: 'backfill',
      priority: 100,
    });
  });

  it('skips the tick while a purge is already pending or running', async () => {
    findFirst.mockResolvedValue({ id: 'job-0', status: 'running' });

    await task.handleCron();

    expect(findFirst).toHaveBeenCalledWith({
      where: { type: AI_USAGE_PURGE_TYPE, status: { in: ['pending', 'running'] } },
      select: { id: true, status: true },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('never throws out of the cron', async () => {
    enqueue.mockRejectedValue(new Error('db down'));

    await expect(task.handleCron()).resolves.toBeUndefined();
  });
});
