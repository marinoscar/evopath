import { NotFoundException } from '@nestjs/common';

import { userDataResetRequestSchema } from './dto/user-data.dto';
import { USER_DATA_RESET_TYPE } from './user-data.constants';
import { UserDataService, toResetStatus } from './user-data.service';

const USER = 'user-1';

function setup() {
  const prisma = {
    workout: { count: jest.fn().mockResolvedValue(3) },
    gym: { count: jest.fn().mockResolvedValue(1) },
    measurement: { count: jest.fn().mockResolvedValue(12) },
    program: { count: jest.fn().mockResolvedValue(1) },
    trainingPlanRun: { count: jest.fn().mockResolvedValue(2) },
    exercise: { count: jest.fn().mockResolvedValue(4) },
    storageObject: { count: jest.fn().mockResolvedValue(5) },
    userAiKey: { count: jest.fn().mockResolvedValue(1) },
    personalAccessToken: { count: jest.fn().mockResolvedValue(2) },
    notification: { count: jest.fn().mockResolvedValue(9) },
    equipmentType: { count: jest.fn().mockResolvedValue(0) },
    photoIntake: { count: jest.fn().mockResolvedValue(6) },
    workoutAdaptation: { count: jest.fn().mockResolvedValue(0) },
    userCredential: { count: jest.fn().mockResolvedValue(1) },
    healthDocument: { count: jest.fn().mockResolvedValue(7) },
    progressPhoto: { count: jest.fn().mockResolvedValue(8) },
    coachMessage: { count: jest.fn().mockResolvedValue(10) },
    userMemory: { count: jest.fn().mockResolvedValue(17) },
    activityGoal: { count: jest.fn().mockResolvedValue(11) },
    activityEntry: { count: jest.fn().mockResolvedValue(12) },
    healthSyncDevice: { count: jest.fn().mockResolvedValue(13) },
    healthSyncRun: { count: jest.fn().mockResolvedValue(14) },
    healthSyncDiagnosticReport: { count: jest.fn().mockResolvedValue(15) },
    sleepSession: { count: jest.fn().mockResolvedValue(16) },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
    job: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const jobs = { enqueue: jest.fn() };
  const service = new UserDataService(prisma as never, jobs as never);
  return { service, prisma, jobs };
}

describe('userDataResetRequestSchema', () => {
  it('accepts exactly "DELETE MY DATA"', () => {
    expect(userDataResetRequestSchema.safeParse({ confirmation: 'DELETE MY DATA' }).success).toBe(true);
  });

  it.each([
    [{}],
    [{ confirmation: '' }],
    [{ confirmation: 'delete my data' }],
    [{ confirmation: 'DELETE MY DATA ' }],
    [{ confirmation: 'DELETE' }],
    [{ confirmation: true }],
  ])('rejects %j', (body) => {
    expect(userDataResetRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('UserDataService', () => {
  describe('getSummary', () => {
    it('counts only the caller rows', async () => {
      const { service, prisma } = setup();

      await expect(service.getSummary(USER)).resolves.toEqual({
        workouts: 3,
        gyms: 1,
        measurements: 12,
        programs: 1,
        trainingRuns: 2,
        customExercises: 4,
        photos: 5,
        aiKeys: 1,
        accessTokens: 2,
        notifications: 9,
        customEquipment: 0,
        photoIntakes: 6,
        workoutAdaptations: 0,
        userCredentials: 1,
        healthDocuments: 7,
        progressPhotos: 8,
        coachMessages: 10,
        memories: 17,
        activityGoals: 11,
        activityEntries: 12,
        healthSyncDevices: 13,
        healthSyncRuns: 14,
        healthSyncDiagnosticReports: 15,
        sleepSessions: 16,
      });
      expect(prisma.userMemory.count).toHaveBeenCalledWith({ where: { userId: USER, status: 'active' } });
      expect(prisma.activityGoal.count).toHaveBeenCalledWith({ where: { userId: USER } });
      expect(prisma.activityEntry.count).toHaveBeenCalledWith({ where: { userId: USER } });

      expect(prisma.workout.count).toHaveBeenCalledWith({ where: { userId: USER } });
      expect(prisma.measurement.count).toHaveBeenCalledWith({
        where: { userId: USER, supersededAt: null, deletedAt: null },
      });
      expect(prisma.exercise.count).toHaveBeenCalledWith({ where: { ownerUserId: USER } });
      expect(prisma.storageObject.count).toHaveBeenCalledWith({ where: { uploadedById: USER } });
      expect(prisma.personalAccessToken.count).toHaveBeenCalledWith({
        where: { userId: USER, revokedAt: null },
      });
      expect(prisma.healthDocument.count).toHaveBeenCalledWith({ where: { userId: USER } });
      expect(prisma.progressPhoto.count).toHaveBeenCalledWith({ where: { userId: USER } });
      expect(prisma.coachMessage.count).toHaveBeenCalledWith({ where: { userId: USER } });
    });
  });

  describe('requestReset', () => {
    it('enqueues user.data_reset against the caller, so the queue dedups one active reset per user', async () => {
      const { service, jobs, prisma } = setup();
      jobs.enqueue.mockResolvedValue({ id: 'job-1', status: 'pending' });

      await expect(service.requestReset(USER)).resolves.toEqual({ jobId: 'job-1', status: 'pending' });

      expect(jobs.enqueue).toHaveBeenCalledWith({
        type: USER_DATA_RESET_TYPE,
        reason: 'rerun',
        subjectType: 'user',
        subjectId: USER,
        payload: { userId: USER },
      });
      // Dedup is the queue's: no opt-out.
      expect(jobs.enqueue.mock.calls[0][0].skipDedup).toBeUndefined();

      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: USER,
          action: 'user.data_reset.requested',
          targetType: 'user',
          targetId: USER,
          meta: { jobId: 'job-1', status: 'pending' },
        },
      });
    });

    it('returns the job already in flight when the queue collapses the enqueue', async () => {
      const { service, jobs } = setup();
      jobs.enqueue.mockResolvedValue({ id: 'job-running', status: 'running' });

      await expect(service.requestReset(USER)).resolves.toEqual({ jobId: 'job-running', status: 'running' });
    });
  });

  describe('getResetStatus', () => {
    it("looks the job up by id, type AND the caller's subject in one query", async () => {
      const { service, prisma } = setup();
      prisma.job.findFirst.mockResolvedValue({ id: 'job-1', status: 'running', lastError: null, payload: {} });

      await expect(service.getResetStatus(USER, 'job-1')).resolves.toEqual({ jobId: 'job-1', status: 'running' });

      expect(prisma.job.findFirst).toHaveBeenCalledWith({
        where: { id: 'job-1', type: USER_DATA_RESET_TYPE, subjectType: 'user', subjectId: USER },
        select: { id: true, status: true, lastError: true, payload: true },
      });
    });

    it("is a 404 for another user's job (the scoped query finds nothing)", async () => {
      const { service, prisma } = setup();
      prisma.job.findFirst.mockResolvedValue(null);

      await expect(service.getResetStatus(USER, 'someone-elses-job')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('toResetStatus', () => {
  const result = {
    workouts: 1,
    gyms: 1,
    measurements: 1,
    healthProfiles: 1,
    photoIntakes: 0,
    healthDocuments: 2,
    progressPhotos: 3,
    coachMessages: 4,
    coachStates: 1,
    memories: 2,
    memoryStates: 1,
    activityGoals: 2,
    activityEntries: 5,
    healthSyncDevices: 1,
    healthSyncRuns: 3,
    healthSyncDiagnosticReports: 1,
    sleepSessions: 4,
    programs: 0,
    programChangeLogs: 0,
    trainingRuns: 0,
    workoutAdaptations: 0,
    trainingCheckpoints: 0,
    customExercises: 0,
    customEquipment: 0,
    aiRuns: 0,
    aiUsageEvents: 0,
    aiKeys: 0,
    userCredentials: 0,
    accessTokens: 0,
    deviceCodes: 0,
    pushSubscriptions: 0,
    notifications: 0,
    notificationDeliveries: 0,
    userSettings: 1,
    cancelledJobs: 0,
    storageObjectsDeleted: 2,
    storageObjectsFailed: 1,
  };

  it('returns the result of a succeeded job', () => {
    expect(
      toResetStatus({ id: 'j', status: 'succeeded', lastError: 'old attempt', payload: { userId: 'u', result } }),
    ).toEqual({ jobId: 'j', status: 'succeeded', result });
  });

  it('returns the error of a failed job, and no result', () => {
    expect(toResetStatus({ id: 'j', status: 'failed', lastError: 'boom', payload: { result } })).toEqual({
      jobId: 'j',
      status: 'failed',
      error: 'boom',
    });
  });

  it('carries neither result nor error while pending or running', () => {
    expect(toResetStatus({ id: 'j', status: 'pending', lastError: 'retrying', payload: null })).toEqual({
      jobId: 'j',
      status: 'pending',
    });
  });

  it('reads a result written before healthDocuments existed as 0 documents, not as malformed', () => {
    const { healthDocuments: _added, ...older } = result;
    expect(
      toResetStatus({ id: 'j', status: 'succeeded', lastError: null, payload: { result: older } }),
    ).toEqual({ jobId: 'j', status: 'succeeded', result: { ...older, healthDocuments: 0 } });
  });

  it('reads a result written before the AI Coach existed as 0 coach rows, not as malformed', () => {
    const { progressPhotos: _p, coachMessages: _m, coachStates: _s, ...older } = result;
    expect(
      toResetStatus({ id: 'j', status: 'succeeded', lastError: null, payload: { result: older } }),
    ).toEqual({
      jobId: 'j',
      status: 'succeeded',
      result: { ...older, progressPhotos: 0, coachMessages: 0, coachStates: 0 },
    });
  });

  it('reads a result written before activity goals existed as 0 goals and entries, not as malformed', () => {
    const { activityGoals: _g, activityEntries: _e, ...older } = result;
    expect(
      toResetStatus({ id: 'j', status: 'succeeded', lastError: null, payload: { result: older } }),
    ).toEqual({ jobId: 'j', status: 'succeeded', result: { ...older, activityGoals: 0, activityEntries: 0 } });
  });

  it('reads a result written before health sync existed as 0 devices, runs and reports', () => {
    const { healthSyncDevices: _d, healthSyncRuns: _r, healthSyncDiagnosticReports: _p, sleepSessions: _s, ...older } = result;
    expect(
      toResetStatus({ id: 'j', status: 'succeeded', lastError: null, payload: { result: older } }),
    ).toEqual({
      jobId: 'j',
      status: 'succeeded',
      result: { ...older, healthSyncDevices: 0, healthSyncRuns: 0, healthSyncDiagnosticReports: 0, sleepSessions: 0 },
    });
  });

  it('omits a malformed result rather than returning it', () => {
    expect(
      toResetStatus({ id: 'j', status: 'succeeded', lastError: null, payload: { result: { workouts: 'x' } } }),
    ).toEqual({ jobId: 'j', status: 'succeeded' });
  });
});
