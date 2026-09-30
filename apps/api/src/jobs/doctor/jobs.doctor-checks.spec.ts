import { ConfigService } from '@nestjs/config';

import { DoctorCheckOutcome } from '../../doctor/doctor-check.interface';
import { DoctorCheckRegistry } from '../../doctor/doctor-check.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { JobAdminService } from '../job-admin.service';
import { JobsBacklogDoctorCheck, decideJobsBacklog } from './jobs-backlog.doctor-check';
import { JobsWorkerDoctorCheck, decideJobsWorker } from './jobs-worker.doctor-check';

function expectRemedy(outcome: DoctorCheckOutcome): void {
  expect(['warn', 'fail']).toContain(outcome.status);
  expect(outcome.remedy).toEqual(expect.stringMatching(/\S{10,}/));
}

const config = (values: Record<string, unknown>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

describe('jobs doctor checks', () => {
  describe('jobs.worker', () => {
    it('passes "all" with slots', () => {
      expect(decideJobsWorker({ rawMode: 'all', mode: 'all', concurrency: 2 })).toMatchObject({
        status: 'pass',
        data: { mode: 'all', concurrency: 2 },
      });
    });

    it('warns when the worker is off', () => {
      const outcome = decideJobsWorker({ rawMode: 'off', mode: 'off', concurrency: 2 });
      expect(outcome.status).toBe('warn');
      expectRemedy(outcome);
    });

    it('warns on an unrecognised mode', () => {
      const outcome = decideJobsWorker({ rawMode: 'sytem', mode: null, concurrency: 2 });
      expect(outcome.detail).toContain('sytem');
      expectRemedy(outcome);
    });

    it('warns on zero concurrency', () => {
      expectRemedy(decideJobsWorker({ rawMode: 'system', mode: 'system', concurrency: 0 }));
    });

    it('reads the settings through the shared parsers', async () => {
      const check = new JobsWorkerDoctorCheck(
        new DoctorCheckRegistry(),
        config({ 'jobs.workerMode': ' SYSTEM ', 'jobs.workerConcurrency': 4 }),
      );

      await expect(check.run()).resolves.toMatchObject({ status: 'pass', data: { mode: 'system', concurrency: 4 } });
    });
  });

  describe('jobs.backlog', () => {
    const facts = {
      pending: 3,
      running: 1,
      stuckRunning: 0,
      stuckThresholdMinutes: 30,
      failedLast24h: 2,
      oldestPendingMinutes: 1,
    };

    it('passes a draining queue, reporting the day’s failures', () => {
      expect(decideJobsBacklog(facts)).toMatchObject({ status: 'pass', data: { failedLast24h: 2 } });
    });

    it('warns on stuck running jobs', () => {
      const outcome = decideJobsBacklog({ ...facts, stuckRunning: 2 });
      expect(outcome.detail).toContain('2 job(s)');
      expectRemedy(outcome);
    });

    it('warns when the oldest due job has waited over 15 minutes', () => {
      expectRemedy(decideJobsBacklog({ ...facts, oldestPendingMinutes: 16 }));
      expect(decideJobsBacklog({ ...facts, oldestPendingMinutes: 15 }).status).toBe('pass');
    });

    it('queries stats, failures and the oldest DUE pending job', async () => {
      const stats = jest.fn().mockResolvedValue({
        byStatus: { pending: 5, running: 0 },
        stuckRunning: 0,
        stuckThresholdMinutes: 30,
      });
      const count = jest.fn().mockResolvedValue(7);
      const findFirst = jest.fn().mockResolvedValue({
        createdAt: new Date(Date.now() - 60 * 60_000),
        scheduledFor: null,
      });
      const check = new JobsBacklogDoctorCheck(
        new DoctorCheckRegistry(),
        { stats } as unknown as JobAdminService,
        { job: { count, findFirst } } as unknown as PrismaService,
      );

      const outcome = await check.run();

      expect(outcome.status).toBe('warn');
      expect(outcome.data).toMatchObject({ failedLast24h: 7, pending: 5, oldestPendingMinutes: 60 });
      expect(findFirst.mock.calls[0][0].where.status).toBe('pending');
      expect(count.mock.calls[0][0].where.status).toBe('failed');
    });
  });
});
