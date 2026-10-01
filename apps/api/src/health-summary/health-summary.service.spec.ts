import { ConflictException, Logger } from '@nestjs/common';

import { createMockPrismaService, type MockPrismaService } from '../../test/mocks/prisma.mock';
import type { AiFeatureModelResolver } from '../ai/assignments/ai-feature-model-resolver.service';
import type { JobsService } from '../jobs/jobs.service';
import type { PrismaService } from '../prisma/prisma.service';
import { buildHealthDigest, digestHash, type HealthDigestSource } from './health-digest';
import { HealthSummaryListener } from './health-summary.listener';
import type { HealthSummaryReader } from './health-summary.reader';
import { HealthSummaryService } from './health-summary.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-01T12:00:00.000Z');

const SOURCE: HealthDigestSource = {
  profile: null,
  measurements: [
    { metricKey: 'weight', value: 80, measuredAt: new Date('2026-09-30T08:00:00Z'), localDate: null, flag: null, referenceLow: null, referenceHigh: null },
  ],
};

describe('HealthSummaryService (H8, #192)', () => {
  let prisma: MockPrismaService;
  let jobs: { enqueue: jest.Mock };
  let reader: { consentOn: jest.Mock; digestSource: jest.Mock; latestReady: jest.Mock };
  let features: { resolve: jest.Mock };
  let service: HealthSummaryService;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['setImmediate', 'nextTick'] });
    prisma = createMockPrismaService();
    jobs = { enqueue: jest.fn(async () => ({ id: 'job-1', status: 'pending', scheduledFor: null })) };
    reader = {
      consentOn: jest.fn(async () => true),
      digestSource: jest.fn(async () => SOURCE),
      latestReady: jest.fn(async () => null),
    };
    features = {
      resolve: jest.fn(async () => ({
        featureId: 'health_summary',
        state: 'ready',
        model: { provider: 'openai', modelId: 'gpt-text', displayName: 'GPT text', keySource: 'org' },
      })),
    };
    service = new HealthSummaryService(
      prisma as unknown as PrismaService,
      jobs as unknown as JobsService,
      reader as unknown as HealthSummaryReader,
      features as unknown as AiFeatureModelResolver,
    );
    (prisma.job.count as jest.Mock).mockResolvedValue(0);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('setConsent', () => {
    it('on: upserts the setting, audits { enabled: true } and enqueues a summary at once', async () => {
      (prisma.healthSummarySetting.findUnique as jest.Mock).mockResolvedValue(null);

      await service.setConsent(USER_ID, true);

      expect(prisma.healthSummarySetting.upsert).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        create: { userId: USER_ID, enabled: true, consentedAt: NOW },
        update: { enabled: true, consentedAt: NOW },
      });
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: USER_ID,
          action: 'health_summary:consent',
          targetType: 'health_summary_setting',
          targetId: USER_ID,
          meta: { enabled: true },
        },
      });
      expect(jobs.enqueue).toHaveBeenCalledWith({
        type: 'ai.health.summary',
        reason: 'upload',
        subjectType: 'health_summary',
        subjectId: USER_ID,
        payload: {},
        scheduledFor: null,
      });
    });

    it('off: audits { enabled: false }, cancels the pending summary job and enqueues nothing', async () => {
      (prisma.healthSummarySetting.findUnique as jest.Mock).mockResolvedValue({ enabled: true, consentedAt: NOW });

      await service.setConsent(USER_ID, false);

      expect(prisma.healthSummarySetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { enabled: false } }));
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ meta: { enabled: false } }) });
      expect(prisma.job.deleteMany).toHaveBeenCalledWith({
        where: { type: 'ai.health.summary', subjectType: 'health_summary', subjectId: USER_ID, status: 'pending' },
      });
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    it('setting the value it already has is not audited again', async () => {
      (prisma.healthSummarySetting.findUnique as jest.Mock).mockResolvedValue({ enabled: false, consentedAt: null });

      await service.setConsent(USER_ID, false);

      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });

    it('an audit failure does not fail the change', async () => {
      (prisma.healthSummarySetting.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.auditEvent.create as jest.Mock).mockRejectedValue(new Error('db down'));

      await expect(service.setConsent(USER_ID, true)).resolves.toMatchObject({ hasData: true });
    });
  });

  describe('requestRegeneration (after a health write)', () => {
    it('consent on: one job, scheduled two minutes ahead, deduplicated by the user subject', async () => {
      await expect(service.requestRegeneration(USER_ID)).resolves.toBe(true);

      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ai.health.summary',
          subjectType: 'health_summary',
          subjectId: USER_ID,
          scheduledFor: new Date(NOW.getTime() + 120_000),
        }),
      );
      expect(jobs.enqueue.mock.calls[0][0].skipDedup).toBeUndefined();
    });

    it('consent off: nothing is enqueued', async () => {
      reader.consentOn.mockResolvedValue(false);

      await expect(service.requestRegeneration(USER_ID)).resolves.toBe(false);

      expect(jobs.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('409 HEALTH_SUMMARY_CONSENT_OFF while the consent is off', async () => {
      reader.consentOn.mockResolvedValue(false);

      const error = await service.refresh(USER_ID).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ details: { reason: 'HEALTH_SUMMARY_CONSENT_OFF' } });
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    it('409 HEALTH_SUMMARY_NO_DATA without health data', async () => {
      reader.digestSource.mockResolvedValue({ profile: null, measurements: [] });

      const error = await service.refresh(USER_ID).catch((e: unknown) => e);

      expect((error as ConflictException).getResponse()).toMatchObject({ details: { reason: 'HEALTH_SUMMARY_NO_DATA' } });
    });

    it('enqueues a forced job now; a waiting debounced job is pulled forward and forced', async () => {
      jobs.enqueue.mockResolvedValue({ id: 'job-1', status: 'pending', scheduledFor: new Date(NOW.getTime() + 60_000) });

      await service.refresh(USER_ID);

      expect(jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ reason: 'rerun', payload: { force: true }, scheduledFor: null }));
      expect(prisma.job.updateMany).toHaveBeenCalledWith({
        where: { id: 'job-1', status: 'pending' },
        data: { scheduledFor: null, payload: { force: true } },
      });
    });
  });

  describe('view', () => {
    it('shows what is shared, the processor, and stale when there is data but no summary', async () => {
      (prisma.healthSummarySetting.findUnique as jest.Mock).mockResolvedValue({ enabled: true, consentedAt: NOW });

      const view = await service.view(USER_ID);

      expect(view).toMatchObject({
        enabled: true,
        consentedAt: NOW.toISOString(),
        sharing: { modelState: 'ready', processor: { provider: 'openai', modelId: 'gpt-text', displayName: 'GPT text' } },
        summary: null,
        lastAttempt: null,
        hasData: true,
        stale: true,
        pending: false,
      });
      expect(view.sharing.shared.length).toBeGreaterThan(0);
      expect(view.sharing.neverShared).toEqual(expect.arrayContaining(['Documents, photos and file names']));
    });

    it('not stale when the newest ready summary was made from the same inputs; stale again once they change', async () => {
      const hash = digestHash(buildHealthDigest(SOURCE));
      reader.latestReady.mockResolvedValue({
        version: 2,
        narrative: 'Summary text.',
        trainingConsiderations: [{ text: 'Go easy.', severity: 'caution', conservative: true }],
        dataAsOf: new Date('2026-09-30T00:00:00Z'),
        inputsHash: hash,
        provider: 'openai',
        model: 'gpt-text',
        createdAt: NOW,
      });

      const fresh = await service.view(USER_ID);
      expect(fresh.stale).toBe(false);
      expect(fresh.summary).toEqual({
        version: 2,
        narrative: 'Summary text.',
        trainingConsiderations: [{ text: 'Go easy.', severity: 'caution', conservative: true }],
        dataAsOf: '2026-09-30',
        createdAt: NOW.toISOString(),
        provider: 'openai',
        model: 'gpt-text',
      });

      reader.digestSource.mockResolvedValue({
        ...SOURCE,
        measurements: [...SOURCE.measurements, { ...SOURCE.measurements[0], value: 79, measuredAt: NOW }],
      });
      expect((await service.view(USER_ID)).stale).toBe(true);
    });

    it('no processor while the feature cannot run', async () => {
      features.resolve.mockResolvedValue({ featureId: 'health_summary', state: 'no_key' });

      const view = await service.view(USER_ID);

      expect(view.sharing).toMatchObject({ modelState: 'no_key', processor: null });
    });
  });
});

describe('HealthSummaryListener (H8, #192)', () => {
  it('asks for one debounced regeneration and never throws', async () => {
    const summaries = { requestRegeneration: jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(true) };
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const listener = new HealthSummaryListener(summaries as never);

    await expect(listener.onHealthDataChanged({ userId: USER_ID, source: 'measurements' })).resolves.toBeUndefined();
    await listener.onHealthDataChanged({ userId: USER_ID, source: 'intake' });

    expect(summaries.requestRegeneration).toHaveBeenCalledTimes(2);
    expect(summaries.requestRegeneration).toHaveBeenCalledWith(USER_ID);
  });
});
