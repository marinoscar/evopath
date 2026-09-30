import 'reflect-metadata';

import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

import { TEMPORARY_GYM_PURGE_CRON, TEMPORARY_GYM_PURGE_JOB_TYPE } from '../gyms.constants';
import { TemporaryGymPurgeTask } from './temporary-gym-purge.task';

describe('TemporaryGymPurgeTask', () => {
  let findFirst: jest.Mock;
  let enqueue: jest.Mock;
  let deleteMany: jest.Mock;
  let task: TemporaryGymPurgeTask;

  beforeEach(() => {
    findFirst = jest.fn().mockResolvedValue(null);
    enqueue = jest.fn().mockResolvedValue({ id: 'job-1' });
    deleteMany = jest.fn();
    task = new TemporaryGymPurgeTask(
      { enqueue } as never,
      { job: { findFirst }, gym: { deleteMany, findMany: jest.fn() } } as never,
    );
  });

  it('runs daily at 03:30', () => {
    expect(TEMPORARY_GYM_PURGE_CRON).toBe('30 3 * * *');
    const options = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, TemporaryGymPurgeTask.prototype.handleCron) as { cronTime: string };
    expect(options.cronTime).toBe('30 3 * * *');
  });

  it('only enqueues one global gyms.temporary.purge job; it deletes nothing itself', async () => {
    await task.handleCron();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({ type: TEMPORARY_GYM_PURGE_JOB_TYPE, priority: 100 });
    expect(enqueue.mock.calls[0][0].subjectId).toBeUndefined();
    expect(enqueue.mock.calls[0][0].payload).toBeUndefined();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('skips the tick while a purge is already pending or running', async () => {
    findFirst.mockResolvedValue({ id: 'job-0', status: 'pending' });

    await task.handleCron();

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ type: TEMPORARY_GYM_PURGE_JOB_TYPE }) }),
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('never throws out of the cron', async () => {
    enqueue.mockRejectedValue(new Error('db down'));

    await expect(task.handleCron()).resolves.toBeUndefined();
  });
});
