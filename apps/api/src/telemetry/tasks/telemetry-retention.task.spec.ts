import { TELEMETRY_RETENTION_TYPE } from '../handlers/telemetry-retention.handler';
import { TelemetryRetentionTask } from './telemetry-retention.task';

describe('TelemetryRetentionTask', () => {
  let findFirst: jest.Mock;
  let enqueue: jest.Mock;
  let task: TelemetryRetentionTask;

  beforeEach(() => {
    findFirst = jest.fn().mockResolvedValue(null);
    enqueue = jest.fn().mockResolvedValue({ id: 'job-1' });
    task = new TelemetryRetentionTask({ enqueue } as never, { job: { findFirst } } as never);
  });

  it('enqueues one global, low-priority telemetry.retention.apply job', async () => {
    await task.handleCron();

    expect(enqueue).toHaveBeenCalledWith({
      type: TELEMETRY_RETENTION_TYPE,
      reason: 'backfill',
      priority: 100,
    });
  });

  it('skips the tick while one is already pending or running', async () => {
    findFirst.mockResolvedValue({ id: 'job-0', status: 'pending' });

    await task.handleCron();

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('never throws out of the cron', async () => {
    enqueue.mockRejectedValue(new Error('db down'));

    await expect(task.handleCron()).resolves.toBeUndefined();
  });
});
