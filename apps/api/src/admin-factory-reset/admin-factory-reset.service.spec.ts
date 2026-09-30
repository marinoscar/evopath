import { NotFoundException } from '@nestjs/common';

import { ADMIN_FACTORY_RESET_TYPE } from './admin-factory-reset.constants';
import { AdminFactoryResetService, toFactoryResetStatus } from './admin-factory-reset.service';

const ACTOR = 'actor-1';

function countMock(value = 0) {
  return { count: jest.fn().mockResolvedValue(value) };
}

function setup() {
  const prisma: any = {
    user: { ...countMock(3), findUnique: jest.fn().mockResolvedValue({ id: ACTOR, email: 'a@example.com' }) },
    databaseBackupRun: { findMany: jest.fn().mockResolvedValue([{ storageKey: 'database-backups/x.dump' }]) },
    workout: countMock(4),
    gym: countMock(1),
    measurement: countMock(5),
    program: countMock(1),
    trainingPlanRun: countMock(2),
    storageObject: countMock(7),
    job: { ...countMock(9), findFirst: jest.fn() },
    notification: countMock(6),
    allowedEmail: countMock(2),
    notificationBroadcast: countMock(1),
    aiRun: countMock(8),
    exercise: countMock(1),
    equipmentType: countMock(1),
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const jobs = { enqueue: jest.fn() };
  const service = new AdminFactoryResetService(prisma, jobs as never);
  return { service, prisma, jobs };
}

describe('AdminFactoryResetService', () => {
  describe('getSummary', () => {
    it('counts deployment-wide, excluding the caller, backup archives, running jobs and the caller allowlist entry', async () => {
      const { service, prisma } = setup();

      await expect(service.getSummary(ACTOR)).resolves.toEqual({
        otherUsers: 3,
        workouts: 4,
        gyms: 1,
        measurements: 5,
        programs: 1,
        trainingRuns: 2,
        storageObjects: 7,
        jobs: 9,
        notifications: 6,
        allowlistEntries: 2,
        broadcasts: 1,
        aiRuns: 8,
        customExercises: 1,
        customEquipment: 1,
      });

      expect(prisma.user.count).toHaveBeenCalledWith({ where: { id: { not: ACTOR } } });
      expect(prisma.storageObject.count).toHaveBeenCalledWith({
        where: { storageKey: { notIn: ['database-backups/x.dump'] } },
      });
      expect(prisma.job.count).toHaveBeenCalledWith({
        where: { status: { in: ['pending', 'succeeded', 'failed'] }, backupRun: { is: null } },
      });
      expect(prisma.allowedEmail.count).toHaveBeenCalledWith({
        where: {
          NOT: { email: { equals: 'a@example.com', mode: 'insensitive' } },
          OR: [{ claimedById: null }, { claimedById: { not: ACTOR } }],
        },
      });
    });
  });

  describe('requestReset', () => {
    it('enqueues one subject-less job (deployment-wide dedup) and audits the request', async () => {
      const { service, prisma, jobs } = setup();
      jobs.enqueue.mockResolvedValue({ id: 'job-1', status: 'pending' });

      await expect(service.requestReset(ACTOR)).resolves.toEqual({ jobId: 'job-1', status: 'pending' });

      expect(jobs.enqueue).toHaveBeenCalledWith({
        type: ADMIN_FACTORY_RESET_TYPE,
        reason: 'rerun',
        payload: { actorUserId: ACTOR },
      });
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: ACTOR,
          action: 'admin.factory_reset.requested',
          targetType: 'job',
          targetId: 'job-1',
        }),
      });
    });
  });

  describe('getResetStatus', () => {
    it('looks the job up by id AND type', async () => {
      const { service, prisma } = setup();
      prisma.job.findFirst.mockResolvedValue({ id: 'job-1', status: 'running', lastError: null, payload: {} });

      await expect(service.getResetStatus('job-1')).resolves.toEqual({ jobId: 'job-1', status: 'running' });
      expect(prisma.job.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'job-1', type: ADMIN_FACTORY_RESET_TYPE } }),
      );
    });

    it('is a 404 for any other job', async () => {
      const { service, prisma } = setup();
      prisma.job.findFirst.mockResolvedValue(null);
      await expect(service.getResetStatus('job-2')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('toFactoryResetStatus', () => {
    it('carries the error of a failed job', () => {
      expect(toFactoryResetStatus({ id: 'j', status: 'failed', lastError: 'boom', payload: null })).toEqual({
        jobId: 'j',
        status: 'failed',
        error: 'boom',
      });
    });

    it('omits a malformed result rather than returning it', () => {
      expect(
        toFactoryResetStatus({ id: 'j', status: 'succeeded', lastError: null, payload: { result: { usersDeleted: -1 } } }),
      ).toEqual({ jobId: 'j', status: 'succeeded' });
    });
  });
});
