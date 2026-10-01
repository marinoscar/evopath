import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { COACH_SWEEP_CRON, CoachSweepTask } from './coach-sweep.task';

// AC 13: nothing is enqueued while AI or the coach is off; one global coach.sweep per hour otherwise.

function setup(options: { ai?: boolean | Error; coach?: boolean; active?: { id: string; status: string } | null } = {}) {
  const jobs = { enqueue: jest.fn(async () => ({ id: 'job-1' })) };
  const prisma = { job: { findFirst: jest.fn(async () => options.active ?? null) } };
  const aiConfig = {
    isEnabled: jest.fn(async () => {
      if (options.ai instanceof Error) throw options.ai;
      return options.ai ?? true;
    }),
  };
  const systemSettings = { getCoachPolicy: jest.fn(async () => ({ enabled: options.coach ?? true })) };
  const task = new CoachSweepTask(jobs as never, prisma as never, aiConfig as never, systemSettings as never);
  return { task, jobs, prisma };
}

describe('CoachSweepTask', () => {
  it('runs at minute 17 of every hour', () => {
    expect(COACH_SWEEP_CRON).toBe('17 * * * *');
  });

  it('queues one global coach.sweep at housekeeping priority while AI and the coach are on', async () => {
    const t = setup();
    await t.task.handleCron();
    expect(t.jobs.enqueue).toHaveBeenCalledWith({ type: 'coach.sweep', reason: 'backfill', priority: 100 });
  });

  it.each([
    ['AI is off', { ai: false }],
    ['the coach is off', { coach: false }],
  ])('queues nothing while %s', async (_label, options) => {
    const t = setup(options);
    await t.task.handleCron();
    expect(t.prisma.job.findFirst).not.toHaveBeenCalled();
    expect(t.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('skips a tick while a sweep is still pending or running (one per hour)', async () => {
    const t = setup({ active: { id: 'job-0', status: 'running' } });
    await t.task.handleCron();
    expect(t.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('never throws, even when the switches cannot be read', async () => {
    const t = setup({ ai: new Error('settings down') });
    await expect(t.task.handleCron()).resolves.toBeUndefined();
    expect(t.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('the cron body only enqueues (no prisma call of its own)', () => {
    const source = readFileSync(join(__dirname, 'coach-sweep.task.ts'), 'utf8');
    const body = source.slice(source.indexOf('async handleCron'), source.indexOf('private async isDue'));
    expect(body).toContain('enqueueHousekeepingJob(');
    expect(body).not.toMatch(/this\.prisma\.\w+\./);
  });
});
