import { TrainingEvaluationTask } from './training-evaluation.task';

function setup(enabled: boolean | Error, active: { id: string; status: string } | null = null) {
  const jobs = { enqueue: jest.fn(async () => ({ id: 'job-1' })) };
  const prisma = { job: { findFirst: jest.fn(async () => active) } };
  const aiConfig = {
    isEnabled: jest.fn(async () => {
      if (enabled instanceof Error) throw enabled;
      return enabled;
    }),
  };
  return { jobs, prisma, task: new TrainingEvaluationTask(jobs as never, prisma as never, aiConfig as never) };
}

describe('TrainingEvaluationTask', () => {
  it('queues one global training.evaluation.sweep at housekeeping priority while AI is on', async () => {
    const t = setup(true);

    await t.task.handleCron();

    expect(t.jobs.enqueue).toHaveBeenCalledWith({ type: 'training.evaluation.sweep', reason: 'backfill', priority: 100 });
  });

  it('queues nothing with AI off (the kill switch stays with scheduling)', async () => {
    const t = setup(false);

    await t.task.handleCron();

    expect(t.prisma.job.findFirst).not.toHaveBeenCalled();
    expect(t.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('skips a tick while a sweep is still pending or running', async () => {
    const t = setup(true, { id: 'job-0', status: 'running' });

    await t.task.handleCron();

    expect(t.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('never throws, even when the AI policy cannot be read', async () => {
    const t = setup(new Error('settings down'));

    await expect(t.task.handleCron()).resolves.toBeUndefined();
    expect(t.jobs.enqueue).not.toHaveBeenCalled();
  });
});
