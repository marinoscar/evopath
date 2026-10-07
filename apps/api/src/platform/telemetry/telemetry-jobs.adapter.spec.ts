import { Logger } from '@nestjs/common';

import { HOUSEKEEPING_PRIORITY } from '../../jobs/housekeeping.enqueue';
import { JOB_TYPE_LABELS, jobTypeLabel } from '../../jobs/job-type-labels';
import { TelemetryJobsAdapter } from './telemetry-jobs.adapter';

// The TELEMETRY_JOBS adapter (marinoscar/EnterpriseAppBase#703). The housekeeping semantics the
// telemetry slice relies on (retention after a settings or connection save,
// after a stack deploy, and nightly) live here, in the app's queue helper.
describe('TelemetryJobsAdapter (TELEMETRY_JOBS)', () => {
  function setup() {
    const jobs = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1', status: 'pending' }) };
    const registry = { register: jest.fn() };
    const prisma = {
      job: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const adapter = new TelemetryJobsAdapter(jobs as never, registry as never, prisma as never);
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;
    return { adapter, jobs, registry, prisma, logger };
  }

  it('queues one GLOBAL, low-priority housekeeping job', async () => {
    const { adapter, jobs, logger } = setup();

    await adapter.enqueueHousekeepingJob({ type: 'telemetry.retention.apply', what: 'telemetry retention', logger });

    expect(jobs.enqueue).toHaveBeenCalledWith({
      type: 'telemetry.retention.apply',
      reason: 'backfill',
      priority: HOUSEKEEPING_PRIORITY,
    });
    expect(HOUSEKEEPING_PRIORITY).toBe(100);
    expect(logger.log).toHaveBeenCalledWith('Queued telemetry retention job job-1');
  });

  it('skips while one is already pending or running, logging on the CALLER\'s logger', async () => {
    const { adapter, jobs, prisma, logger } = setup();
    prisma.job.findFirst.mockResolvedValue({ id: 'job-0', status: 'running' });

    await adapter.enqueueHousekeepingJob({ type: 'telemetry.retention.apply', what: 'telemetry retention', logger });

    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('never throws (a failed enqueue never fails the save or the cron that asked)', async () => {
    const { adapter, jobs, logger } = setup();
    jobs.enqueue.mockRejectedValue(new Error('queue down'));

    await expect(
      adapter.enqueueHousekeepingJob({ type: 'telemetry.retention.apply', what: 'telemetry retention', logger }),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it('enqueues with the given reason and payload, and nothing else (no subject: one global job)', async () => {
    const { adapter, jobs } = setup();

    await expect(
      adapter.enqueue({ type: 'telemetry.stack.deploy', reason: 'rerun', payload: { requestedByUserId: 'u1' } }),
    ).resolves.toMatchObject({ id: 'job-1', status: 'pending' });

    expect(jobs.enqueue).toHaveBeenCalledWith({
      type: 'telemetry.stack.deploy',
      reason: 'rerun',
      payload: { requestedByUserId: 'u1' },
    });
  });

  it('registers a handler with the app registry, as the object it is', () => {
    const { adapter, registry } = setup();
    const handler = { type: 'telemetry.retention.apply', process: jest.fn() };

    adapter.registerHandler(handler);

    expect(registry.register).toHaveBeenCalledWith(handler);
  });

  it('reads the latest job of a type and replaces a payload', async () => {
    const { adapter, prisma } = setup();

    await adapter.findLatest('telemetry.stack.deploy');
    await adapter.updatePayload('job-9', { result: { ok: true } });

    expect(prisma.job.findFirst).toHaveBeenCalledWith({
      where: { type: 'telemetry.stack.deploy' },
      orderBy: { createdAt: 'desc' },
    });
    expect(prisma.job.update).toHaveBeenCalledWith({ where: { id: 'job-9' }, data: { payload: { result: { ok: true } } } });
  });

  it('both telemetry job types are labelled for the jobs dashboard', () => {
    expect(JOB_TYPE_LABELS['telemetry.retention.apply']).toBe('Telemetry retention');
    expect(JOB_TYPE_LABELS['telemetry.stack.deploy']).toBe('Telemetry services deploy');
    expect(jobTypeLabel('telemetry.retention.apply')).not.toBe('telemetry.retention.apply');
  });
});
