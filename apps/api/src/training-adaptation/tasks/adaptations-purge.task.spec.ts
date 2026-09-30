import 'reflect-metadata';

import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

import { ADAPTATIONS_PURGE_CRON, ADAPTATIONS_PURGE_JOB_TYPE } from '../adaptation.constants';
import { AdaptationsPurgeTask } from './adaptations-purge.task';

describe('AdaptationsPurgeTask', () => {
  let findFirst: jest.Mock;
  let enqueue: jest.Mock;
  let deleteMany: jest.Mock;
  let task: AdaptationsPurgeTask;

  beforeEach(() => {
    findFirst = jest.fn().mockResolvedValue(null);
    enqueue = jest.fn().mockResolvedValue({ id: 'job-1' });
    deleteMany = jest.fn();
    task = new AdaptationsPurgeTask(
      { enqueue } as never,
      { job: { findFirst }, workoutAdaptation: { deleteMany, findMany: jest.fn() } } as never,
    );
  });

  it('runs daily at 03:20', () => {
    expect(ADAPTATIONS_PURGE_CRON).toBe('20 3 * * *');
    const options = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, AdaptationsPurgeTask.prototype.handleCron) as { cronTime: string };
    expect(options.cronTime).toBe('20 3 * * *');
  });

  it('only enqueues one global training.adaptations.purge job; it deletes nothing itself', async () => {
    await task.handleCron();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({ type: ADAPTATIONS_PURGE_JOB_TYPE });
    expect(enqueue.mock.calls[0][0].subjectId).toBeUndefined();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('skips the tick while a purge is already pending or running', async () => {
    findFirst.mockResolvedValue({ id: 'job-0', status: 'running' });

    await task.handleCron();

    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ type: ADAPTATIONS_PURGE_JOB_TYPE }) }));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('never throws out of the cron', async () => {
    enqueue.mockRejectedValue(new Error('db down'));

    await expect(task.handleCron()).resolves.toBeUndefined();
  });
});
